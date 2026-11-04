// 0.12 stored stroke geometry: the ink drawn live is what is saved and rendered (no shift on lift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrokeBuilder, buildStrokeGeometry, geometryFromStored, quantizeGeometry, trimGeometryHook } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import { createDocument, newId, type Stroke } from '../../src/document/model';
import { decodeGeometry, encodeGeometry, parseDocument, quantizeSample, serializeDocument } from '../../src/document/codec';
import { GeometryCache } from '../../src/document/geometry-cache';
import { cutStroke } from '../../src/ink/erase';
import { transformStroke } from '../../src/editor/lasso';
import { convertPagesToBoard } from '../../src/document/board';
import type { InkTool } from '../../src/ink/types';
import { circle, lShape, samplePath } from './helpers';

const wave = (u: number) => ({ x: 40 + u * 220, y: 120 + Math.sin(u * 9) * 30 });

/** Draw a stroke as the editor does: builder fed live, stroke built from it on lift. */
function draw(path: (u: number) => { x: number; y: number }, opts: { tool?: InkTool; engine?: number; zoom?: number; seed?: number } = {}) {
  const tool = opts.tool ?? 'fountain';
  const ctx = { zoom: opts.zoom ?? 1, hasPressure: true, engine: opts.engine ?? 1 };
  const b = new StrokeBuilder(tool, { ...DEFAULT_PEN_PARAMS[tool] }, ctx);
  const raw = samplePath(path, { durationMs: 700, noise: 0.15, seed: opts.seed ?? 4, pressure: (u) => 0.3 + 0.5 * Math.sin(u * Math.PI) });
  for (const s of raw) b.add(s);
  // what the screen showed right before the pen lifted (no predicted points)
  const st = b.stable();
  const tl = b.tail();
  const live = { xs: [...st.xs, ...tl.xs], ys: [...st.ys, ...tl.ys], rs: [...st.rs, ...tl.rs] };
  const stroke: Stroke = {
    id: newId('s'),
    tool,
    color: '#1a1a1a',
    params: { ...b.params },
    zoom: ctx.zoom,
    hasPressure: true,
    engine: ctx.engine,
    created: 0,
    samples: b.rawSamples.map(quantizeSample),
    geom: b.commitGeometry(),
  };
  return { stroke, live, builder: b };
}

/** Largest distance from each point of `a` to the centerline of `b`. */
function maxDev(a: { xs: number[]; ys: number[] }, b: { xs: number[]; ys: number[] }): number {
  let worst = 0;
  for (let i = 0; i < a.xs.length; i++) {
    let best = Infinity;
    for (let j = 1; j < b.xs.length; j++) {
      const ax = b.xs[j - 1];
      const ay = b.ys[j - 1];
      const dx = b.xs[j] - ax;
      const dy = b.ys[j] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((a.xs[i] - ax) * dx + (a.ys[i] - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(a.xs[i] - ax - dx * t, a.ys[i] - ay - dy * t));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

for (const engine of [1, 2]) {
  test(`stored geometry (engine ${engine}): the committed ink is the live ink — nothing moves when the pen lifts`, () => {
    for (const [name, path] of [['wave', wave], ['circle', circle(150, 150, 60)], ['L', lShape(50, 50, 120)]] as const) {
      const { stroke, live } = draw(path, { engine });
      const g = stroke.geom!;
      // a subset of the live points (straight runs merged), each where it was drawn
      assert.ok(g.xs.length < live.xs.length, `${name}: ${g.xs.length} of ${live.xs.length} points kept`);
      let j = 0;
      // (the last point is moved forward by the taper — checked below)
      for (let i = 0; i < g.xs.length - 1; i++) {
        while (j < live.xs.length && (Math.abs(g.xs[i] - live.xs[j]) > 0.006 || Math.abs(g.ys[i] - live.ys[j]) > 0.006)) j++;
        assert.ok(j < live.xs.length, `${name}: point ${i} is not a drawn point`);
        // the width is the drawn width except at the exit taper (the last part of the stroke)
        if (j < live.xs.length * 0.6) assert.ok(Math.abs(g.rs[i] - live.rs[j]) <= 0.003, `${name}: radius at ${i} changed`);
      }
      // the tapered end reaches as far as the drawn end and stays inside it (thinner, not shorter)
      const m = g.xs.length - 1;
      const L = live.xs.length - 1;
      const gap = Math.hypot(g.xs[m] - live.xs[L], g.ys[m] - live.ys[L]);
      assert.ok(gap + g.rs[m] <= live.rs[L] + 0.02, `${name}: the end is inside the drawn end`);
      assert.ok(g.rs[m] <= live.rs[L] + 0.005 && g.rs[m] >= live.rs[L] * 0.4, `${name}: end radius ${g.rs[m]} vs drawn ${live.rs[L]} (mild taper)`);
      // the old path (rebuild from the quantized samples) moved the ink; measure it for comparison
      const rebuilt = buildStrokeGeometry(stroke.samples, stroke.tool, stroke.params, { zoom: 1, hasPressure: true, engine });
      const body = { xs: g.xs.slice(0, -1), ys: g.ys.slice(0, -1) };
      const shiftNew = maxDev(body, live);
      const shiftOld = maxDev(rebuilt, live);
      assert.ok(shiftNew < 0.01, `${name}: committed ink off the live ink by ${shiftNew}`);
      assert.ok(maxDev(live, g) < 0.02, `${name}: merged points within the simplification tolerance`);
      console.log(`  engine ${engine} ${name}: shift on lift ${shiftOld.toFixed(3)} → ${shiftNew.toFixed(3)} units; ${live.xs.length} → ${g.xs.length} points`);
    }
  });
}

test('stored geometry: save → load renders exactly what was drawn', () => {
  const doc = createDocument();
  const a = draw(wave).stroke;
  const b = draw(circle(150, 150, 60), { tool: 'pencil', seed: 7 }).stroke;
  doc.pages[0].strokes.push(a, b);
  const text = serializeDocument(doc);
  const back = parseDocument(text).doc.pages[0].strokes;
  const c1 = new GeometryCache();
  const c2 = new GeometryCache();
  for (const [i, s] of [a, b].entries()) {
    assert.deepEqual(back[i].geom, s.geom, 'geometry round trip is exact');
    assert.deepEqual(back[i].samples, s.samples, 'samples are still written');
    const g1 = c1.get(s);
    const g2 = c2.get(back[i]);
    assert.deepEqual([g2.xs, g2.ys, g2.rs, g2.bbox, g2.dot], [g1.xs, g1.ys, g1.rs, g1.bbox, g1.dot]);
  }
  // saving again gives the same bytes
  assert.equal(serializeDocument(parseDocument(text).doc), text);
  // size of the extra data, for the record
  const without = createDocument();
  without.pages[0].strokes.push(...[a, b].map((s) => ({ ...s, geom: undefined })));
  const k = text.length / serializeDocument(without).length;
  console.log(`  file size with geometry: ×${k.toFixed(2)}`);
  assert.ok(k < 2.5);
});

test('stored geometry: delta encoding round trip and malformed data', () => {
  const g = quantizeGeometry({ xs: [-500.123, 10, 10.004, 1e5], ys: [0, -3.33, 7, 2], rs: [0.5, 1.237, 2, 0.1] });
  assert.deepEqual(decodeGeometry(encodeGeometry(g)), g);
  assert.equal(decodeGeometry([1, 2]), null, 'not triplets');
  assert.equal(decodeGeometry([1, 2, 'x']), null, 'not numbers');
  assert.equal(decodeGeometry([1, 2, Infinity]), null, 'not finite');
  assert.equal(decodeGeometry({}), null);
});

test('stored geometry: older files (samples only) load and render from samples; bad geometry is ignored', () => {
  const doc = createDocument();
  const { stroke } = draw(wave);
  doc.pages[0].strokes.push(stroke);
  const text = serializeDocument(doc);
  // a file written before 0.12: no genc / geo
  const old = text.replace(/,"genc":"g1","geo":\[[^\]]*\]/, '');
  assert.ok(!old.includes('"geo"'));
  const s0 = parseDocument(old).doc.pages[0].strokes[0];
  assert.equal(s0.geom, undefined);
  const g0 = new GeometryCache().get(s0);
  const ref = buildStrokeGeometry(s0.samples, s0.tool, s0.params, { zoom: s0.zoom, hasPressure: s0.hasPressure, engine: s0.engine });
  assert.deepEqual(g0.xs, ref.xs, 'built from samples as before');
  // damaged geometry: the stroke still loads, from its samples
  const bad = text.replace(/"geo":\[/, '"geo":[1,"a",');
  const s1 = parseDocument(bad).doc.pages[0].strokes[0];
  assert.equal(s1.geom, undefined);
  assert.equal(s1.samples.length, stroke.samples.length);
});

test('stored geometry: the eraser regenerates each piece from its samples (square cut ends), stored and stable on reload', () => {
  const { stroke } = draw((u) => ({ x: 20 + u * 300, y: 100 }));
  const pieces = cutStroke(stroke, 170, 80, 170, 120, 6, true);
  assert.ok(pieces && pieces.length === 2);
  const [left, right] = pieces!;
  assert.equal(left.cut, 2);
  assert.equal(right.cut, 1);
  for (const p of pieces!) {
    assert.ok(p.geom && p.geom.xs.length > 2, 'the piece stores its ink');
    const g = new GeometryCache().get(p);
    assert.ok(g.bbox[2] - g.bbox[0] < 160, 'the piece only covers its part');
  }
  // the cut end keeps the full width (no taper there)
  const lg = left.geom!;
  const base = Math.max(...lg.rs);
  assert.ok(lg.rs[lg.rs.length - 1] > base * 0.5, 'cut end is not tapered');
  assert.ok(Math.max(...lg.xs) < 170, 'nothing left under the eraser');
  assert.ok(Math.min(...right.geom!.xs) > 170);
  // pieces survive a reload unchanged
  const doc = createDocument();
  doc.pages[0].strokes.push(...pieces!);
  const back = parseDocument(serializeDocument(doc)).doc.pages[0].strokes;
  assert.deepEqual(back.map((s) => s.geom), pieces!.map((s) => s.geom));
  // a stroke without stored geometry (older file) gives pieces without it too: built from samples as before
  const oldStroke = { ...stroke };
  delete oldStroke.geom;
  const oldPieces = cutStroke(oldStroke, 170, 80, 170, 120, 6, true)!;
  assert.ok(oldPieces.every((p) => p.geom === undefined));
});

test('stored geometry: lasso move / scale / rotate and whiteboard conversion move the ink with the samples', () => {
  const { stroke } = draw(wave);
  const moved = transformStroke(stroke, [100, 100], 1, 0, 30, -20);
  assert.ok(Math.abs(moved.geom!.xs[5] - (stroke.geom!.xs[5] + 30)) < 0.006);
  assert.ok(Math.abs(moved.geom!.ys[5] - (stroke.geom!.ys[5] - 20)) < 0.006);
  assert.deepEqual(moved.geom!.rs, stroke.geom!.rs);
  const turned = transformStroke(stroke, [100, 100], 2, Math.PI / 2, 0, 0);
  const i = 7;
  const dx = stroke.geom!.xs[i] - 100;
  const dy = stroke.geom!.ys[i] - 100;
  assert.ok(Math.abs(turned.geom!.xs[i] - (100 - dy * 2)) < 0.01 && Math.abs(turned.geom!.ys[i] - (100 + dx * 2)) < 0.01);
  assert.ok(Math.abs(turned.geom!.rs[i] - stroke.geom!.rs[i] * 2) < 0.006, 'radius scaled like the width');
  // the transformed ink matches the transformed samples' centerline closely (same shape, moved)
  const tg = new GeometryCache().get(turned);
  const fromSamples = buildStrokeGeometry(turned.samples, turned.tool, turned.params, { zoom: turned.zoom, hasPressure: true, engine: turned.engine });
  assert.ok(maxDev(tg, fromSamples) < 1.5);
  // whiteboard conversion: strokes of page 2 move right with their page
  const doc = createDocument({ pages: 2 });
  doc.pages[1].strokes.push(stroke);
  const board = convertPagesToBoard(doc.pages);
  const s2 = board.strokes[0];
  const off = s2.samples[0].x - stroke.samples[0].x;
  assert.ok(off > 500);
  assert.ok(Math.abs(s2.geom!.xs[0] - (stroke.geom!.xs[0] + off)) < 0.006);
});

test('stored geometry: lift hook on the drawn ink is cut only when it clearly turns back', () => {
  // straight line to the right with a 2-unit hook back left-down at the end
  const xs = Array.from({ length: 30 }, (_, i) => i * 2);
  const ys = xs.map(() => 0);
  const rs = xs.map(() => 1);
  const hooked = trimGeometryHook([...xs, 57.4, 56.5], [...ys, 0.8, 1.5], [...rs, 1, 1], 1);
  assert.equal(hooked.xs.length, 30, 'the hook is removed');
  const straight = trimGeometryHook([...xs, 60, 62], [...ys, 0, 0], [...rs, 1, 1], 1);
  assert.equal(straight.xs.length, 32, 'a straight end is kept');
  const bend = trimGeometryHook([...xs, 59.5, 60.5], [...ys, 1, 2.2], [...rs, 1, 1], 1);
  assert.equal(bend.xs.length, 32, 'a gentle bend (< 100°) is kept');
  // a dot stays a dot
  const dot = geometryFromStored({ xs: [5], ys: [5], rs: [2] });
  assert.equal(dot.dot, true);
  assert.deepEqual(dot.bbox, [3, 3, 7, 7]);
});
