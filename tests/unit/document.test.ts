import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HandNoteParseError,
  decodeSamples,
  encodeSamples,
  parseDocument,
  peekHeader,
  quantizeSample,
  serializeDocument,
} from '../../src/document/codec';
import { createDocument, createPage, defaultBackground, newId, type HandNoteDocument, type Stroke } from '../../src/document/model';
import { History } from '../../src/document/history';
import { GeometryCache, hitStroke, hitStrokeSegment } from '../../src/document/geometry-cache';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import type { InputSample } from '../../src/ink/types';
import { pageToSvg } from '../../src/rendering/svg-export';
import { line, samplePath } from './helpers';

function makeStroke(samples: InputSample[], tool: Stroke['tool'] = 'fountain'): Stroke {
  return {
    id: newId('s'),
    tool,
    color: tool === 'highlighter' ? '#ffe066' : '#1a1a1a',
    params: { ...DEFAULT_PEN_PARAMS[tool] },
    zoom: 1.5,
    hasPressure: true,
    engine: 1,
    created: 1700000000000,
    samples: samples.map(quantizeSample),
  };
}

function sampleDoc(): HandNoteDocument {
  const doc = createDocument({ pages: 2, device: 'dev-test' });
  doc.pages[0].strokes.push(makeStroke(samplePath(line(10, 10, 200, 40), { durationMs: 300, noise: 0.1 })));
  const tilted = samplePath(line(10, 60, 100, 60), { durationMs: 200 }).map((s, i) => ({ ...s, tx: 30 + i * 0.1, ty: -12 }));
  doc.pages[0].strokes.push(makeStroke(tilted, 'ballpoint'));
  doc.pages[1].strokes.push(makeStroke(samplePath(line(0, 300, 400, 300), { durationMs: 250 }), 'highlighter'));
  return doc;
}

test('sample encoding roundtrip (quantized, delta-encoded)', () => {
  const raw: InputSample[] = [
    { x: 10.123, y: 20.456, p: 0.3333, t: 0, tx: 12.4, ty: -3.6 },
    { x: 10.5, y: 21.01, p: 0.35, t: 4.2, tx: 12.9, ty: -3.1 },
    { x: -5.2, y: 0, p: 1.2, t: 8.4, tx: 13, ty: -3 },
  ];
  const enc = encodeSamples(raw);
  assert.equal(enc.pts.length, 12);
  assert.ok(enc.pts.every(Number.isInteger));
  const dec = decodeSamples(enc.pts, enc.tilt);
  assert.deepEqual(dec, raw.map(quantizeSample));
  assert.equal(dec[2].p, 1, 'pressure clamped');
});

test('document serialize/parse roundtrip is lossless for stored data', () => {
  const doc = sampleDoc();
  const text = serializeDocument(doc);
  const res = parseDocument(text);
  assert.equal(res.readOnly, false);
  assert.equal(res.recovered, false);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.doc.pages.length, 2);
  assert.deepEqual(res.doc.pages[0].strokes[0].samples, doc.pages[0].strokes[0].samples);
  assert.deepEqual(res.doc.pages[0].strokes[1].samples, doc.pages[0].strokes[1].samples);
  assert.equal(res.doc.pages[1].strokes[0].tool, 'highlighter');
  // stable output
  assert.equal(serializeDocument(res.doc), text);
  // one stroke per line
  const strokeLines = text.split('\n').filter((l) => l.startsWith('{"id":"s'));
  assert.equal(strokeLines.length, 3);
});

test('damaged (truncated) file is recovered stroke by stroke', () => {
  const doc = sampleDoc();
  doc.pages[0].strokes.push(makeStroke(samplePath(line(0, 0, 50, 50), { durationMs: 100 })));
  const text = serializeDocument(doc);
  // cut in the middle of the last stroke of page 1
  const lines = text.split('\n');
  const idx = lines.findIndex((l, i) => i > 3 && l.startsWith('{"id":"s') && lines[i + 1].startsWith(']}'));
  const cut = lines.slice(0, idx).join('\n') + '\n' + lines[idx].slice(0, 40);
  const res = parseDocument(cut);
  assert.equal(res.recovered, true);
  assert.equal(res.doc.id, doc.id);
  assert.equal(res.doc.pages[0].strokes.length, 2, 'two complete strokes recovered');
  assert.ok(res.warnings.length > 0);
});

test('newer format version opens read-only; non-HandNote files are rejected', () => {
  const doc = sampleDoc();
  const text = serializeDocument({ ...doc, version: 99 });
  const res = parseDocument(text);
  assert.equal(res.readOnly, true);
  assert.throws(() => parseDocument('{"hello":1}'), HandNoteParseError);
  assert.throws(() => parseDocument(''), HandNoteParseError);
  assert.throws(() => parseDocument('not json at all'), HandNoteParseError);
});

test('invalid strokes are skipped, not fatal', () => {
  const doc = sampleDoc();
  const text = serializeDocument(doc).replace('"tool":"ballpoint"', '"tool":"laser"');
  const res = parseDocument(text);
  assert.equal(res.doc.pages[0].strokes.length, 1);
  assert.ok(res.warnings.some((w) => w.includes('laser')));
});

test('peekHeader reads id/revision/device without full parse', () => {
  const doc = sampleDoc();
  doc.revision = 42;
  const h = peekHeader(serializeDocument(doc));
  assert.equal(h.id, doc.id);
  assert.equal(h.revision, 42);
  assert.equal(h.device, 'dev-test');
});

test('undo/redo of strokes and pages', () => {
  const doc = createDocument();
  const h = new History();
  const pid = doc.pages[0].id;
  const s1 = makeStroke(samplePath(line(0, 0, 10, 0), { durationMs: 50 }));
  const s2 = makeStroke(samplePath(line(0, 5, 10, 5), { durationMs: 50 }));
  const s3 = makeStroke(samplePath(line(0, 9, 10, 9), { durationMs: 50 }));
  for (const s of [s1, s2, s3]) h.push(doc, { kind: 'add-strokes', pageId: pid, strokes: [s] });
  assert.equal(doc.pages[0].strokes.length, 3);
  h.undo(doc);
  assert.deepEqual(doc.pages[0].strokes.map((s) => s.id), [s1.id, s2.id]);
  h.redo(doc);
  assert.deepEqual(doc.pages[0].strokes.map((s) => s.id), [s1.id, s2.id, s3.id]);
  // erase s1 and s3, then undo restores original z-order
  doc.pages[0].strokes = [s2];
  h.record({ kind: 'remove-strokes', pageId: pid, removed: [{ index: 0, stroke: s1 }, { index: 2, stroke: s3 }] });
  h.undo(doc);
  assert.deepEqual(doc.pages[0].strokes.map((s) => s.id), [s1.id, s2.id, s3.id]);
  // pages
  const p2 = createPage(595, 842, defaultBackground('grid'));
  h.push(doc, { kind: 'add-page', index: 1, page: p2 });
  assert.equal(doc.pages.length, 2);
  h.undo(doc);
  assert.equal(doc.pages.length, 1);
  h.redo(doc);
  assert.equal(doc.pages[1].id, p2.id);
  // the last page can never be removed
  const only = createDocument();
  const h2 = new History();
  h2.push(only, { kind: 'remove-page', index: 0, page: only.pages[0] });
  assert.equal(only.pages.length, 1);
  // redo stack cleared by a new action
  h.undo(doc);
  h.push(doc, { kind: 'add-strokes', pageId: pid, strokes: [makeStroke([{ x: 1, y: 1, p: 0.3, t: 0 }])] });
  assert.equal(h.canRedo, false);
});

test('no duplicate strokes when an add is applied twice', () => {
  const doc = createDocument();
  const h = new History();
  const s = makeStroke(samplePath(line(0, 0, 10, 0), { durationMs: 50 }));
  h.push(doc, { kind: 'add-strokes', pageId: doc.pages[0].id, strokes: [s] });
  h.undo(doc);
  h.redo(doc);
  h.undo(doc);
  h.redo(doc);
  assert.equal(doc.pages[0].strokes.length, 1);
});

test('eraser hit testing', () => {
  const cache = new GeometryCache();
  const s = makeStroke(samplePath(line(0, 50, 100, 50), { durationMs: 300 }));
  const g = cache.get(s);
  assert.ok(hitStroke(g, 50, 50, 1));
  assert.ok(hitStroke(g, 50, 52, 2));
  assert.ok(!hitStroke(g, 50, 60, 2));
  // a fast vertical swipe crossing the line between two samples is still detected
  assert.ok(hitStrokeSegment(g, 50, 30, 50, 70, 1));
  assert.ok(!hitStrokeSegment(g, 150, 30, 150, 70, 1));
});

test('SVG export contains ink and merged highlighter paths', () => {
  const doc = sampleDoc();
  const svg = pageToSvg(doc.pages[0], new GeometryCache());
  assert.match(svg, /^<svg xmlns/);
  assert.equal((svg.match(/fill="#1a1a1a"/g) ?? []).length, 2);
  const svg2 = pageToSvg(doc.pages[1], new GeometryCache());
  assert.equal((svg2.match(/fill-opacity="0.35"/g) ?? []).length, 1);
  assert.ok(!/NaN/.test(svg + svg2));
});

// ---------------------------------------------------------------------------------------------
// v0.2 compatibility with files written by the released v0.1.0 plugin
// ---------------------------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { requiredVersion } from '../../src/document/codec';
import { FORMAT_VERSION } from '../../src/document/model';

const V01 = readFileSync('tests/fixtures/v0.1-sample.handnote', 'utf8');

test('v0.1 file loads with all pages, strokes, pressure, tilt, colors and backgrounds', () => {
  const res = parseDocument(V01);
  assert.equal(res.readOnly, false);
  assert.equal(res.recovered, false);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.doc.pages.length, 2);
  assert.equal(res.doc.pages[0].strokes.length, 3);
  assert.equal(res.doc.pages[1].background.kind, 'grid');
  const f = res.doc.pages[0].strokes[0];
  assert.equal(f.engine, 1);
  assert.equal(f.color, '#1a1a1a');
  assert.ok(f.samples.every((s) => s.tx !== undefined));
  assert.ok(new Set(f.samples.map((s) => s.p)).size > 10, 'pressure preserved');
  assert.equal(res.doc.pages[0].strokes[2].tool, 'highlighter');
});

test('v0.1 file re-saved by v0.2 without edits is byte-identical (still version 1, still editable by v0.1)', () => {
  const res = parseDocument(V01);
  assert.equal(serializeDocument(res.doc), V01);
});

test('v0.1 file edited with Baseline strokes stays version 1; adding an Experimental stroke writes version 2', () => {
  const res = parseDocument(V01);
  const s1 = makeStroke(samplePath(line(10, 500, 90, 520), { durationMs: 200 }));
  res.doc.pages[0].strokes.push(s1);
  assert.equal(requiredVersion(res.doc), 1);
  assert.match(serializeDocument(res.doc), /"version":1,/);
  const s2 = { ...makeStroke(samplePath(line(10, 600, 90, 620), { durationMs: 200 })), engine: 2, params: { ...DEFAULT_PEN_PARAMS.fountain, pressureCurve: 3, minWidthRatio: 0.2, maxWidthRatio: 2.2, pressureSmoothing: 0.7, typicalPressure: 0.3 } };
  res.doc.pages[0].strokes.push(s2);
  const text = serializeDocument(res.doc);
  assert.match(text, /"version":2,/);
  const back = parseDocument(text);
  assert.equal(back.readOnly, false, 'v0.2 reads its own version 2');
  const r2 = back.doc.pages[0].strokes[4];
  assert.equal(r2.engine, 2);
  assert.equal(r2.params.pressureCurve, 3);
  assert.equal(r2.params.typicalPressure, 0.3);
  assert.equal(back.doc.pages[0].strokes[3].params.pressureCurve, undefined, 'engine-1 params gain no new fields');
  assert.equal(FORMAT_VERSION, 5, 'v0.5 reads up to version 5');
});

test('geometry of v0.1 strokes is the same before and after a v0.2 save', () => {
  const a = parseDocument(V01).doc;
  const b = parseDocument(serializeDocument(a)).doc;
  const ca = new GeometryCache();
  const cb = new GeometryCache();
  for (let p = 0; p < a.pages.length; p++)
    for (let i = 0; i < a.pages[p].strokes.length; i++) assert.deepEqual(ca.get(a.pages[p].strokes[i]), cb.get(b.pages[p].strokes[i]));
});
