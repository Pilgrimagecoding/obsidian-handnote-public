// 0.12 outline: smooth offset outline with round caps; capsules only at sharp turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CountingSink, SvgPathSink, emitStroke, type PathSink } from '../../src/ink/outline';
import { INK_PIPELINE, StrokeBuilder } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import { lShape, samplePath } from './helpers';

/** Flattens the path into polygons (arcs every 2°) for a nonzero point-in-shape test. */
class PolySink implements PathSink {
  polys: [number, number][][] = [];
  private cur: [number, number][] = [];
  moveTo(x: number, y: number): void {
    this.cur = [[x, y]];
    this.polys.push(this.cur);
  }
  lineTo(x: number, y: number): void {
    this.cur.push([x, y]);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const n = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 90)));
    for (let i = 0; i <= n; i++) this.cur.push([cx + r * Math.cos(a0 + ((a1 - a0) * i) / n), cy + r * Math.sin(a0 + ((a1 - a0) * i) / n)]);
  }
  quadTo(cx: number, cy: number, x: number, y: number): void {
    const [x0, y0] = this.cur[this.cur.length - 1];
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      this.cur.push([(1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y]);
    }
  }
  closePath(): void {}
  winding(x: number, y: number): number {
    let w = 0;
    for (const p of this.polys)
      for (let i = 0; i < p.length; i++) {
        const [x0, y0] = p[i];
        const [x1, y1] = p[(i + 1) % p.length];
        if (y0 <= y) {
          if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++;
        } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
      }
    return w;
  }
}

/** Inside the union of the pen's circles along the centerline (the ink by definition). */
function inInk(xs: number[], ys: number[], rs: number[], x: number, y: number): boolean {
  for (let i = 0; i < xs.length; i++) {
    const n = i ? Math.ceil(Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) / 0.05) : 1;
    for (let j = 1; j <= n; j++) {
      const u = j / n;
      const cx = i ? xs[i - 1] + (xs[i] - xs[i - 1]) * u : xs[i];
      const cy = i ? ys[i - 1] + (ys[i] - ys[i - 1]) * u : ys[i];
      const r = i ? rs[i - 1] + (rs[i] - rs[i - 1]) * u : rs[i];
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
    }
  }
  return false;
}

function compare(xs: number[], ys: number[], rs: number[]): { wrong: number; total: number } {
  const sink = new PolySink();
  emitStroke(sink, xs, ys, rs);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    x0 = Math.min(x0, xs[i] - rs[i]);
    x1 = Math.max(x1, xs[i] + rs[i]);
    y0 = Math.min(y0, ys[i] - rs[i]);
    y1 = Math.max(y1, ys[i] + rs[i]);
  }
  let wrong = 0;
  let total = 0;
  const step = Math.max(x1 - x0, y1 - y0) / 140;
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      const a = inInk(xs, ys, rs, x, y);
      const b = sink.winding(x, y) !== 0;
      if (a) total++;
      // only count disagreements clearly away from the edge (the outline is a polygon)
      if (a !== b) {
        let near = false;
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) if (inInk(xs, ys, rs, x + dx * 0.6, y + dy * 0.6) !== a) near = true;
        if (!near) wrong++;
      }
    }
  return { wrong, total };
}

function ink(path: (u: number) => { x: number; y: number }, pressure: (u: number) => number) {
  const raw = samplePath(path, { durationMs: 600, noise: 0.1, seed: 5, pressure });
  const b = new StrokeBuilder('fountain', DEFAULT_PEN_PARAMS.fountain, { zoom: 1, hasPressure: true, ink: INK_PIPELINE });
  for (const s of raw) b.add(s);
  return b.commitGeometry();
}

test('outline: a single point is a circle; a straight line of equal width is one smooth piece', () => {
  const c = new CountingSink();
  emitStroke(c, [5], [5], [2]);
  assert.equal(c.subpaths, 1);
  const xs = Array.from({ length: 50 }, (_, i) => i * 0.5);
  const line = new CountingSink();
  emitStroke(line, xs, xs.map(() => 10), xs.map(() => 1));
  assert.equal(line.subpaths, 1, 'one closed outline, not 49 capsules');
  const r = compare(xs, xs.map(() => 10), xs.map(() => 1));
  assert.equal(r.wrong, 0);
});

test('outline: covers exactly the ink — varying width, curves and a sharp corner (no holes, no spikes)', () => {
  const cases = {
    'width varies': ink((u) => ({ x: 10 + u * 120, y: 50 + Math.sin(u * 4) * 10 }), (u) => 0.1 + 0.5 * u),
    curve: ink((u) => ({ x: 60 + 40 * Math.cos(u * 5), y: 60 + 40 * Math.sin(u * 5) }), () => 0.3),
    'sharp corner': ink(lShape(10, 10, 40), () => 0.3),
    'small loop': ink((u) => ({ x: 20 + u * 30 + 4 * Math.cos(u * 12), y: 20 + 4 * Math.sin(u * 12) }), () => 0.35),
  };
  for (const [name, g] of Object.entries(cases)) {
    const { wrong, total } = compare(g.xs, g.ys, g.rs);
    assert.ok(wrong / total < 0.002, `${name}: ${wrong} of ${total} points disagree`);
  }
});

test('outline: SVG and canvas get the same path; a long smooth stroke is a few pieces', () => {
  const g = ink((u) => ({ x: 10 + u * 200, y: 50 + Math.sin(u * 6) * 15 }), (u) => 0.2 + 0.2 * Math.sin(u * 9));
  const svg = new SvgPathSink();
  emitStroke(svg, g.xs, g.ys, g.rs);
  assert.ok(svg.toString().startsWith('M'));
  const c = new CountingSink();
  emitStroke(c, g.xs, g.ys, g.rs);
  assert.ok(c.subpaths <= 3, `${c.subpaths} pieces for ${g.xs.length} points`);
});
