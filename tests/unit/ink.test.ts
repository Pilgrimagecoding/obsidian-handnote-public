import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrokeBuilder, buildStrokeGeometry, trimLiftHook } from '../../src/ink/stroke-builder';
import { pressureMultiplier, nibMultiplier } from '../../src/ink/math';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import { CountingSink, SvgPathSink, emitGeometry, emitCapsule } from '../../src/ink/outline';
import { circle, distToPolyline, lShape, line, samplePath, stddev } from './helpers';

const fountain = DEFAULT_PEN_PARAMS.fountain;
const ballpoint = DEFAULT_PEN_PARAMS.ballpoint;
const ctx = { zoom: 2, hasPressure: true };

test('pressure mapping: typical pressure is neutral, monotonic, bounded', () => {
  assert.ok(Math.abs(pressureMultiplier(0.3, 0.7) - 1) < 1e-9);
  assert.equal(pressureMultiplier(0.9, 0), 1);
  let prev = 0;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const m = pressureMultiplier(p, 0.7);
    assert.ok(m >= prev - 1e-12, `monotonic at ${p}`);
    assert.ok(m >= 0.28 && m <= 2.1, `bounded at ${p}: ${m}`);
    prev = m;
  }
  // light pressure range stays responsive (small characters written lightly still vary)
  assert.ok(pressureMultiplier(0.2, 0.7) - pressureMultiplier(0.1, 0.7) > 0.15);
  // heavy pressure saturates softly instead of exploding
  assert.ok(pressureMultiplier(1, 1) < 2.1);
});

test('nib multiplier averages to ~1 and is 1 for round nibs', () => {
  assert.equal(nibMultiplier(1.2, 0.3, 0), 1);
  let sum = 0;
  for (let i = 0; i < 360; i++) sum += nibMultiplier((i * Math.PI) / 180, -0.6, 0.3);
  const avg = sum / 360;
  assert.ok(avg > 0.9 && avg < 1.1, `avg ${avg}`);
});

test('slow writing: jitter is strongly reduced', () => {
  // 60 units in 1.5 s (~80 screen px/s at zoom 2) with 0.25 unit tremor
  const raw = samplePath(line(10, 100, 70, 100), { durationMs: 1500, noise: 0.25, seed: 7 });
  const g = buildStrokeGeometry(raw, 'fountain', fountain, ctx);
  const inner = (ys: number[]) => ys.slice(Math.floor(ys.length * 0.1), Math.floor(ys.length * 0.9));
  const rawSd = stddev(inner(raw.map((s) => s.y)));
  const outSd = stddev(inner(g.ys));
  assert.ok(outSd < rawSd * 0.5, `jitter ${outSd.toFixed(3)} vs raw ${rawSd.toFixed(3)}`);
});

test('fast writing: shape is preserved (small loops do not shrink much)', () => {
  // a 12-unit-radius circle in 260 ms: fast cursive
  const raw = samplePath(circle(100, 100, 12), { durationMs: 260 });
  const g = buildStrokeGeometry(raw, 'fountain', fountain, ctx);
  const radii = g.xs.map((x, i) => Math.hypot(x - 100, g.ys[i] - 100)).slice(Math.floor(g.xs.length * 0.2));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  assert.ok(Math.abs(mean - 12) / 12 < 0.08, `mean radius ${mean.toFixed(2)}`);
});

test('corners stay sharp (横折)', () => {
  const raw = samplePath(lShape(20, 20, 30), { durationMs: 500 });
  const g = buildStrokeGeometry(raw, 'fountain', fountain, ctx);
  const d = distToPolyline(50, 20, g.xs, g.ys);
  assert.ok(d < 1.2, `corner distance ${d.toFixed(2)} units`);
});

test('final stroke ends exactly at the last raw sample (no gap / no jump on release)', () => {
  const raw = samplePath(line(0, 0, 80, 30), { durationMs: 300 });
  const g = buildStrokeGeometry(raw, 'ballpoint', ballpoint, ctx);
  const last = raw[raw.length - 1];
  assert.ok(Math.hypot(g.xs[g.xs.length - 1] - last.x, g.ys[g.ys.length - 1] - last.y) < 1e-6);
  assert.ok(Math.hypot(g.xs[0] - raw[0].x, g.ys[0] - raw[0].y) < 1e-6, 'starts at first sample');
});

test('live preview prefix is identical to the committed geometry (deterministic, incremental)', () => {
  const raw = samplePath(circle(50, 50, 20), { durationMs: 600, noise: 0.1, seed: 3 });
  const b = new StrokeBuilder('fountain', fountain, ctx);
  const snapshots: { xs: number[]; ys: number[] }[] = [];
  raw.forEach((s, i) => {
    b.add(s);
    if (i % 17 === 0) {
      const st = b.stable();
      snapshots.push({ xs: [...st.xs], ys: [...st.ys] });
      // tail always reaches the pen tip
      const tl = b.tail();
      if (tl.xs.length) {
        assert.ok(Math.hypot(tl.xs[tl.xs.length - 1] - s.x, tl.ys[tl.ys.length - 1] - s.y) < 1e-6, 'tail reaches pen tip');
      }
    }
  });
  const g = buildStrokeGeometry(raw, 'fountain', fountain, ctx);
  for (const snap of snapshots) {
    for (let i = 0; i < snap.xs.length; i++) {
      assert.equal(snap.xs[i], g.xs[i]);
      assert.equal(snap.ys[i], g.ys[i]);
    }
  }
  assert.ok(snapshots[snapshots.length - 1].xs.length > 50);
});

test('no lost samples: builder keeps every raw sample', () => {
  const raw = samplePath(line(0, 0, 100, 0), { durationMs: 500 });
  const b = new StrokeBuilder('fountain', fountain, ctx);
  for (const s of raw) b.add(s);
  assert.equal(b.rawCount, raw.length);
  // non-monotonic timestamps are sanitized, not dropped
  b.add({ x: 101, y: 0, p: 0.3, t: 1 });
  assert.equal(b.rawCount, raw.length + 1);
  assert.ok(b.rawSamples[b.rawCount - 1].t >= raw[raw.length - 1].t);
});

test('taps become dots that are at least as large as the nib', () => {
  const g = buildStrokeGeometry([{ x: 5, y: 5, p: 0.3, t: 0 }], 'fountain', fountain, ctx);
  assert.equal(g.dot, true);
  assert.ok(g.rs[0] >= (fountain.width / 2) * 0.8);
  const g2 = buildStrokeGeometry(
    [
      { x: 5, y: 5, p: 0.3, t: 0 },
      { x: 5.1, y: 5, p: 0.35, t: 8 },
    ],
    'fountain',
    fountain,
    ctx,
  );
  assert.equal(g2.dot, true);
});

test('fountain pen has entry and exit taper; ballpoint stays even', () => {
  const raw = samplePath(line(0, 0, 120, 0), { durationMs: 400, pressure: () => 0.3 });
  const gf = buildStrokeGeometry(raw, 'fountain', fountain, ctx);
  const mid = gf.rs[Math.floor(gf.rs.length / 2)];
  assert.ok(gf.rs[0] < mid * 0.75, `entry ${gf.rs[0]} vs mid ${mid}`);
  assert.ok(gf.rs[gf.rs.length - 1] < mid * 0.75, `exit ${gf.rs[gf.rs.length - 1]} vs mid ${mid}`);
  const gb = buildStrokeGeometry(raw, 'ballpoint', ballpoint, ctx);
  const bmid = gb.rs[Math.floor(gb.rs.length / 2)];
  const body = gb.rs.slice(Math.floor(gb.rs.length * 0.1), Math.floor(gb.rs.length * 0.9));
  const bmin = Math.min(...body);
  const bmax = Math.max(...body);
  assert.ok((bmax - bmin) / bmid < 0.05, 'ballpoint width is stable');
});

test('pressure changes the fountain width; heavier = thicker', () => {
  const light = buildStrokeGeometry(samplePath(line(0, 0, 100, 0), { durationMs: 400, pressure: () => 0.12 }), 'fountain', fountain, ctx);
  const heavy = buildStrokeGeometry(samplePath(line(0, 0, 100, 0), { durationMs: 400, pressure: () => 0.6 }), 'fountain', fountain, ctx);
  const m = (g: { rs: number[] }) => g.rs[Math.floor(g.rs.length / 2)];
  assert.ok(m(heavy) > m(light) * 1.5, `${m(heavy)} vs ${m(light)}`);
});

test('lift hook is trimmed, ordinary endings are not', () => {
  const base = samplePath(line(0, 0, 40, 0), { durationMs: 200, hz: 240 });
  const lastT = base[base.length - 1].t;
  const hooked = base.concat([
    { x: 39.6, y: 0.4, p: 0.1, t: lastT + 4 },
    { x: 39.2, y: 0.8, p: 0.05, t: lastT + 8 },
  ]);
  const trimmed = trimLiftHook(hooked, 2);
  assert.ok(trimmed.length < hooked.length, 'hook removed');
  assert.equal(trimLiftHook(base, 2).length, base.length, 'normal stroke untouched');
});

test('outline: capsules are emitted with consistent winding and valid SVG', () => {
  const raw = samplePath(circle(30, 30, 10), { durationMs: 300 });
  const g = buildStrokeGeometry(raw, 'fountain', fountain, ctx);
  const c = new CountingSink();
  emitGeometry(c, g);
  assert.ok(c.subpaths > 10);
  const svg = new SvgPathSink();
  emitGeometry(svg, g);
  const d = svg.toString();
  assert.match(d, /^M[-\d.]+ [-\d.]+A/);
  assert.ok(!/NaN|Infinity/.test(d));
  // contained circle degenerates to one circle
  const one = new CountingSink();
  emitCapsule(one, 0, 0, 5, 1, 0, 1);
  assert.equal(one.subpaths, 1);
});

test('mouse input (no pressure) still produces a sensible stroke', () => {
  const raw = samplePath(line(0, 0, 60, 20), { durationMs: 300 }).map((s) => ({ ...s, p: 0.5 }));
  const g = buildStrokeGeometry(raw, 'fountain', fountain, { zoom: 1, hasPressure: false });
  const mid = g.rs[Math.floor(g.rs.length / 2)];
  assert.ok(mid > fountain.width * 0.3 && mid < fountain.width * 1.2, `mid radius ${mid}`);
});
