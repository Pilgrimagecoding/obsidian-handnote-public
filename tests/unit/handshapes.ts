import type { InputSample } from '../../src/ink/types';
import { gauss, rng } from './helpers';

/**
 * Realistic hand-drawn shape strokes for recognition tests: uneven speed (slow start, fast middle,
 * slow end), 240 Hz sampling, sensor jitter, low-frequency wobble across the stroke, small landing /
 * lift hooks, rounded corners, overshoot or a gap where a closed shape meets its start.
 */
type Pt = [number, number];

export interface HandOpts {
  seed: number;
  /** px per ms at full speed (0.3 slow … 1.5 fast). */
  speed?: number;
  /** std-dev of per-sample jitter (page units). */
  jitter?: number;
  /** amplitude of the perpendicular wobble as a fraction of the path length. */
  wobble?: number;
  hooks?: boolean;
}

function polyLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Point and unit normal at arc length d along a dense polyline. */
function at(pts: Pt[], cum: number[], d: number): { p: Pt; n: Pt } {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  const a = pts[i - 1];
  const b = pts[i];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return { p: [a[0] + dx * t, a[1] + dy * t], n: [-dy / l, dx / l] };
}

/** Turn an ideal dense path into what a hand + Pencil produces. */
export function handStroke(ideal: Pt[], o: HandOpts): InputSample[] {
  const r = rng(o.seed);
  const L = polyLength(ideal);
  const cum = [0];
  for (let i = 1; i < ideal.length; i++) cum.push(cum[i - 1] + Math.hypot(ideal[i][0] - ideal[i - 1][0], ideal[i][1] - ideal[i - 1][1]));
  const vmax = o.speed ?? 0.08 + r() * 1.3;
  const jitter = o.jitter ?? 0.45;
  const tremor = 0.2 + r() * 0.5; // physiological tremor (~9 Hz), page units
  const tph = r() * 6.28;
  const wob = (o.wobble ?? 0.012) * L;
  const ph1 = r() * 6.28;
  const ph2 = r() * 6.28;
  const f1 = 0.7 + r() * 1.2;
  const out: InputSample[] = [];
  const dt = 1000 / 240;
  let d = 0;
  let t = 0;
  const push = (x: number, y: number) => out.push({ x: x + gauss(r) * jitter, y: y + gauss(r) * jitter, p: 0.3, t });
  // landing hook: a few units in a random direction before the stroke proper
  const start = at(ideal, cum, 0).p;
  if (o.hooks !== false && r() < 0.8) {
    const ang = r() * Math.PI * 2;
    const hl = 1.5 + r() * 3.5;
    for (let k = 3; k >= 1; k--) {
      push(start[0] + Math.cos(ang) * hl * (k / 3), start[1] + Math.sin(ang) * hl * (k / 3));
      t += dt;
    }
  }
  while (d <= L) {
    const u = d / L;
    // bell-shaped speed profile: slow at both ends
    const v = vmax * (0.18 + 0.82 * Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 0.7);
    const { p, n } = at(ideal, cum, d);
    const w = wob * (Math.sin(2 * Math.PI * f1 * u + ph1) * 0.7 + Math.sin(2 * Math.PI * 2.3 * u + ph2) * 0.3) * Math.sin(Math.PI * u);
    const tr = tremor * Math.sin(2 * Math.PI * 9 * (t / 1000) + tph);
    push(p[0] + n[0] * (w + tr), p[1] + n[1] * (w + tr));
    d += v * dt;
    t += dt;
  }
  const end = at(ideal, cum, L).p;
  push(end[0], end[1]);
  t += dt;
  if (o.hooks !== false && r() < 0.8) {
    const ang = r() * Math.PI * 2;
    const hl = 1.5 + r() * 4;
    for (let k = 1; k <= 3; k++) {
      push(end[0] + Math.cos(ang) * hl * (k / 3), end[1] + Math.sin(ang) * hl * (k / 3));
      t += dt;
    }
  }
  return out;
}

export function densify(pts: Pt[], step = 1): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Polygon with rounded corners (radius in page units), drawn from a start offset along the outline. */
export function roundedPolygon(corners: Pt[], radius: number, closeExtra: number, startFrac = 0): Pt[] {
  const n = corners.length;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = corners[(i - 1 + n) % n];
    const p1 = corners[i];
    const p2 = corners[(i + 1) % n];
    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r1 = Math.min(radius, l1 / 3);
    const r2 = Math.min(radius, l2 / 3);
    const a: Pt = [p1[0] + ((p0[0] - p1[0]) * r1) / l1, p1[1] + ((p0[1] - p1[1]) * r1) / l1];
    const b: Pt = [p1[0] + ((p2[0] - p1[0]) * r2) / l2, p1[1] + ((p2[1] - p1[1]) * r2) / l2];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * p1[0] + t * t * b[0], u * u * a[1] + 2 * u * t * p1[1] + t * t * b[1]]);
    }
  }
  const dense = densify([...pts, pts[0]], 1);
  const L = polyLength(dense);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const out: Pt[] = [];
  const s0 = startFrac * L;
  const total = L * (1 + closeExtra);
  for (let d = 0; d <= total; d += 1) out.push(at(dense, cum, (s0 + d) % L).p);
  return out;
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number, rot: number, startAng: number, sweepFrac: number, radialWobble = 0, seed = 1): Pt[] {
  const r = rng(seed);
  const ph = r() * 6.28;
  const out: Pt[] = [];
  const n = Math.max(40, Math.round((Math.PI * (rx + ry) * sweepFrac) / 1));
  for (let i = 0; i <= n; i++) {
    const a = startAng + (i / n) * Math.PI * 2 * sweepFrac;
    const k = 1 + radialWobble * Math.sin(3 * a + ph);
    const x = rx * k * Math.cos(a);
    const y = ry * k * Math.sin(a);
    out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

export function arcPath(a: Pt, b: Pt, sagFrac: number): Pt[] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  const c: Pt = [mx - (dy / l) * l * sagFrac * 2, my + (dx / l) * l * sagFrac * 2];
  const out: Pt[] = [];
  const n = Math.max(20, Math.round(l));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}
