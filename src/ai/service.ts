import { extractJson, SceneError, validateScene, type EditableScene } from './scene';
import { systemPrompt, taskPrompt } from './prompts';
import { providerFor, redact } from './providers';
import { AIError, type AIImage, type AIRequest, type AITask, type AIUsage, type HttpFn, type ProviderId } from './types';
import { DEFAULT_BASE_URL, PROVIDER_TYPE_LABEL, isAllowedBaseUrl, type AIModelEntry, type AIProfile, type AISettings } from './config';
import { toError } from '../utils/errors';

export { defaultAISettings, sanitizeAISettings, isHttpsUrl } from './config';
export type { AISettings, AIUsageStats, AIProfile, AIModelEntry } from './config';

export interface AIServiceDeps {
  settings(): AISettings;
  /** Persist usage counters (data.json). */
  saveSettings(s: AISettings): void;
  /** API key from the host's secret storage (null when missing). */
  getSecret(name: string): string | null | Promise<string | null>;
  /** False when the host has no secret storage (Obsidian < 1.11.4): keyed providers are disabled. */
  secretsSupported: boolean;
  http: HttpFn;
  now?: () => number;
}

export interface AIStatus {
  ready: boolean;
  reason?: string;
  provider: ProviderId;
  mock: boolean;
}

export interface AIRunResult {
  scene: EditableScene;
  dropped: string[];
  usage: AIUsage;
  provider: ProviderId;
  model: string;
  ms: number;
}

function today(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Routes a task to the configured provider and model, enforces the request limits, timeout,
 * bounded retries and cancellation, and validates the answer into an EditableScene.
 */
export class AIService {
  constructor(private readonly deps: AIServiceDeps) {}

  /** Model entry and provider profile used for a task (task choice → default model). */
  resolve(task: AITask = 'handwriting'): { entry: AIModelEntry; profile: AIProfile } | null {
    const s = this.deps.settings();
    const id = s.taskModels[task] || s.defaultModel;
    const entry = s.modelEntries.find((m) => m.id === id) ?? s.modelEntries.find((m) => m.id === s.defaultModel);
    if (!entry) return null;
    const profile = s.profiles.find((p) => p.id === entry.profileId);
    return profile ? { entry, profile } : null;
  }

  model(task: AITask): string {
    return this.resolve(task)?.entry.model ?? '';
  }

  /** "OpenAI · gpt-5.4-mini" for the upload dialog. */
  label(task: AITask = 'handwriting'): string {
    const r = this.resolve(task);
    return r ? `${r.profile.name} · ${PROVIDER_TYPE_LABEL[r.profile.type] ?? r.profile.type}` : '—';
  }

  baseUrlFor(entry: AIModelEntry, profile: AIProfile): string {
    return entry.endpoint || profile.baseUrl || DEFAULT_BASE_URL[profile.type] || '';
  }

  baseUrl(task: AITask = 'handwriting'): string {
    const r = this.resolve(task);
    return r ? this.baseUrlFor(r.entry, r.profile) : '';
  }

  /** Whether a profile can be used: key chosen (or no key needed). */
  profileReady(profile: AIProfile): { ready: boolean; reason?: string } {
    if (profile.type === 'mock') return { ready: true };
    if (profile.type === 'hosted') return { ready: false, reason: 'hosted-unavailable' };
    if (!this.deps.secretsSupported) return { ready: false, reason: 'secret-storage-unsupported' };
    if (!profile.secretName) return { ready: false, reason: 'no-key' };
    if (profile.type === 'openai-compatible' && !profile.baseUrl) return { ready: false, reason: 'no-endpoint' };
    return { ready: true };
  }

  status(task: AITask = 'handwriting'): AIStatus {
    const s = this.deps.settings();
    const r = this.resolve(task);
    const base = { provider: (r?.profile.type ?? 'mock'), mock: r?.profile.type === 'mock' };
    if (!s.enabled) return { ...base, ready: false, reason: 'disabled' };
    if (!r) return { ...base, ready: false, reason: 'no-model' };
    if (!r.entry.multimodal) return { ...base, ready: false, reason: 'model-not-multimodal' };
    const pr = this.profileReady(r.profile);
    return { ...base, ...pr };
  }

  private async key(profile: AIProfile): Promise<string> {
    if (profile.type === 'mock') return 'mock';
    if (!this.deps.secretsSupported) throw new AIError('unsupported-version', 'secret storage requires Obsidian 1.11.4 or newer');
    const name = profile.secretName;
    if (!name) throw new AIError('not-configured', 'no API key selected');
    const v = await this.deps.getSecret(name);
    if (!v) throw new AIError('not-configured', `secret "${name}" is empty or missing on this device`);
    return v.trim();
  }

  private bumpUsage(entryName: string, u: AIUsage, failed: boolean): void {
    const s = this.deps.settings();
    const now = (this.deps.now ?? Date.now)();
    const day = today(now);
    const us = { ...s.usage };
    if (us.day !== day) Object.assign(us, { day, requests: 0, inputTokens: 0, outputTokens: 0 });
    us.requests++;
    us.totalRequests++;
    if (failed) us.failures++;
    us.inputTokens += u.inputTokens ?? 0;
    us.outputTokens += u.outputTokens ?? 0;
    us.totalInputTokens += u.inputTokens ?? 0;
    us.totalOutputTokens += u.outputTokens ?? 0;
    const per = { ...s.usageByModel };
    const m = { ...(per[entryName] ?? { requests: 0, inputTokens: 0, outputTokens: 0, failures: 0 }) };
    m.requests++;
    if (failed) m.failures++;
    m.inputTokens += u.inputTokens ?? 0;
    m.outputTokens += u.outputTokens ?? 0;
    per[entryName] = m;
    this.deps.saveSettings({ ...s, usage: us, usageByModel: per });
  }

  private checkLimit(): void {
    const s = this.deps.settings();
    if (!s.dailyLimit) return;
    const day = today((this.deps.now ?? Date.now)());
    if (s.usage.day === day && s.usage.requests >= s.dailyLimit) throw new AIError('limit', `daily request limit reached (${s.dailyLimit})`);
  }

  private log(msg: string, data?: Record<string, unknown>): void {
    // diagnostics only: never keys, images, prompts or recognised text
    if (this.deps.settings().verboseLog) console.debug(`HandNote AI: ${msg}`, data ?? '');
  }

  /** Run one recognition task on an image of the user's selection. */
  async run(task: AITask, image: AIImage, meta: { selectionId: string; bounds: { x: number; y: number; w: number; h: number }; language: 'zh' | 'en' }, signal?: AbortSignal): Promise<AIRunResult> {
    const st = this.status(task);
    if (!st.ready) throw new AIError('not-configured', st.reason ?? 'not configured');
    this.checkLimit();
    const s = this.deps.settings();
    const r = this.resolve(task) as { entry: AIModelEntry; profile: AIProfile };
    const { entry, profile } = r;
    const provider = providerFor(profile.type);
    const model = entry.model;
    const baseUrl = this.baseUrlFor(entry, profile);
    if (profile.type !== 'mock' && !isAllowedBaseUrl(baseUrl, profile.type)) throw new AIError('not-configured', 'endpoint must be an https:// URL');
    const apiKey = await this.key(profile);
    const req = { task, image, selectionId: meta.selectionId, language: meta.language };
    const t0 = (this.deps.now ?? Date.now)();
    this.log('request', { task, type: profile.type, model, host: hostOf(baseUrl), imageBytes: Math.round((image.base64.length * 3) / 4), w: image.width, h: image.height });
    const attempt = () =>
      withTimeout(
        provider.complete(req, systemPrompt(meta.language), taskPrompt(task), { apiKey, model, baseUrl, http: this.deps.http, maxOutputTokens: s.maxOutputTokens }),
        s.timeoutSec * 1000,
        signal,
      );
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new AIError('cancelled', 'cancelled');
      let res;
      try {
        res = await attempt();
      } catch (e) {
        const err = e instanceof AIError ? e : new AIError('network', redact(String((e as Error)?.message ?? e)));
        this.log('failed', { code: err.code, status: err.status, attempt: i + 1 });
        if (err.code === 'cancelled') throw err;
        this.bumpUsage(entry.name, {}, true);
        if (err.code === 'timeout' || !err.retryable || i >= s.maxRetries) throw err;
        await sleep(1500 * (i + 1), signal);
        continue;
      }
      this.bumpUsage(entry.name, res.usage, false);
      this.log('answer', { ms: (this.deps.now ?? Date.now)() - t0, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, chars: res.text.length });
      let parsed: unknown;
      try {
        parsed = extractJson(res.text);
      } catch (e) {
        throw new AIError('bad-response', (e as Error).message);
      }
      try {
        const v = validateScene(parsed, { selectionId: meta.selectionId, bounds: meta.bounds });
        return { scene: v.scene, dropped: v.dropped, usage: res.usage, provider: profile.type, model: res.model || model, ms: (this.deps.now ?? Date.now)() - t0 };
      } catch (e) {
        throw new AIError('invalid-scene', e instanceof SceneError ? e.message : 'invalid scene');
      }
    }
  }

  /**
   * One recognition request with caller-built prompts (0.5 convert flow). Returns the raw model
   * text plus timings; the caller validates it. Bounded: one attempt, plus at most
   * `maxRetries` automatic repeats only for errors the provider rejected before doing the work
   * (rate limit, 502/503/504) — anything that may have been billed (timeout, empty or cut-off
   * answer) is reported to the user, who decides whether to try again.
   */
  async request(
    task: AITask,
    image: AIImage,
    prompts: { system: string; user: string },
    meta: { selectionId: string; language: 'zh' | 'en'; recTask?: AIRequest['recTask']; lineCount?: number; json?: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: AIUsage; model: string; provider: ProviderId; requestMs: number; attempts: number }> {
    const st = this.status(task);
    if (!st.ready) throw new AIError('not-configured', st.reason ?? 'not configured');
    this.checkLimit();
    const s = this.deps.settings();
    const { entry, profile } = this.resolve(task) as { entry: AIModelEntry; profile: AIProfile };
    const provider = providerFor(profile.type);
    const baseUrl = this.baseUrlFor(entry, profile);
    if (profile.type !== 'mock' && !isAllowedBaseUrl(baseUrl, profile.type)) throw new AIError('not-configured', 'endpoint must be an https:// URL');
    const apiKey = await this.key(profile);
    const req: AIRequest = { task, image, selectionId: meta.selectionId, language: meta.language, recTask: meta.recTask, lineCount: meta.lineCount };
    this.log('request', { task: meta.recTask ?? task, type: profile.type, model: entry.model, host: hostOf(baseUrl), imageBytes: Math.round((image.base64.length * 3) / 4), w: image.width, h: image.height });
    const now = () => (this.deps.now ?? Date.now)();
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new AIError('cancelled', 'cancelled');
      const t0 = now();
      try {
        const res = await withTimeout(
          provider.complete(req, prompts.system, prompts.user, { apiKey, model: entry.model, baseUrl, http: this.deps.http, maxOutputTokens: s.maxOutputTokens, json: meta.json }),
          s.timeoutSec * 1000,
          signal,
        );
        const requestMs = now() - t0;
        this.bumpUsage(entry.name, res.usage, false);
        this.log('answer', { ms: requestMs, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, chars: res.text.length, attempt: i + 1 });
        return { text: res.text, usage: res.usage, model: res.model || entry.model, provider: profile.type, requestMs, attempts: i + 1 };
      } catch (e) {
        const err = e instanceof AIError ? e : new AIError('network', redact(String((e as Error)?.message ?? e)));
        this.log('failed', { code: err.code, status: err.status, attempt: i + 1, ms: now() - t0 });
        if (err.code === 'cancelled') throw err;
        this.bumpUsage(entry.name, {}, true);
        if (!err.retryable || i >= s.maxRetries) throw err;
        await sleep(1500 * (i + 1), signal);
      }
    }
  }

  /**
   * Test a profile (and a model of it) with a tiny text request — no note content. Counts as one
   * request at the provider. Without arguments: the default model.
   */
  async test(profileId?: string, modelId?: string): Promise<{ ms: number; model: string }> {
    const s = this.deps.settings();
    let entry: AIModelEntry | undefined;
    let profile: AIProfile | undefined;
    if (profileId) {
      profile = s.profiles.find((p) => p.id === profileId);
      entry = s.modelEntries.find((m) => m.profileId === profileId && (!modelId || m.id === modelId)) ?? s.modelEntries.find((m) => m.profileId === profileId);
    } else {
      const r = this.resolve('handwriting');
      entry = r?.entry;
      profile = r?.profile;
    }
    if (!profile) throw new AIError('not-configured', 'no provider');
    if (!entry) throw new AIError('not-configured', 'add a model for this provider first');
    return this.testWith(profile, entry);
  }

  /** Test a (possibly unsaved) profile + model, e.g. from the edit dialog. */
  async testWith(profile: AIProfile, entry: Pick<AIModelEntry, 'model' | 'endpoint'>): Promise<{ ms: number; model: string }> {
    const s = this.deps.settings();
    const pr = this.profileReady(profile);
    if (!pr.ready && pr.reason !== 'no-key') throw new AIError('not-configured', pr.reason ?? 'not configured');
    const baseUrl = entry.endpoint || profile.baseUrl || DEFAULT_BASE_URL[profile.type] || '';
    if (profile.type !== 'mock' && !isAllowedBaseUrl(baseUrl, profile.type)) throw new AIError('not-configured', 'endpoint must be an https:// URL');
    const apiKey = await this.key(profile);
    const t0 = Date.now();
    await withTimeout(providerFor(profile.type).testConnection({ apiKey, model: entry.model, baseUrl, http: this.deps.http }), Math.min(30, s.timeoutSec) * 1000);
    return { ms: Date.now() - t0, model: entry.model };
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '?';
  }
}

/** Obsidian's requestUrl cannot be aborted: cancellation and timeouts stop waiting and ignore the late answer. */
export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new AIError('timeout', `no answer within ${Math.round(ms / 1000)} s`))), ms);
    const onAbort = () => finish(() => reject(new AIError('cancelled', 'cancelled')));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(toError(e))),
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return withTimeout(new Promise<void>((r) => setTimeout(r, ms)), ms + 1000, signal).catch((e) => {
    if (e instanceof AIError && e.code === 'cancelled') throw e;
  });
}
