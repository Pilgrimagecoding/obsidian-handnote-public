import type { StrokeGeometry } from './stroke-builder';

/**
 * Converts centerline+radius samples into a fillable outline.
 *
 * The outline is the union of "tapered capsules" (convex hull of two circles) between consecutive
 * samples, emitted as separate sub-paths that all wind the same way and filled with the nonzero
 * rule. Compared with stroking each segment with a different lineWidth, this gives:
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

/**
 * Emit the whole stroke. Capsules shorter than `minStep` are merged forward to keep the path small;
 * the merged capsule still covers the skipped samples because radius changes are smoothed.
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
  let i0 = Math.max(0, from);
  if (i0 >= n - 1) {
    emitCircle(sink, xs[n - 1], ys[n - 1], rs[n - 1]);
    return;
  }
  for (let i = i0 + 1; i < n; i++) {
    const dx = xs[i] - xs[i0];
    const dy = ys[i] - ys[i0];
    const minStep = Math.min(rs[i0], rs[i]) * 0.35;
    if (i < n - 1 && dx * dx + dy * dy < minStep * minStep) continue;
    emitCapsule(sink, xs[i0], ys[i0], rs[i0], xs[i], ys[i], rs[i]);
    i0 = i;
  }
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
