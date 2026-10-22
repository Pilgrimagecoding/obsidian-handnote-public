import { AIError, type AIImage, type AITask, type HttpFn } from '../ai/types';
import { withTimeout, type AIService } from '../ai/service';
import type { AISettings } from '../ai/config';
import { providerFor } from '../ai/providers';
import { myscriptRecognize } from './myscript';
import { recSystemPrompt, recTaskPrompt } from './prompts';
import { quickHash } from './raster';
import type { InkStrokeIn, RecEngine, RecResult, RecRun, RecStage, RecTask } from './types';
import { RecError, validateRecognition } from './validate';
import type { RecognitionSettings } from './settings';
import { OFFLINE_ZH, recognizeOfflineText } from './offline/engine';
import type { MathResult, TextResult } from './types';

/** On-device models (src/local), injected so the service stays testable without WASM. */
export interface LocalApi {
  ready(id: 'math' | 'text-zh'): boolean;
  /** Why local recognition cannot run on this system at all (null / absent = it can). */
  unsupported?(): string | null;
  /** Local math recognition exists in this build (absent = yes; the public edition says no). */
  includesMath?(): boolean;
  /** Name of the local math model, when there is one. */
  mathModel?(): { model: string; label: string } | null;
  math(ink: InkStrokeIn[], signal?: AbortSignal): Promise<{ result: MathResult; confident: boolean; ms: { render: number; infer: number; total: number }; mode: string }>;
  text(ink: InkStrokeIn[], signal?: AbortSignal): Promise<{ result: TextResult; confident: boolean; ms: { render: number; infer: number; total: number }; mode: string }>;
  warm(model: 'math' | 'text'): void;
}

/**
 * HandwritingRecognitionService — routes a convert task to an engine and returns a validated
 * result. It never touches the document.
 *
 *  Convert → text / math (digital ink — the strokes themselves, never a picture):
 *     1. MyScript Cloud when the user configured MyScript keys (text + math, many languages);
 *     2. the offline Chinese engine for text (bundled templates, no network, no key);
 *     3. a general vision model only when the user explicitly allowed it as a fallback (or chose
 *        it) — it reads a picture and is labelled as such everywhere.
 *  AI tools → mind map / diagram / image text: general vision model (structure only).
 *
 * Reliability: one request at a time per selection (a second tap joins the running one), a small
 * cache (the same unchanged selection converted again returns instantly, no second charge),
 * cancellation, measured stages, and typed errors. Automatic repeats only where the provider
 * rejected the call before doing the work (see AIService.request).
 */

export type { EngineChoice, RecognitionSettings } from './settings';
export { DEFAULT_LEXICON, defaultRecognitionSettings, sanitizeRecognitionSettings } from './settings';

export interface RecInput {
  selectionId: string;
  language: 'zh' | 'en';
  /** Vector ink (MyScript). */
  ink?: InkStrokeIn[];
  /** Picture of the selection (vision models). */
  image?: AIImage;
  /** Lines found by local ink analysis (hint for text). */
  lineCount?: number;
  /** Offline engine progress (lines done / total). */
  onProgress?: (done: number, total: number) => void;
}

export interface EngineInfo {
  engine: RecEngine;
  ready: boolean;
  reason?: string;
  model: string;
  /** Provider / engine shown in the consent dialog. */
  label: string;
  /** What leaves the device: nothing (offline), the vector strokes, or a picture. */
  sends: 'nothing' | 'ink' | 'image';
  maxImageSide: number;
  /** Technology: digital-ink recognition, an on-device model, or a general vision model. */
  kind: 'digital-ink' | 'local' | 'vision-llm' | 'demo';
}

export interface MyScriptDiagnosis {
  ok: boolean;
  /** config: keys missing · network: server unreachable / no answer · auth: keys or HMAC refused · quota · other · done */
  step: 'config' | 'network' | 'slow' | 'auth' | 'quota' | 'other' | 'done';
  host: string;
  reachMs?: number;
  version?: string;
  recognizeMs?: number;
  label?: string;
  detail?: string;
  status?: number;
  /** transport that answered the reachability check */
  via?: string;
}

export interface RecognitionDeps {
  ai: AIService | null;
  settings(): AISettings;
  recognition(): RecognitionSettings;
  getSecret(name: string): string | null | Promise<string | null>;
  secretsSupported: boolean;
  http: HttpFn;
  now?: () => number;
  local?: LocalApi;
}

const AI_TASK: Record<RecTask, AITask> = { text: 'handwriting', math: 'handwriting', mindmap: 'mindmap', diagram: 'diagram', 'image-text': 'image-text' };

export interface RecTiming {
  task: RecTask;
  engine: RecEngine;
  model: string;
  totalMs: number;
  requestMs: number;
  cached: boolean;
  at: number;
}

export interface RecStats {
  n: number;
  p50: number;
  p95: number;
  /** p50 / p95 of the request stage only */
  req50: number;
  req95: number;
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(v: number[], q: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export class HandwritingRecognitionService {
  private cache = new Map<string, RecRun>();
  /** Measured timings of the last conversions (memory only; durations, never content). */
  private timings: RecTiming[] = [];
  private inflight = new Map<string, Promise<RecRun>>();

  constructor(private readonly deps: RecognitionDeps) {}

  /** MyScript keys are set (independent of the general AI switch). */
  myscriptReady(): { ready: boolean; reason?: string } {
    const r = this.deps.recognition();
    if (!this.deps.secretsSupported) return { ready: false, reason: 'secret-storage-unsupported' };
    if (!r.myscriptAppKeySecret) return { ready: false, reason: 'no-myscript-key' };
    return { ready: true };
  }

  private myscriptInfo(task: 'text' | 'math'): EngineInfo {
    const r = this.deps.recognition();
    const ms = this.myscriptReady();
    return { engine: 'myscript', ...ms, model: `MyScript ${task === 'text' ? 'Text' : 'Math'} (${r.myscriptLang})`, label: `MyScript Cloud · ${r.myscriptHost}`, sends: 'ink', maxImageSide: 0, kind: 'digital-ink' };
  }

  private localInfo(task: 'text' | 'math'): EngineInfo {
    const id = task === 'math' ? 'math' : 'text-zh';
    const unsupported = !!this.deps.local?.unsupported?.();
    const notIncluded = task === 'math' && this.deps.local?.includesMath?.() === false;
    const ready = !unsupported && !notIncluded && !!this.deps.local?.ready(id);
    const mm = task === 'math' ? (this.deps.local?.mathModel?.() ?? null) : null;
    return {
      engine: 'local',
      ready,
      reason: ready ? undefined : notIncluded ? 'local-math-not-included' : unsupported ? 'local-unsupported' : task === 'math' ? 'local-math-missing' : 'local-text-missing',
      model: task === 'math' ? (mm?.model ?? 'local math') : 'PP-OCRv5 mobile',
      label: task === 'math' ? (mm?.label ?? 'local') : 'PP-OCRv5',
      sends: 'nothing',
      maxImageSide: 0,
      kind: 'local',
    };
  }

  /** Local model ready for a task (Convert menu hints, prefetch). */
  localReady(task: 'text' | 'math'): boolean {
    return !!this.deps.local?.ready(task === 'math' ? 'math' : 'text-zh');
  }

  warmLocal(task: 'text' | 'math'): void {
    if (this.localReady(task)) this.deps.local?.warm(task);
  }

  private offlineInfo(): EngineInfo {
    const on = this.deps.recognition().offlineZh;
    return { engine: 'offline', ready: on, reason: on ? undefined : 'offline-disabled', model: `${OFFLINE_ZH.characters} 字`, label: OFFLINE_ZH.label, sends: 'nothing', maxImageSide: 0, kind: 'digital-ink' };
  }

  private visionInfo(task: RecTask): EngineInfo {
    const ai = this.deps.ai;
    const at = AI_TASK[task];
    if (!ai) return { engine: 'vision', ready: false, reason: 'no-ai', model: '', label: '', sends: 'image', maxImageSide: 1280, kind: 'vision-llm' };
    const st = ai.status(at);
    const res = ai.resolve(at);
    const caps = res ? providerFor(res.profile.type).capabilities(res.entry.model) : null;
    return { engine: st.mock ? 'mock' : 'vision', ready: st.ready, reason: st.reason, model: ai.model(at), label: ai.label(at), sends: 'image', maxImageSide: Math.min(1600, caps?.maxImageSide || 1280), kind: st.mock ? 'demo' : 'vision-llm' };
  }

  /**
   * Engine for a task. Convert → Text / Math never silently falls back to a general vision model:
   * that needs the explicit `visionFallback` setting (or choosing it). When nothing suitable is
   * available the info says why (`ready: false`) — the UI then explains instead of guessing.
   */
  engineFor(task: RecTask): EngineInfo {
    if (task !== 'text' && task !== 'math') return this.visionInfo(task);
    const r = this.deps.recognition();
    if (r.engine === 'myscript') return this.myscriptInfo(task);
    if (r.engine === 'vision') return this.visionInfo(task);
    if (r.engine === 'offline') {
      if (task === 'text') return this.offlineInfo();
      return { engine: 'offline', ready: false, reason: 'math-not-offline', model: '', label: OFFLINE_ZH.label, sends: 'nothing', maxImageSide: 0, kind: 'digital-ink' };
    }
    // auto = on device first: installed local model → (text) bundled offline engine → explicit
    // picture fallback. MyScript / chat models are used only when chosen in the settings.
    const loc = this.localInfo(task);
    if (loc.ready) return loc;
    if (task === 'text' && r.offlineZh) return this.offlineInfo();
    if (r.visionFallback) {
      const v = this.visionInfo(task);
      if (v.ready) return v;
    }
    if (this.deps.local) return loc;
    return { ...this.myscriptInfo(task), ready: false, reason: task === 'math' ? 'math-needs-myscript' : 'no-ink-engine' };
  }

  /** Cache / dedupe key of a request: task, engine, model, content, dictionary. */
  key(task: RecTask, input: RecInput): string {
    const e = this.engineFor(task);
    const content = e.sends === 'image' ? (input.image?.base64 ?? '') : JSON.stringify(input.ink ?? []);
    return [task, e.engine, e.model, quickHash(content), quickHash(this.deps.recognition().lexicon.join('|')), input.language].join(':');
  }

  record(run: RecRun, totalMs: number, task: RecTask): void {
    this.timings.push({ task, engine: run.engine, model: run.model, totalMs, requestMs: run.stages.find((x) => x.name === 'request')?.ms ?? 0, cached: run.cached, at: Date.now() });
    if (this.timings.length > 100) this.timings.shift();
  }

  /** p50 / p95 of real (not cached) conversions, optionally for one model. */
  stats(model?: string): RecStats {
    const v = this.timings.filter((x) => !x.cached && (!model || x.model === model));
    const tot = v.map((x) => x.totalMs);
    const req = v.map((x) => x.requestMs);
    return { n: v.length, p50: percentile(tot, 0.5), p95: percentile(tot, 0.95), req50: percentile(req, 0.5), req95: percentile(req, 0.95) };
  }

  recentTimings(): RecTiming[] {
    return [...this.timings];
  }

  /**
   * Diagnose MyScript in two steps so the user can tell a network problem from a key problem:
   *  1. GET /api/v4.0/iink/version (no key, nothing of the user's) — is the server reachable?
   *  2. recognise one synthetic horizontal stroke ("一") — are the keys / HMAC accepted?
   * Step 2 counts as one request on the user's MyScript account. Never throws.
   */
  async testMyScript(): Promise<MyScriptDiagnosis> {
    const rec = this.deps.recognition();
    const now = this.deps.now ?? (() => performance.now());
    const host = rec.myscriptHost;
    const ready = this.myscriptReady();
    if (!ready.ready) return { ok: false, step: 'config', host, detail: ready.reason ?? 'not configured' };
    // 1. reachability
    const t0 = now();
    let version = '';
    let via = '';
    try {
      const res = await withTimeout(this.deps.http({ url: `https://${host}/api/v4.0/iink/version`, method: 'GET', headers: { Accept: 'application/json' } }), 15000);
      via = res.via ?? '';
      if (res.status >= 200 && res.status < 300) {
        try {
          version = String((JSON.parse(res.text) as { version?: string }).version ?? '');
        } catch {
          version = '';
        }
      } else if (res.status >= 500 || res.status === 0) {
        return { ok: false, step: 'network', host, reachMs: Math.round(now() - t0), detail: `HTTP ${res.status}` };
      }
    } catch (e) {
      return { ok: false, step: 'network', host, reachMs: Math.round(now() - t0), detail: e instanceof AIError ? e.message : String((e as Error)?.message ?? e) };
    }
    const reachMs = Math.round(now() - t0);
    // 2. keys
    const appKey = await this.deps.getSecret(rec.myscriptAppKeySecret as string);
    const hmac = rec.myscriptHmacSecret ? await this.deps.getSecret(rec.myscriptHmacSecret) : null;
    if (!appKey) return { ok: false, step: 'config', host, reachMs, version, detail: 'application key is empty or missing on this device' };
    const xs = Array.from({ length: 20 }, (_, i) => 20 + i * 8);
    const ink: InkStrokeIn[] = [{ id: 't1', xs, ys: xs.map(() => 60), ts: xs.map((_, i) => i * 10), ps: xs.map(() => 0.5) }];
    const t1 = now();
    try {
      const out = await withTimeout(myscriptRecognize('text', ink, { host, applicationKey: appKey.trim(), hmacKey: hmac?.trim() || undefined, lang: rec.myscriptLang, lexicon: [] }, this.deps.http), 45000);
      const r = out.result;
      return { ok: true, step: 'done', host, reachMs, version, via, recognizeMs: Math.round(now() - t1), label: r.task === 'text' ? r.lines.map((l) => l.text).join(' ') : '' };
    } catch (e) {
      const err = e instanceof AIError ? e : new AIError('provider', String((e as Error)?.message ?? e));
      const step = err.code === 'auth' ? 'auth' : err.code === 'timeout' ? 'slow' : err.code === 'network' ? 'network' : err.code === 'rate-limit' || err.code === 'quota' ? 'quota' : err.code === 'empty' ? 'done' : 'other';
      if (step === 'done') return { ok: true, step, host, reachMs, version, recognizeMs: Math.round(now() - t1), label: '' };
      return { ok: false, step, host, reachMs, version, via, recognizeMs: Math.round(now() - t1), detail: err.message, status: err.status };
    }
  }

  private warmAt = -Infinity;
  private rtt: number | undefined;

  /** Round trip of the last keyless GET to MyScript (ms): the network part of every conversion. */
  networkRtt(): number | undefined {
    return this.rtt;
  }

  /**
   * Open the HTTPS connection to MyScript before the user taps Convert, so the recognition request
   * does not pay for DNS + TCP + TLS (several round trips to the server in Europe). It is a GET of
   * the public version endpoint: no key, nothing of the user's. At most every 30 s. Never throws.
   */
  warmUp(): void {
    const ms = this.myscriptReady();
    if (!ms.ready) return;
    const now = this.deps.now ?? (() => performance.now());
    const t = now();
    if (t - this.warmAt < 30000) return;
    this.warmAt = t;
    const host = this.deps.recognition().myscriptHost;
    const t0 = now();
    void withTimeout(this.deps.http({ url: `https://${host}/api/v4.0/iink/version`, method: 'GET', headers: { Accept: 'application/json' } }), 15000)
      .then(() => {
        this.rtt = now() - t0;
      })
      .catch(() => {
        this.warmAt = -Infinity;
      });
  }

  /** Forget cached results (settings changed). */
  clearCache(): void {
    this.cache.clear();
  }

  async recognize(task: RecTask, input: RecInput, signal?: AbortSignal, onStage?: (s: RecStage['name']) => void): Promise<RecRun> {
    const key = this.key(task, input);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true, stages: [] };
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(task, input, signal, onStage).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    const out = await p;
    this.cache.set(key, out);
    if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value as string);
    return out;
  }

  private async run(task: RecTask, input: RecInput, signal?: AbortSignal, onStage?: (s: RecStage['name']) => void): Promise<RecRun> {
    const info = this.engineFor(task);
    if (!info.ready) throw new AIError('not-configured', info.reason ?? 'not configured');
    const now = this.deps.now ?? (() => performance.now());
    const stages: RecStage[] = [];
    const rec = this.deps.recognition();
    if (info.engine === 'offline') {
      if (!input.ink?.length) throw new AIError('not-configured', 'offline recognition needs ink strokes in the selection');
      onStage?.('request');
      const t0 = now();
      const result = await recognizeOfflineText(input.ink, rec.lexicon, signal, input.onProgress);
      stages.push({ name: 'request', ms: now() - t0 });
      return { result, engine: 'offline', model: info.model, stages, bytes: 0, usage: {}, cached: false };
    }
    if (info.engine === 'local') {
      if (!input.ink?.length) throw new AIError('not-configured', 'local recognition needs ink strokes in the selection');
      const local = this.deps.local as LocalApi;
      onStage?.('request');
      const r = task === 'math' ? await local.math(input.ink, signal) : await local.text(input.ink, signal);
      stages.push({ name: 'prepare', ms: r.ms.render }, { name: 'request', ms: r.ms.infer });
      return { result: r.result, engine: 'local', model: `${info.model} · ${r.mode || 'worker'}`, stages, bytes: 0, usage: {}, cached: false, confident: r.confident };
    }
    if (info.engine === 'myscript') {
      if (!input.ink?.length) throw new AIError('not-configured', 'MyScript needs ink strokes in the selection');
      const appKey = await this.deps.getSecret(rec.myscriptAppKeySecret as string);
      const hmac = rec.myscriptHmacSecret ? await this.deps.getSecret(rec.myscriptHmacSecret) : null;
      if (!appKey) throw new AIError('not-configured', 'MyScript application key is empty or missing on this device');
      onStage?.('request');
      const t0 = now();
      const timeoutMs = this.deps.settings().timeoutSec * 1000;
      const call = myscriptRecognize(task as 'text' | 'math', input.ink, { host: rec.myscriptHost, applicationKey: appKey.trim(), hmacKey: hmac?.trim() || undefined, lang: rec.myscriptLang, lexicon: rec.lexicon }, this.deps.http);
      const out = await withTimeout(call, timeoutMs, signal);
      const all = now() - t0;
      // body + HMAC on the device vs the network request (upload, server, download)
      stages.push({ name: 'prepare', ms: Math.max(0, all - out.netMs) });
      stages.push({ name: 'request', ms: out.netMs });
      return { result: out.result, engine: 'myscript', model: info.model, stages, bytes: out.bytes, usage: {}, cached: false };
    }
    const ai = this.deps.ai as AIService;
    if (!input.image) throw new AIError('not-configured', 'no picture of the selection');
    onStage?.('request');
    const t0 = now();
    const res = await ai.request(
      AI_TASK[task],
      input.image,
      { system: recSystemPrompt(input.language, rec.lexicon), user: recTaskPrompt(task, { lines: input.lineCount }) },
      { selectionId: input.selectionId, language: input.language, recTask: task, lineCount: input.lineCount, json: true },
      signal,
    );
    stages.push({ name: 'request', ms: now() - t0 });
    onStage?.('parse');
    const t1 = now();
    let result: RecResult;
    try {
      result = validateRecognition(task, res.text);
    } catch (e) {
      if (e instanceof RecError) throw new AIError(e.code === 'empty' ? 'empty' : e.code === 'invalid-json' ? 'bad-response' : 'invalid-scene', e.message);
      throw e;
    }
    stages.push({ name: 'parse', ms: now() - t1 });
    return { result, engine: info.engine, model: res.model, stages, bytes: Math.round((input.image.base64.length * 3) / 4), usage: res.usage, cached: false };
  }
}
