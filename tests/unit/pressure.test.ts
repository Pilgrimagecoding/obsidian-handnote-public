import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StrokeBuilder, buildStrokeGeometry } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS, EXPERIMENTAL_FOUNTAIN_BETA2 as EXPERIMENTAL_FOUNTAIN } from '../../src/ink/presets';
import { curveShape, pressureWidthFactor } from '../../src/ink/math';
import { pressureVerdict, summarize, histogram } from '../../src/input/diagnostics';
import { circle, line, lShape, samplePath, stddev, distToPolyline } from './helpers';

const ctx1 = { zoom: 1.7, hasPressure: true };
const ctx2 = { zoom: 1.7, hasPressure: true, engine: 2 };

test('engine 1 (v0.1 Baseline) geometry is bit-for-bit unchanged (24 recorded cases)', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/engine-v1-geometry.json', 'utf8')).cases as Record<string, string>;
  const inputs = {
    line: samplePath(line(0, 0, 120, 30), { durationMs: 400, noise: 0.1, seed: 3, pressure: (u) => 0.15 + 0.5 * Math.sin(u * 3) ** 2 }),
    circle: samplePath(circle(50, 50, 12), { durationMs: 260, seed: 5, pressure: () => 0.3 }),
    corner: samplePath(lShape(10, 10, 20), { durationMs: 500, noise: 0.05, seed: 9, pressure: (u) => 0.2 + 0.3 * u }),
    dot: [{ x: 5, y: 5, p: 0.3, t: 0 }],
  };
  let n = 0;
  for (const tool of ['fountain', 'ballpoint', 'highlighter'] as const) {
    for (const [name, s] of Object.entries(inputs)) {
      for (const hasPressure of [true, false]) {
        // engine undefined (old strokes) and engine 1 must both give the recorded result
        for (const engine of [undefined, 1]) {
          const g = buildStrokeGeometry(s, tool, DEFAULT_PEN_PARAMS[tool], { zoom: 1.7, hasPressure, engine });
          const h = createHash('sha256').update(JSON.stringify([g.xs, g.ys, g.rs, g.dot, g.bbox])).digest('hex').slice(0, 24);
          assert.equal(h, fixture[`${tool}/${name}/${hasPressure ? 'p' : 'np'}`], `${tool}/${name}/${hasPressure}`);
          n++;
        }
      }
    }
  }
  assert.equal(n, 48);
});

test('pressure curves are monotonic, start at 0 and end at 1', () => {
  for (const c of [0, 1, 2, 3]) {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const v = curveShape(c, t);
      assert.ok(v >= prev - 1e-12, `curve ${c} monotonic at ${t}`);
      prev = v;
    }
    assert.ok(Math.abs(curveShape(c, 0)) < 1e-9 && Math.abs(curveShape(c, 1) - 1) < 1e-9);
  }
});

test('engine 2 mapping: typical pressure = nominal width; light thin, heavy bounded', () => {
  const f = (p: number, typical = 0.3) => pressureWidthFactor(p, 1, 3, 0.2, 2.2, typical);
  assert.ok(Math.abs(f(0.3) - 1) < 1e-9);
  assert.ok(Math.abs(f(0.18, 0.18) - 1) < 1e-9, 'calibrated typical pressure maps to nominal width');
  assert.ok(f(0) < 0.4, `p=0 → ${f(0)}`);
  assert.ok(f(0.1) < f(0.3) && f(0.3) < f(0.5) && f(0.5) < f(1));
  assert.ok(f(1) < 2.2, `p=1 bounded (${f(1)})`);
  assert.equal(pressureWidthFactor(0.9, 0, 0, 0.3, 1.9, 0.3), 1, 'sensitivity 0 = constant width');
});

const P = EXPERIMENTAL_FOUNTAIN;

function midRadius(g: { rs: number[] }) {
  return g.rs[Math.floor(g.rs.length / 2)];
}

test('engine 2 widths across the real Pencil range (0 / 0.05 / 0.25 / 0.45) are ordered and finite', () => {
  const widths = [0, 0.05, 0.25, 0.45].map((p) => midRadius(buildStrokeGeometry(samplePath(line(0, 0, 100, 0), { durationMs: 400, pressure: () => p }), 'fountain', P, ctx2)));
  for (const w of widths) assert.ok(Number.isFinite(w) && w > 0);
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2] && widths[2] < widths[3], widths.join(', '));
  assert.ok(widths[3] / widths[1] > 2.6, `heavy vs light contrast ${(widths[3] / widths[1]).toFixed(2)}`);
});

test('missing / fixed pressure (mouse, finger) gives a stable, near-nominal width', () => {
  const g = buildStrokeGeometry(samplePath(line(0, 0, 100, 0), { durationMs: 400, pressure: () => 0.5 }), 'fountain', P, { ...ctx2, hasPressure: false });
  const body = g.rs.slice(Math.floor(g.rs.length * 0.15), Math.floor(g.rs.length * 0.75));
  const rel = (Math.max(...body) - Math.min(...body)) / midRadius(g);
  assert.ok(rel < 0.25, `variation ${rel.toFixed(3)}`);
  const nominal = P.width / 2;
  assert.ok(midRadius(g) > nominal * 0.6 && midRadius(g) < nominal * 1.3);
});

test('pressure noise does not make edges jitter (engine 2 smoother than engine 1)', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  // noise of ±17% around the writer's typical pressure (0.12, first iPad report)
  const raw = samplePath(line(0, 0, 150, 0), { durationMs: 900, hz: 240, pressure: () => 0.12 + 0.02 * rnd() });
  const g1 = buildStrokeGeometry(raw, 'fountain', DEFAULT_PEN_PARAMS.fountain, ctx1);
  const g2 = buildStrokeGeometry(raw, 'fountain', P, ctx2);
  const rough = (rs: number[]) => {
    const b = rs.slice(Math.floor(rs.length * 0.2), Math.floor(rs.length * 0.8));
    const d: number[] = [];
    for (let i = 1; i < b.length; i++) d.push(b[i] - b[i - 1]);
    return stddev(d) / (b.reduce((a, c) => a + c, 0) / b.length);
  };
  assert.ok(rough(g2.rs) < 0.02, `engine 2 edge roughness ${rough(g2.rs).toFixed(4)}`);
  assert.ok(rough(g2.rs) <= rough(g1.rs) * 1.05, `v2 ${rough(g2.rs).toFixed(4)} vs v1 ${rough(g1.rs).toFixed(4)}`);
});

test('rapid deliberate pressure changes are followed (not smoothed away)', () => {
  const raw = samplePath(line(0, 0, 150, 0), { durationMs: 600, pressure: (u) => (u < 0.5 ? 0.06 : 0.4) });
  const g = buildStrokeGeometry(raw, 'fountain', P, ctx2);
  const n = g.rs.length;
  const light = g.rs[Math.floor(n * 0.35)];
  const heavy = g.rs[Math.floor(n * 0.62)];
  assert.ok(heavy > light * 1.8, `step response ${light.toFixed(3)} → ${heavy.toFixed(3)}`);
});

test('taper stays proportionate on short strokes (small Chinese characters)', () => {
  // a 4-unit stroke (a dot-stroke in a ~4 mm character)
  const raw = samplePath(line(0, 0, 4, 1), { durationMs: 70, pressure: (u) => 0.25 + 0.1 * Math.sin(u * 3) });
  for (const [params, c, name] of [
    [DEFAULT_PEN_PARAMS.fountain, ctx1, 'v1'],
    [P, ctx2, 'v2'],
  ] as const) {
    const g = buildStrokeGeometry(raw, 'fountain', params, c);
    const end = g.rs[g.rs.length - 1];
    const max = Math.max(...g.rs);
    if (name === 'v2') assert.ok(end / max > 0.25, `v2 end keeps ${(end / max).toFixed(2)} of the max width`);
  }
});

test('engine 2 keeps small-character corners sharp (口 / 日 style turns)', () => {
  for (const size of [6, 12]) {
    const raw = samplePath(lShape(10, 10, size), { durationMs: 300 + size * 10, noise: 0.03, seed: 4, pressure: () => 0.3 });
    const g = buildStrokeGeometry(raw, 'fountain', P, ctx2);
    const d = distToPolyline(10 + size, 10, g.xs, g.ys) * ctx2.zoom;
    assert.ok(d < 1.2, `corner of a ${size}-unit stroke within ${d.toFixed(2)} screen px`);
  }
});

test('engine 2 live prefix equals committed geometry (no jump on release)', () => {
  const raw = samplePath(circle(40, 40, 10), { durationMs: 500, noise: 0.05, seed: 2, pressure: (u) => 0.2 + 0.4 * u });
  const b = new StrokeBuilder('fountain', P, ctx2);
  const snaps: number[][] = [];
  raw.forEach((s, i) => {
    b.add(s);
    if (i % 13 === 0) snaps.push([...b.stable().rs]);
  });
  const g = buildStrokeGeometry(raw, 'fountain', P, ctx2);
  const final = snaps[snaps.length - 1];
  // stable prefix is immutable; only the exit taper may change the last samples
  const exitZone = Math.ceil(g.rs.length * 0.25);
  for (let i = 0; i < Math.min(final.length, g.rs.length - exitZone); i++) assert.equal(final[i], g.rs[i]);
});

test('re-render consistency: building twice gives identical geometry', () => {
  const raw = samplePath(circle(40, 40, 10), { durationMs: 400, seed: 8, pressure: (u) => 0.3 + 0.2 * Math.sin(u * 7) });
  const a = buildStrokeGeometry(raw, 'fountain', P, ctx2);
  const b = buildStrokeGeometry(raw, 'fountain', P, ctx2);
  assert.deepEqual(a, b);
});

test('predicted samples only affect the preview tail, never stored samples', () => {
  const raw = samplePath(line(0, 0, 40, 0), { durationMs: 200 });
  const b = new StrokeBuilder('fountain', P, ctx2);
  for (const s of raw) b.add(s);
  const before = b.rawSamples.length;
  const tail = b.tail([{ x: 45, y: 0, p: 0.3, t: 210 }]);
  assert.equal(b.rawSamples.length, before);
  assert.ok(tail.xs[tail.xs.length - 1] > 44, 'tail reaches the predicted point');
  const g = b.finalize();
  assert.ok(Math.max(...g.xs) <= 40 + 1e-9, 'final geometry ignores predictions');
});

test('diagnostics: pressure verdicts and summaries', () => {
  assert.equal(pressureVerdict(new Array(100).fill(0.5)).verdict, 'constant');
  assert.equal(pressureVerdict(new Array(100).fill(0)).verdict, 'none');
  assert.equal(pressureVerdict([0.1, 0.2]).verdict, 'insufficient');
  assert.equal(pressureVerdict(Array.from({ length: 100 }, (_, i) => 0.1 + i * 0.005)).verdict, 'real');
  const s = summarize([3, 1, 2]);
  assert.equal(s.p50, 2);
  assert.equal(s.min, 1);
  assert.deepEqual(histogram([0, 0.05, 0.5, 0.99, 1], 4, 0, 1), [2, 0, 1, 2]);
});

test('engine 2 strokes saved by 0.2.0-beta.1 (no heavyPressure) keep identical geometry (12 recorded cases)', () => {
  const fx = JSON.parse(readFileSync('tests/fixtures/engine-v2-beta1-geometry.json', 'utf8'));
  const inputs = {
    line: samplePath(line(0, 0, 120, 30), { durationMs: 400, noise: 0.1, seed: 3, pressure: (u) => 0.05 + 0.4 * Math.sin(u * 3) ** 2 }),
    circle: samplePath(circle(50, 50, 12), { durationMs: 260, seed: 5, pressure: () => 0.12 }),
    corner: samplePath(lShape(10, 10, 20), { durationMs: 500, noise: 0.05, seed: 9, pressure: (u) => 0.1 + 0.35 * u }),
  };
  let n = 0;
  for (const [pn, params] of Object.entries(fx.params as Record<string, any>)) {
    assert.equal(params.heavyPressure, undefined);
    for (const [name, s] of Object.entries(inputs)) {
      for (const hasPressure of [true, false]) {
        const g = buildStrokeGeometry(s, 'fountain', params, { zoom: 1.7, hasPressure, engine: 2 });
        const h = createHash('sha256').update(JSON.stringify([g.xs, g.ys, g.rs, g.dot, g.bbox])).digest('hex').slice(0, 24);
        assert.equal(h, fx.cases[`${pn}/${name}/${hasPressure ? 'p' : 'np'}`], `${pn}/${name}`);
        n++;
      }
    }
  }
  assert.equal(n, 12);
});

test('calibrated range from the first iPad report: median → nominal width, heavy range reachable', () => {
  // Apple Pencil in Obsidian 1.14.5 (docs/device-reports/2026-10-18-ipad-0.2.0-beta.1.md):
  // median 0.123, p95 0.337, max 0.469 — pressure never went above 0.5.
  const P = EXPERIMENTAL_FOUNTAIN;
  const w = (p: number, prm = P) =>
    pressureWidthFactor(p, prm.pressureSensitivity, prm.pressureCurve ?? 0, prm.minWidthRatio ?? 0.3, prm.maxWidthRatio ?? 1.9, prm.typicalPressure ?? 0.3, prm.heavyPressure);
  const beta1 = { ...P, typicalPressure: 0.3, heavyPressure: undefined };
  // beta.1 defaults drew this writer's normal writing ~25% thinner than nominal
  assert.ok(w(0.123, beta1) < 0.8, `beta1 median ${w(0.123, beta1)}`);
  // new defaults: normal writing ≈ nominal
  assert.ok(Math.abs(w(0.123) - 1) < 0.06, `median ${w(0.123)}`);
  // the heavy end of the real range reaches the top of the width range (beta.1: it never did)
  assert.ok(w(0.337) > 1.35, `p95 ${w(0.337)}`);
  assert.ok(Math.abs(w(0.469) - w(1)) < 1e-9, 'max measured pressure already gives the maximum width');
  assert.ok(w(0.469, beta1) < w(1, beta1) * 0.85, 'beta.1 left the top of the width range unused');
  assert.ok(w(0.05) < 0.7, `light ${w(0.05)}`);
  // monotonic over the real range
  let prev = 0;
  for (let p = 0; p <= 0.6; p += 0.01) {
    const v = w(p);
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
});
