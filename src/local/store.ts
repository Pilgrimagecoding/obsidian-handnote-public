import { PACKS, type PackFile, type PackId } from './manifest';
import { toError } from '../utils/errors';

/**
 * Model storage: this device's IndexedDB ("handnote-models"), outside the vault — never synced
 * by Remotely Save / iCloud / OneDrive and never part of a note. Every read is checked against the
 * pinned SHA-256 once per session; a damaged or missing file reports the pack as not installed,
 * so conversion falls back instead of failing.
 */

const DB = 'handnote-models';
const STORE = 'files';
const META = 'meta';

export interface StoredMeta {
  key: string;
  pack: PackId;
  name: string;
  sha256: string;
  bytes: number;
  savedAt: number;
}

export interface StoredFile extends StoredMeta {
  data: ArrayBuffer;
}

export interface StoreLike {
  get(key: string): Promise<StoredFile | undefined>;
  /** metadata only (no bytes read) */
  meta(key: string): Promise<StoredMeta | undefined>;
  put(f: StoredFile): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** release the connection (plugin unload) */
  close?(): void;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * IndexedDB-backed store (browser / Obsidian desktop and mobile). Bytes and metadata are kept in
 * two object stores, so "is it installed?" never reads megabytes (version 2; version 1 stored
 * only the files and is migrated on open).
 */
export class StorageBlockedError extends Error {
  constructor() {
    super('storage-blocked');
  }
}

export class IdbStore implements StoreLike {
  /** the open request (may stay pending while an older connection blocks the upgrade) */
  private req: Promise<IDBDatabase> | null = null;
  private conn: IDBDatabase | null = null;
  private closed = false;

  constructor(private readonly blockedMs = 6000) {}

  /** Close the connection (plugin unload): a newer plugin version can then upgrade the database. */
  close(): void {
    this.closed = true;
    this.conn?.close();
    this.conn = null;
    this.req = null;
  }

  private keep(db: IDBDatabase): IDBDatabase {
    if (this.closed) {
      db.close();
      return db;
    }
    // a newer version of the plugin wants to upgrade the database: give way (0.7.0-beta.1 did
    // not, which blocked beta.2's upgrade until Obsidian was restarted)
    db.onversionchange = () => {
      db.close();
      if (this.conn === db) {
        this.conn = null;
        this.req = null;
      }
    };
    this.conn = db;
    return db;
  }

  private open(): Promise<IDBDatabase> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.closed) return Promise.reject(new Error('IndexedDB closed'));
    if (!this.req) {
      this.req = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
        const r = indexedDB.open(DB, 2);
        r.onupgradeneeded = (ev) => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(META)) {
            const meta = db.createObjectStore(META, { keyPath: 'key' });
            if ((ev.oldVersion ?? 0) >= 1) {
              // migrate 0.7.0-beta.1 data: build the metadata index from the stored files
              const files = (r.transaction as IDBTransaction).objectStore(STORE);
              const cur = files.openCursor();
              cur.onsuccess = () => {
                const c = cur.result;
                if (!c) return;
                const v = c.value as StoredFile;
                meta.put({ key: v.key, pack: v.pack, name: v.name, sha256: v.sha256, bytes: v.data?.byteLength ?? v.bytes, savedAt: v.savedAt });
                c.continue();
              };
            }
          }
        };
        r.onsuccess = () => resolve(this.keep(r.result));
        r.onerror = () => {
          this.req = null;
          reject(r.error ?? new Error('IndexedDB open failed'));
        };
        // blocked: an older connection has not given way yet; the request stays queued and
        // succeeds as soon as it closes — callers meanwhile get StorageBlockedError (below)
        r.onblocked = () => undefined;
      });
      this.req.catch(() => undefined);
    }
    const pending = this.req;
    return new Promise<IDBDatabase>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new StorageBlockedError()), this.blockedMs);
      pending.then(
        (db) => {
          window.clearTimeout(timer);
          resolve(db);
        },
        (e) => {
          window.clearTimeout(timer);
          reject(toError(e));
        },
      );
    });
  }

  private async tx(stores: string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    return (await this.open()).transaction(stores, mode);
  }

  async get(key: string): Promise<StoredFile | undefined> {
    return req((await this.tx([STORE], 'readonly')).objectStore(STORE).get(key) as IDBRequest<StoredFile | undefined>);
  }

  async meta(key: string): Promise<StoredMeta | undefined> {
    const m = (await req((await this.tx([META], 'readonly')).objectStore(META).get(key) as IDBRequest<StoredMeta | undefined>)) ?? undefined;
    if (m) return m;
    // self-heal: a file stored without its metadata (an interrupted migration from 0.7.0-beta.1)
    // is indexed now instead of being downloaded again
    const f = await this.get(key);
    if (!f?.data) return undefined;
    const meta: StoredMeta = { key: f.key, pack: f.pack, name: f.name, sha256: f.sha256, bytes: f.data.byteLength, savedAt: f.savedAt };
    const t = await this.tx([META], 'readwrite');
    t.objectStore(META).put(meta);
    return meta;
  }

  async put(f: StoredFile): Promise<void> {
    const t = await this.tx([STORE, META], 'readwrite');
    t.objectStore(STORE).put(f);
    t.objectStore(META).put({ key: f.key, pack: f.pack, name: f.name, sha256: f.sha256, bytes: f.bytes, savedAt: f.savedAt });
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB write aborted (storage full?)'));
    });
  }

  async delete(key: string): Promise<void> {
    const t = await this.tx([STORE, META], 'readwrite');
    t.objectStore(STORE).delete(key);
    t.objectStore(META).delete(key);
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB delete failed'));
    });
  }

  async keys(): Promise<string[]> {
    return (await req((await this.tx([META], 'readonly')).objectStore(META).getAllKeys())).map(String);
  }
}

/** In-memory store (tests). */
export class MemoryStore implements StoreLike {
  readonly map = new Map<string, StoredFile>();
  async get(k: string) {
    return this.map.get(k);
  }
  async meta(k: string) {
    const f = this.map.get(k);
    if (!f) return undefined;
    const { data, ...m } = f;
    return { ...m, bytes: data.byteLength };
  }
  async put(f: StoredFile) {
    this.map.set(f.key, f);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
  async keys() {
    return [...this.map.keys()];
  }
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const fileKey = (pack: PackId, f: PackFile | string) => `${pack}/${typeof f === 'string' ? f : f.name}`;

export interface PackState {
  id: PackId;
  installed: boolean;
  /** files present with the pinned hash */
  have: number;
  total: number;
  bytes: number;
  /** a file was present but damaged (removed) */
  damaged: string[];
}

/**
 * Verified access to installed packs. `verify` hashes each file once per session (desktop: a few
 * ms per MB; the result is remembered), so a damaged file is found before a model is loaded.
 */
export class ModelStore {
  private verified = new Set<string>();

  constructor(readonly store: StoreLike) {}

  async state(id: PackId, verify = false): Promise<PackState> {
    const pack = PACKS[id];
    let have = 0;
    let bytes = 0;
    const damaged: string[] = [];
    for (const f of pack.files) {
      const key = fileKey(id, f);
      let m: StoredMeta | undefined;
      try {
        m = await this.store.meta(key);
      } catch (e) {
        if (e instanceof StorageBlockedError) throw e;
        m = undefined;
      }
      if (!m || m.sha256 !== f.sha256 || m.bytes !== f.bytes) {
        if (m) {
          damaged.push(f.name);
          await this.store.delete(key).catch(() => undefined);
        }
        continue;
      }
      if (verify && !this.verified.has(key)) {
        const s = await this.store.get(key).catch(() => undefined);
        if (!s || s.data.byteLength !== f.bytes || (await sha256Hex(s.data)) !== f.sha256) {
          damaged.push(f.name);
          await this.store.delete(key).catch(() => undefined);
          continue;
        }
        this.verified.add(key);
      }
      have++;
      bytes += m.bytes;
    }
    return { id, installed: have === pack.files.length && pack.files.length > 0, have, total: pack.files.length, bytes, damaged };
  }

  /** A file with the pinned hash is stored (metadata only). */
  async has(id: PackId, name: string): Promise<boolean> {
    const f = PACKS[id].files.find((x) => x.name === name);
    if (!f) return false;
    const m = await this.store.meta(fileKey(id, f)).catch(() => undefined);
    return !!m && m.sha256 === f.sha256 && m.bytes === f.bytes;
  }

  /** Bytes of a verified file (throws when missing or damaged). */
  async file(id: PackId, name: string): Promise<ArrayBuffer> {
    const f = PACKS[id].files.find((x) => x.name === name);
    if (!f) throw new Error(`unknown file ${id}/${name}`);
    const key = fileKey(id, f);
    const s = await this.store.get(key);
    if (!s || s.sha256 !== f.sha256) throw new Error(`model file missing: ${key}`);
    if (!this.verified.has(key)) {
      if ((await sha256Hex(s.data)) !== f.sha256) {
        await this.store.delete(key).catch(() => undefined);
        throw new Error(`model file damaged: ${key}`);
      }
      this.verified.add(key);
    }
    return s.data;
  }

  async save(id: PackId, f: PackFile, data: ArrayBuffer): Promise<void> {
    await this.store.put({ key: fileKey(id, f), pack: id, name: f.name, sha256: f.sha256, bytes: data.byteLength, savedAt: Date.now(), data });
    this.verified.add(fileKey(id, f));
  }

  async remove(id: PackId): Promise<void> {
    for (const f of PACKS[id].files) {
      await this.store.delete(fileKey(id, f)).catch(() => undefined);
      this.verified.delete(fileKey(id, f));
    }
  }
}
