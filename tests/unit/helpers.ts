import type { InputSample } from '../../src/ink/types';

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian noise via Box-Muller. */
export function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Sample a parametric path f(u), u in [0,1], at `hz` samples per second for `durationMs`.
 * `noise` is the std-dev of positional jitter in page units.
 */
export function samplePath(
  f: (u: number) => { x: number; y: number },
  opts: { durationMs: number; hz?: number; noise?: number; seed?: number; pressure?: (u: number) => number },
): InputSample[] {
  const hz = opts.hz ?? 240;
  const n = Math.max(2, Math.round((opts.durationMs / 1000) * hz));
  const r = rng(opts.seed ?? 1);
  const out: InputSample[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const p = f(u);
    const nz = opts.noise ?? 0;
    out.push({
      x: p.x + (nz ? gauss(r) * nz : 0),
      y: p.y + (nz ? gauss(r) * nz : 0),
      p: opts.pressure ? opts.pressure(u) : 0.3,
      t: (i * 1000) / hz,
    });
  }
  return out;
}

export const line = (x0: number, y0: number, x1: number, y1: number) => (u: number) => ({
  x: x0 + (x1 - x0) * u,
  y: y0 + (y1 - y0) * u,
});

export const circle = (cx: number, cy: number, r: number) => (u: number) => ({
  x: cx + r * Math.cos(u * Math.PI * 2),
  y: cy + r * Math.sin(u * Math.PI * 2),
});

/** L-shaped polyline (横折): right then down, with a sharp 90° corner at (x0 + a, y0). */
export const lShape = (x0: number, y0: number, a: number) => (u: number) =>
  u < 0.5 ? { x: x0 + a * (u / 0.5), y: y0 } : { x: x0 + a, y: y0 + a * ((u - 0.5) / 0.5) };

/** Distance from point to polyline. */
export function distToPolyline(px: number, py: number, xs: number[], ys: number[]): number {
  let best = Infinity;
  for (let i = 1; i < xs.length; i++) {
    const ax = xs[i - 1];
    const ay = ys[i - 1];
    const bx = xs[i];
    const by = ys[i];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + dx * t - px, ay + dy * t - py));
  }
  return best;
}

export function stddev(a: number[]): number {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
}
