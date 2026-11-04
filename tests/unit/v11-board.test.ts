// 0.11 infinite whiteboards: format v7, conversion from pages, undo back to the note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createPage, defaultBackground, newId, type HandNoteDocument, type Stroke } from '../../src/document/model';
import { parseDocument, quantizeSample, recoverDocument, requiredVersion, serializeDocument } from '../../src/document/codec';
import { History } from '../../src/document/history';
import { BOARD_MARGIN, FRAME_GAP, boardExtent, contentBounds, convertPagesToBoard, createBoardDocument, framesInOrder, isBoard } from '../../src/document/board';
import type { TextItem } from '../../src/document/items';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';

function stroke(pts: [number, number][]): Stroke {
  return {
    id: newId('s'),
    tool: 'fountain',
    color: '#1a1a1a',
    params: { ...DEFAULT_PEN_PARAMS.fountain },
    zoom: 1,
    hasPressure: true,
    engine: 1,
    created: 0,
    samples: pts.map(([x, y], i) => quantizeSample({ x, y, p: 0.5, t: i * 8 })),
  };
}

const text = (x: number, y: number): TextItem => ({ id: newId('t'), type: 'text', x, y, w: 100, h: 20, created: 0, text: 'hi', size: 16, color: '#1a1a1a', font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true });

function threePageNote(): HandNoteDocument {
  const doc = createDocument({ pages: 3 });
  doc.pages[1] = createPage(612, 792, defaultBackground('grid', 'cream'));
  doc.pages[1].doc = { src: 's1', n: 2 };
  doc.sources = { s1: { id: 's1', kind: 'pdf', path: 'HandNote imports/a.pdf', name: 'a.pdf', size: 10, sha256: 'a'.repeat(64), pages: 3, imported: 1 } };
  doc.pages[0].strokes.push(stroke([[10, 10], [100, 40]]));
  doc.pages[1].strokes.push(stroke([[20, 30], [60, 70]]));
  doc.pages[2].items.push(text(50, 60));
  return doc;
}

test('board: a new whiteboard is version 7 with a dotted background and survives a round trip', () => {
  const doc = createBoardDocument();
  assert.ok(isBoard(doc));
  assert.equal(doc.pages[0].background.kind, 'dots');
  assert.equal(requiredVersion(doc), 7);
  doc.pages[0].strokes.push(stroke([[-500, -300], [-200, -100]]));
  const back = parseDocument(serializeDocument(doc));
  assert.equal(back.readOnly, false);
  assert.equal(back.doc.version, 7);
  assert.ok(isBoard(back.doc));
  const p = back.doc.pages[0];
  assert.equal(p.strokes.length, 1);
  assert.equal(p.strokes[0].samples[0].x, -500, 'negative coordinates are kept');
  assert.ok(p.board!.origin[0] <= -500 && p.board!.origin[1] <= -300, 'origin = top-left of the content');
});

test('board: notes with pages are still written as 1–6 (a whiteboard never leaks into a note)', () => {
  const doc = threePageNote();
  assert.equal(requiredVersion(doc), 6);
  const note = createDocument({ pages: 2 });
  assert.equal(requiredVersion(note), 1);
});

test('board: converting lays the pages out left to right, tops aligned, content moved with its page', () => {
  const doc = threePageNote();
  const page = convertPagesToBoard(doc.pages);
  const f = page.board!.frames;
  assert.equal(f.length, 3);
  assert.deepEqual(f.map((x) => [x.x, x.y]), [[0, 0], [595 + FRAME_GAP, 0], [595 + FRAME_GAP + 612 + FRAME_GAP, 0]]);
  assert.deepEqual([f[1].width, f[1].height], [612, 792]);
  assert.equal(f[1].background.kind, 'grid', 'each frame keeps its own paper');
  assert.deepEqual(f[1].doc, { src: 's1', n: 2 }, 'and its imported document page');
  assert.equal(page.strokes[1].samples[0].x, 20 + 595 + FRAME_GAP);
  const it = page.items[0] as TextItem;
  assert.equal(it.x, 50 + 595 + FRAME_GAP + 612 + FRAME_GAP);
  assert.equal(doc.pages[0].strokes[0].samples[0].x, 10, 'the original pages are not changed');
  assert.deepEqual(framesInOrder(page).map((x) => x.id), f.map((x) => x.id));
});

test('board: a converted board keeps the imported document reference when saved', () => {
  const doc = threePageNote();
  doc.pages = [convertPagesToBoard(doc.pages)];
  const back = parseDocument(serializeDocument(doc)).doc;
  assert.equal(back.sources?.s1?.name, 'a.pdf', 'sources referenced only by a frame are written');
  assert.deepEqual(back.pages[0].board!.frames[1].doc, { src: 's1', n: 2 });
});

test('board: conversion is one undo step that brings the note back exactly', () => {
  const doc = threePageNote();
  const before = serializeDocument(doc);
  const h = new History();
  h.push(doc, { kind: 'set-pages', before: doc.pages.slice(), after: [convertPagesToBoard(doc.pages)] });
  assert.ok(isBoard(doc));
  assert.equal(requiredVersion(doc), 7);
  h.undo(doc);
  assert.ok(!isBoard(doc));
  assert.equal(serializeDocument(doc), before, 'byte for byte the same file as before the conversion');
  h.redo(doc);
  assert.ok(isBoard(doc));
});

test('board: moving frames is undoable', () => {
  const doc = threePageNote();
  doc.pages = [convertPagesToBoard(doc.pages)];
  const p = doc.pages[0];
  const before = p.board!.frames.slice();
  const after = before.map((f, i) => (i === 0 ? { ...f, x: f.x - 1000, y: f.y + 50 } : f));
  const h = new History();
  h.push(doc, { kind: 'set-frames', pageId: p.id, before, after });
  assert.equal(p.board!.frames[0].x, -1000);
  h.undo(doc);
  assert.equal(p.board!.frames[0].x, 0);
});

test('board: extent follows the content; an empty board has a page-sized default', () => {
  const doc = createBoardDocument();
  const p = doc.pages[0];
  assert.equal(contentBounds(p), null);
  assert.deepEqual(boardExtent(p), { x: 0, y: 0, w: 595, h: 842 });
  p.strokes.push(stroke([[-100, 2000], [300, 2100]]));
  const e = boardExtent(p);
  assert.ok(e.x < -100 && e.x > -110 && e.y < 2000 && e.x + e.w > 300 && e.y + e.h > 2100);
  assert.ok(BOARD_MARGIN > 0);
});

test('board: malformed board data is cleaned up, never trusted', () => {
  const doc = createBoardDocument();
  doc.pages[0].board!.frames.push({ id: 'f1', x: 0, y: 0, width: 595, height: 842, background: defaultBackground('ruled') });
  let s = serializeDocument(doc);
  s = s.replace('"x":0,"y":0,"width":595', '"x":1e12,"y":"no","width":595');
  const back = parseDocument(s).doc.pages[0].board!;
  assert.equal(back.frames[0].x, 1e6, 'clamped to the board limit');
  assert.equal(back.frames[0].y, 0, 'non-number → 0');
  const bad = serializeDocument(doc).replace('"width":595,"height":842,"background":{"kind":"ruled"', '"width":-5,"height":842,"background":{"kind":"ruled"');
  assert.equal(parseDocument(bad).doc.pages[0].board!.frames.length, 0, 'a frame without a size is dropped');
  // board data on a document with several pages: read as a note
  const two = createDocument({ pages: 2 });
  const t2 = serializeDocument(two).replace('"strokes":[', '"board":{"origin":[0,0],"frames":[]},"strokes":[');
  const r2 = parseDocument(t2);
  assert.ok(!isBoard(r2.doc));
  assert.ok(r2.warnings.some((w) => /Whiteboard/.test(w)));
});

test('board: a whiteboard opens read-only in a version that reads only up to 6 (0.10 behaviour)', () => {
  const doc = createBoardDocument();
  const v8 = serializeDocument(doc).replace('"version":7', '"version":8');
  assert.equal(parseDocument(v8).readOnly, true);
});

test('board: line recovery of a damaged whiteboard keeps the board header and strokes', () => {
  const doc = createBoardDocument();
  doc.pages[0].strokes.push(stroke([[-40, -40], [40, 40]]), stroke([[100, 100], [200, 150]]));
  const s = serializeDocument(doc);
  const damaged = s.slice(0, s.lastIndexOf(']}')); // truncated write
  const rec = recoverDocument(damaged);
  assert.ok(rec);
  assert.ok(isBoard(rec!.doc), 'still a whiteboard');
  assert.equal(rec!.doc.pages[0].strokes.length, 2);
});

// ---- grid index (rendering at scale) ----
import { roughBox, strokesIn, useSimplified, CELL } from '../../src/rendering/board-index';

test('board index: strokes in a rectangle = a linear scan, in page order, after appends and rebuilds', () => {
  const page = createBoardDocument().pages[0];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const mk = () => {
    const x = (rnd() - 0.5) * 8000;
    const y = (rnd() - 0.5) * 8000;
    return stroke([[x, y], [x + rnd() * 300, y + rnd() * 1500]]); // some cross several cells
  };
  for (let i = 0; i < 800; i++) page.strokes.push(mk());
  const linear = (r: [number, number, number, number]) =>
    page.strokes.filter((s) => {
      const b = roughBox(s);
      return !(b[2] < r[0] || b[0] > r[2] || b[3] < r[1] || b[1] > r[3]);
    });
  const views: [number, number, number, number][] = [
    [-500, -500, 500, 500],
    [-4000, -4000, 4000, 4000],
    [CELL - 1, CELL - 1, CELL + 1, CELL + 1],
    [-1e6, -1e6, 1e6, 1e6], // too many cells: linear fallback
  ];
  for (const v of views) assert.deepEqual(strokesIn(page, v).map((s) => s.id), linear(v).map((s) => s.id));
  // appended strokes (same array, as add-strokes does) are found
  for (let i = 0; i < 50; i++) page.strokes.push(mk());
  for (const v of views) assert.deepEqual(strokesIn(page, v).map((s) => s.id), linear(v).map((s) => s.id));
  // removal (new array, as undo does) rebuilds
  page.strokes = page.strokes.filter((_, i) => i % 3);
  for (const v of views) assert.deepEqual(strokesIn(page, v).map((s) => s.id), linear(v).map((s) => s.id));
});

test('board index: simplified drawing only when zoomed far out with many strokes in view', () => {
  assert.equal(useSimplified(5000, 0.3), true);
  assert.equal(useSimplified(5000, 1.5), false, 'normal zoom: exact ink');
  assert.equal(useSimplified(100, 0.2), false, 'few strokes: exact ink');
});
