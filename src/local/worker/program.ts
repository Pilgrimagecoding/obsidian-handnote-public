/**
 * Local recognition program. Runs inside a Web Worker (normal case) or, when workers are not
 * available, in the page behind a MessagePort. It receives ONNX Runtime Web as an argument
 * (built into main.js, decoded on first use) and only ever talks through `port`.
 *
 *  - math: only in the private edition (src/private/edition/math-worker.ts);
 *  - text: PP-OCRv5 mobile recognition (CTC) — one rendered line at a time; per-character
 *    alternatives from the CTC posteriors.
 *
 * No network access, no DOM, no eval of model output: results are plain strings/numbers.
 */

import type { MathCandidate } from '../../edition/types';
import { createMathEngine } from '@edition/math-worker';
import { sessionOptions, type Ort, type OrtSession } from './ort-types';

export type { MathCandidate };

/** A request from the engine (fields depend on `type`). */
interface Request {
  id: number;
  type: string;
  wasm: ArrayBuffer;
  files: Record<string, ArrayBuffer>;
  model?: string;
  onnx: ArrayBuffer;
  dict: ArrayBuffer;
  tensor: Float32Array;
  h: number;
  w: number;
  mask: Uint8Array;
  beam?: number;
  maxSteps?: number;
  sureScore?: number;
  lines: { tensor: Float32Array; w: number }[];
}

export interface Port {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

export interface TextChar {
  c: string;
  p: number;
  alts: [string, number][];
}

export function start(ort: Ort, port: Port): void {
  // math recognition is part of the private edition only (`@edition/math-worker`)
  const math = __HN_PRIVATE__ && createMathEngine ? createMathEngine(ort, () => performance.now()) : null;
  const texts = new Map<string, { rec: OrtSession; dict: string[] }>();
  let ready = false;

  const reply = (id: number, body: Record<string, unknown>) => port.postMessage({ id, ...body });
  const now = () => performance.now();

  async function init(wasm: ArrayBuffer): Promise<void> {
    // Hand the runtime its WASM as a blob URL (the bytes came from IndexedDB): ONNX Runtime would
    // otherwise resolve "ort-wasm-simd-threaded.wasm" against its own (blob:) module URL, which
    // is not a valid base. Nothing is fetched from the network.
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    ort.env.wasm.wasmPaths = { wasm: wasmUrl };
    ort.env.wasm.numThreads = 1; // no SharedArrayBuffer in Obsidian (not cross-origin isolated)
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    ready = true;
  }

  const opts = sessionOptions;

  /** A PP-OCR recognition model: `model` = key ('zh', 'en'), files = { onnx, dict }. */
  async function loadText(model: string, onnx: ArrayBuffer, dictBytes: ArrayBuffer) {
    const dict = new TextDecoder().decode(dictBytes).split(/\r?\n/);
    while (dict.length && dict[dict.length - 1] === '') dict.pop();
    const rec = await ort.InferenceSession.create(new Uint8Array(onnx), opts());
    // CTC classes: 0 = blank, 1..n = dictionary, n+1 = space
    texts.set(model, { rec, dict: ['', ...dict, ' '] });
  }

  async function recognizeLine(model: string, tensor: Float32Array, w: number) {
    const t = texts.get(model) as { rec: OrtSession; dict: string[] };
    const x = new ort.Tensor('float32', tensor, [1, 3, 48, w]);
    const r = await t.rec.run({ [t.rec.inputNames[0]]: x });
    const out = r[t.rec.outputNames[0]];
    const [, T, C] = out.dims as number[];
    const d = out.data as Float32Array;
    // the model's output is already softmax-ed (PaddleOCR rec head); normalise defensively
    const chars: TextChar[] = [];
    let prev = 0;
    for (let s = 0; s < T; s++) {
      const off = s * C;
      let best = 0;
      let bp = -Infinity;
      let sum = 0;
      for (let k = 0; k < C; k++) sum += d[off + k];
      for (let k = 0; k < C; k++) {
        if (d[off + k] > bp) {
          bp = d[off + k];
          best = k;
        }
      }
      if (best !== 0 && best !== prev) {
        const norm = sum > 0 ? sum : 1;
        const alts: [string, number][] = [];
        // top-5 non-blank alternatives at this time step
        const idx: number[] = [];
        for (let k = 1; k < C; k++) {
          if (k === best) continue;
          const v = d[off + k];
          if (idx.length < 5 || v > d[off + idx[idx.length - 1]]) {
            idx.push(k);
            idx.sort((a, b) => d[off + b] - d[off + a]);
            if (idx.length > 5) idx.pop();
          }
        }
        for (const k of idx) alts.push([t.dict[k] ?? '', d[off + k] / norm]);
        chars.push({ c: t.dict[best] ?? '', p: bp / norm, alts });
      }
      prev = best;
    }
    return { chars, T };
  }

  // one request at a time: ONNX Runtime sessions are not re-entrant
  let queue: Promise<unknown> = Promise.resolve();
  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as Request;
    const run = async () => {
      const t0 = now();
      // math requests exist only in the private edition (removed from the public build)
      if (__HN_PRIVATE__ && math) {
        if (msg.type === math.loadMessage) {
          if (!ready) throw new Error('runtime not initialised');
          await math.load(msg.files);
          return { ms: now() - t0 };
        }
        if (msg.type === 'math') {
          if (!math.loaded()) throw new Error('math model not loaded');
          return { ...(await math.recognize(msg.tensor, msg.h, msg.w, msg.mask, msg.beam ?? 3, msg.maxSteps ?? 60, msg.sureScore ?? -0.05)), ms: now() - t0 };
        }
      }
      switch (msg.type) {
        case 'init':
          await init(msg.wasm);
          return { ms: now() - t0, threads: 1 };
        case 'load-text':
          if (!ready) throw new Error('runtime not initialised');
          await loadText(msg.model ?? 'zh', msg.onnx, msg.dict);
          return { ms: now() - t0 };
        case 'text': {
          const model = msg.model ?? 'zh';
          if (!texts.has(model)) throw new Error(`text model ${model} not loaded`);
          const lines = [];
          for (const l of msg.lines) lines.push(await recognizeLine(model, l.tensor, l.w));
          return { lines, ms: now() - t0 };
        }
        case 'unload':
          await math?.release();
          for (const s of [...texts.values()].map((x) => x.rec)) if (s?.release) await s.release();
          texts.clear();
          return { ms: now() - t0 };
        case 'ping':
          return { ms: 0, loaded: { math: !!math?.loaded(), text: [...texts.keys()] } };
        default:
          throw new Error(`unknown message ${msg.type}`);
      }
    };
    queue = queue.then(run).then(
      (body) => reply(msg.id, { ok: true, ...body }),
      (err) => reply(msg.id, { ok: false, error: String((err as Error)?.message ?? err) }),
    );
  };
  port.postMessage({ id: 0, ok: true, ready: true });
}
