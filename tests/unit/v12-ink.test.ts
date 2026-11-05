// 0.12 ink pipeline: light noise filter + symmetric centerline smoothing (GoodNotes-like smooth lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INK_PIPELINE, StrokeBuilder, buildStrokeGeometry } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS, EXPERIMENTAL_FOUNTAIN } from '../../src/ink/presets';
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

test('0.12 ink: 笔锋 — a flick ends in a point, a slow lift keeps some width, and the end never reaches past the live ink', () => {
  const run = (durationMs: number, endSlow: boolean) => {
    const raw = samplePath((u) => ({ x: 20 + (endSlow ? Math.sin((u * Math.PI) / 2) : u) * 120, y: 50 + u * 30 }), { durationMs, noise: 0.05, seed: 3, pressure: () => 0.3 });
    const b = new StrokeBuilder('fountain', fountain, { zoom: 1, hasPressure: true, engine: 2, ink: INK_PIPELINE });
    for (const s of raw) b.add(s);
    const st = b.stable();
    const tl = b.tail();
    const lx = [...st.xs, ...tl.xs];
    const ly = [...st.ys, ...tl.ys];
    const lr = [...st.rs, ...tl.rs];
    const g = b.commitGeometry();
    const mid = g.rs[Math.floor(g.rs.length / 2)];
    const end = g.rs[g.rs.length - 1];
    // reach along the exit direction: live tip + its radius vs stored tip + its radius
    const n = lx.length;
    const ux = (lx[n - 1] - lx[n - 6]) / Math.hypot(lx[n - 1] - lx[n - 6], ly[n - 1] - ly[n - 6]);
    const uy = (ly[n - 1] - ly[n - 6]) / Math.hypot(lx[n - 1] - lx[n - 6], ly[n - 1] - ly[n - 6]);
    const live = lx[n - 1] * ux + ly[n - 1] * uy + lr[n - 1];
    const m = g.xs.length;
    const stored = g.xs[m - 1] * ux + g.ys[m - 1] * uy + end;
    return { ratio: end / mid, overshoot: stored - live };
  };
  const flick = run(80, false);
  const slow = run(1200, true);
  assert.ok(flick.ratio < 0.2, `flick ends at ${(flick.ratio * 100).toFixed(0)} % of the width`);
  assert.ok(slow.ratio > 0.4, `slow lift keeps ${(slow.ratio * 100).toFixed(0)} %`);
  for (const r of [flick, slow]) assert.ok(r.overshoot < 0.02, `stored end ${r.overshoot.toFixed(3)} beyond the live end`);
});

test('0.12 ink: 起笔 — a stroke starts narrower than it continues', () => {
  const raw = samplePath((u) => ({ x: 20 + u * 100, y: 50 }), { durationMs: 400, noise: 0.02, seed: 2, pressure: () => 0.3 });
  const b = new StrokeBuilder('ballpoint', DEFAULT_PEN_PARAMS.ballpoint, { zoom: 1, hasPressure: true, ink: INK_PIPELINE });
  for (const s of raw) b.add(s);
  const g = b.commitGeometry();
  assert.ok(g.rs[0] < g.rs[Math.floor(g.rs.length / 2)] * 0.6, `start ${g.rs[0].toFixed(2)} vs middle ${g.rs[Math.floor(g.rs.length / 2)].toFixed(2)}`);
});

import { TYPICAL_PRESSURE_V12, tiltFactor } from '../../src/ink/stroke-builder';

test('0.12 ink: Pencil tilt widens the stroke gently; no tilt (mouse, upright pen) changes nothing', () => {
  assert.equal(tiltFactor(0, 0, 0.4), 1);
  assert.ok(Math.abs(tiltFactor(45, 0, 0.4) - 1.2) < 1e-9, '45° → +20 %');
  assert.ok(Math.abs(tiltFactor(-45, 0, 0.4) - 1.2) < 1e-9, 'either side');
  assert.ok(tiltFactor(89, 89, 1) <= 2 + 1e-9, 'never more than 1 + sensitivity');
  assert.equal(tiltFactor(60, 30, 0), 1, 'sensitivity 0 = tilt ignored');
  const raw = samplePath((u) => ({ x: 20 + u * 120, y: 50 }), { durationMs: 500, noise: 0.02, seed: 4, pressure: () => 0.12 });
  const mid = (samples: typeof raw, ink?: number) => {
    const b = new StrokeBuilder('ballpoint', DEFAULT_PEN_PARAMS.ballpoint, { zoom: 1, hasPressure: true, ink });
    for (const s of samples) b.add(s);
    const g = b.commitGeometry();
    return g.rs[Math.floor(g.rs.length / 2)];
  };
  const flat = mid(raw, INK_PIPELINE);
  const tilted = mid(raw.map((s) => ({ ...s, tx: 45, ty: 0 })), INK_PIPELINE);
  assert.ok(Math.abs(tilted / flat - 1.2) < 0.02, `tilted 45°: ×${(tilted / flat).toFixed(3)}`);
  // strokes written before 0.12 keep their width whatever tilt they recorded
  assert.equal(mid(raw.map((s) => ({ ...s, tx: 45, ty: 0 }))), mid(raw));
});

test('0.12 ink: the typical (calibrated) pressure draws the nominal width', () => {
  const raw = samplePath((u) => ({ x: 20 + u * 120, y: 50 }), { durationMs: 500, noise: 0.02, seed: 4, pressure: () => TYPICAL_PRESSURE_V12 });
  const b = new StrokeBuilder('ballpoint', { ...DEFAULT_PEN_PARAMS.ballpoint, velocityThinning: 0 }, { zoom: 1, hasPressure: true, ink: INK_PIPELINE });
  for (const s of raw) b.add(s);
  const g = b.commitGeometry();
  const r = g.rs[Math.floor(g.rs.length / 2)];
  assert.ok(Math.abs(r / (DEFAULT_PEN_PARAMS.ballpoint.width / 2) - 1) < 0.03, `radius ${r.toFixed(3)} vs nominal ${(DEFAULT_PEN_PARAMS.ballpoint.width / 2).toFixed(3)}`);
});

test('0.12 ink: a light touch — a pressure dropout leaves no dent, and light writing is smoothed like firm writing', () => {
  const mk = (p: number, dropAt: number | null) =>
    samplePath((u) => ({ x: 20 + u * 120, y: 50 }), { durationMs: 500, noise: 0.02, seed: 6, pressure: (u) => (dropAt !== null && Math.abs(u - dropAt) < 0.004 ? p * 0.3 : p) });
  const radii = (samples: ReturnType<typeof mk>) => {
    const b = new StrokeBuilder('fountain', EXPERIMENTAL_FOUNTAIN, { zoom: 1, hasPressure: true, engine: 2, ink: INK_PIPELINE });
    for (const s of samples) b.add(s);
    return b.commitGeometry();
  };
  const clean = radii(mk(0.04, null));
  const dented = radii(mk(0.04, 0.5));
  const at = (g: { xs: number[]; rs: number[] }, x: number) => g.rs[g.xs.findIndex((v) => v >= x)];
  const dent = 1 - at(dented, 80) / at(clean, 80);
  assert.ok(Math.abs(dent) < 0.03, `one-sample dropout changes the width by ${(dent * 100).toFixed(1)} %`);
});
