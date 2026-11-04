// 0.12 shape pen: U / V / < / S / J strokes, recognition in screen pixels (zoom), cubic curves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeArrowHead, recognizeShape } from '../../src/ink/shape-recognition';
import { chordMap, connectorPoints, cubicPoint, curveMidOf, moveItem, resolveConnectors, transformItem, type ShapeItem } from '../../src/document/items';
import { createDocument } from '../../src/document/model';
import { parseDocument, requiredVersion, serializeDocument } from '../../src/document/codec';
import { densify, handStroke } from './handshapes';

type Pt = [number, number];
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 60): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });

const SHAPES: Record<string, { make: (s: number) => Pt[]; kind: string }> = {
  'U (round bottom)': { make: (s) => [...densify([[300, 300], [300, 300 + s * 0.6]]), ...arc(300 + s * 0.35, 300 + s * 0.6, s * 0.35, Math.PI, 0), ...densify([[300 + s * 0.7, 300 + s * 0.6], [300 + s * 0.7, 300]])], kind: 'curve' },
  'U (parabola)': { make: (s) => Array.from({ length: 81 }, (_, i) => { const u = (i / 80) * 2 - 1; return [300 + u * s * 0.4, 300 + s * (1 - u * u)] as Pt; }), kind: 'curve' },
  V: { make: (s) => densify([[300, 300], [300 + s * 0.3, 300 + s], [300 + s * 0.6, 300]]), kind: 'polyline' },
  '< (the arm of a k)': { make: (s) => densify([[300 + s * 0.6, 300], [300, 300 + s * 0.4], [300 + s * 0.6, 300 + s * 0.8]]), kind: 'polyline' },
  'S curve': { make: (s) => Array.from({ length: 81 }, (_, i) => { const u = i / 80; return [300 + u * s, 300 + Math.sin(u * Math.PI * 2) * s * 0.25] as Pt; }), kind: 'curve' },
  'J hook': { make: (s) => [...densify([[300 + s * 0.5, 300], [300 + s * 0.5, 300 + s * 0.7]]), ...arc(300 + s * 0.25, 300 + s * 0.7, s * 0.25, 0, Math.PI)], kind: 'curve' },
};

for (const [name, sh] of Object.entries(SHAPES)) {
  test(`shape pen: ${name} is a ${sh.kind} (hand-drawn, 60–300 px)`, () => {
    let ok = 0;
    let n = 0;
    for (const s of [60, 150, 300]) {
      for (let i = 0; i < 10; i++) {
        n++;
        const r = recognizeShape(handStroke(sh.make(s), { seed: 40 + i * 3 + s, wobble: 0.006 }));
        if (r?.kind === sh.kind && !r.arrowEnd) ok++;
      }
    }
    console.log(`  ${name}: ${ok}/${n}`);
    assert.ok(ok / n >= 0.85, `${name}: ${ok}/${n}`);
  });
}

test('shape pen: a U becomes a cubic curve that follows the drawn bottom', () => {
  const r = recognizeShape(handStroke(SHAPES['U (round bottom)'].make(200), { seed: 3, wobble: 0.004 }));
  assert.equal(r?.kind, 'curve');
  assert.ok(r!.c && r!.c2, 'two control points');
  const mid = cubicPoint(r!.a!, r!.c!, r!.c2!, r!.b!, 0.5);
  assert.ok(Math.abs(mid[1] - (300 + 200 * 0.95)) < 15, `bottom of the U at y ${mid[1].toFixed(0)}`);
});

test('shape pen: recognition works in screen pixels — a shape written at 800 % is judged like one at 100 %', () => {
  const z = 8;
  for (const [name, sh] of Object.entries(SHAPES)) {
    const big = handStroke(sh.make(240), { seed: 9, wobble: 0.006 });
    const small = big.map((p) => ({ ...p, x: p.x / z, y: p.y / z }));
    const r1 = recognizeShape(big);
    const r8 = recognizeShape(small, z);
    assert.equal(r8?.kind, r1?.kind, name);
    if (r1 && r8) {
      assert.ok(Math.abs(r8.x * z - r1.x) < 0.01 && Math.abs(r8.w * z - r1.w) < 0.01, `${name}: result scaled back to page units`);
      if (r1.c2) assert.ok(r8.c2 && Math.abs(r8.c2[0] * z - r1.c2[0]) < 0.01);
    }
  }
  // the same strokes judged without the zoom are "tiny" and used to fail
  const rect = handStroke(densify([[0, 0], [240, 0], [240, 160], [0, 160], [0, 4]]), { seed: 2, wobble: 0.003 });
  assert.equal(recognizeShape(rect.map((p) => ({ ...p, x: p.x / z, y: p.y / z })), z)?.kind, 'rect');
  // a separate V arrow head at 800 %
  const vh = handStroke(densify([[0, 0], [30, 15], [0, 30]]), { seed: 5, wobble: 0.003, hooks: false });
  const h1 = recognizeArrowHead(vh);
  const h8 = recognizeArrowHead(vh.map((p) => ({ ...p, x: p.x / z, y: p.y / z })), z);
  assert.ok(h1 && h8);
  assert.ok(Math.abs(h8!.tip[0] * z - h1!.tip[0]) < 0.01 && Math.abs(h8!.size * z - h1!.size) < 0.01);
});

// ---- cubic curve items ----

const cubic: ShapeItem = { id: 'c1', type: 'shape', kind: 'curve', x: 0, y: 0, w: 0, h: 0, created: 0, stroke: '#1a1a1a', strokeWidth: 2, fill: null, fillOpacity: 1, a: [0, 0], b: [100, 0], c: [0, 120], c2: [100, 120] };

test('cubic curve: sampled path, middle, transform and save / load', () => {
  const pts = connectorPoints(cubic as ShapeItem & { a: Pt; b: Pt }, 32);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [100, 0]);
  const mid = curveMidOf({ a: cubic.a!, b: cubic.b!, c: cubic.c!, c2: cubic.c2 });
  assert.deepEqual(mid, [50, 90]);
  const moved = moveItem(cubic, 10, 5) as ShapeItem;
  assert.deepEqual(moved.c2, [110, 125]);
  const turned = transformItem(cubic, [0, 0], 2, 0, 0, 0) as ShapeItem;
  assert.deepEqual(turned.c2, [200, 240]);
  const doc = createDocument();
  doc.pages[0].items = [cubic];
  assert.equal(requiredVersion(doc), 7, 'cubic curves need a reader that knows c2');
  const back = parseDocument(serializeDocument(doc)).doc.pages[0].items[0] as ShapeItem;
  assert.deepEqual([back.c, back.c2], [cubic.c, cubic.c2]);
  const quad = { ...cubic };
  delete quad.c2;
  doc.pages[0].items = [quad];
  assert.ok(requiredVersion(doc) < 7, 'a quadratic curve keeps the old version');
});

test('cubic curve: an attached end that moves carries the whole shape (rotation + scale of the chord)', () => {
  // chordMap: the chord (0,0)→(100,0) becomes (0,0)→(0,200): rotate 90°, scale 2
  assert.deepEqual(chordMap([0, 0], [100, 0], [0, 0], [0, 200], [50, 30]).map((v) => Math.round(v)), [-60, 100]);
  const box: ShapeItem = { id: 'r1', type: 'shape', kind: 'rect', x: 180, y: -10, w: 40, h: 20, created: 0, stroke: '#000', strokeWidth: 1, fill: null, fillOpacity: 1 };
  const attached: ShapeItem = { ...cubic, to: { id: 'r1', ax: 0, ay: 0.5 } };
  const out = resolveConnectors([box, attached]);
  const c = out[1] as ShapeItem;
  assert.deepEqual(c.b, [180, 0]);
  assert.deepEqual(c.c2!.map((v) => Math.round(v)), [180, 216], 'c2 scaled with the chord (×1.8)');
});
