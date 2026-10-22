import { AIError } from '../ai/types';
import { segmentLines, type StrokeBox } from '../recognition/ink-analysis';
import type { InkStrokeIn, MathResult, TextLineResult, TextResult } from '../recognition/types';
import { installPack, probeMirrors, resetMirrorProbes, type FetchBinary, type InstallProgress, type MirrorStatus, type ProbeUrl } from './download';
import { LocalEngine, type EngineTimings } from './engine';
import type { TextChar } from './worker/program';
import { compactLatex, isWellFormed, repairTokens } from './latex';
import { MATH_EDITION } from '@edition/math';
import { LOCAL_MATH, PACKS, packBytes, packPinned, type PackId } from './manifest';
import { renderLine, renderMath, TEXT_RENDER, type Pt } from './render';

/** Glyph height (of 48 px) and stroke width of the line renderings compared per line. */
export const TEXT_VARIANTS = [
  { contentH: 30, line: 3.0 },
  { contentH: 36, line: 3.4 },
  { contentH: 42, line: 3.8 },
];
import { BundledRuntimeModels, embeddedRuntimeBuilt, embeddedRuntimeProblem } from './embedded-runtime';
import { IdbStore, ModelStore, sha256Hex, StorageBlockedError, type PackState, type StoreLike } from './store';
import { HandFonts } from './fonts';
import { toError } from '../utils/errors';

/**
 * Local (on-device) recognition: the models run in this device's WebView via ONNX Runtime Web
 * (WASM, CPU, one thread, in a Web Worker). Nothing leaves the device and no key is needed; the
 * optional model packs are downloaded once (sizes shown first) and kept in IndexedDB.
 *
 *  LocalMathRecognizer        — math model, private edition only (image of the re-rendered strokes) → LaTeX + candidates
 *  LocalHandwritingRecognizer — PP-OCRv5 mobile rec, line by line (lines from the stroke
 *                               analysis, each re-rendered at 48 px) → text + per-character
 *                               candidates. Image OCR, not online ink recognition.
 */

export interface LocalResult<R> {
  result: R;
  /** high enough to replace the ink in place; otherwise the UI previews with candidates */
  confident: boolean;
  ms: { render: number; infer: number; total: number };
  mode: string;
}

const toPts = (s: InkStrokeIn): Pt[] => s.xs.map((x, i) => [x, s.ys[i]] as Pt);

export const CONFIDENCE = { mathScore: -0.25, textMinP: 0.45, textMeanP: 0.75 };

export class LocalRecognition {
  readonly models: ModelStore;
  readonly engine: LocalEngine;
  /** Excalidraw hand-drawn fonts (optional pack) for converted text. */
  readonly fonts: HandFonts;
  private states = new Map<PackId, PackState>();
  private listeners = new Set<() => void>();
  /** the model database is held by an older plugin version (Obsidian must be restarted) */
  storageBlocked = false;

  constructor(
    private readonly fetchBinary: FetchBinary,
    store: StoreLike = new IdbStore(),
    engineOpts: { idleMs?: number; preferPage?: boolean } = {},
    private readonly probe?: ProbeUrl,
  ) {
    // ONNX Runtime Web is built into main.js: it is never downloaded (Obsidian's policy). The
    // downloadable runtime pack is only used by builds made with HN_EMBED_ORT=0.
    this.models = embeddedRuntimeBuilt() ? new BundledRuntimeModels(store) : new ModelStore(store);
    this.engine = new LocalEngine(this.models, engineOpts);
    this.fonts = new HandFonts(this.models);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Re-read which packs are installed (startup, after install / delete). */
  async refresh(verify = false): Promise<void> {
    this.storageBlocked = false;
    for (const id of Object.keys(PACKS) as PackId[]) {
      try {
        this.states.set(id, await this.models.state(id, verify));
      } catch (e) {
        if (e instanceof StorageBlockedError) this.storageBlocked = true;
        this.states.set(id, { id, installed: false, have: 0, total: PACKS[id].files.length, bytes: 0, damaged: [] });
      }
    }
    const fontsOn = !!this.states.get('font-hand')?.installed;
    if (fontsOn !== this.fonts.enabled) this.fonts.enable(fontsOn);
    for (const fn of this.listeners) fn();
  }

  state(id: PackId): PackState | undefined {
    return this.states.get(id);
  }

  /** Pack and its runtime installed (sync, from the last refresh). */
  ready(id: 'math' | 'text-zh' | 'text-en'): boolean {
    if (id === 'math' && !LOCAL_MATH) return false;
    return !!this.states.get(id)?.installed && !!this.states.get('runtime')?.installed;
  }

  /** The runtime ships inside the plugin (nothing to download or delete). */
  get runtimeBuiltIn(): boolean {
    return this.models instanceof BundledRuntimeModels;
  }

  /**
   * Why local recognition cannot run on this system (null = it can): the built-in runtime needs
   * DecompressionStream (iOS / iPadOS 16.4+).
   */
  unsupported(): string | null {
    return this.runtimeBuiltIn ? embeddedRuntimeProblem() : null;
  }

  available(id: PackId): boolean {
    // nothing to offer when the runtime cannot run here (no download of models that cannot be used)
    if (this.unsupported() && (id === 'runtime' || PACKS[id].needs.includes('runtime'))) return false;
    return packPinned(id) && PACKS[id].needs.every((n) => packPinned(n));
  }

  /** Bytes still to download for a pack (and the runtime). */
  missingBytes(id: PackId): number {
    let n = 0;
    for (const p of [...PACKS[id].needs, id]) if (!this.states.get(p)?.installed) n += packBytes(p, false);
    return n;
  }

  async install(id: PackId, onProgress?: (p: InstallProgress) => void, signal?: AbortSignal): Promise<void> {
    // public edition: there is no math pack to install (no files, no sources)
    if (id === 'math' && !LOCAL_MATH) throw new Error('local math recognition is not included in this edition');
    const problem = this.unsupported();
    if (problem && (id === 'runtime' || PACKS[id].needs.includes('runtime'))) throw new Error(`local recognition unavailable: ${problem}`);
    try {
      // a failed install probes again next time (the network may have changed)
      await installPack(id, this.models, this.fetchBinary, onProgress, signal, 4, this.probe).catch((e: unknown) => {
        resetMirrorProbes();
        throw e;
      });
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
    } finally {
      await this.refresh();
    }
  }

  /**
   * Import pack files the user already has (file picker — for networks where the mirrors are
   * blocked). Each file is matched by name and accepted only with the pinned SHA-256.
   * Returns the names accepted / rejected.
   */
  async importFiles(files: { name: string; data: ArrayBuffer }[]): Promise<{ accepted: string[]; rejected: string[] }> {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      let ok = false;
      // matched by content (size + SHA-256), so a file keeps working under any name
      const h = await sha256Hex(f.data);
      for (const id of Object.keys(PACKS) as PackId[]) {
        const pf = PACKS[id].files.find((x) => x.bytes === f.data.byteLength && x.sha256 === h);
        if (!pf) continue;
        await this.models.save(id, pf, f.data);
        ok = true;
      }
      (ok ? accepted : rejected).push(f.name);
    }
    await this.refresh();
    return { accepted, rejected };
  }

  /** Mirror reachability on this network (self-test). */
  async mirrors(): Promise<MirrorStatus[] | null> {
    if (!this.probe) return null;
    resetMirrorProbes();
    // the built-in runtime has no mirrors to probe
    return probeMirrors((Object.keys(PACKS) as PackId[]).filter((id) => !(id === 'runtime' && this.runtimeBuiltIn)), this.probe);
  }

  /** Plugin unload: stop the engine and release the database (lets a newer version upgrade it). */
  dispose(): void {
    this.engine.stop();
    this.models.store.close?.();
  }

  async remove(id: PackId): Promise<void> {
    this.engine.stop();
    await this.models.remove(id);
    await this.refresh();
  }

  /** Load runtime + model ahead of use (lasso / Convert menu); errors are ignored here. */
  warm(model: 'math' | 'text'): void {
    if (!this.ready(model === 'math' ? 'math' : 'text-zh')) return;
    void this.engine.ensure(model).catch(() => undefined);
  }

  timings(): EngineTimings {
    return this.engine.timings;
  }

  /** Local math recognition exists in this build (private edition only). */
  includesMath(): boolean {
    return LOCAL_MATH;
  }

  /** Name of the local math model (private edition), shown in the UI. */
  mathModel(): { model: string; label: string } | null {
    return LOCAL_MATH && MATH_EDITION ? { model: MATH_EDITION.model, label: MATH_EDITION.label } : null;
  }

  async math(ink: InkStrokeIn[], signal?: AbortSignal): Promise<LocalResult<MathResult>> {
    if (!LOCAL_MATH) throw new AIError('not-configured', 'local math recognition is not included in this edition');
    if (!this.ready('math')) throw new AIError('not-configured', 'local math model not installed');
    const t0 = performance.now();
    const input = renderMath(ink.filter((s) => s.xs.length).map(toPts));
    const t1 = performance.now();
    const r = await abortable(this.engine.math(input, 3), signal);
    const t2 = performance.now();
    const cands = r.candidates.map((c) => ({ tokens: repairTokens(c.tokens), score: c.score }));
    const ok = cands.filter((c) => isWellFormed(c.tokens));
    const pick = ok[0] ?? cands[0];
    if (!pick || !pick.tokens.length) throw new AIError('empty', 'no formula recognised');
    const latex = compactLatex(pick.tokens);
    const alternatives = [...new Set(cands.map((c) => compactLatex(c.tokens)).filter((l) => l && l !== latex))].slice(0, 4);
    const confident = !!ok[0] && ok[0] === cands[0] && pick.score >= CONFIDENCE.mathScore;
    const warnings = confident ? [] : ['i18n:localUncertain'];
    return { result: { task: 'math', latex, alternatives, warnings }, confident, ms: { render: t1 - t0, infer: t2 - t1, total: t2 - t0 }, mode: this.engine.mode ?? '' };
  }

  async text(ink: InkStrokeIn[], signal?: AbortSignal): Promise<LocalResult<TextResult>> {
    if (!this.ready('text-zh')) throw new AIError('not-configured', 'local text model not installed');
    const t0 = performance.now();
    const strokes = ink.filter((s) => s.xs.length);
    const boxes: StrokeBox[] = strokes.map((s) => ({ id: s.id, x0: Math.min(...s.xs), y0: Math.min(...s.ys), x1: Math.max(...s.xs), y1: Math.max(...s.ys) }));
    const lines = segmentLines(boxes);
    const byId = new Map(strokes.map((s) => [s.id, s]));
    // each line rendered at a few glyph sizes / stroke widths; the most confident reading wins
    // (synthetic tests: Chinese CER 0.46 % → 0.23 %, cursive English −5 to −10 points)
    const inputs = lines.flatMap((l) => {
      const pts = l.strokeIds.map((id) => toPts(byId.get(id) as InkStrokeIn));
      return TEXT_VARIANTS.map((v) => renderLine(pts, { ...TEXT_RENDER, ...v }));
    });
    const t1 = performance.now();
    const raw = await abortable(
      this.engine.text(inputs.map((x) => ({ tensor: x.tensor, w: x.w }))),
      signal,
    );
    const t2 = performance.now();
    const mean = (l: { chars: { c: string; p: number }[] }) => {
      const cs = l.chars.filter((c) => c.c.trim());
      return cs.length ? cs.reduce((a, c) => a + c.p, 0) / cs.length : 0;
    };
    const pick = (all: { chars: TextChar[] }[], i: number) => all.slice(i * TEXT_VARIANTS.length, (i + 1) * TEXT_VARIANTS.length).reduce((a, b) => (mean(b) > mean(a) ? b : a));
    const r = { lines: lines.map((_, i) => pick(raw.lines, i)) };
    // lines that read as Latin script go through the English model too (better on handwritten
    // English); the more confident reading wins
    if (this.ready('text-en')) {
      const latin = r.lines.map((l) => {
        const cs = l.chars.map((c) => c.c).join('').replace(/\s/g, '');
        return cs.length > 0 && cs.replace(/[^A-Za-z0-9.,;:'"!?()-]/g, '').length / cs.length >= 0.5;
      });
      const idx = latin.flatMap((v, i) => (v ? [i] : []));
      if (idx.length) {
        const again = idx.flatMap((i) => {
          const pts = lines[i].strokeIds.map((id) => toPts(byId.get(id) as InkStrokeIn));
          return TEXT_VARIANTS.map((v) => renderLine(pts, { ...TEXT_RENDER, ...v }));
        });
        const en = await abortable(this.engine.text(again.map((x) => ({ tensor: x.tensor, w: x.w })), 'en'), signal);
        idx.forEach((li, k) => {
          const best = pick(en.lines, k);
          if (mean(best) >= mean(r.lines[li])) r.lines[li] = best;
        });
      }
    }
    let minP = 1;
    let sumP = 0;
    let n = 0;
    const out: TextLineResult[] = [];
    for (const l of r.lines) {
      const chars = l.chars.filter((c) => c.c);
      for (const c of chars) {
        minP = Math.min(minP, c.p);
        sumP += c.p;
        n++;
      }
      const text = chars.map((c) => c.c).join('').trim();
      if (!text) continue;
      out.push({
        text,
        alternatives: [],
        tokens: chars.map((c) => ({ text: c.c, candidates: c.alts.filter(([a, p]) => a && a.trim() && a !== c.c && p >= 1e-6).map(([a]) => a).slice(0, 4) })),
      });
    }
    if (!out.length) throw new AIError('empty', 'no text recognised');
    const confident = minP >= CONFIDENCE.textMinP && sumP / Math.max(1, n) >= CONFIDENCE.textMeanP;
    return { result: { task: 'text', lines: out, warnings: confident ? [] : ['i18n:localUncertain'] }, confident, ms: { render: t1 - t0, infer: t2 - t1, total: t2 - t0 }, mode: this.engine.mode ?? '' };
  }
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AIError('cancelled', 'cancelled'));
  return new Promise<T>((resolve, reject) => {
    const on = () => reject(new AIError('cancelled', 'cancelled'));
    signal.addEventListener('abort', on, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', on);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', on);
        reject(toError(e));
      },
    );
  });
}

export { PACKS, packBytes, type PackId };
