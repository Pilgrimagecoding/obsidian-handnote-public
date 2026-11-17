import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataAdapter } from 'obsidian';
import {
  LOCAL_VIEW_DELAY_MS,
  LOCAL_VIEW_MAX_WAIT_MS,
  SYNC_DELAY_MS,
  SYNC_MAX_WAIT_MS,
  ViewStateStore,
  chooseRestore,
  mergeSynced,
  parseLocal,
  parseSynced,
  prune,
  resolvePage,
  type LocalView,
  type SyncedPage,
  type ViewSnapshot,
} from '../../src/storage/view-state';

const DIR = '.obsidian/plugins/handnote';

/** In-memory adapter that counts writes per file. */
function fakeAdapter(files: Record<string, string> = {}) {
  const writes: Record<string, number> = {};
  const a = {
    files,
    writes,
    exists: async (p: string) => p === DIR || p in files,
    read: async (p: string) => {
      if (!(p in files)) throw new Error('missing');
      return files[p];
    },
    write: async (p: string, s: string) => {
      await Promise.resolve();
      files[p] = s;
      writes[p.split('/').pop()!] = (writes[p.split('/').pop()!] ?? 0) + 1;
    },
    mkdir: async () => undefined,
  };
  return a;
}

/** Manual clock and timers. */
function fakeTime() {
  let now = 1_000_000;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: number) => void pending.delete(id),
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
    pendingCount: () => pending.size,
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const view = (pageIndex: number, offsetY = 0, zoom = 1): ViewSnapshot => ({ pageId: `p${pageIndex}`, pageIndex, x: 0, offsetY, zoom, viewW: 1000 });
const lv = (v: Partial<LocalView>): LocalView => ({ pageId: 'p3', pageIndex: 3, x: 0, offsetY: 40, zoom: 1.5, viewW: 1000, at: 100, ...v });
const sp = (pageId: string, at: number, pageIndex = 0): SyncedPage => ({ pageId, pageIndex, at });

function makeStore(files: Record<string, string> = {}) {
  const adapter = fakeAdapter(files);
  const time = fakeTime();
  const store = new ViewStateStore(adapter as unknown as DataAdapter, DIR, time.now, time.timers);
  return { adapter, time, store };
}

test('view state: mergeSynced keeps the newest entry per note and notes only one side has', () => {
  const disk = { a: sp('pa1', 10), b: sp('pb1', 50), c: sp('pc', 5) };
  const mine = { a: sp('pa2', 20), b: sp('pb2', 40), d: sp('pd', 1) };
  const m = mergeSynced(disk, mine);
  assert.equal(m.a.pageId, 'pa2', 'mine is newer');
  assert.equal(m.b.pageId, 'pb1', 'disk is newer');
  assert.equal(m.c.pageId, 'pc');
  assert.equal(m.d.pageId, 'pd');
});

test('view state: prune keeps the most recently viewed notes', () => {
  const m: Record<string, SyncedPage> = {};
  for (let i = 0; i < 520; i++) m[`d${i}`] = sp('p', i);
  const p = prune(m);
  assert.equal(Object.keys(p).length, 500);
  assert.ok(!('d0' in p) && !('d19' in p));
  assert.ok('d20' in p && 'd519' in p);
  const small = { a: sp('p', 1) };
  assert.equal(prune(small), small);
});

test('view state: resolvePage by id, else by index, clamped', () => {
  const pages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolvePage(pages, 'c', 0), 2, 'page moved: found by id');
  assert.equal(resolvePage(pages, 'gone', 1), 1, 'page deleted: same position');
  assert.equal(resolvePage(pages, 'gone', 9), 2, 'note got shorter: last page');
  assert.equal(resolvePage(pages, '', -3), 0);
  assert.equal(resolvePage([], 'a', 4), 0);
});

test('view state: chooseRestore', () => {
  const ctx = { viewW: 1000, board: false };
  assert.deepEqual(chooseRestore(undefined, undefined, ctx), { kind: 'default' });
  // this device viewed it last
  const local = lv({ at: 200 });
  assert.deepEqual(chooseRestore(local, sp('p1', 100, 1), ctx), { kind: 'exact', view: local });
  assert.deepEqual(chooseRestore(local, undefined, ctx), { kind: 'exact', view: local });
  assert.deepEqual(chooseRestore(local, sp('p3', 200, 3), ctx), { kind: 'exact', view: local }, 'tie: this device');
  // another device viewed it later: its page, this device's zoom
  assert.deepEqual(chooseRestore(lv({ at: 200, x: 150 }), sp('p1', 300, 1), ctx), { kind: 'page', pageId: 'p1', pageIndex: 1, zoom: 1.5, x: 150 }, 'zoomed in: same side of the page');
  // ... but fit width when the window is much wider or narrower than when that zoom was set
  assert.deepEqual(chooseRestore(lv({ at: 200, x: 150 }), sp('p1', 300, 1), { viewW: 1400, board: false }), { kind: 'page', pageId: 'p1', pageIndex: 1, zoom: null, x: 0 });
  assert.deepEqual(chooseRestore(local, sp('p1', 300, 1), { viewW: 0, board: false }), { kind: 'page', pageId: 'p1', pageIndex: 1, zoom: null, x: 0 }, 'width unknown yet');
  // never viewed on this device
  assert.deepEqual(chooseRestore(undefined, sp('p2', 300, 2), ctx), { kind: 'page', pageId: 'p2', pageIndex: 2, zoom: null, x: 0 });
  // whiteboard: only this device's camera
  const board = lv({ pageId: '', board: { x: 5, y: 6, zoom: 0.5 } });
  assert.deepEqual(chooseRestore(board, sp('x', 999), { viewW: 1000, board: true }), { kind: 'exact', view: board });
  assert.deepEqual(chooseRestore(local, sp('x', 999), { viewW: 1000, board: true }), { kind: 'default' }, 'no whiteboard camera recorded');
  assert.deepEqual(chooseRestore(undefined, sp('x', 999), { viewW: 1000, board: true }), { kind: 'default' });
});

test('view state: damaged or foreign files load as empty', () => {
  assert.deepEqual(parseLocal(null), {});
  assert.deepEqual(parseLocal('{not json'), {});
  assert.deepEqual(parseLocal('{"v":2,"notes":{"a":{}}}'), {});
  assert.deepEqual(parseSynced('[]'), {});
  // bad entries are dropped, good ones kept
  const text = JSON.stringify({ v: 1, notes: { good: sp('p', 5, 2), bad: { pageId: 3 }, nan: { pageId: 'x', pageIndex: 'a', at: 1 } } });
  assert.deepEqual(Object.keys(parseSynced(text)), ['good']);
  const l = JSON.stringify({ v: 1, notes: { a: lv({}), z: lv({ zoom: 0 }) } });
  assert.deepEqual(Object.keys(parseLocal(l)), ['a']);
});

test('view state: a page change is written to this device right away, the synced file after its delay', async () => {
  const { adapter, time, store } = makeStore();
  await store.load();
  store.record('doc', view(0));
  store.record('doc', view(3));
  await settle();
  assert.ok((adapter.writes['view-local.json'] ?? 0) >= 1, 'local written without waiting');
  assert.equal(adapter.writes['view-sync.json'], undefined, 'synced file waits');
  assert.equal(parseLocal(adapter.files[`${DIR}/view-local.json`]).doc.pageIndex, 3);
  await time.advance(SYNC_DELAY_MS);
  assert.equal(adapter.writes['view-sync.json'], 1);
  assert.equal(parseSynced(adapter.files[`${DIR}/view-sync.json`]).doc.pageId, 'p3');
});

test('view state: a fast fling through 40 pages makes only a few writes', async () => {
  const { adapter, time, store } = makeStore();
  await store.load();
  for (let i = 0; i < 40; i++) store.record('doc', view(i));
  await settle();
  await time.advance(SYNC_MAX_WAIT_MS + 100);
  assert.ok(adapter.writes['view-local.json'] <= 3, `local writes: ${adapter.writes['view-local.json']}`);
  assert.equal(adapter.writes['view-sync.json'], 1);
  assert.equal(parseLocal(adapter.files[`${DIR}/view-local.json`]).doc.pageIndex, 39, 'the last page wins');
  assert.equal(parseSynced(adapter.files[`${DIR}/view-sync.json`]).doc.pageIndex, 39);
});

test('view state: moving within a page waits for the view to settle (with a maximum wait)', async () => {
  const { adapter, time, store } = makeStore();
  await store.load();
  store.record('doc', view(2, 0));
  await settle();
  const base = adapter.writes['view-local.json'];
  store.record('doc', view(2, 50));
  await time.advance(LOCAL_VIEW_DELAY_MS - 10);
  assert.equal(adapter.writes['view-local.json'], base, 'not yet');
  await time.advance(20);
  assert.equal(adapter.writes['view-local.json'], base + 1);
  assert.equal(parseLocal(adapter.files[`${DIR}/view-local.json`]).doc.offsetY, 50);
  // continuous scrolling within the page still writes within the maximum wait
  for (let i = 0; i < 40; i++) {
    store.record('doc', view(2, 60 + i, 1));
    await time.advance(100);
  }
  assert.ok(adapter.writes['view-local.json'] >= base + 2, 'written during continuous movement');
  assert.ok(LOCAL_VIEW_MAX_WAIT_MS <= 4000);
  // no page change: the synced file is not touched
  await time.advance(SYNC_MAX_WAIT_MS);
  assert.equal(adapter.writes['view-sync.json'], 1, 'only the first page');
});

test('view state: reopening on the stored page does not write the synced file', async () => {
  const files = { [`${DIR}/view-local.json`]: JSON.stringify({ v: 1, notes: { doc: lv({ pageId: 'p3', pageIndex: 3, at: 5 }) } }) };
  const { adapter, time, store } = makeStore(files);
  await store.load();
  assert.equal(store.local('doc')?.pageIndex, 3);
  store.record('doc', view(3, 40));
  await time.advance(SYNC_MAX_WAIT_MS);
  assert.equal(adapter.writes['view-sync.json'], undefined);
  assert.equal(adapter.writes['view-local.json'], 1, 'the new time is still saved locally');
});

test('view state: flush writes everything now and leaves no timers', async () => {
  const { adapter, time, store } = makeStore();
  await store.load();
  store.record('doc', view(1));
  store.record('doc', view(1, 30));
  await store.flush();
  assert.equal(parseLocal(adapter.files[`${DIR}/view-local.json`]).doc.offsetY, 30);
  assert.equal(parseSynced(adapter.files[`${DIR}/view-sync.json`]).doc.pageIndex, 1);
  assert.equal(time.pendingCount(), 0);
  const w = { ...adapter.writes };
  await store.flush();
  assert.deepEqual(adapter.writes, w, 'nothing to write: no write');
});

test('view state: the synced file is merged with what another device wrote meanwhile', async () => {
  const { adapter, time, store } = makeStore();
  await store.load();
  store.record('mine', view(4));
  // another device's sync delivers its file before our delayed write
  const later = time.now() + 10_000;
  adapter.files[`${DIR}/view-sync.json`] = JSON.stringify({ v: 1, notes: { theirs: sp('t2', later, 2), mine: sp('old', 1, 0) } });
  await time.advance(SYNC_MAX_WAIT_MS);
  const m = parseSynced(adapter.files[`${DIR}/view-sync.json`]);
  assert.equal(m.theirs.pageId, 't2', 'their note kept');
  assert.equal(m.mine.pageId, 'p4', 'our newer page wins');
  // reading for a note sees both the file and what is not written yet
  store.record('other', view(7));
  assert.equal((await store.synced('other'))?.pageIndex, 7);
  assert.equal((await store.synced('theirs'))?.pageId, 't2');
});

test('view state: a failed write is retried with the next one', async () => {
  const { adapter, time, store } = makeStore();
  await store.load();
  const write = adapter.write;
  let fail = true;
  adapter.write = async (p: string, s: string) => {
    if (fail && p.endsWith('view-sync.json')) throw new Error('disk full');
    return write(p, s);
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    store.record('doc', view(2));
    await time.advance(SYNC_MAX_WAIT_MS);
    assert.equal(adapter.files[`${DIR}/view-sync.json`], undefined);
    fail = false;
    await store.flush();
    assert.equal(parseSynced(adapter.files[`${DIR}/view-sync.json`]).doc.pageIndex, 2);
  } finally {
    console.warn = warn;
  }
});

test('view state: opening a note on another device\'s newer page writes nothing to the synced file', async () => {
  const files = {
    [`${DIR}/view-local.json`]: JSON.stringify({ v: 1, notes: { doc: lv({ pageId: 'p3', pageIndex: 3, at: 5 }) } }),
    [`${DIR}/view-sync.json`]: JSON.stringify({ v: 1, notes: { doc: sp('p7', 50, 7) } }),
  };
  const { adapter, time, store } = makeStore(files);
  await store.load();
  assert.equal(store.synced('doc')?.pageId, 'p7', 'known at once from the file read at startup');
  // the note opened on page 8 (the other device's page), at this device's zoom
  store.record('doc', view(7));
  await time.advance(SYNC_MAX_WAIT_MS);
  assert.equal(adapter.writes['view-sync.json'], undefined, 'not a page change');
  // turning the page from there is
  store.record('doc', view(8));
  await time.advance(SYNC_MAX_WAIT_MS);
  assert.equal(adapter.writes['view-sync.json'], 1);
});

test('view state: the synced page is known without disk access; a refresh picks up a sync', async () => {
  const { adapter, store } = makeStore({ [`${DIR}/view-sync.json`]: JSON.stringify({ v: 1, notes: { doc: sp('p1', 10, 1) } }) });
  await store.load();
  let reads = 0;
  const read = adapter.read;
  adapter.read = async (p: string) => {
    reads++;
    return read(p);
  };
  assert.equal(store.synced('doc')?.pageId, 'p1');
  assert.equal(reads, 0, 'opening a note reads nothing');
  // another device's sync replaces the file
  adapter.files[`${DIR}/view-sync.json`] = JSON.stringify({ v: 1, notes: { doc: sp('p5', 99, 5), other: sp('q', 3, 0) } });
  await Promise.all([store.refreshSynced(), store.refreshSynced()]);
  assert.equal(reads, 1, 'concurrent refreshes share one read');
  assert.equal(store.synced('doc')?.pageId, 'p5');
  assert.equal(store.synced('other')?.pageId, 'q');
  // an older file (sync rolled back) does not undo a newer known page
  adapter.files[`${DIR}/view-sync.json`] = JSON.stringify({ v: 1, notes: { doc: sp('p0', 1, 0) } });
  await store.refreshSynced();
  assert.equal(store.synced('doc')?.pageId, 'p5');
});
