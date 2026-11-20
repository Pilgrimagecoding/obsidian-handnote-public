/** Minimal ZIP STORE writer: immutable sources, append-only note checkpoints. ZIP64 is rejected. */
export interface StoredEntry { name: string; offset: number; size: number; crc: number }
const enc = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crcUpdate(crc: number, bytes: Uint8Array): number {
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
export function crc32(bytes: Uint8Array): number { return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
function header(size: number) { const bytes = new Uint8Array(size); return { bytes, v: new DataView(bytes.buffer) }; }
export function localHeader(name: string): Uint8Array<ArrayBuffer> {
  const n = enc.encode(name), { bytes, v } = header(30 + n.length);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x808, true);
  v.setUint16(26, n.length, true); bytes.set(n, 30); return bytes;
}
export function descriptor(entry: StoredEntry): Uint8Array<ArrayBuffer> {
  const { bytes, v } = header(16); v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, entry.crc, true); v.setUint32(8, entry.size, true); v.setUint32(12, entry.size, true); return bytes;
}
export function directory(entries: StoredEntry[], offset: number): Uint8Array<ArrayBuffer> {
  if (entries.length > 65535 || offset > 0xffff0000) throw new Error('HandNote package exceeds the 4 GB ZIP limit');
  const names = entries.map(e => enc.encode(e.name));
  const length = names.reduce((n, name) => n + 46 + name.length, 0);
  if (offset + length + 22 > 0xffffffff) throw new Error('HandNote package exceeds the 4 GB ZIP limit');
  const { bytes, v } = header(length + 22); let at = 0;
  entries.forEach((e, i) => {
    v.setUint32(at, 0x02014b50, true); v.setUint16(at + 4, 20, true); v.setUint16(at + 6, 20, true);
    v.setUint16(at + 8, 0x808, true); v.setUint32(at + 16, e.crc, true);
    v.setUint32(at + 20, e.size, true); v.setUint32(at + 24, e.size, true);
    v.setUint16(at + 28, names[i].length, true); v.setUint32(at + 42, e.offset, true);
    bytes.set(names[i], at + 46); at += 46 + names[i].length;
  });
  v.setUint32(at, 0x06054b50, true); v.setUint16(at + 8, entries.length, true); v.setUint16(at + 10, entries.length, true);
  v.setUint32(at + 12, length, true); v.setUint32(at + 16, offset, true); return bytes;
}
/** A portable ZIP for an entire notebook's PNG / SVG pages. */
export async function storedZip(files: { name: string; blob: Blob }[], maxBytes = 128 * 1024 * 1024): Promise<Blob> {
  const parts: BlobPart[] = [], entries: StoredEntry[] = []; let offset = 0;
  for (const file of files) {
    if (offset + file.blob.size > maxBytes) throw new Error('Export exceeds the memory budget');
    const head = localHeader(file.name), bytes = new Uint8Array(await file.blob.arrayBuffer());
    const entry = { name: file.name, offset, size: bytes.length, crc: crc32(bytes) };
    parts.push(head, file.blob, descriptor(entry)); entries.push(entry); offset += head.length + bytes.length + 16;
  }
  parts.push(directory(entries, offset)); return new Blob(parts, { type: 'application/zip' });
}
