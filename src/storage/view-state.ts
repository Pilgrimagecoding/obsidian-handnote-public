import type { DataAdapter } from 'obsidian';

/**
 * Where each note was last viewed (0.13: "Open notes where you left off").
 *
 * Two small files in the plugin folder, keyed by the note's document id (survives renames):
 *  - view-local.json : this device's exact view (page, offset in the page, zoom). Never meant to
 *                      sync: zoom depends on the screen.
 *  - view-sync.json  : only the page. Syncs with the plugin folder (Obsidian Sync with plugins,
 *                      Remotely Save with syncConfigDir); without that it simply stays local.
 *
 * Nothing here touches the .handnote files, so viewing never changes a note or its revision.
 * Writes never overlap: a change during a write is written once more when it finishes.
 */

export interface LocalView {
  /** Page.id; '' on a whiteboard */
  pageId: string;
  pageIndex: number;
  /** camera left, in page units (zoomed in: the part of the page in view) */
  x: number;
  /** camera top minus page top, in page units */
  offsetY: number;
  zoom: number;
  /** viewport width (CSS px) when recorded: a very different width gets fit-to-width instead */
  viewW: number;
  /** whiteboard camera */
  board?: { x: number; y: number; zoom: number };
  at: number;
}

export interface SyncedPage {
  pageId: string;
  pageIndex: number;
  at: number;
}

export type ViewSnapshot = Omit<LocalView, 'at'>;

/** What the editor should show when a note opens. */
export type RestorePlan =
  | { kind: 'default' }
  | { kind: 'exact'; view: LocalView }
  /** another device's page; `zoom` and `x` are this device's (null: fit the width) */
  | { kind: 'page'; pageId: string; pageIndex: number; zoom: number | null; x: number };

export const MAX_NOTES = 500;
/** a viewport this much wider or narrower than when recorded gets fit-to-width */
export const ZOOM_WIDTH_TOLERANCE = 0.3;
export const LOCAL_VIEW_DELAY_MS = 1000;
export const LOCAL_VIEW_MAX_WAIT_MS = 3000;
export const SYNC_DELAY_MS = 2000;
export const SYNC_MAX_WAIT_MS = 5000;

const LOCAL_FILE = 'view-local.json';
const SYNC_FILE = 'view-sync.json';

type NoteMap<T> = Record<string, T>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cleanLocal(v: unknown): LocalView | null {
  const o = v as Partial<LocalView> | null;
  if (!o || typeof o !== 'object' || typeof o.pageId !== 'string') return null;
  if (!isNum(o.pageIndex) || !isNum(o.x) || !isNum(o.offsetY) || !isNum(o.zoom) || !isNum(o.viewW) || !isNum(o.at) || o.zoom <= 0) return null;
  const b = o.board;
  const board = b && isNum(b.x) && isNum(b.y) && isNum(b.zoom) && b.zoom > 0 ? { x: b.x, y: b.y, zoom: b.zoom } : undefined;
  return { pageId: o.pageId, pageIndex: Math.max(0, Math.floor(o.pageIndex)), x: o.x, offsetY: o.offsetY, zoom: o.zoom, viewW: o.viewW, ...(board ? { board } : {}), at: o.at };
}

function cleanSynced(v: unknown): SyncedPage | null {
  const o = v as Partial<SyncedPage> | null;
  if (!o || typeof o !== 'object' || typeof o.pageId !== 'string' || !isNum(o.pageIndex) || !isNum(o.at)) return null;
  return { pageId: o.pageId, pageIndex: Math.max(0, Math.floor(o.pageIndex)), at: o.at };
}

/** Parse a view file; anything unreadable or of another version counts as empty. */
export function parseNotes<T>(text: string | null, clean: (v: unknown) => T | null): NoteMap<T> {
  if (!text) return {};
  try {
    const f = JSON.parse(text) as { v?: unknown; notes?: unknown };
    if (!f || f.v !== 1 || !f.notes || typeof f.notes !== 'object') return {};
    const out: NoteMap<T> = {};
    for (const [id, v] of Object.entries(f.notes as Record<string, unknown>)) {
      const c = clean(v);
      if (c) out[id] = c;
    }
    return out;
  } catch {
    return {};
  }
}

export const parseLocal = (text: string | null) => parseNotes(text, cleanLocal);
export const parseSynced = (text: string | null) => parseNotes(text, cleanSynced);

/** Per note, the newer entry wins; notes only one side has are kept. */
export function mergeSynced(disk: NoteMap<SyncedPage>, mine: NoteMap<SyncedPage>): NoteMap<SyncedPage> {
  const out: NoteMap<SyncedPage> = { ...disk };
  for (const [id, p] of Object.entries(mine)) {
    const d = out[id];
    if (!d || p.at >= d.at) out[id] = p;
  }
  return out;
}

/** Keep the `max` most recently viewed notes. */
export function prune<T extends { at: number }>(m: NoteMap<T>, max = MAX_NOTES): NoteMap<T> {
  const ids = Object.keys(m);
  if (ids.length <= max) return m;
  ids.sort((a, b) => m[b].at - m[a].at);
  const out: NoteMap<T> = {};
  for (const id of ids.slice(0, max)) out[id] = m[id];
  return out;
}

/** Index of the page to show: by id first (pages may have moved), else the old index, clamped. */
export function resolvePage(pages: readonly { id: string }[], pageId: string, pageIndex: number): number {
  if (!pages.length) return 0;
  const byId = pageId ? pages.findIndex((p) => p.id === pageId) : -1;
  if (byId >= 0) return byId;
  return Math.max(0, Math.min(pages.length - 1, Math.floor(pageIndex)));
}

/**
 * Decide what a note opens on. This device's view wins unless another device viewed the note
 * more recently: then its page, at this device's zoom when the window is about as wide as before.
 */
export function chooseRestore(local: LocalView | undefined, synced: SyncedPage | undefined, ctx: { viewW: number; board: boolean }): RestorePlan {
  if (ctx.board) return local?.board ? { kind: 'exact', view: local } : { kind: 'default' };
  if (local && (!synced || local.at >= synced.at)) return { kind: 'exact', view: local };
  if (synced) {
    const zoomOk = !!local && ctx.viewW > 0 && local.viewW > 0 && Math.abs(ctx.viewW - local.viewW) / local.viewW < ZOOM_WIDTH_TOLERANCE;
    return { kind: 'page', pageId: synced.pageId, pageIndex: synced.pageIndex, zoom: zoomOk ? local.zoom : null, x: zoomOk ? local.x : 0 };
  }
  return { kind: 'default' };
}

const pageKey = (v: ViewSnapshot): string => (v.board ? '' : v.pageId || String(v.pageIndex));

interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/**
 * Debounce with a maximum wait: runs `delay` after the last call, but never later than `maxWait`
 * after the first call of a burst.
 */
class Debounce {
  private timer: number | null = null;
  private firstAt = 0;

  constructor(
    private readonly fn: () => void,
    private readonly delay: number,
    private readonly maxWait: number,
    private readonly timers: Timers,
    private readonly now: () => number,
  ) {}

  trigger(): void {
    const t = this.now();
    if (this.timer === null) this.firstAt = t;
    else this.timers.clear(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstAt + this.maxWait - t));
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.fn();
    }, wait);
  }

  /** Cancel the pending run; true when one was pending. */
  cancel(): boolean {
    if (this.timer === null) return false;
    this.timers.clear(this.timer);
    this.timer = null;
    return true;
  }
}

/** Serialises writes of one file: at most one in flight, and one more if asked meanwhile. */
class Writer {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly write: () => Promise<void>) {}

  request(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          try {
            await this.write();
          } catch (e) {
            console.warn('HandNote: could not save the last viewed page', e);
          }
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
}

export class ViewStateStore {
  private localNotes: NoteMap<LocalView> = {};
  /** view-sync.json as last read or written (refreshed in the background when a note opens) */
  private syncedNotes: NoteMap<SyncedPage> = {};
  private refreshing: Promise<void> | null = null;
  /** synced pages recorded on this device and not yet written */
  private syncPending: NoteMap<SyncedPage> = {};
  /** last page recorded per note (only a change is recorded) */
  private lastPage = new Map<string, string>();
  private readonly localWriter: Writer;
  private readonly syncWriter: Writer;
  private readonly localLater: Debounce;
  private readonly syncLater: Debounce;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
    timers: Timers = windowTimers,
  ) {
    this.localWriter = new Writer(() => this.writeLocal());
    this.syncWriter = new Writer(() => this.writeSync());
    this.localLater = new Debounce(() => void this.localWriter.request(), LOCAL_VIEW_DELAY_MS, LOCAL_VIEW_MAX_WAIT_MS, timers, now);
    this.syncLater = new Debounce(() => void this.syncWriter.request(), SYNC_DELAY_MS, SYNC_MAX_WAIT_MS, timers, now);
  }

  async load(): Promise<void> {
    const [local, synced] = await Promise.all([this.read(LOCAL_FILE), this.read(SYNC_FILE)]);
    this.localNotes = parseLocal(local);
    this.syncedNotes = parseSynced(synced);
  }

  local(docId: string): LocalView | undefined {
    return this.localNotes[docId];
  }

  /** The page last viewed on any device, as far as known now (no disk access: notes open at once). */
  synced(docId: string): SyncedPage | undefined {
    const p = this.syncPending[docId];
    const d = this.syncedNotes[docId];
    return p && (!d || p.at >= d.at) ? p : d;
  }

  /** Read view-sync.json again: a sync may have delivered another device's pages since. */
  refreshSynced(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        this.syncedNotes = mergeSynced(this.syncedNotes, parseSynced(await this.read(SYNC_FILE)));
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * The view moved. A new page is written to this device's file right away (and to the synced
   * file shortly after); a move within the page is written once the view has settled.
   */
  record(docId: string, v: ViewSnapshot): void {
    const at = this.now();
    const prev = this.localNotes[docId];
    this.localNotes[docId] = { ...v, at };
    const key = pageKey(v);
    // the first record after opening compares with the view the note was opened on (this device's,
    // or another device's newer page): opening a note is not a page change, so it writes nothing
    // to the synced file
    if ((this.lastPage.get(docId) ?? this.openedOn(docId, prev)) !== key) {
      this.lastPage.set(docId, key);
      if (!v.board) {
        this.syncPending[docId] = { pageId: v.pageId, pageIndex: v.pageIndex, at };
        this.syncLater.trigger();
      }
      this.localLater.cancel();
      void this.localWriter.request();
    } else {
      this.lastPage.set(docId, key);
      this.localLater.trigger();
    }
  }

  /** Page key of the view a note opens on, as chooseRestore picks it. */
  private openedOn(docId: string, prev: LocalView | undefined): string | null {
    const s = this.synced(docId);
    if (s && (!prev || s.at > prev.at)) return s.pageId || String(s.pageIndex);
    return prev ? pageKey(prev) : null;
  }

  /** Write everything now (note closed, app hidden or quitting). */
  async flush(): Promise<void> {
    const local = this.localLater.cancel();
    const sync = this.syncLater.cancel() || Object.keys(this.syncPending).length > 0;
    await Promise.all([local ? this.localWriter.request() : this.localWriter.idle(), sync ? this.syncWriter.request() : this.syncWriter.idle()]);
  }

  private async writeLocal(): Promise<void> {
    this.localNotes = prune(this.localNotes);
    await this.write(LOCAL_FILE, JSON.stringify({ v: 1, notes: this.localNotes }));
  }

  private async writeSync(): Promise<void> {
    const pending = this.syncPending;
    if (!Object.keys(pending).length) return;
    this.syncPending = {};
    try {
      // merge with what is on disk now: another device's pages arrived through the sync
      const merged = prune(mergeSynced(parseSynced(await this.read(SYNC_FILE)), pending));
      await this.write(SYNC_FILE, JSON.stringify({ v: 1, notes: merged }));
      this.syncedNotes = prune(mergeSynced(this.syncedNotes, merged));
    } catch (e) {
      // keep them for the next write (newer entries recorded meanwhile win)
      this.syncPending = mergeSynced(pending, this.syncPending);
      throw e;
    }
  }

  private async read(name: string): Promise<string | null> {
    const p = `${this.dir}/${name}`;
    try {
      if (!(await this.adapter.exists(p))) return null;
      return await this.adapter.read(p);
    } catch {
      return null;
    }
  }

  private async write(name: string, text: string): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    await this.adapter.write(`${this.dir}/${name}`, text);
  }
}
