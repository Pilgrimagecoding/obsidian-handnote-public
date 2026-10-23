/**
 * Compound File Binary (the container of .doc / .xls / .ppt and of password-protected Office
 * files), read-only and defensive: every sector number, chain and size is checked, chains that
 * loop are cut, streams are capped. Only what the importer needs: list entries, read a stream.
 */

export const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_STREAM = 128 * 1024 * 1024;

export interface CfbEntry {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  start: number;
  size: number;
}

export class CfbError extends Error {}

export class Cfb {
  readonly entries: CfbEntry[] = [];
  private readonly sectorSize: number;
  private readonly fat: number[] = [];
  private miniFat: number[] = [];
  private miniStream: Uint8Array | null = null;
  private readonly cutoff: number;
  private readonly dv: DataView;

  constructor(private readonly b: Uint8Array) {
    if (b.length < 512 || CFB_SIGNATURE.some((x, i) => b[i] !== x)) throw new CfbError('not a compound file');
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const shift = this.dv.getUint16(0x1e, true);
    if (shift !== 9 && shift !== 12) throw new CfbError('damaged compound file (sector size)');
    this.sectorSize = 1 << shift;
    this.cutoff = this.dv.getUint32(0x38, true) || 4096;
    const nSectors = Math.ceil((b.length - this.sectorSize) / this.sectorSize);
    // FAT sectors: 109 in the header, the rest in the DIFAT chain
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const s = this.dv.getUint32(0x4c + i * 4, true);
      if (s === FREE || s === END) continue;
      fatSectors.push(s);
    }
    let difat = this.dv.getUint32(0x44, true);
    for (let guard = 0; difat !== END && difat !== FREE && guard < nSectors; guard++) {
      const off = this.offset(difat);
      const per = this.sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const s = this.dv.getUint32(off + i * 4, true);
        if (s !== FREE && s !== END) fatSectors.push(s);
      }
      difat = this.dv.getUint32(off + per * 4, true);
    }
    for (const fs of fatSectors) {
      const off = this.offset(fs);
      for (let i = 0; i < this.sectorSize / 4; i++) this.fat.push(this.dv.getUint32(off + i * 4, true));
    }
    // directory
    const dir = this.chainBytes(this.dv.getUint32(0x30, true), Number.MAX_SAFE_INTEGER, 64 * 1024 * 1024);
    const dirDv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    for (let p = 0; p + 128 <= dir.length && this.entries.length < 100_000; p += 128) {
      const nameLen = Math.min(64, dirDv.getUint16(p + 0x40, true));
      let name = '';
      for (let i = 0; i + 2 <= nameLen - 2; i += 2) name += String.fromCharCode(dirDv.getUint16(p + i, true));
      const type = dir[p + 0x42];
      const start = dirDv.getUint32(p + 0x74, true);
      const size = Number(dirDv.getUint32(p + 0x78, true)); // high part ignored (streams > 4 GB are not read)
      this.entries.push({ name, type, start, size });
    }
    const root = this.entries.find((e) => e.type === 5);
    if (root && root.size > 0) {
      this.miniStream = this.chainBytes(root.start, root.size, MAX_STREAM);
      const mf = this.chainBytes(this.dv.getUint32(0x3c, true), this.dv.getUint32(0x40, true) * this.sectorSize, 16 * 1024 * 1024);
      const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
      for (let i = 0; i + 4 <= mf.length; i += 4) this.miniFat.push(mdv.getUint32(i, true));
    }
  }

  private offset(sector: number): number {
    const off = (sector + 1) * this.sectorSize;
    if (sector >= 0xfffffffa || off + this.sectorSize > this.b.length) throw new CfbError('damaged compound file (sector out of range)');
    return off;
  }

  /** Bytes of a FAT chain, at most `size` (and `max`) bytes; loops are cut. */
  private chainBytes(start: number, size: number, max: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let s = start; s !== END && s !== FREE && total < size; s = this.fat[s] ?? END) {
      if (seen.has(s)) throw new CfbError('damaged compound file (loop)');
      seen.add(s);
      const off = this.offset(s);
      parts.push(this.b.subarray(off, off + this.sectorSize));
      total += this.sectorSize;
      if (total > max) throw new CfbError('stream too large');
    }
    return concat(parts, Math.min(total, size));
  }

  private miniBytes(start: number, size: number): Uint8Array {
    if (!this.miniStream) throw new CfbError('damaged compound file (no mini stream)');
    const parts: Uint8Array[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let s = start; s !== END && s !== FREE && total < size; s = this.miniFat[s] ?? END) {
      if (seen.has(s)) throw new CfbError('damaged compound file (loop)');
      seen.add(s);
      const off = s * 64;
      if (off + 64 > this.miniStream.length) throw new CfbError('damaged compound file (mini sector)');
      parts.push(this.miniStream.subarray(off, off + 64));
      total += 64;
    }
    return concat(parts, Math.min(total, size));
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.type === 2 && e.name === name);
  }

  /** A stream's bytes by name (first match), or null. */
  stream(name: string): Uint8Array | null {
    const e = this.entries.find((x) => x.type === 2 && x.name === name);
    if (!e) return null;
    if (e.size > MAX_STREAM) throw new CfbError(`${name} is too large`);
    return e.size < this.cutoff ? this.miniBytes(e.start, e.size) : this.chainBytes(e.start, e.size, MAX_STREAM);
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let p = 0;
  for (const x of parts) {
    if (p >= size) break;
    const n = Math.min(x.length, size - p);
    out.set(x.subarray(0, n), p);
    p += n;
  }
  return out;
}
