declare const __HN_PRIVATE__: boolean;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PACKS, packBytes, packPinned } from '../../src/local/manifest';
import { installPack, installOrder, resetMirrorProbes, tarMember } from '../../src/local/download';
import { MemoryStore, ModelStore, fileKey } from '../../src/local/store';
import { compactLatex, isWellFormed, repairTokens } from '../../src/local/latex';
import { HandwritingRecognitionService, type LocalApi } from '../../src/recognition/service';
import { defaultAISettings, type AISettings } from '../../src/ai/service';
import { MATH_CASES, mathInk } from '../../src/local/synthetic-math';
import { WORKER_SRC } from '../../src/local/worker-src.generated';

test('0.7 packs: every file pinned (size + SHA-256), official source first, runtime needed by models', () => {
  for (const id of ['runtime', 'text-zh', 'text-en', 'font-hand'] as const) assert.ok(packPinned(id), id);
  // the math pack exists only in the private edition
  assert.equal(packPinned('math'), __HN_PRIVATE__, `math pack pinned only in the private edition`);
  assert.equal(PACKS['font-hand'].files.length, 216, 'Excalidraw subsets');
  assert.deepEqual(installOrder('math'), ['runtime', 'math']);
  assert.ok(PACKS['text-zh'].files[0].urls[0].includes('paddle-model-ecology.bj.bcebos.com'), 'PaddleOCR official download first');
  assert.ok(PACKS.runtime.files.every((f) => f.urls.every((u) => u.includes('onnxruntime-web@1.24.2') || u.includes('onnxruntime-web/1.24.2'))), 'runtime version pinned on every mirror');
  const mb = (n: number) => n / 1048576;
  if (__HN_PRIVATE__) assert.ok(mb(packBytes('math')) > 19 && mb(packBytes('math')) < 21, `math + runtime ≈ 20 MB (${mb(packBytes('math')).toFixed(1)})`);
  else assert.equal(PACKS.math.files.length, 0, 'public edition: no math files, no sources');
  assert.ok(mb(packBytes('text-zh')) > 27 && mb(packBytes('text-zh')) < 29, `text + runtime ≈ 28 MB (${mb(packBytes('text-zh')).toFixed(1)})`);
});


test('0.7 install: wrong / truncated bytes from a mirror are rejected, the next mirror is used; damaged files are detected and removed', async () => {
  const data = new TextEncoder().encode('model-bytes-0123456789');
  const sha = createHash('sha256').update(data).digest('hex');
  const saved = PACKS.runtime.files.map((f) => ({ ...f }));
  const savedMath = PACKS.math.files.map((f) => ({ ...f }));
  try {
    PACKS.runtime.files = [{ name: 'a.bin', bytes: data.length, sha256: sha, urls: ['https://bad.example/a.bin', 'https://good.example/a.bin'] }];
    PACKS.math.files = [{ name: 'm.bin', bytes: data.length, sha256: sha, urls: ['https://cdn.example/x.tar#tar=m.bin'] }];
    // ustar archive with m.bin inside
    const tar = new Uint8Array(1536);
    const enc = new TextEncoder();
    tar.set(enc.encode('dir/m.bin'), 0);
    tar.set(enc.encode(data.length.toString(8).padStart(11, '0')), 124);
    tar[156] = 48;
    tar.set(enc.encode('ustar'), 257);
    tar.set(data, 512);
    const calls: string[] = [];
    const fetchBinary = async (url: string) => {
      calls.push(url);
      if (url.includes('bad.example')) return new TextEncoder().encode('model-bytes-XXXXXXXXXX').buffer;
      if (url.includes('cdn.example')) return tar.buffer.slice(0);
      return data.buffer.slice(0);
    };
    const mem = new MemoryStore();
    const store = new ModelStore(mem);
    await installPack('math', store, fetchBinary);
    assert.deepEqual([...calls].sort(), ['https://bad.example/a.bin', 'https://cdn.example/x.tar', 'https://good.example/a.bin'], 'bad mirror tried once, then the next (parallel downloads)');
  assert.ok(calls.indexOf('https://bad.example/a.bin') < calls.indexOf('https://good.example/a.bin'));
    assert.equal((await store.state('math', true)).installed, true);
    // re-install does not download again
    await installPack('math', store, fetchBinary);
    assert.equal(calls.length, 3);
    // damage a stored file → detected on verify, removed, reported
    const k = fileKey('math', 'm.bin');
    const f = mem.map.get(k)!;
    const broken = new Uint8Array(f.data.slice(0));
    broken[3] ^= 255;
    mem.map.set(k, { ...f, data: broken.buffer });
    const fresh = new ModelStore(mem);
    const st = await fresh.state('math', true);
    assert.equal(st.installed, false);
    assert.deepEqual(st.damaged, ['m.bin']);
    assert.equal(mem.map.has(k), false, 'damaged file removed');
    await assert.rejects(fresh.file('math', 'm.bin'));
    // all mirrors wrong → InstallError, nothing stored
    PACKS.runtime.files[0].urls = ['https://bad.example/a.bin'];
    const empty = new ModelStore(new MemoryStore());
    await assert.rejects(installPack('runtime', empty, fetchBinary), /no mirror delivered/);
    assert.equal((await empty.state('runtime')).have, 0);
    assert.equal(tarMember(tar.buffer, 'nope'), null);
  } finally {
    PACKS.runtime.files = saved;
    PACKS.math.files = savedMath;
  }
});

test('beta.4 install: mirrors probed first (once per host); the fastest reachable host is used, a dead one is not waited for; file size passed for the timeout', async () => {
  const data = new TextEncoder().encode('model-bytes-0123456789');
  const sha = createHash('sha256').update(data).digest('hex');
  const saved = PACKS.runtime.files.map((f) => ({ ...f }));
  try {
    resetMirrorProbes();
    PACKS.runtime.files = ['a', 'b', 'c'].map((n) => ({ name: `${n}.bin`, bytes: data.length, sha256: sha, urls: [`https://dead.example/${n}.bin`, `https://slow.example/${n}.bin`, `https://fast.example/${n}.bin`] }));
    const probed: string[] = [];
    const probe = async (url: string) => {
      probed.push(new URL(url).host);
      if (url.includes('dead')) throw new Error('timeout (8 s)');
      return url.includes('slow') ? 1400 : 60;
    };
    const calls: { url: string; bytes?: number }[] = [];
    const fetchBinary = async (url: string, bytes?: number) => {
      calls.push({ url, bytes });
      if (url.includes('dead')) await new Promise(() => undefined); // would hang forever
      return data.buffer.slice(0);
    };
    const store = new ModelStore(new MemoryStore());
    await installPack('runtime', store, fetchBinary, undefined, undefined, 2, probe);
    assert.deepEqual([...probed].sort(), ['dead.example', 'fast.example', 'slow.example'], 'each host probed once');
    assert.ok(calls.every((c) => c.url.includes('fast.example')), `only the fast mirror used: ${calls.map((c) => c.url).join(' ')}`);
    assert.ok(calls.every((c) => c.bytes === data.length), 'expected size passed for the timeout');
    assert.equal((await store.state('runtime', true)).installed, true);
    // every mirror unreachable by probe → still tried (probe may be wrong), in listed order
    resetMirrorProbes();
    const calls2: string[] = [];
    await installPack('runtime', new ModelStore(new MemoryStore()), async (url) => (calls2.push(url), url.includes('dead') ? Promise.reject(new Error('x')) : data.buffer.slice(0)), undefined, undefined, 1, async () => Promise.reject(new Error('offline')));
    assert.ok(calls2[0].includes('dead.example') && calls2.some((u) => u.includes('slow.example')), calls2.join(' '));
  } finally {
    PACKS.runtime.files = saved;
    resetMirrorProbes();
  }
});

test('0.7 LaTeX: decoder slips repaired; structure check; compact output', () => {
  assert.deepEqual(repairTokens(['x', '^', '{', '2']), ['x', '^', '{', '2', '}']);
  assert.deepEqual(repairTokens(['\\frac', '{', 'a', '}', '{', 'b', '}', '{', '}']), ['\\frac', '{', 'a', '}', '{', 'b', '}']);
  assert.deepEqual(repairTokens(['\\sqrt', 'x']), ['\\sqrt', '{', 'x', '}']);
  assert.deepEqual(repairTokens(['a', '}', '+', 'b']), ['a', '+', 'b']);
  assert.ok(isWellFormed(['x', '^', '{', '2', '}']));
  assert.ok(!isWellFormed(['x', '+']));
  assert.ok(!isWellFormed(['\\frac', '{', '}', '{', 'b', '}']));
  assert.equal(compactLatex(['\\sqrt', '{', 'x', '^', '{', '2', '}', '+', 'y', '}']), '\\sqrt{x^{2}+y}');
  assert.equal(compactLatex(['\\pi', 'r', '^', '{', '2', '}']), '\\pi r^{2}');
});

test('0.7 synthetic math ink: every case lays out (MOCK data for pipeline tests)', () => {
  for (const c of MATH_CASES) {
    const s = mathInk(c.node, { seed: 3 });
    assert.ok(s.length >= 2 && s.every((st) => st.length >= 2), c.name);
  }
});

test('0.7 worker program is embedded without ONNX Runtime and without dynamic import', () => {
  assert.ok(WORKER_SRC.includes('__hnLocalStart'));
  assert.ok(!WORKER_SRC.includes('import('));
  assert.ok(WORKER_SRC.length < 20000, `${WORKER_SRC.length} bytes`);
});

function svc(local: Partial<LocalApi> & { readyIds: string[] }, patch: Partial<AISettings['recognition']> = {}) {
  const s: AISettings = { ...defaultAISettings(), enabled: true, defaultModel: 'mock-1' };
  s.recognition = { ...s.recognition, ...patch };
  const api: LocalApi = {
    ready: (id) => local.readyIds.includes(id),
    math: local.math ?? (async () => ({ result: { task: 'math', latex: 'x^{2}', alternatives: [], warnings: [] }, confident: true, ms: { render: 1, infer: 5, total: 6 }, mode: 'worker' })),
    text: local.text ?? (async () => ({ result: { task: 'text', lines: [{ text: '永', alternatives: [] }], warnings: [] }, confident: false, ms: { render: 1, infer: 5, total: 6 }, mode: 'worker' })),
    warm: () => undefined,
  };
  return new HandwritingRecognitionService({ local: api, ai: null, settings: () => s, recognition: () => s.recognition, getSecret: () => 'k', secretsSupported: true, http: (async () => ({ status: 500, text: '' })) as never });
}

const INK = [{ id: 'a', xs: [0, 10], ys: [0, 0], ts: [0, 10], ps: [0.5, 0.5] }];

test('0.7 routing: auto = on device first; MyScript keys alone no longer imply MyScript; missing local math explains (install), never guesses', async () => {
  let r = svc({ readyIds: ['math', 'text-zh'] }, { myscriptAppKeySecret: 'ms' });
  assert.equal(r.engineFor('math').engine, 'local');
  assert.equal(r.engineFor('math').sends, 'nothing');
  assert.equal(r.engineFor('text').engine, 'local');
  const run = await r.recognize('math', { selectionId: 's', language: 'zh', ink: INK });
  assert.equal(run.engine, 'local');
  assert.equal(run.confident, true);
  assert.ok(run.stages.some((s) => s.name === 'request'));
  const tx = await r.recognize('text', { selectionId: 's', language: 'zh', ink: INK });
  assert.equal(tx.confident, false, 'uncertain local result is flagged (preview with candidates)');
  // nothing installed: text falls back to the bundled offline engine, math explains
  r = svc({ readyIds: [] }, { myscriptAppKeySecret: 'ms' });
  assert.equal(r.engineFor('text').engine, 'offline');
  assert.equal(r.engineFor('math').ready, false);
  assert.equal(r.engineFor('math').reason, 'local-math-missing');
  // explicit MyScript still works
  r = svc({ readyIds: ['math'] }, { engine: 'myscript', myscriptAppKeySecret: 'ms' });
  assert.equal(r.engineFor('math').engine, 'myscript');
});

// 0.7.0-beta.7: converted text matches the handwriting; grouped text pieces read as one text
import { buildTextBlock, sizeForLine } from '../../src/convert/build';
import { mergeTextPieces, textUnit } from '../../src/editor/text-unit';
import { textWidth } from '../../src/rendering/items-paint';

test('beta.7 build: converted text is as wide as the handwriting (not just as tall), where it was written', () => {
  // English handwriting: tall line (ascenders / descenders) but not that wide
  const ink = [{ index: 0, strokeIds: ['a'], x: 100, y: 100, w: 300, h: 60 }];
  const b = buildTextBlock([{ text: 'Today is Saturday', alternatives: [] }], ink, { x: 100, y: 100, w: 300, h: 60 }, { font: 'hand', color: '#e8590c', dx: 0, dy: 0 });
  assert.ok(b);
  const byHeight = sizeForLine(60);
  assert.ok(b.size < byHeight, `narrowed (${b.size} < ${byHeight})`);
  const w = textWidth(b, b.text);
  assert.ok(Math.abs(w - 300) < 20, `about the ink's width (${Math.round(w)} vs 300)`);
  assert.ok(Math.abs(b.x - 96) < 1 && Math.abs(b.y + b.h / 2 - 130) < 8, `on the handwriting (${b.x}, ${Math.round(b.y + b.h / 2)})`);
  // a short word written very wide grows a little, never far beyond its height
  const wide = buildTextBlock([{ text: 'hi', alternatives: [] }], [{ index: 0, strokeIds: ['a'], x: 0, y: 0, w: 400, h: 40 }], { x: 0, y: 0, w: 400, h: 40 }, { font: 'sans', color: '#000', dx: 0, dy: 0 });
  assert.ok(wide && wide.size <= sizeForLine(40) * 1.3 + 0.5 && wide.size > sizeForLine(40), `capped (${wide?.size})`);
});

test('beta.7 grouped text pieces ("Today is " + "Sa" + "turday") are edited as one text in reading order', () => {
  const base = { type: 'text' as const, w: 10, h: 10, created: 1, size: 40, color: '#000', font: 'hand' as const, bold: false, italic: false, align: 'left' as const, autoWidth: true, g: 'g1' };
  const a = { ...base, id: 'a', text: 'Today is ', x: 100, y: 100 };
  const sa = { ...base, id: 'b', text: 'Sa', x: 100 + textWidth(base, 'Today is '), y: 101, color: '#c92a2a' };
  const tu = { ...base, id: 'c', text: 'turday', x: 100 + textWidth(base, 'Today is Sa'), y: 100 };
  const word2 = { ...base, id: 'd', text: 'again', x: 100 + textWidth(base, 'Today is Saturday') + 30, y: 99 };
  const line2 = { ...base, id: 'e', text: 'ok', x: 100, y: 160 };
  const lone = { ...base, id: 'f', text: 'x', x: 0, y: 0, g: undefined };
  const items = [line2, tu, word2, sa, a, lone];
  assert.equal(textUnit(items, 'f'), null, 'ungrouped text stands alone');
  const unit = textUnit(items, 'b');
  assert.equal(unit?.length, 5);
  const m = mergeTextPieces(unit!);
  assert.equal(m.text, 'Today is Saturday again\nok');
  assert.equal(m.x, 100);
  assert.equal(m.y, 99);
  assert.equal(m.color, '#000', 'style of the first piece');
});
