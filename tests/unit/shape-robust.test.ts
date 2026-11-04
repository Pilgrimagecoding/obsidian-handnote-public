import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape } from '../../src/ink/shape-recognition';
import { arcPath, densify, ellipsePath, handStroke, roundedPolygon } from './handshapes';
import { rng } from './helpers';

/**
 * Shape pen robustness (iPad feedback: "casually drawn lines are often not recognised").
 * A seeded corpus of realistic hand-drawn strokes — uneven speed, sensor jitter, wobble, landing /
 * lift hooks, rounded corners, gaps and overshoot — must be recognised at a high rate, while
 * handwriting-like strokes must stay ink.
 */
type Pt = [number, number];
const N = 60;

function rate(name: string, make: (i: number, r: () => number) => { pts: Pt[]; wobble?: number; jitter?: number }, ok: (kind: string | undefined, r: ReturnType<typeof recognizeShape>) => boolean): number {
  let pass = 0;
  const fails: string[] = [];
  for (let i = 0; i < N; i++) {
    const r = rng(1000 + i * 7 + name.length);
    const m = make(i, r);
    const s = handStroke(m.pts, { seed: 77 + i, wobble: m.wobble, jitter: m.jitter });
    const rec = recognizeShape(s);
    if (ok(rec?.kind, rec)) pass++;
    else if (fails.length < 4) fails.push(String(rec?.kind ?? 'null'));
  }
  const pct = (100 * pass) / N;
  console.log(`  shape corpus ${name}: ${pct.toFixed(0)}% (${pass}/${N})${fails.length ? ' e.g. ' + fails.join(',') : ''}`);
  return pct;
}

test('casual straight lines (any angle, 30–400 units, wobble, hooks) are lines', () => {
  const p = rate(
    'line',
    (_i, r) => {
      const len = 30 + r() * 370;
      const ang = r() * Math.PI * 2;
      const x0 = 300;
      const y0 = 300;
      return { pts: densify([[x0, y0], [x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len]]), wobble: 0.004 + r() * 0.026 };
    },
    (k) => k === 'line',
  );
  assert.ok(p >= 95, `line rate ${p}%`);
});

test('arcs become curves', () => {
  const p = rate(
    'curve',
    (_i, r) => {
      const len = 80 + r() * 300;
      const ang = r() * Math.PI * 2;
      const a: Pt = [300, 300];
      const b: Pt = [300 + Math.cos(ang) * len, 300 + Math.sin(ang) * len];
      return { pts: arcPath(a, b, (r() < 0.5 ? -1 : 1) * (0.12 + r() * 0.2)), wobble: 0.004 + r() * 0.008 };
    },
    (k) => k === 'curve',
  );
  assert.ok(p >= 88, `curve rate ${p}%`);
});

test('circles and ellipses (gap or overlap at the end, uneven radius) are ellipses', () => {
  const p = rate(
    'ellipse',
    (i, r) => {
      const rx = 25 + r() * 130;
      const ry = rx * (0.55 + r() * 0.45);
      return { pts: ellipsePath(300, 300, rx, ry, r() * Math.PI, r() * 6.28, 0.9 + r() * 0.22, 0.02 + r() * 0.04, i), wobble: 0.004 };
    },
    (k) => k === 'ellipse',
  );
  assert.ok(p >= 92, `ellipse rate ${p}%`);
});

test('rectangles (rounded corners, overshoot, wobbly sides) are rectangles', () => {
  const p = rate(
    'rect',
    (_i, r) => {
      const w = 50 + r() * 250;
      const h = 40 + r() * 200;
      const x = 100;
      const y = 100;
      return { pts: roundedPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], 2 + r() * Math.min(w, h) * 0.08, -0.04 + r() * 0.12, r() * 0.2), wobble: 0.002 + r() * 0.004 };
    },
    (k) => k === 'rect',
  );
  assert.ok(p >= 90, `rect rate ${p}%`);
});

test('triangles are triangles', () => {
  const p = rate(
    'triangle',
    (_i, r) => {
      const s = 60 + r() * 220;
      const x = 100;
      const y = 100;
      return { pts: roundedPolygon([[x + s / 2 + (r() - 0.5) * s * 0.3, y], [x + s, y + s * (0.7 + r() * 0.3)], [x, y + s * (0.7 + r() * 0.3)]], 1 + r() * 4, -0.03 + r() * 0.1, r() * 0.3), wobble: 0.003 };
    },
    (k) => k === 'triangle',
  );
  assert.ok(p >= 85, `triangle rate ${p}%`);
});

test('a line with a V head drawn in one stroke is an arrow', () => {
  const p = rate(
    'arrow',
    (_i, r) => {
      const len = 90 + r() * 250;
      const ang = r() * Math.PI * 2;
      const a: Pt = [300, 300];
      const tip: Pt = [300 + Math.cos(ang) * len, 300 + Math.sin(ang) * len];
      const hl = 12 + r() * 14;
      const back = ang + Math.PI;
      const b1: Pt = [tip[0] + Math.cos(back + 0.5) * hl, tip[1] + Math.sin(back + 0.5) * hl];
      const b2: Pt = [tip[0] + Math.cos(back - 0.5) * hl, tip[1] + Math.sin(back - 0.5) * hl];
      return { pts: densify([a, tip, b1, tip, b2]), wobble: 0.003 };
    },
    (k, rec) => k === 'line' && !!rec?.arrowEnd,
  );
  assert.ok(p >= 80, `arrow rate ${p}%`);
});

test('handwriting-like strokes stay ink (no false shapes)', () => {
  const p = rate(
    'handwriting',
    (i, r) => {
      // cursive loops, zig-zags, hooks: ordinary writing strokes
      const pts: Pt[] = [];
      const kind = i % 3;
      for (let k = 0; k <= 200; k++) {
        const u = k / 200;
        if (kind === 0) pts.push([100 + u * 160 + 14 * Math.cos(u * 26), 200 + 14 * Math.sin(u * 26) + r() * 0.1]);
        else if (kind === 1) pts.push([100 + u * 150, 200 + (Math.floor(u * 6) % 2 ? 1 : -1) * ((u * 6) % 1) * 30]);
        else pts.push([100 + 40 * Math.sin(u * 9.4), 200 + u * 120 + 25 * Math.sin(u * 18.8)]);
      }
      return { pts, wobble: 0.002 };
    },
    (k) => k === undefined,
  );
  assert.ok(p >= 90, `false positives ${100 - p}%`);
});

// ---- 0.12: size-adaptive tolerances, live preview recognition ----
import { shapeTolerance } from '../../src/ink/shape-recognition';
import { bandStroke, expected, type Band, type Kind } from './shape-bands';

function bandRate(kind: Kind, band: Band, n = 60): number {
  let ok = 0;
  for (let i = 0; i < n; i++) if (expected(kind, recognizeShape(bandStroke(kind, band, i)), i)) ok++;
  const pct = (100 * ok) / n;
  console.log(`  shape band ${band} ${kind}: ${pct.toFixed(0)}%`);
  return pct;
}

test('tolerances scale with the size: looser (relative) for big shapes, tighter (absolute) for small ones', () => {
  const s = shapeTolerance(20);
  const m = shapeTolerance(200);
  const l = shapeTolerance(1500);
  assert.ok(s.k < m.k && m.k < l.k, 'relative multiplier grows with the size');
  assert.equal(shapeTolerance(10).k, shapeTolerance(40).k, 'flat below 40 units');
  assert.equal(shapeTolerance(800).k, shapeTolerance(5000).k, 'flat above 800 units');
  // absolute corner tolerance: small strokes get a few units (pen noise), large ones a share of their size
  assert.ok(s.cornerEps < m.cornerEps && m.cornerEps < l.cornerEps);
  assert.ok(s.cornerEps / 20 > l.cornerEps / 1500, 'relative to the size, pen noise dominates small shapes');
  for (const t of [s, m, l]) {
    assert.ok(t.ellipseErr < t.ellipseErrRound);
    assert.ok(t.lineLen > 1 && t.lineDev > 0 && t.curveErr > 0 && t.polyEps > 0);
  }
});

test('small shapes (16–45 units) are recognised much more often than with fixed thresholds', () => {
  // fixed thresholds (0.11): rect 45 %, triangle 34 %, curve 80 %, ellipse 88 %, line 91 %
  assert.ok(bandRate('rect', 'small') >= 75);
  assert.ok(bandRate('triangle', 'small') >= 75);
  assert.ok(bandRate('curve', 'small') >= 85);
  assert.ok(bandRate('ellipse', 'small') >= 85);
  assert.ok(bandRate('line', 'small') >= 90);
  assert.ok(bandRate('scribble', 'small') >= 85, 'small writing strokes stay ink');
});

test('medium and large shapes stay recognised (no regression from the adaptive thresholds)', () => {
  for (const band of ['medium', 'large'] as Band[]) {
    for (const k of ['line', 'curve', 'rect', 'triangle', 'arrow'] as Kind[]) assert.ok(bandRate(k, band) >= 93, `${band} ${k}`);
    // rotated ellipses are not fitted (axis-aligned fit only), hence a lower floor
    assert.ok(bandRate('ellipse', band) >= 85, `${band} ellipse`);
    assert.ok(bandRate('scribble', band) >= 97, `${band} scribble`);
  }
});

test('a near-circle snaps to a circle; a clear ellipse keeps its proportions', () => {
  const circ = recognizeShape(handStroke(ellipsePath(300, 300, 80, 76, 0, 0.5, 1.02, 0.02, 1), { seed: 3, wobble: 0.004 }));
  assert.equal(circ?.kind, 'ellipse');
  assert.ok(Math.abs(circ!.w - circ!.h) < 0.01, `circle ${circ!.w} × ${circ!.h}`);
  const ell = recognizeShape(handStroke(ellipsePath(300, 300, 120, 60, 0, 0.5, 1.02, 0.02, 2), { seed: 4, wobble: 0.004 }));
  assert.equal(ell?.kind, 'ellipse');
  assert.ok(ell!.w > ell!.h * 1.6, 'ellipse not snapped');
});
