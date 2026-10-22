import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, newId, type Stroke } from '../../src/document/model';
import { parseDocument, quantizeSample, recoverDocument, requiredVersion, serializeDocument } from '../../src/document/codec';
import { History } from '../../src/document/history';
import { resolveConnectors, type Item, type ShapeItem, type TextItem } from '../../src/document/items';
import { DEFAULT_PEN_PARAMS, EXPERIMENTAL_FOUNTAIN } from '../../src/ink/presets';
import { cutStroke } from '../../src/ink/erase';
import { recognizeShape } from '../../src/ink/shape-recognition';
import { buildStrokeGeometry } from '../../src/ink/stroke-builder';
import { naturalCurve, pressureWidthFactor } from '../../src/ink/math';
import { GeometryCache } from '../../src/document/geometry-cache';
import { circle, line, samplePath } from './helpers';

/** Closed/open polyline as a parametric path (constant speed). */
const poly = (pts: [number, number][]) => {
  const seg: number[] = [];
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(L);
  }
  return (u: number) => {
    const d = u * L;
    let i = seg.findIndex((s) => s >= d);
    if (i < 0) i = seg.length - 1;
    const s0 = i ? seg[i - 1] : 0;
    const k = seg[i] > s0 ? (d - s0) / (seg[i] - s0) : 0;
    return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k };
  };
};

function stroke(samples = samplePath(line(10, 50, 210, 50), { durationMs: 500, hz: 120 }), tool: Stroke['tool'] = 'fountain'): Stroke {
  return { id: newId('s'), tool, color: '#1a1a1a', params: { ...DEFAULT_PEN_PARAMS[tool] }, zoom: 1.5, hasPressure: true, engine: 1, created: 0, samples: samples.map(quantizeSample) };
}

const text: TextItem = { id: 't1', type: 'text', x: 40, y: 60, w: 120, h: 20, created: 0, text: '知行合一\nline 2', size: 16, color: '#1a1a1a', font: 'sans', bold: true, italic: false, align: 'center', autoWidth: false };
const rect: ShapeItem = { id: 'r1', type: 'shape', kind: 'rect', x: 100, y: 200, w: 80, h: 40, created: 0, stroke: '#c62828', strokeWidth: 2, fill: '#ffe066', fillOpacity: 0.4 };
const ell: ShapeItem = { id: 'e1', type: 'shape', kind: 'ellipse', x: 300, y: 200, w: 60, h: 60, created: 0, stroke: '#1a1a1a', strokeWidth: 1.5, fill: null, fillOpacity: 1 };
const arrow: ShapeItem = {
  id: 'a1', type: 'shape', kind: 'arrow', x: 180, y: 220, w: 120, h: 10, created: 0, stroke: '#1a1a1a', strokeWidth: 1.5, fill: null, fillOpacity: 1,
  a: [180, 220], b: [300, 230], from: { id: 'r1', ax: 1, ay: 0.5 }, to: { id: 'e1', ax: 0, ay: 0.5 },
};

test('format v3: items round-trip; version 3 only when needed', () => {
  const doc = createDocument({ pages: 2 });
  doc.pages[0].strokes.push(stroke());
  assert.equal(requiredVersion(doc), 1);
  doc.pages[1].items = [text, rect, ell, arrow, { id: 'i1', type: 'image', x: 10, y: 10, w: 200, h: 100, created: 0, src: 'attachments/a b.png', natW: 800, natH: 400, crop: [0.1, 0, 0.8, 1] }];
  assert.equal(requiredVersion(doc), 3);
  const txt = serializeDocument(doc);
  assert.match(txt, /"version":3/);
  const back = parseDocument(txt).doc;
  assert.equal(back.pages[1].items.length, 5);
  assert.deepEqual(back.pages[1].items[0], text);
  assert.deepEqual((back.pages[1].items[3] as ShapeItem).from, arrow.from);
  assert.equal(serializeDocument(back), txt, 'stable re-serialization');
  // line-based recovery of a truncated file keeps items that are complete
  const cut = txt.split('\n');
  const rec = recoverDocument(cut.slice(0, cut.length - 3).join('\n'));
  assert.ok(rec && rec.doc.pages[1].items.length >= 3, `recovered ${rec?.doc.pages[1].items.length}`);
});

test('format v3: pencil strokes, cut fragments and curve 4 require version 3; v2 readers open read-only', () => {
  const doc = createDocument({ pages: 1 });
  const s = stroke();
  s.engine = 2;
  s.params = { ...EXPERIMENTAL_FOUNTAIN, pressureCurve: 0 };
  doc.pages[0].strokes = [s];
  assert.equal(requiredVersion(doc), 2);
  doc.pages[0].strokes = [{ ...s, params: { ...EXPERIMENTAL_FOUNTAIN } }];
  assert.equal(requiredVersion(doc), 3, 'natural curve');
  doc.pages[0].strokes = [{ ...stroke(), cut: 2 }];
  assert.equal(requiredVersion(doc), 3, 'cut flag');
  const p = stroke(undefined, 'pencil');
  doc.pages[0].strokes = [p];
  assert.equal(requiredVersion(doc), 3, 'pencil');
  const back = parseDocument(serializeDocument(doc));
  assert.equal(back.doc.pages[0].strokes[0].tool, 'pencil');
  assert.equal(back.readOnly, false);
  // a hypothetical v6 file opens read-only (v0.5 reads up to version 5)
  const v5 = serializeDocument(doc).replace('"version":3', '"version":6');
  assert.equal(parseDocument(v5).readOnly, true);
});

test('history: set-items / set-strokes / set-page / batch undo and redo', () => {
  const doc = createDocument({ pages: 2 });
  const h = new History();
  const pid = doc.pages[0].id;
  h.push(doc, { kind: 'set-items', pageId: pid, before: [], after: [text] });
  h.push(doc, { kind: 'set-items', pageId: pid, before: [text], after: [{ ...text, x: 99 }] });
  assert.equal((doc.pages[0].items[0] as TextItem).x, 99);
  h.undo(doc);
  assert.equal((doc.pages[0].items[0] as TextItem).x, 40);
  const s = stroke();
  h.push(doc, { kind: 'set-strokes', pageId: pid, before: [], after: [s] });
  const before = { width: 595, height: 842, background: doc.pages[0].background };
  const r = h.push(doc, {
    kind: 'batch',
    ops: doc.pages.map((p) => ({ kind: 'set-page' as const, pageId: p.id, before, after: { ...before, width: 842, height: 595 } })),
  });
  assert.equal(r.structural, true);
  assert.ok(doc.pages.every((p) => p.width === 842 && p.height === 595));
  h.undo(doc);
  assert.ok(doc.pages.every((p) => p.width === 595));
  h.undo(doc);
  assert.equal(doc.pages[0].strokes.length, 0);
  h.redo(doc);
  assert.equal(doc.pages[0].strokes.length, 1);
});

test('connectors follow the shapes they are attached to', () => {
  const moved = resolveConnectors([{ ...rect, x: 0, y: 0 }, ell, arrow] as Item[]);
  const a = moved[2] as ShapeItem;
  assert.deepEqual(a.a, [80, 20], 'from = right middle of the moved rectangle');
  assert.deepEqual(a.b, [300, 230], 'to = left middle of the ellipse');
});

test('partial eraser: a pass through the middle of a stroke leaves two fragments with cut ends', () => {
  const s = stroke(samplePath(line(10, 50, 210, 50), { durationMs: 400, hz: 60 })); // sparse samples (≈5 units apart)
  const parts = cutStroke(s, 110, 30, 110, 70, 4, true);
  assert.ok(parts, 'stroke was hit');
  assert.equal(parts!.length, 2);
  const [a, b] = parts!;
  assert.equal(a.cut, 2, 'first fragment: end cut');
  assert.equal(b.cut, 1, 'second fragment: start cut');
  const aEnd = a.samples[a.samples.length - 1].x;
  const bStart = b.samples[0].x;
  assert.ok(aEnd < 110 && aEnd > 100, `cut point ${aEnd}`);
  assert.ok(bStart > 110 && bStart < 120, `cut point ${bStart}`);
  // untouched samples are unchanged
  assert.deepEqual(a.samples.slice(0, 5), s.samples.slice(0, 5));
  // a miss returns null; erasing everything returns []
  assert.equal(cutStroke(s, 110, 90, 120, 90, 4, true), null);
  assert.deepEqual(cutStroke(s, 0, 50, 220, 50, 6, false), []);
});

test('partial eraser: cut ends get no taper (width at the cut equals the body width)', () => {
  const s = stroke(samplePath(line(10, 50, 210, 50), { durationMs: 500, hz: 240, pressure: () => 0.3 }));
  const [a] = cutStroke(s, 110, 30, 110, 70, 4, true)!;
  const g = new GeometryCache().get(a);
  const mid = g.rs[Math.floor(g.rs.length / 2)];
  const end = g.rs[g.rs.length - 1];
  assert.ok(end > mid * 0.9, `end radius ${end.toFixed(3)} vs body ${mid.toFixed(3)}`);
  const full = buildStrokeGeometry(a.samples, a.tool, a.params, { zoom: a.zoom, hasPressure: true });
  assert.ok(full.rs[full.rs.length - 1] < mid * 0.9, 'without the cut flag the end would taper');
});

test('shape recognition: line, rectangle, ellipse, triangle, diamond; scribbles stay ink', () => {
  const ln = recognizeShape(samplePath(line(10, 10, 200, 40), { durationMs: 300, noise: 0.4 }));
  assert.equal(ln?.kind, 'line');
  const rectPts: [number, number][] = [[50, 50], [250, 50], [250, 150], [50, 150], [50, 51]];
  assert.equal(recognizeShape(samplePath(poly(rectPts), { durationMs: 800, noise: 0.6 }))?.kind, 'rect');
  const c = recognizeShape(samplePath(circle(150, 150, 60), { durationMs: 700, noise: 0.6 }));
  assert.equal(c?.kind, 'ellipse');
  assert.ok(Math.abs(c!.w - 120) < 8 && Math.abs(c!.h - 120) < 8);
  const tri = recognizeShape(samplePath(poly([[100, 20], [180, 160], [20, 160], [100, 21]]), { durationMs: 700, noise: 0.5 }));
  assert.equal(tri?.kind, 'triangle');
  assert.equal(tri?.points?.length, 6);
  const dia = recognizeShape(samplePath(poly([[100, 20], [180, 100], [100, 180], [20, 100], [100, 21]]), { durationMs: 800, noise: 0.5 }));
  assert.equal(dia?.kind, 'diamond');
  // v0.4: an open zig-zag with sharp corners is a polyline (no arrow head)
  const zig = recognizeShape(samplePath(poly([[0, 0], [30, 40], [60, 0], [90, 40], [120, 0]]), { durationMs: 500 }));
  assert.equal(zig?.kind, 'polyline');
  assert.ok(!zig?.arrowEnd, 'zig-zag has no arrow head');
  assert.equal(recognizeShape(samplePath(circle(10, 10, 2), { durationMs: 200 })), null, 'too small');
});

test('pressure curve 4: hairline at feather-light touch, nominal at typical, ~2x at heavy', () => {
  const P = EXPERIMENTAL_FOUNTAIN;
  const f = (p: number) => pressureWidthFactor(p, P.pressureSensitivity, 4, P.minWidthRatio!, P.maxWidthRatio!, P.typicalPressure!, P.heavyPressure);
  assert.ok(f(0.01) < 0.25, `p=0.01 → ${f(0.01).toFixed(2)}`);
  assert.ok(Math.abs(f(0.1) - 1) < 1e-9);
  assert.ok(f(0.45) > 1.95 && f(0.6) <= 2.0001);
  let prev = 0;
  for (let p = 0; p <= 1; p += 0.005) {
    const v = naturalCurve(p, 0.15, 2, 0.1, 0.45);
    assert.ok(v >= prev - 1e-9, 'monotonic');
    prev = v;
  }
  // light (0.03) to heavy (0.35) contrast is much stronger than the beta.2 gamma defaults
  const beta2 = (p: number) => pressureWidthFactor(p, 0.85, 0, 0.2, 2.2, 0.12, 0.45);
  assert.ok(f(0.35) / f(0.03) > 1.5 * (beta2(0.35) / beta2(0.03)), `${(f(0.35) / f(0.03)).toFixed(1)}x vs ${(beta2(0.35) / beta2(0.03)).toFixed(1)}x`);
});
