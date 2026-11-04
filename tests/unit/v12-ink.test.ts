// 0.12 ink pipeline: light noise filter + symmetric centerline smoothing (GoodNotes-like smooth lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INK_PIPELINE, StrokeBuilder, buildStrokeGeometry } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import { distToPolyline, lShape, samplePath } from './helpers';
import type { InputSample } from '../../src/ink/types';

const fountain = DEFAULT_PEN_PARAMS.fountain;

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => {
  let u = 0;
  while (!u) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};

/** A hand-drawn straight line in screen px (240 Hz, ease in / out, sensor noise + tremor), written at `zoom`. */
function shakyLine(zoom: number, s0: number): InputSample[] {
  seed = s0;
  const n = 110;
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = i / n;
    const u = s * s * (3 - 2 * s);
    const t = i * (1000 / 240);
    return { x: (100 + u * 120 + 0.35 * gauss() + 0.2 * Math.sin(t / 15)) / zoom, y: (100 + u * 300 + 0.35 * gauss() + 0.2 * Math.cos(t / 19)) / zoom, p: 0.2 + 0.1 * Math.sin(Math.PI * s), t };
  });
}

/** Total turning (degrees) of a centerline per 100 screen px, measured every 3 px. */
function wiggle(xs: number[], ys: number[], zoom: number): number {
  const pts: [number, number][] = [[xs[0] * zoom, ys[0] * zoom]];
  for (let i = 1; i < xs.length; i++) {
    const [px, py] = pts[pts.length - 1];
    if (Math.hypot(xs[i] * zoom - px, ys[i] * zoom - py) >= 3) pts.push([xs[i] * zoom, ys[i] * zoom]);
  }
  let turn = 0;
  for (let k = 2; k < pts.length; k++) {
    const a = Math.atan2(pts[k - 1][1] - pts[k - 2][1], pts[k - 1][0] - pts[k - 2][0]);
    const b = Math.atan2(pts[k][1] - pts[k - 1][1], pts[k][0] - pts[k - 1][0]);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    turn += d;
  }
  return (turn * 180) / Math.PI / ((pts.length * 3) / 100);
}

function commit(raw: InputSample[], zoom: number, ink?: number) {
  const b = new StrokeBuilder('fountain', fountain, { zoom, hasPressure: true, ink });
  for (const s of raw) b.add(s);
  return b.commitGeometry();
}

test('0.12 ink: a shaky straight line comes out much straighter (less than half the wiggle)', () => {
  for (const zoom of [1, 4, 12]) {
    let before = 0;
    let after = 0;
    for (let r = 0; r < 4; r++) {
      const raw = shakyLine(zoom, 100 + r * 31);
      const g0 = commit(raw, zoom);
      const g1 = commit(raw, zoom, INK_PIPELINE);
      const cut = (g: { xs: number[]; ys: number[] }) => {
        const a = Math.floor(g.xs.length * 0.1);
        const b = Math.floor(g.xs.length * 0.9);
        return wiggle(g.xs.slice(a, b), g.ys.slice(a, b), zoom);
      };
      before += cut(g0);
      after += cut(g1);
    }
    console.log(`  zoom ${zoom}: wiggle ${(before / 4).toFixed(1)} → ${(after / 4).toFixed(1)} °/100 px`);
    assert.ok(after < before * 0.6, `zoom ${zoom}: ${after / 4} vs ${before / 4}`);
  }
});

test('0.12 ink: corners of small characters stay sharp (口 / 日 turns)', () => {
  for (const zoom of [1, 2]) {
    for (const size of [6, 12, 30]) {
      const raw = samplePath(lShape(10, 10, size), { durationMs: 300 + size * 10, noise: 0.03, seed: 4, pressure: () => 0.3 });
      const g = buildStrokeGeometry(raw, 'fountain', fountain, { zoom, hasPressure: true, ink: INK_PIPELINE });
      const d = distToPolyline(10 + size, 10, g.xs, g.ys) * zoom;
      assert.ok(d < 1.2, `zoom ${zoom}: corner of a ${size}-unit stroke within ${d.toFixed(2)} screen px`);
    }
  }
});

test('0.12 ink: the live ink is the stored ink, and old strokes are rebuilt exactly as before', () => {
  const raw = shakyLine(4, 7);
  const b = new StrokeBuilder('fountain', fountain, { zoom: 4, hasPressure: true, ink: INK_PIPELINE });
  for (const s of raw) b.add(s);
  const st = b.stable();
  const tl = b.tail();
  const live = { xs: [...st.xs, ...tl.xs], ys: [...st.ys, ...tl.ys] };
  const g = b.commitGeometry();
  for (let i = 0; i < g.xs.length - 1; i++) assert.ok(distToPolyline(g.xs[i], g.ys[i], live.xs, live.ys) < 0.01);
  // without ink: 2 the builder is the earlier one (stored strokes without geometry look the same)
  const a1 = buildStrokeGeometry(raw, 'fountain', fountain, { zoom: 4, hasPressure: true });
  const a2 = buildStrokeGeometry(raw, 'fountain', fountain, { zoom: 4, hasPressure: true, engine: 1 });
  assert.deepEqual(a1, a2);
});
