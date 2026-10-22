import { PACKS, packPinned, type PackId } from './manifest';
import { sha256Hex, type ModelStore } from './store';

/**
 * Pack installer: downloads only the missing files of a pack (and of the packs it needs), from
 * the first mirror that delivers the pinned SHA-256. A wrong or truncated file is never stored.
 * Nothing is uploaded. A failure leaves the files already verified in place, so "Retry" resumes.
 */

/** `expectBytes`: size of the file, so the caller can scale its timeout to it. */
export type FetchBinary = (url: string, expectBytes?: number) => Promise<ArrayBuffer>;
/** Quick reachability check of a mirror (HEAD, short timeout): resolves with the round trip in ms. */
export type ProbeUrl = (url: string) => Promise<number>;

export interface MirrorStatus {
  host: string;
  ok: boolean;
  ms: number;
  error?: string;
}

const hostOf = (raw: string) => new URL(raw.split('#')[0]).host;

/** Probe results of this session, per host (a network change → `resetMirrorProbes`). */
const probes = new Map<string, Promise<MirrorStatus>>();

export function resetMirrorProbes(): void {
  probes.clear();
}

export function probeMirror(raw: string, probe: ProbeUrl): Promise<MirrorStatus> {
  const host = hostOf(raw);
  let p = probes.get(host);
  if (!p) {
    p = probe(raw.split('#')[0]).then(
      (ms) => ({ host, ok: true, ms }),
      (e: unknown) => ({ host, ok: false, ms: Infinity, error: String((e as Error)?.message ?? e).slice(0, 60) }),
    );
    probes.set(host, p);
  }
  return p;
}

/** Probe every mirror host of these packs once (in parallel); results sorted fastest first. */
export async function probeMirrors(ids: PackId[], probe: ProbeUrl): Promise<MirrorStatus[]> {
  const first = new Map<string, string>();
  for (const id of ids) for (const f of PACKS[id].files) for (const u of f.urls) if (!first.has(hostOf(u))) first.set(hostOf(u), u);
  const out = await Promise.all([...first.values()].map((u) => probeMirror(u, probe)));
  return out.sort((a, b) => a.ms - b.ms);
}

export interface InstallProgress {
  pack: PackId;
  file: string;
  /** files done / total of this install */
  done: number;
  total: number;
  /** host being tried */
  host: string;
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly attempts: string[],
  ) {
    super(message);
  }
}

/** Minimal ustar reader: the first member whose base name is `name`. */
export function tarMember(buf: ArrayBuffer, name: string): ArrayBuffer | null {
  const u = new Uint8Array(buf);
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= u.length) {
    const hdr = u.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a: number, b: number) => dec.decode(hdr.subarray(a, b)).replace(/\0.*$/s, '');
    const full = (str(345, 500) ? `${str(345, 500)}/` : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = hdr[156];
    if ((type === 48 || type === 0) && full.split('/').pop() === name) return buf.slice(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Packs to install for `id`, dependencies first. */
export function installOrder(id: PackId): PackId[] {
  const out: PackId[] = [];
  const add = (p: PackId) => {
    for (const n of PACKS[p].needs) add(n);
    if (!out.includes(p)) out.push(p);
  };
  add(id);
  return out;
}

export async function installPack(id: PackId, store: ModelStore, fetchBinary: FetchBinary, onProgress?: (p: InstallProgress) => void, signal?: AbortSignal, concurrency = 4, probe?: ProbeUrl): Promise<void> {
  const order = installOrder(id);
  for (const p of order) if (!packPinned(p)) throw new InstallError(`pack ${p} has no pinned hashes yet`, '', []);
  const todo: { pack: PackId; i: number }[] = [];
  for (const p of order) {
    for (let i = 0; i < PACKS[p].files.length; i++) {
      // a file of a partly installed pack may already be there (metadata check, no bytes read)
      if (!(await store.has(p, PACKS[p].files[i].name))) todo.push({ pack: p, i });
    }
  }
  let done = 0;
  // mirror affinity: a host that answered keeps being tried first; one that failed twice is skipped
  const hostFails = new Map<string, number>();
  let preferred = '';
  let failure: InstallError | null = null;
  // which mirrors answer on THIS network, and how fast (a few seconds instead of waiting for a
  // dead mirror's download timeout): fastest first; unreachable ones are kept as a last resort
  const speed = new Map<string, number>();
  if (probe && todo.length) {
    const hosts = new Map<string, string>();
    for (const { pack, i } of todo) for (const u of PACKS[pack].files[i].urls) if (!hosts.has(hostOf(u))) hosts.set(hostOf(u), u);
    onProgress?.({ pack: id, file: '', done: 0, total: todo.length, host: 'probing mirrors' });
    for (const m of await Promise.all([...hosts.values()].map((u) => probeMirror(u, probe)))) {
      speed.set(m.host, m.ms);
      if (!m.ok) hostFails.set(m.host, 2);
    }
  }
  const rank = (raw: string) => {
    const h = hostOf(raw);
    // the host that delivered keeps going first; otherwise by probe time, in 250 ms steps so the
    // listed order (official source first) still decides between mirrors about as fast
    return h === preferred ? -1 : Math.floor((speed.get(h) ?? 1e6) / 250);
  };
  const one = async ({ pack, i }: { pack: PackId; i: number }) => {
    const f = PACKS[pack].files[i];
    const attempts: string[] = [];
    const urls = [...f.urls].sort((a, b) => rank(a) - rank(b));
    for (const raw of urls) {
      if (signal?.aborted || failure) throw new InstallError('cancelled', f.name, attempts);
      const [url, frag] = raw.split('#');
      const member = frag?.startsWith('tar=') ? frag.slice(4) : null;
      const host = new URL(url).host;
      if ((hostFails.get(host) ?? 0) >= 2 && urls.some((u) => (hostFails.get(new URL(u.split('#')[0]).host) ?? 0) < 2)) continue;
      onProgress?.({ pack, file: f.name, done, total: todo.length, host });
      try {
        let data = await fetchBinary(url, member ? undefined : f.bytes);
        if (member) {
          const m = tarMember(data, member);
          if (!m) throw new Error(`${member} not in archive`);
          data = m;
        }
        if (data.byteLength !== f.bytes) throw new Error(`size ${data.byteLength} ≠ ${f.bytes}`);
        const h = await sha256Hex(data);
        if (h !== f.sha256) throw new Error('SHA-256 mismatch');
        await store.save(pack, f, data);
        preferred = host;
        done++;
        return;
      } catch (e) {
        hostFails.set(host, (hostFails.get(host) ?? 0) + 1);
        attempts.push(`${host}: ${(e as Error)?.message ?? e}`);
      }
    }
    throw new InstallError(`${f.name}: no mirror delivered the expected file`, f.name, attempts);
  };
  const queue = [...todo];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length && !failure) {
      const job = queue.shift() as { pack: PackId; i: number };
      try {
        await one(job);
      } catch (e) {
        failure ??= e instanceof InstallError ? e : new InstallError(String((e as Error)?.message ?? e), '', []);
      }
    }
  });
  await Promise.all(workers);
  // assigned inside the workers: TypeScript cannot see that, hence the explicit type
  const failed = failure as InstallError | null;
  if (failed) throw failed;
  onProgress?.({ pack: id, file: '', done, total: todo.length, host: '' });
}
