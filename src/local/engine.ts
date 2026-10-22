import { WORKER_SRC } from './worker-src.generated';
import type { ModelStore } from './store';
import type { MathInput, LineInput } from './render';
import type { MathCandidate, TextChar } from './worker/program';
import { MATH_EDITION } from '@edition/math';
import { LOCAL_MATH, PACKS } from './manifest';

/**
 * Runs the local recognition program off the main thread so Apple Pencil drawing is never blocked:
 *
 *  1. Web Worker (module worker from a blob URL) — ONNX Runtime Web is imported from the
 *     downloaded runtime pack (blob URL), its WASM is handed over as bytes (no fetch, no path).
 *  2. If workers cannot be created here, the same program runs in the page behind a
 *     MessagePort ("page" mode, reported in the self-test): it still never blocks for more than
 *     one model call at a time, but a long call can delay a stroke — the UI says so.
 *
 * Memory: models stay loaded while used; after `idleMs` without a request the worker is
 * terminated and everything is freed (next use reloads from IndexedDB, measured).
 */

export type RunMode = 'worker' | 'page';

export interface EngineTimings {
  runtimeMs?: number;
  mathLoadMs?: number;
  textLoadMs?: number;
  textEnLoadMs?: number;
  mode?: RunMode;
}

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
}

export class LocalEngine {
  private port: { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null } | null = null;
  private worker: Worker | null = null;
  private cleanup: (() => void)[] = [];
  private seq = 1;
  private pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  private loaded: Record<string, boolean> = {};
  private loading: Record<string, Promise<void> | undefined> = {};
  private idleTimer = 0;
  readonly timings: EngineTimings = {};

  constructor(
    private readonly store: ModelStore,
    private readonly opts: { idleMs?: number; preferPage?: boolean } = {},
  ) {}

  get mode(): RunMode | undefined {
    return this.timings.mode;
  }

  private call(type: string, body: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<Record<string, unknown>> {
    const port = this.port;
    if (!port) return Promise.reject(new Error('local engine not started'));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      port.postMessage({ id, type, ...body }, transfer);
    });
  }

  private onMessage = (e: MessageEvent) => {
    const m = e.data as { id: number; ok: boolean; error?: string };
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(new Error(m.error ?? 'local recognition failed'));
  };

  private async spawn(ortSrc: ArrayBuffer): Promise<void> {
    const ortUrl = URL.createObjectURL(new Blob([ortSrc], { type: 'text/javascript' }));
    this.cleanup.push(() => URL.revokeObjectURL(ortUrl));
    const program = `${WORKER_SRC}\n`;
    const ready = (port: { onmessage: ((e: MessageEvent) => void) | null }) =>
      new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error('local engine did not start (timeout)')), 20000);
        port.onmessage = (e: MessageEvent) => {
          if ((e.data as { ready?: boolean })?.ready) {
            window.clearTimeout(t);
            port.onmessage = this.onMessage;
            resolve();
          } else if ((e.data as { error?: string })?.error) {
            window.clearTimeout(t);
            reject(new Error((e.data as { error: string }).error));
          }
        };
      });
    if (!this.opts.preferPage && typeof Worker !== 'undefined') {
      try {
        const src = `import * as ort from ${JSON.stringify(ortUrl)};\n${program}\ntry { self.__hnLocalStart(ort, self); } catch (e) { self.postMessage({ id: 0, ok: false, error: String(e && e.message || e) }); }\n`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.cleanup.push(() => URL.revokeObjectURL(url));
        const w = new Worker(url, { type: 'module', name: 'handnote-local' });
        const errored = new Promise<never>((_, reject) => {
          w.onerror = (ev) => reject(new Error(`worker error: ${(ev).message || 'could not load'}`));
        });
        this.worker = w;
        this.port = w;
        await Promise.race([ready(w as unknown as { onmessage: ((e: MessageEvent) => void) | null }), errored]);
        w.onerror = null;
        this.timings.mode = 'worker';
        return;
      } catch (e) {
        this.worker?.terminate();
        this.worker = null;
        this.port = null;
        console.warn('[HandNote] local recognition worker unavailable, using the page', e);
      }
    }
    // page mode: same program behind a MessageChannel, loaded as a module script
    const ch = new MessageChannel();
    const key = `__hnLocalPort${Math.random().toString(36).slice(2)}`;
    (window as unknown as Record<string, unknown>)[key] = ch.port2;
    const src = `import * as ort from ${JSON.stringify(ortUrl)};\n${program}\nconst p = window[${JSON.stringify(key)}]; delete window[${JSON.stringify(key)}]; p.start(); self.__hnLocalStart(ort, p);\n`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const s = document.createElement('script');
    s.type = 'module';
    s.src = url;
    this.port = ch.port1;
    ch.port1.start();
    const p = ready(ch.port1);
    document.head.appendChild(s);
    this.cleanup.push(() => {
      s.remove();
      URL.revokeObjectURL(url);
      ch.port1.close();
    });
    await p;
    this.timings.mode = 'page';
  }

  /** Start the runtime (worker + ONNX Runtime WASM). */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = (async () => {
        const t0 = performance.now();
        const [ortSrc, wasm] = await Promise.all([this.store.file('runtime', 'ort.wasm.bundle.min.mjs'), this.store.file('runtime', 'ort-wasm-simd-threaded.wasm')]);
        await this.spawn(ortSrc);
        const copy = wasm.slice(0);
        await this.call('init', { wasm: copy }, [copy]);
        this.timings.runtimeMs = performance.now() - t0;
      })();
      this.starting.catch(() => this.stop());
    }
    return this.starting;
  }

  async ensure(model: 'math' | 'text' | 'text-en'): Promise<void> {
    // public edition: no math model and no math message (nothing is started for it)
    if (model === 'math' && (!LOCAL_MATH || !MATH_EDITION)) throw new Error('local math recognition is not included in this edition');
    this.touch();
    await this.start();
    if (this.loaded[model]) return;
    if (!this.loading[model]) {
      this.loading[model] = (async () => {
        const t0 = performance.now();
        if (model === 'math') {
          if (!MATH_EDITION) throw new Error('local math recognition is not included in this edition');
          const files: Record<string, ArrayBuffer> = {};
          for (const f of PACKS.math.files) files[f.name] = (await this.store.file('math', f.name)).slice(0);
          await this.call(MATH_EDITION.loadMessage, { files }, Object.values(files));
          this.timings.mathLoadMs = performance.now() - t0;
        } else {
          const en = model === 'text-en';
          const pack = en ? 'text-en' : 'text-zh';
          const onnx = (await this.store.file(pack, en ? 'en_inference.onnx' : 'inference.onnx')).slice(0);
          const dict = (await this.store.file(pack, en ? 'ppocrv5_en_dict.txt' : 'ppocrv5_dict.txt')).slice(0);
          await this.call('load-text', { model: en ? 'en' : 'zh', onnx, dict }, [onnx, dict]);
          if (en) this.timings.textEnLoadMs = performance.now() - t0;
          else this.timings.textLoadMs = performance.now() - t0;
        }
        this.loaded[model] = true;
      })();
      this.loading[model].catch(() => {
        delete this.loading[model];
      });
    }
    await this.loading[model];
  }

  async math(input: MathInput, beam = 3): Promise<{ candidates: MathCandidate[]; encMs: number; decMs: number; ms: number }> {
    await this.ensure('math');
    this.touch();
    const r = await this.call('math', { tensor: input.tensor, h: input.h, w: input.w, mask: input.mask, beam }, [input.tensor.buffer, input.mask.buffer]);
    this.touch();
    return r as unknown as { candidates: MathCandidate[]; encMs: number; decMs: number; ms: number };
  }

  async text(lines: LineInput[], model: 'zh' | 'en' = 'zh'): Promise<{ lines: { chars: TextChar[] }[]; ms: number }> {
    await this.ensure(model === 'en' ? 'text-en' : 'text');
    this.touch();
    const r = await this.call(
      'text',
      { model, lines: lines.map((l) => ({ tensor: l.tensor, w: l.w })) },
      lines.map((l) => l.tensor.buffer),
    );
    this.touch();
    return r as unknown as { lines: { chars: TextChar[] }[]; ms: number };
  }

  private touch(): void {
    window.clearTimeout(this.idleTimer);
    const ms = this.opts.idleMs ?? 180000;
    if (ms > 0) this.idleTimer = window.setTimeout(() => this.stop(), ms);
  }

  /** Free everything (models, runtime, worker). The next request starts again. */
  stop(): void {
    window.clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = null;
    this.port = null;
    for (const c of this.cleanup.splice(0)) c();
    for (const p of this.pending.values()) p.reject(new Error('local engine stopped'));
    this.pending.clear();
    this.starting = null;
    this.loaded = {};
    this.loading = {};
  }

  get running(): boolean {
    return !!this.port;
  }
}
