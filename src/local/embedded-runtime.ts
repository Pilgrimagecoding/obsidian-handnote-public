import { ORT_EMBEDDED } from './ort-embedded.generated';
import { PACKS, type PackFile, type PackId } from './manifest';
import { ModelStore, sha256Hex, type PackState } from './store';

/**
 * Since 0.8.0-beta.3 (tested on branch experiment/bundled-ort-wasm): the "runtime" pack (ONNX
 * Runtime Web JS + WASM) ships inside main.js instead of being downloaded. Everything else is unchanged:
 *
 *  - same files, same version, same pinned SHA-256 (checked again after decompression);
 *  - the engine still receives the runtime through `file('runtime', …)`, so the worker, the WASM
 *    initialisation (blob URL in `env.wasm.wasmPaths`) and the model packs are untouched;
 *  - lazy: the compressed text is a function result, decoded only when recognition starts and
 *    freed when the engine stops (the engine already re-reads the runtime on every start);
 *  - model packs (math, text, fonts) are still stored in IndexedDB and downloaded on request.
 *
 * A runtime copy downloaded by an earlier version is left in IndexedDB (not deleted), so going
 * back to an earlier build needs no new download.
 *
 * Without `DecompressionStream` (iOS / iPadOS before 16.4) local recognition is NOT available: the
 * runtime is never downloaded as a fallback (Obsidian's policy: plugins must not install
 * dependencies). MyScript keeps working there.
 */
export function embeddedRuntimeBuilt(): boolean {
  return !!ORT_EMBEDDED;
}

/** Why the embedded runtime cannot be used here (null = it can). */
export function embeddedRuntimeProblem(): string | null {
  if (!ORT_EMBEDDED) return 'not built in';
  if (typeof DecompressionStream === 'undefined') return 'this system has no DecompressionStream (needs iPadOS / iOS 16.4 or newer)';
  return null;
}

function base64Bytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Last decode time (self-test / measurements). */
export const embeddedTimings = { decodeMs: 0 };

export class BundledRuntimeModels extends ModelStore {
  private file0(name: string): { name: string; bytes: number; sha256: string; data: () => string } {
    const f = ORT_EMBEDDED?.files.find((x) => x.name === name);
    if (!f) throw new Error(`runtime file not built in: ${name}`);
    return f;
  }

  override async state(id: PackId, verify = false): Promise<PackState> {
    if (id !== 'runtime') return super.state(id, verify);
    const files = PACKS.runtime.files;
    const ok = !embeddedRuntimeProblem();
    return { id, installed: ok, have: ok ? files.length : 0, total: files.length, bytes: ok ? files.reduce((n, f) => n + f.bytes, 0) : 0, damaged: [] };
  }

  override async has(id: PackId, name: string): Promise<boolean> {
    if (id === 'runtime') return PACKS.runtime.files.some((f) => f.name === name);
    return super.has(id, name);
  }

  /** Runtime files: decompressed from main.js and checked against the pinned SHA-256. */
  override async file(id: PackId, name: string): Promise<ArrayBuffer> {
    if (id !== 'runtime') return super.file(id, name);
    const problem = embeddedRuntimeProblem();
    if (problem) throw new Error(`local recognition unavailable: ${problem}`);
    const pin = PACKS.runtime.files.find((f) => f.name === name);
    const f = this.file0(name);
    if (!pin || pin.sha256 !== f.sha256 || pin.bytes !== f.bytes) throw new Error(`built-in runtime does not match the pinned ${name}`);
    const t0 = performance.now();
    const data = await gunzip(base64Bytes(f.data()));
    if (data.byteLength !== pin.bytes || (await sha256Hex(data)) !== pin.sha256) throw new Error(`built-in runtime damaged: ${name}`);
    embeddedTimings.decodeMs = performance.now() - t0;
    return data;
  }

  /** Nothing to save or delete for the built-in runtime (an imported copy is ignored). */
  override async save(id: PackId, f: PackFile, data: ArrayBuffer): Promise<void> {
    if (id === 'runtime') return;
    return super.save(id, f, data);
  }

  override async remove(id: PackId): Promise<void> {
    if (id === 'runtime') return;
    return super.remove(id);
  }
}
