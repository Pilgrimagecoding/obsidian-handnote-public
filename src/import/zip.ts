/**
 * Reading entries of an Office ZIP (0.9 import) with the platform's DecompressionStream
 * ('deflate-raw'; Obsidian desktop, iPadOS / iOS 16.4+) — no ZIP library is bundled. Every read is
 * capped: the declared size must match the central directory and stay below a per-entry limit, so a
 * hostile archive cannot make HandNote inflate gigabytes.
 */
import { zipEntries, type ZipEntry } from './detect';

export const ZIP_ENTRY_MAX = 64 * 1024 * 1024;

export class ZipArchive {
  readonly entries: ZipEntry[];
  private byName = new Map<string, ZipEntry>();

  constructor(private readonly bytes: Uint8Array) {
    this.entries = zipEntries(bytes);
    for (const e of this.entries) this.byName.set(e.name, e);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Raw bytes of an entry (inflated), or null when it does not exist. */
  async bytesOf(name: string, max = ZIP_ENTRY_MAX): Promise<Uint8Array | null> {
    const e = this.byName.get(name);
    if (!e) return null;
    if (e.size > max) throw new Error(`${name} is too large (${e.size} bytes)`);
    const b = this.bytes;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (e.offset + 30 > b.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`damaged entry ${name}`);
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    if (start + e.compressed > b.length) throw new Error(`damaged entry ${name}`);
    const raw = b.subarray(start, start + e.compressed);
    if (e.method === 0) return raw.slice();
    if (e.method !== 8) throw new Error(`unsupported compression in ${name}`);
    if (typeof DecompressionStream === 'undefined') throw new Error('this system cannot unpack Office files (needs iPadOS / iOS 16.4 or newer)');
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > Math.max(e.size, 1) || total > max) {
        await reader.cancel();
        throw new Error(`${name} unpacks to more than declared`);
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let p = 0;
    for (const x of parts) {
      out.set(x, p);
      p += x.byteLength;
    }
    return out;
  }

  async text(name: string, max = ZIP_ENTRY_MAX): Promise<string | null> {
    const b = await this.bytesOf(name, max);
    return b ? new TextDecoder().decode(b) : null;
  }
}

/** Resolve a relationship target relative to the part that references it ("../media/a.png"). */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') base.pop();
    else if (seg !== '.' && seg !== '') base.push(seg);
  }
  return base.join('/');
}

/** The _rels file of a part ("word/document.xml" → "word/_rels/document.xml.rels"). */
export function relsOf(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}
