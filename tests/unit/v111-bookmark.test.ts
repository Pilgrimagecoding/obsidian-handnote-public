// 0.11.1 page bookmarks ("Add to favorites"): an optional page header field, additive to format v7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, FORMAT_VERSION } from '../../src/document/model';
import { parseDocument, recoverDocument, requiredVersion, serializeDocument } from '../../src/document/codec';
import { History } from '../../src/document/history';
import { createBoardDocument } from '../../src/document/board';

test('bookmark: written only on bookmarked pages and read back', () => {
  const doc = createDocument({ pages: 3 });
  doc.pages[1].bookmark = true;
  const text = serializeDocument(doc);
  assert.equal(text.match(/"bookmark":true/g)?.length, 1);
  const back = parseDocument(text).doc;
  assert.deepEqual(
    back.pages.map((p) => p.bookmark),
    [undefined, true, undefined],
  );
});

test('bookmark: does not raise the format version (older plugins open the note normally)', () => {
  const doc = createDocument({ pages: 2 });
  const before = requiredVersion(doc);
  doc.pages[0].bookmark = true;
  assert.equal(requiredVersion(doc), before);
  assert.ok(requiredVersion(doc) <= FORMAT_VERSION);
  assert.equal(parseDocument(serializeDocument(doc)).readOnly, false);
});

test('bookmark: only `true` counts; a whiteboard never has one', () => {
  const doc = createDocument({ pages: 2 });
  const text = serializeDocument(doc).replace(/("pages":\[\n\{"id":"[^"]+")/, '$1,"bookmark":"yes"');
  assert.ok(text.includes('"bookmark":"yes"'));
  assert.equal(parseDocument(text).doc.pages[0].bookmark, undefined);
  const board = createBoardDocument();
  board.pages[0].bookmark = true;
  const b = serializeDocument(board).replace(/("pages":\[\n\{"id":"[^"]+")/, '$1,"bookmark":true');
  assert.ok(b.includes('"bookmark":true'));
  assert.equal(parseDocument(b).doc.pages[0].bookmark, undefined);
});

test('bookmark: survives line-based recovery of a damaged file', () => {
  const doc = createDocument({ pages: 2 });
  doc.pages[1].bookmark = true;
  const lines = serializeDocument(doc).split('\n');
  const damaged = lines.slice(0, -1).join('\n'); // last line lost
  const r = recoverDocument(damaged);
  assert.ok(r);
  assert.equal(r?.doc.pages[1]?.bookmark, true);
});

test('bookmark: moves with its page; undoing a page deletion brings it back bookmarked', () => {
  const doc = createDocument({ pages: 3 });
  const marked = doc.pages[2];
  marked.bookmark = true;
  const h = new History();
  h.push(doc, { kind: 'move-page', pageId: marked.id, from: 2, to: 0 });
  assert.equal(doc.pages[0].bookmark, true);
  h.push(doc, { kind: 'remove-page', index: 0, page: doc.pages[0] });
  assert.ok(!doc.pages.some((p) => p.bookmark));
  h.undo(doc);
  assert.equal(doc.pages[0].bookmark, true);
  h.push(doc, { kind: 'set-page', pageId: marked.id, before: { width: marked.width, height: marked.height, background: marked.background }, after: { width: marked.height, height: marked.width, background: marked.background } });
  assert.equal(doc.pages[0].bookmark, true);
});
