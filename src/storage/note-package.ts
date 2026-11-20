import { Platform, type App, type DataAdapter, type TFile } from 'obsidian';
declare const require: (name: string) => any;
import type { HandNoteDocument } from '../document/model';
import { crc32, crcUpdate, descriptor, directory, localHeader, type StoredEntry } from './zip-store';

const NOTE = 'handnote.json';
const CHUNK = 4 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
interface Index { entries: StoredEntry[]; text: string; size: number; mtime: number; packed: boolean }
const stores = new WeakMap<App, NotePackages>();
export function notePackages(app: App): NotePackages {
  let store = stores.get(app); if (!store) { store = new NotePackages(app); stores.set(app, store); } return store;
}
export function bindPackageSources(doc: HandNoteDocument, path: string): void {
  for (const source of Object.values(doc.sources ?? {})) if (source.containerId === doc.id && source.entry) source.path = path;
}

/** Desktop uses native range reads; mobile uses its resource URL, falling back to a Blob.
 * The Blob is scoped to one read, never a retained base64 copy of a large PDF. */
class Reader {
  private blob: Blob | null = null;
  constructor(private adapter: DataAdapter, private path: string, readonly size: number) {}
  async range(start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (start < 0 || length < 0 || start + length > this.size) throw new Error('Invalid package byte range');
    const desktop = this.adapter as DataAdapter & { getFullPath?: (path: string) => string };
    // Mobile adapters also expose getFullPath and a require shim. Neither implies Node.js.
    // Only probe native modules on desktop, and tolerate unavailable module shims there.
    let fs;
    if (Platform.isDesktopApp && typeof desktop.getFullPath === 'function' && typeof require === 'function') {
      try { fs = require('fs')?.promises; } catch { /* use the adapter/resource reader */ }
    }
    if (typeof fs?.open === 'function') {
      const file = await fs.open(desktop.getFullPath!(this.path), 'r');
      try { const bytes = new Uint8Array(length); let at = 0;
        while (at < length) { const r = await file.read(bytes, at, length - at, start + at); if (!r.bytesRead) throw new Error('Incomplete package'); at += r.bytesRead; }
        return bytes;
      } finally { await file.close(); }
    }
    if (this.blob) return new Uint8Array(await this.blob.slice(start, start + length).arrayBuffer());
    try {
      const response = await fetch(this.adapter.getResourcePath(this.path), { headers: { Range: `bytes=${start}-${start + length - 1}` }, cache: 'no-store' });
      if (response.status === 206) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const range = response.headers.get('content-range');
        if (bytes.length === length && range?.startsWith(`bytes ${start}-`)) return bytes;
        throw new Error('Incorrect resource range');
      }
      if (!response.ok) throw new Error('Resource unavailable');
      this.blob = await response.blob();
      if (this.blob.size !== this.size) { this.blob = null; throw new Error('Resource changed'); }
    } catch {
      this.blob = new Blob([await this.adapter.readBinary(this.path)]);
      if (this.blob.size !== this.size) throw new Error('Package changed during read');
    }
    return new Uint8Array(await this.blob.slice(start, start + length).arrayBuffer());
  }
}

/** Every mutation of one package is serialized. The last complete ZIP directory is its commit.
 * Old source bytes are never rewritten by autosave; only the small handnote.json is appended. */
export class NotePackages {
  private cache = new Map<string, Index>();
  private queues = new Map<string, Promise<unknown>>();
  private remember(path: string, value: Index): void {
    this.cache.delete(path); this.cache.set(path, value);
    let chars = [...this.cache.values()].reduce((n, v) => n + v.text.length, 0);
    while (this.cache.size > 8 || (chars > 16 * 1024 * 1024 && this.cache.size > 1)) {
      const key = this.cache.keys().next().value as string;
      chars -= this.cache.get(key)?.text.length ?? 0; this.cache.delete(key);
    }
  }
  constructor(private app: App) {}
  invalidate(path: string): void { this.cache.delete(path); }
  private async locked<T>(path: string, task: () => Promise<T>): Promise<T> {
    const old = this.queues.get(path) ?? Promise.resolve();
    const next = old.catch(() => undefined).then(task); this.queues.set(path, next);
    try { return await next; } finally { if (this.queues.get(path) === next) this.queues.delete(path); }
  }
  private async index(path: string): Promise<Index> {
    if (/^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(path)) throw new Error('Invalid vault path');
    const adapter = this.app.vault.adapter, stat = await adapter.stat(path);
    if (!stat || stat.type !== 'file') throw new Error('Note not found');
    const cached = this.cache.get(path);
    if (cached && cached.size === stat.size && cached.mtime === stat.mtime) return cached;
    const reader = new Reader(adapter, path, stat.size);
    const head = await reader.range(0, Math.min(4, stat.size));
    if (head.length < 4 || new DataView(head.buffer).getUint32(0, true) !== 0x04034b50) {
      const value = { entries: [], text: await adapter.read(path), size: stat.size, mtime: stat.mtime, packed: false };
      this.remember(path, value); return value;
    }
    // Recover a complete earlier checkpoint after interrupted append (scan bounded chunks).
    for (let end = stat.size; end > 0;) {
      const start = Math.max(0, end - CHUNK), bytes = await reader.range(start, end - start);
      const v = new DataView(bytes.buffer);
      for (let i = bytes.length - 22; i >= 0; i--) {
        if (v.getUint32(i, true) !== 0x06054b50 || v.getUint16(i + 4, true) || v.getUint16(i + 6, true)) continue;
        const count = v.getUint16(i + 10, true), length = v.getUint32(i + 12, true), offset = v.getUint32(i + 16, true);
        if (count > 10000 || length > 4e6 || offset + length !== start + i) continue;
        try {
          const central = await reader.range(offset, length), cv = new DataView(central.buffer);
          const entries: StoredEntry[] = []; let at = 0;
          for (let n = 0; n < count; n++) {
            if (cv.getUint32(at, true) !== 0x02014b50 || cv.getUint16(at + 10, true) !== 0) throw new Error('Unsupported package compression');
            const nl = cv.getUint16(at + 28, true), extra = cv.getUint16(at + 30, true), comment = cv.getUint16(at + 32, true);
            const entry = { name: decoder.decode(central.subarray(at + 46, at + 46 + nl)), offset: cv.getUint32(at + 42, true), size: cv.getUint32(at + 24, true), crc: cv.getUint32(at + 16, true) };
            if (entry.offset + 30 + entry.size > offset || entry.size !== cv.getUint32(at + 20, true)) throw new Error('Invalid package entry');
            entries.push(entry); at += 46 + nl + extra + comment;
          }
          if (at !== length) continue;
          const note = entries.find(e => e.name === NOTE);
          if (!note || note.size > 128e6) continue;
          const text = decoder.decode(await this.entryBytes(reader, note));
          const value = { entries, text, size: stat.size, mtime: stat.mtime, packed: true };
          this.remember(path, value); return value;
        } catch { /* an interrupted newer directory: find the last intact one */ }
      }
      if (!start) break; end = start + 21;
    }
    throw new Error('No intact HandNote package checkpoint');
  }
  private async entryBytes(reader: Reader, entry: StoredEntry): Promise<Uint8Array<ArrayBuffer>> {
    if (entry.size > 512 * 1024 * 1024) throw new Error('Embedded source exceeds 512 MiB');
    const head = await reader.range(entry.offset, 30), v = new DataView(head.buffer);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid package entry header');
    const start = entry.offset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    const bytes = await reader.range(start, entry.size);
    let crc = 0xffffffff;
    for (let at = 0; at < bytes.length; at += CHUNK) { crc = crcUpdate(crc, bytes.subarray(at, at + CHUNK)); if (bytes.length > CHUNK) await new Promise(r => setTimeout(r, 0)); }
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('Package entry checksum mismatch');
    return bytes;
  }
  read(path: string): Promise<string> { return this.locked(path, async () => (await this.index(path)).text); }
  isPacked(path: string): Promise<boolean> { return this.locked(path, async () => (await this.index(path)).packed); }
  entry(path: string, name: string): Promise<ArrayBuffer> {
    return this.locked(path, async () => {
      const ix = await this.index(path), entry = ix.entries.find(e => e.name === name);
      if (!entry) throw new Error('Embedded source not found');
      return (await this.entryBytes(new Reader(this.app.vault.adapter, path, ix.size), entry)).buffer;
    });
  }
  async ensure(file: TFile): Promise<void> {
    await this.locked(file.path, async () => {
      const ix = await this.index(file.path); if (ix.packed) return;
      const bytes = new TextEncoder().encode(ix.text), entry = { name: NOTE, offset: 0, size: bytes.length, crc: crc32(bytes) };
      const head = localHeader(NOTE), tail = directory([entry], head.length + bytes.length + 16);
      const blob = new Blob([head, bytes, descriptor(entry), tail]);
      if (await this.app.vault.adapter.read(file.path) !== ix.text) throw new Error('Note changed during package conversion');
      // This conversion contains only the existing note, before any large source is appended.
      await this.app.vault.modifyBinary(file, await blob.arrayBuffer()); this.cache.delete(file.path);
    });
  }
  private async append(path: string, ix: Index, files: { name: string; blob: Blob }[], signal?: AbortSignal): Promise<void> {
    const adapter = this.app.vault.adapter, entries = ix.entries.slice(); let offset = ix.size;
    let stamp = ix.mtime, writtenSize = ix.size, replaced = false;
    const write = async (bytes: ArrayBuffer) => {
      const before = await adapter.stat(path);
      if (!before || before.size !== writtenSize || before.mtime !== stamp) { replaced = true; throw new Error('Package changed during append'); }
      await adapter.appendBinary(path, bytes);
      const after = await adapter.stat(path);
      if (!after || after.size !== writtenSize + bytes.byteLength) { replaced = true; throw new Error('Package changed during append'); }
      writtenSize = after.size; stamp = after.mtime;
    };
    try {
      for (const file of files) {
        if (file.name !== NOTE && entries.some(e => e.name === file.name && e.size === file.blob.size)) continue;
        signal?.throwIfAborted();
        if (offset + file.blob.size + 4e6 > 0xffff0000) throw new Error('HandNote package exceeds the 4 GB ZIP limit');
        const head = localHeader(file.name), entry = { name: file.name, offset, size: file.blob.size, crc: 0 };
        await write(head.buffer); offset += head.length;
        let crc = 0xffffffff;
        for (let at = 0; at < file.blob.size; at += CHUNK) {
          signal?.throwIfAborted();
          const bytes = new Uint8Array(await file.blob.slice(at, at + CHUNK).arrayBuffer());
          crc = crcUpdate(crc, bytes); await write(bytes.buffer); offset += bytes.length;
          await new Promise(r => setTimeout(r, 0));
        }
        entry.crc = (crc ^ 0xffffffff) >>> 0;
        await write(descriptor(entry).buffer); offset += 16;
        const old = entries.findIndex(e => e.name === file.name); if (old >= 0) entries.splice(old, 1); entries.push(entry);
      }
      await write(directory(entries, offset).buffer);
      const stat = await adapter.stat(path);
      if (!stat) throw new Error('Package disappeared');
      const note = files.find(f => f.name === NOTE);
      this.remember(path, { entries, text: note ? await note.blob.text() : ix.text, size: stat.size, mtime: stat.mtime, packed: true });
    } catch (e) {
      // Re-publish the old complete directory after failed/cancelled append; old note and
      // originals stay intact. A crash before this still recovers the earlier directory.
      const stat = await adapter.stat(path);
      if (!replaced && stat?.size === writtenSize && stat.mtime === stamp) await adapter.appendBinary(path, directory(ix.entries, stat.size).buffer).catch(() => undefined);
      this.cache.delete(path); throw e;
    }
  }
  add(path: string, files: { name: string; blob: Blob }[], signal?: AbortSignal): Promise<void> {
    return this.locked(path, async () => { const ix = await this.index(path); if (!ix.packed) throw new Error('Not a package'); await this.append(path, ix, files, signal); });
  }
  write(path: string, text: string, expected: string): Promise<void> {
    return this.locked(path, async () => {
      const ix = await this.index(path);
      if (ix.text !== expected) throw new Error('Note changed while saving; retry to preserve both revisions');
      if (!ix.packed) throw new Error('Not a package');
      const note = JSON.parse(text);
      for (const source of note.sources ?? []) {
        if (!source.entry || source.containerId !== note.id) continue;
        for (const name of [source.entry, source.layoutEntry].filter(Boolean)) {
          if (!ix.entries.some(entry => entry.name === name)) throw new Error('An embedded original is missing after sync. Restore the original package before saving.');
        }
      }
      await this.append(path, ix, [{ name: NOTE, blob: new Blob([text]) }]);
    });
  }
  async copy(path: string, target: string, text: string): Promise<void> {
    await this.locked(path, async () => {
      const source = this.app.vault.getAbstractFileByPath?.(path);
      if (source) await this.app.vault.copy(source, target);
      else await this.app.vault.adapter.copy(path, target);
    });
    this.cache.delete(target);
    const ix = await this.index(target);
    await this.write(target, text, ix.text);
  }
}
