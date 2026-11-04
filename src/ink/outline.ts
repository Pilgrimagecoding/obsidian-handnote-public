import type { StrokeGeometry } from './stroke-builder';

/**
 * Converts centerline+radius samples into a fillable outline.
 *
 * 0.12: the outline is the centerline offset by the radius on both sides with round caps (see
 * emitStroke); sharp turns fall back to "tapered capsules" (convex hull of two circles). All
 * pieces wind the same way and are filled with the nonzero rule. Compared with stroking each
 * segment with a different lineWidth, this gives:
 *  - one fill per stroke, so translucent strokes have no darker beads where segments overlap;
 *  - exact, artifact-free corners at any turn angle (no miter spikes, no self-intersections);
 *  - smooth width transitions (each capsule interpolates the radius linearly);
 *  - identical results for Canvas 2D (Path2D) and SVG export.
 */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  /** Arc around (cx, cy) from angle a0 to a1 (a1 >= a0), increasing angle (clockwise in y-down space). */
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void;
  closePath(): void;
}

const TWO_PI = Math.PI * 2;

export function emitCircle(sink: PathSink, x: number, y: number, r: number): void {
  sink.moveTo(x + r, y);
  sink.arc(x, y, r, 0, TWO_PI);
  sink.closePath();
}

/** Emit one capsule between (x0,y0,r0) and (x1,y1,r1). */
export function emitCapsule(
  sink: PathSink,
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(r0 - r1) + 1e-9) {
    // one circle contains the other
    if (r0 >= r1) emitCircle(sink, x0, y0, r0);
    else emitCircle(sink, x1, y1, r1);
    return;
  }
  const th = Math.atan2(dy, dx);
  const al = Math.acos((r0 - r1) / d);
  const a0 = th + al;
  sink.moveTo(x0 + r0 * Math.cos(a0), y0 + r0 * Math.sin(a0));
  sink.arc(x0, y0, r0, a0, th + TWO_PI - al); // back of the first circle
  sink.lineTo(x1 + r1 * Math.cos(th - al), y1 + r1 * Math.sin(th - al));
  sink.arc(x1, y1, r1, th - al, th + al); // front of the second circle
  sink.closePath();
}

/** Longest merged step (page units): at 2400 % that is under a pixel. */
const MAX_MERGE = 0.035;
/** Turn between two outline points (radians) above which the joint is drawn as capsules. */
const MAX_SMOOTH_TURN = (30 * Math.PI) / 180;

/**
 * Emit the whole stroke (0.12): one smooth outline — the centerline offset along its normal by
 * the radius on each side, round caps at both ends — instead of a union of capsules. A capsule
 * between every pair of points made the edge a chain of straight pieces that bent at every point
 * where the radius changed slope: fine, irregular waves along the edge. The offset also leans
 * with the radius change (the envelope of the pen's circles), so a widening stroke is outlined
 * exactly as before.
 *
 * Where the outline cannot follow the centerline smoothly — a sharp turn, a bend tighter than
 * the pen's radius (the inner side would loop) or a radius change steeper than the step — those
 * steps are drawn as capsules, which handle any turn. Every piece winds the same way and the
 * stroke is filled once with the nonzero rule, so overlaps never darken translucent ink.
 *
 * `from` draws only the part from that point on (the live layer appends as the stroke grows);
 * the points before it still give the direction at the joint.
 */
export function emitStroke(
  sink: PathSink,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  rs: ArrayLike<number>,
  from = 0,
  dot = false,
): void {
  const n = xs.length;
  if (n === 0) return;
  if (dot || n === 1) {
    emitCircle(sink, xs[from] ?? xs[0], ys[from] ?? ys[0], rs[from] ?? rs[0]);
    return;
  }
  const i0 = Math.max(0, from);
  if (i0 >= n - 1) {
    emitCircle(sink, xs[n - 1], ys[n - 1], rs[n - 1]);
    return;
  }
  // points used for the outline: steps shorter than minStep are skipped (the path stays small)
  const idx: number[] = [i0];
  for (let i = i0 + 1; i < n; i++) {
    const j = idx[idx.length - 1];
    const minStep = Math.min(Math.min(rs[j], rs[i]) * 0.35, MAX_MERGE);
    if (i < n - 1 && (xs[i] - xs[j]) ** 2 + (ys[i] - ys[j]) ** 2 < minStep * minStep) continue;
    idx.push(i);
  }
  const m = idx.length;
  // direction (tangent angle) and lean (angle between the tangent and the offset) at each point
  const th = new Float64Array(m);
  const al = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    const a = k > 0 ? idx[k - 1] : i0 > 0 ? i0 - 1 : i;
    const b = k < m - 1 ? idx[k + 1] : i;
    let dx = xs[b] - xs[a];
    let dy = ys[b] - ys[a];
    let d = Math.hypot(dx, dy);
    if (d < 1e-9) {
      // coincident neighbours: the nearest step that has a direction
      const c = k < m - 1 ? idx[k + 1] : idx[Math.max(0, k - 1)];
      dx = k < m - 1 ? xs[c] - xs[i] : xs[i] - xs[c];
      dy = k < m - 1 ? ys[c] - ys[i] : ys[i] - ys[c];
      d = Math.hypot(dx, dy);
    }
    th[k] = Math.atan2(dy, dx);
    const drds = d > 1e-9 ? (rs[b] - rs[a]) / d : 0;
    al[k] = Math.acos(Math.max(-0.95, Math.min(0.95, -drds)));
  }
  // a step can be outlined smoothly when it turns little, does not bend tighter than the radius
  // and the inner side moves forward
  const smooth = (k: number): boolean => {
    const i = idx[k];
    const j = idx[k + 1];
    const d = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    if (d <= Math.abs(rs[j] - rs[i]) * 1.05 + 1e-9) return false;
    let turn = Math.abs(th[k + 1] - th[k]);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > MAX_SMOOTH_TURN) return false;
    if (turn > 1e-6 && d / turn < Math.max(rs[i], rs[j]) * 1.15) return false;
    // mean direction of the step
    const ux = Math.cos(th[k]) + Math.cos(th[k + 1]);
    const uy = Math.sin(th[k]) + Math.sin(th[k + 1]);
    for (const sgn of [1, -1]) {
      const ex0 = xs[i] + rs[i] * Math.cos(th[k] + sgn * al[k]);
      const ey0 = ys[i] + rs[i] * Math.sin(th[k] + sgn * al[k]);
      const ex1 = xs[j] + rs[j] * Math.cos(th[k + 1] + sgn * al[k + 1]);
      const ey1 = ys[j] + rs[j] * Math.sin(th[k + 1] + sgn * al[k + 1]);
      if ((ex1 - ex0) * ux + (ey1 - ey0) * uy <= 0) return false;
    }
    return true;
  };
  let k = 0;
  while (k < m - 1) {
    if (!smooth(k)) {
      const i = idx[k];
      const j = idx[k + 1];
      emitCapsule(sink, xs[i], ys[i], rs[i], xs[j], ys[j], rs[j]);
      k++;
      continue;
    }
    let e = k + 1;
    while (e < m - 1 && smooth(e)) e++;
    emitOffsetPiece(sink, xs, ys, rs, idx, th, al, k, e);
    k = e;
  }
}

/** One smooth piece from outline point a to b: back cap, one side, front cap, the other side. */
function emitOffsetPiece(
  sink: PathSink,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  rs: ArrayLike<number>,
  idx: number[],
  th: Float64Array,
  al: Float64Array,
  a: number,
  b: number,
): void {
  const ia = idx[a];
  const ib = idx[b];
  // same winding as emitCapsule: start on the +lean side, round the back, along the −lean side
  sink.moveTo(xs[ia] + rs[ia] * Math.cos(th[a] + al[a]), ys[ia] + rs[ia] * Math.sin(th[a] + al[a]));
  sink.arc(xs[ia], ys[ia], rs[ia], th[a] + al[a], th[a] + TWO_PI - al[a]);
  for (let k = a + 1; k <= b; k++) {
    const i = idx[k];
    sink.lineTo(xs[i] + rs[i] * Math.cos(th[k] - al[k]), ys[i] + rs[i] * Math.sin(th[k] - al[k]));
  }
  sink.arc(xs[ib], ys[ib], rs[ib], th[b] - al[b], th[b] + al[b]);
  for (let k = b - 1; k >= a; k--) {
    const i = idx[k];
    sink.lineTo(xs[i] + rs[i] * Math.cos(th[k] + al[k]), ys[i] + rs[i] * Math.sin(th[k] + al[k]));
  }
  sink.closePath();
}

export function emitGeometry(sink: PathSink, g: StrokeGeometry): void {
  emitStroke(sink, g.xs, g.ys, g.rs, 0, g.dot);
}

/** PathSink that writes into a CanvasRenderingContext2D path or a Path2D. */
export class CanvasPathSink implements PathSink {
  constructor(private readonly p: Path2D | CanvasRenderingContext2D) {}
  moveTo(x: number, y: number): void {
    this.p.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.p.lineTo(x, y);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    this.p.arc(cx, cy, r, a0, a1, false);
  }
  closePath(): void {
    this.p.closePath();
  }
}

/** PathSink that produces SVG path data. */
export class SvgPathSink implements PathSink {
  private parts: string[] = [];
  constructor(private readonly precision = 2) {}
  private f(v: number): string {
    return Number(v.toFixed(this.precision)).toString();
  }
  moveTo(x: number, y: number): void {
    this.parts.push(`M${this.f(x)} ${this.f(y)}`);
  }
  lineTo(x: number, y: number): void {
    this.parts.push(`L${this.f(x)} ${this.f(y)}`);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const span = a1 - a0;
    if (span <= 0) return;
    // SVG cannot draw a full circle in one arc command: split into two halves when needed
    if (span >= TWO_PI - 1e-6) {
      const mid = a0 + Math.PI;
      this.arcPart(cx, cy, r, a0, mid);
      this.arcPart(cx, cy, r, mid, a0 + TWO_PI);
      return;
    }
    this.arcPart(cx, cy, r, a0, a1);
  }
  private arcPart(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const ex = cx + r * Math.cos(a1);
    const ey = cy + r * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    this.parts.push(`A${this.f(r)} ${this.f(r)} 0 ${large} 1 ${this.f(ex)} ${this.f(ey)}`);
  }
  closePath(): void {
    this.parts.push('Z');
  }
  toString(): string {
    return this.parts.join('');
  }
}

/** Counts sub-paths/ops; used by tests and the performance HUD. */
export class CountingSink implements PathSink {
  subpaths = 0;
  ops = 0;
  moveTo(): void {
    this.subpaths++;
    this.ops++;
  }
  lineTo(): void {
    this.ops++;
  }
  arc(): void {
    this.ops++;
  }
  closePath(): void {
    this.ops++;
  }
}
