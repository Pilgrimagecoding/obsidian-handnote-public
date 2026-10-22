import { embeddedTimings } from './embedded-runtime';
import type { InkStrokeIn } from '../recognition/types';
import type { LocalRecognition } from './index';
import { compactLatex } from './latex';
import { MATH_CASES, mathInk } from './synthetic-math';

/**
 * Local recognition self-test (Settings → Local recognition → Run self-test). Answers, on THIS
 * device, the questions that decide whether on-device recognition works here:
 *  WebAssembly + SIMD, Web Worker (module, blob URL), IndexedDB read/write, storage quota /
 *  persistence, ONNX Runtime start, model load (cold = from IndexedDB), recognition time
 *  (warm), main-thread frame gaps while recognising (Pencil smoothness proxy), memory if the
 *  platform reports it. Accuracy here is on SYNTHETIC ink (labelled so); nothing is uploaded and
 *  nothing is written to the vault.
 */

export interface SelfTestLine {
  key: string;
  ok: boolean | null;
  value: string;
}

const SIMD_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

function ms(v: number | undefined): string {
  return v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

async function moduleWorkerOk(): Promise<string> {
  if (typeof Worker === 'undefined') return 'no Worker';
  const url = URL.createObjectURL(new Blob(['self.postMessage(typeof WebAssembly === "object" ? "wasm" : "nowasm");'], { type: 'text/javascript' }));
  try {
    return await new Promise<string>((resolve) => {
      const w = new Worker(url, { type: 'module' });
      const t = window.setTimeout(() => {
        w.terminate();
        resolve('timeout');
      }, 5000);
      w.onmessage = (e) => {
        window.clearTimeout(t);
        w.terminate();
        resolve(`ok (${e.data})`);
      };
      w.onerror = (e) => {
        window.clearTimeout(t);
        w.terminate();
        resolve(`error: ${(e).message || 'blocked'}`);
      };
    });
  } catch (e) {
    return `error: ${(e as Error).message}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function idbRoundTrip(): Promise<string> {
  const name = 'handnote-selftest';
  const data = new Uint8Array(4 * 1024 * 1024).map((_, i) => i & 255);
  const t0 = performance.now();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('t');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
  });
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      const q = f(db.transaction('t', mode).objectStore('t'));
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error ?? new Error('IndexedDB request failed'));
    });
  await run('readwrite', (s) => s.put(data.buffer, 'x'));
  const t1 = performance.now();
  const back = (await run('readonly', (s) => s.get('x'))) as ArrayBuffer;
  const t2 = performance.now();
  db.close();
  indexedDB.deleteDatabase(name);
  const same = back && back.byteLength === data.byteLength && new Uint8Array(back)[12345] === data[12345];
  return `${same ? 'ok' : 'MISMATCH'} · write 4 MB ${ms(t1 - t0)} · read ${ms(t2 - t1)}`;
}

/** What the model database holds (files vs index), to tell "never stored" from "not indexed". */
async function modelInventory(): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('handnote-models');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
  });
  try {
    const count = (store: string) =>
      new Promise<number>((resolve) => {
        if (!db.objectStoreNames.contains(store)) return resolve(-1);
        const q = db.transaction(store, 'readonly').objectStore(store).count();
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => resolve(-1);
      });
    return `db v${db.version} · files ${await count('files')} · index ${await count('meta')}`;
  } finally {
    db.close();
  }
}

/** Longest gap between animation frames while `work` runs (main-thread smoothness proxy). */
async function frameGaps<T>(work: () => Promise<T>): Promise<{ value: T; maxGap: number; frames: number }> {
  let last = performance.now();
  let maxGap = 0;
  let frames = 0;
  let on = true;
  const tick = () => {
    const n = performance.now();
    maxGap = Math.max(maxGap, n - last);
    last = n;
    frames++;
    if (on) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  try {
    const value = await work();
    return { value, maxGap, frames };
  } finally {
    on = false;
  }
}

const toIn = (strokes: [number, number][][]): InkStrokeIn[] => strokes.map((s, i) => ({ id: `s${i}`, xs: s.map((p) => p[0]), ys: s.map((p) => p[1]), ts: s.map((_, k) => i * 400 + k * 8), ps: s.map(() => 0.5) }));

export async function runSelfTest(local: LocalRecognition, onLine: (l: SelfTestLine) => void): Promise<SelfTestLine[]> {
  const out: SelfTestLine[] = [];
  const add = (key: string, ok: boolean | null, value: string) => {
    const l = { key, ok, value };
    out.push(l);
    onLine(l);
  };
  const nav = navigator as Navigator & { deviceMemory?: number };
  // which build this is (public: no local math model; private: maintainer's builds with it)
  add('Edition', null, local.includesMath() ? 'private (with the local math model)' : 'public');
  add('device', null, `${nav.userAgent} · cores ${nav.hardwareConcurrency ?? '?'} · deviceMemory ${nav.deviceMemory ?? 'not reported'}`);
  const wasm = typeof WebAssembly === 'object';
  add('WebAssembly', wasm, wasm ? 'available' : 'NOT available');
  let simd = false;
  try {
    simd = wasm && WebAssembly.validate(SIMD_WASM);
  } catch {
    simd = false;
  }
  add('WASM SIMD', simd, simd ? 'available' : 'NOT available (ONNX Runtime 1.24 needs SIMD)');
  add('SharedArrayBuffer / threads', null, typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated ? 'available' : 'not available → single thread (expected in Obsidian)');
  const mw = await moduleWorkerOk();
  add('Module worker (blob URL)', mw.startsWith('ok'), mw);
  try {
    add('IndexedDB', true, await idbRoundTrip());
  } catch (e) {
    add('IndexedDB', false, `error: ${(e as Error).message}`);
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    add('Storage', null, est ? `used ${(((est.usage ?? 0) / 1048576) | 0)} MB of ${(((est.quota ?? 0) / 1048576) | 0)} MB · persisted ${persisted ?? 'unknown'}` : 'estimate not available');
  } catch {
    add('Storage', null, 'estimate not available');
  }
  try {
    add('Model storage', null, await modelInventory());
  } catch (e) {
    add('Model storage', false, `error: ${(e as Error).message}`);
  }
  await local.refresh(true);
  if (local.storageBlocked) add('Model storage', false, 'BLOCKED by an older plugin version still loaded — quit Obsidian completely and reopen');
  try {
    const m = await local.mirrors();
    if (m) add('Download mirrors (this network)', m.some((x) => x.ok), m.map((x) => (x.ok ? `${x.host} ${ms(x.ms)}` : `${x.host} ✘ ${x.error ?? ''}`.trim())).join(' · '));
  } catch (e) {
    add('Download mirrors (this network)', false, `error: ${(e as Error).message}`);
  }
  const rt = local.state('runtime');
  const mp = local.state('math');
  const tp = local.state('text-zh');
  const en = local.state('text-en');
  const fh = local.state('font-hand');
  const yn = (s: typeof rt) => (s?.installed ? 'yes' : s?.have ? `${s.have}/${s.total}` : 'no');
  add('Runtime source', local.unsupported() ? false : null, local.runtimeBuiltIn ? (local.unsupported() ? `built into the plugin, but unusable here: ${local.unsupported()} — local recognition is off; MyScript still works` : 'built into the plugin (no download)') : 'downloadable pack (build made with HN_EMBED_ORT=0)');
  add('Installed packs', null, `runtime ${yn(rt)} · math ${local.includesMath() ? yn(mp) : 'not in this edition'} · text ${yn(tp)} · english ${yn(en)} · font ${yn(fh)}${[rt, mp, tp, en, fh].some((s) => s?.damaged.length) ? ' · DAMAGED files removed' : ''}`);
  if (!rt?.installed) {
    add('Runtime', null, local.unsupported() ? 'unavailable on this system' : 'not installed — install a local model first, then run the self-test again');
    return out;
  }
  local.engine.stop();
  try {
    const t0 = performance.now();
    await local.engine.start();
    add('ONNX Runtime start', true, `${ms(performance.now() - t0)} · mode ${local.engine.mode}`);
  } catch (e) {
    add('ONNX Runtime start', false, `error: ${(e as Error).message}`);
    return out;
  }
  const mem = () => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return m ? `${(m.usedJSHeapSize / 1048576).toFixed(0)} MB JS heap (page)` : 'not reported by this platform';
  };
  if (mp?.installed && local.includesMath()) {
    try {
      const t0 = performance.now();
      await local.engine.ensure('math');
      add('Math model load (cold, from IndexedDB)', true, ms(performance.now() - t0));
      let ok = 0;
      const times: number[] = [];
      let gap = 0;
      const fails: string[] = [];
      const cases = MATH_CASES.slice(0, 8);
      for (const [i, c] of cases.entries()) {
        const ink = toIn(mathInk(c.node, { seed: 10 + i, jitter: 1, size: 28 }));
        const r = await frameGaps(() => local.math(ink));
        gap = Math.max(gap, r.maxGap);
        times.push(r.value.ms.total);
        const want = compactLatex(c.latex.split(' '));
        if (r.value.result.latex === want) ok++;
        else fails.push(`${want} → ${r.value.result.latex}`);
      }
      const sorted = [...times].sort((a, b) => a - b);
      add('Math recognition (warm, synthetic ink)', ok >= cases.length / 2, `${ok}/${cases.length} exact · median ${ms(sorted[sorted.length >> 1])} · max ${ms(sorted[sorted.length - 1])}${fails.length ? ` · e.g. ${fails[0]}` : ''}`);
      add('Main-thread frame gap during math', gap < 50, `max ${ms(gap)} (worker mode keeps drawing smooth; > 50 ms would be visible)`);
    } catch (e) {
      add('Math model', false, `error: ${(e as Error).message}`);
    }
  }
  if (tp?.installed) {
    try {
      const t0 = performance.now();
      await local.engine.ensure('text');
      add('Text model load (cold, from IndexedDB)', true, ms(performance.now() - t0));
      // speed only: a printed line (no handwriting fixture ships with the plugin)
      const c = document.createElement('canvas');
      c.width = 360;
      c.height = 48;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 360, 48);
      g.fillStyle = '#000';
      g.font = '32px sans-serif';
      g.textBaseline = 'middle';
      g.fillText('手写识别自检', 8, 25);
      const img = g.getImageData(0, 0, 360, 48).data;
      const n = 360 * 48;
      const tensor = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) tensor[k * n + i] = (img[i * 4] / 255 - 0.5) / 0.5;
      const r = await frameGaps(() => local.engine.text([{ tensor, w: 360 }]));
      const text = r.value.lines[0]?.chars.map((x) => x.c).join('') ?? '';
      add('Text recognition (warm, printed line, speed only)', text === '手写识别自检', `"${text}" · ${ms(r.value.ms)} · frame gap max ${ms(r.maxGap)}`);
    } catch (e) {
      add('Text model', false, `error: ${(e as Error).message}`);
    }
  }
  add('Memory', null, mem());
  const t = local.timings();
  add('Timings', null, `runtime ${ms(t.runtimeMs)}${local.runtimeBuiltIn ? ` (decompress ${ms(embeddedTimings.decodeMs)})` : ''} · math load ${ms(t.mathLoadMs)} · text load ${ms(t.textLoadMs)}`);
  return out;
}

export function selfTestReport(lines: SelfTestLine[]): string {
  return ['HandNote local recognition self-test', new Date().toISOString(), ...lines.map((l) => `${l.ok === true ? '✔' : l.ok === false ? '✘' : '·'} ${l.key}: ${l.value}`)].join('\n');
}
