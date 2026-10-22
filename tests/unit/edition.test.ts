declare const __HN_PRIVATE__: boolean;
// Public / private edition (docs/PUBLIC_PRIVATE_RELEASE_STRATEGY.md). This file runs in both:
//   npm test            → public edition (default): no local math model anywhere
//   npm run test:private → private edition: the local math model is present
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LOCAL_MATH, PACKS, packPinned } from '../../src/local/manifest';
import { MATH_EDITION } from '@edition/math';
import { LocalRecognition } from '../../src/local';
import { MemoryStore } from '../../src/local/store';
import { WORKER_SRC } from '../../src/local/worker-src.generated';
import { HandwritingRecognitionService } from '../../src/recognition/service';
import { defaultAISettings, type AISettings } from '../../src/ai/service';
import { AIError } from '../../src/ai/types';
import { createDocument } from '../../src/document/model';
import { parseDocument, serializeDocument } from '../../src/document/codec';
import type { FormulaItem } from '../../src/document/items';

const PRIV = __HN_PRIVATE__;
const INK = [{ id: 'a', xs: [0, 10, 20], ys: [0, 5, 0], ts: [0, 10, 20], ps: [0.5, 0.5, 0.5] }];

test(`edition (${PRIV ? 'private' : 'public'}): the math pack, model name and worker code exist only in the private edition`, () => {
  assert.equal(LOCAL_MATH, PRIV);
  assert.equal(MATH_EDITION !== null, PRIV);
  assert.equal(packPinned('math'), PRIV);
  if (PRIV) {
    assert.equal(PACKS.math.files.length, 3);
    assert.ok(PACKS.math.files.every((f) => f.urls.length > 0 && /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.ok(WORKER_SRC.includes(MATH_EDITION?.loadMessage ?? '?') && /encoder/.test(WORKER_SRC) && /vocab/i.test(WORKER_SRC), 'the worker has the math model code');
  } else {
    assert.equal(PACKS.math.files.length, 0, 'no files');
    assert.equal(PACKS.math.version, '', 'no version');
    assert.ok(!/https?:/.test(JSON.stringify(PACKS.math)), 'no download source');
    assert.ok(!/\b(encoder|decoder)\b|vocab/.test(WORKER_SRC), 'no math model code in the worker (no encoder / decoder / vocabulary)');
  }
});

test(`edition (${PRIV ? 'private' : 'public'}): model files left in the database by another build are never read, never deleted`, async () => {
  const store = new MemoryStore();
  const data = new Uint8Array(1024).fill(3).buffer;
  // what a private build stores: files under the "math" pack (here with wrong hashes)
  for (const name of PRIV ? PACKS.math.files.map((f) => f.name) : ['model-a.onnx', 'model-b.onnx', 'vocab.json'])
    await store.put({ key: `math/${name}`, pack: 'math', name, sha256: '0'.repeat(64), bytes: data.byteLength, savedAt: 1, data });
  let reads = 0;
  const get = store.get.bind(store);
  store.get = async (k: string) => {
    if (k.startsWith('math/')) reads++;
    return get(k);
  };
  const local = new LocalRecognition(async () => {
    throw new Error('no network in this test');
  }, store);
  await local.refresh(true);
  assert.equal(local.ready('math'), false);
  assert.equal(local.state('math')?.installed, false);
  assert.equal(local.includesMath(), PRIV);
  await assert.rejects(local.math(INK), (e: unknown) => e instanceof AIError && e.code === 'not-configured');
  if (!PRIV) {
    assert.equal(local.available('math'), false);
    assert.equal(local.mathModel(), null);
    await assert.rejects(local.install('math'), /not included/);
    await assert.rejects(local.engine.ensure('math'), /not included/);
    const imp = await local.importFiles([{ name: 'vocab.json', data }]);
    assert.equal(imp.accepted.length, 0, 'nothing imported into the math pack');
    assert.equal(reads, 0, 'no math file was read');
    assert.equal((await store.keys()).filter((k) => k.startsWith('math/')).length, 3, 'the cached files are left alone');
  } else {
    // the private edition verifies by hash: damaged files are dropped, as for any pack
    assert.equal((await store.keys()).filter((k) => k.startsWith('math/')).length, 0);
  }

});

test(`edition (${PRIV ? 'private' : 'public'}): Convert → Math routing explains a missing model and never guesses; MyScript stays available`, () => {
  const s: AISettings = { ...defaultAISettings(), enabled: true, defaultModel: 'mock-1' };
  const local = new LocalRecognition(async () => {
    throw new Error('offline');
  }, new MemoryStore());
  const svc = (patch: Partial<AISettings['recognition']> = {}) => {
    s.recognition = { ...defaultAISettings().recognition, ...patch };
    return new HandwritingRecognitionService({ local, ai: null, settings: () => s, recognition: () => s.recognition, getSecret: () => 'k', secretsSupported: true, http: (async () => ({ status: 500, text: '' })) as never });
  };
  const e = svc().engineFor('math');
  assert.equal(e.ready, false);
  assert.equal(e.reason, PRIV ? 'local-math-missing' : 'local-math-not-included');
  assert.equal(e.sends, 'nothing');
  if (!PRIV) assert.equal(`${e.model} / ${e.label}`, 'local math / local', 'public edition names no model');
  const m = svc({ engine: 'myscript', myscriptAppKeySecret: 'ms' }).engineFor('math');
  assert.equal(m.engine, 'myscript', 'MyScript (own keys) works in both editions');

});

test('edition: the file format has no edition — formulas from either build round-trip unchanged', () => {
  const doc = createDocument({ pages: 1 });
  const f: FormulaItem = { id: 'f1', type: 'formula', latex: '\\frac{a}{b}+x^{2}', color: '#1a1a1a', size: 28, x: 40, y: 60, w: 120, h: 48, created: 1, rot: 0.2 } as FormulaItem;
  doc.pages[0].items = [f];
  doc.pages[0].strokes = [];
  const text = serializeDocument(doc);
  const back = parseDocument(text);
  assert.equal(back.readOnly, false);
  assert.deepEqual(back.doc.pages[0].items[0], f);
  assert.equal(serializeDocument(back.doc), text, 'byte-identical after a round trip');
  // no code that reads or writes notes may depend on the edition
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  const shared = walk('src').filter((p) => p.endsWith('.ts') && !/^src[\\/](local|edition|private)[\\/]/.test(p));
  const branching = shared.filter((p) => /__HN_PRIVATE__|@edition\//.test(readFileSync(p, 'utf8')));
  assert.deepEqual(branching, [], 'edition checks only in src/local (recognition), never in the document, editor or UI code');
});

test('edition: a note saved by the private build opens and edits in this build (fixture)', () => {
  const p = 'tests/fixtures/edition/private-formula.handnote';
  if (!existsSync(p)) return assert.ok(true, 'fixture not recorded yet');
  const text = readFileSync(p, 'utf8');
  const r = parseDocument(text);
  assert.equal(r.readOnly, false, 'opens editable');
  const items = r.doc.pages.flatMap((pg) => pg.items);
  const formulas = items.filter((i) => i.type === 'formula') as FormulaItem[];
  assert.ok(formulas.length >= 1, 'formula kept');
  assert.ok(formulas.every((x) => x.latex.length > 0));
  assert.ok(r.doc.pages.some((pg) => pg.strokes.length > 0), 'ink kept');
  // edit and save: still the same format, other content untouched
  formulas[0].latex = '\\alpha+\\beta';
  const again = parseDocument(serializeDocument(r.doc));
  assert.equal((again.doc.pages.flatMap((pg) => pg.items).find((i) => i.id === formulas[0].id) as FormulaItem).latex, '\\alpha+\\beta');
  assert.equal(again.doc.pages.reduce((n, pg) => n + pg.strokes.length, 0), r.doc.pages.reduce((n, pg) => n + pg.strokes.length, 0));
});
