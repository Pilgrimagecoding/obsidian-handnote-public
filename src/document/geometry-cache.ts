import { buildStrokeGeometry, type StrokeGeometry } from '../ink/stroke-builder';
import type { Stroke } from './model';

/**
 * Lazily computed geometry per stroke (keyed by stroke object identity, so edits that replace a
 * stroke object automatically invalidate). Geometry is pure data; renderers attach their own
 * cached Path2D objects.
 */
export class GeometryCache {
  private map = new WeakMap<Stroke, StrokeGeometry>();

  get(stroke: Stroke): StrokeGeometry {
    let g = this.map.get(stroke);
    if (!g) {
      g = buildStrokeGeometry(stroke.samples, stroke.tool, stroke.params, {
        zoom: stroke.zoom,
        hasPressure: stroke.hasPressure,
        engine: stroke.engine,
        cutStart: ((stroke.cut ?? 0) & 1) !== 0,
        cutEnd: ((stroke.cut ?? 0) & 2) !== 0,
      });
      this.map.set(stroke, g);
    }
    return g;
  }

  set(stroke: Stroke, g: StrokeGeometry): void {
    this.map.set(stroke, g);
  }
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d2: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return { d2: cx * cx + cy * cy, t };
}

/** True if a circle (x, y, radius) touches the stroke's inked area. */
export function hitStroke(g: StrokeGeometry, x: number, y: number, radius: number): boolean {
  const [x0, y0, x1, y1] = g.bbox;
  if (x < x0 - radius || x > x1 + radius || y < y0 - radius || y > y1 + radius) return false;
  const n = g.xs.length;
  if (n === 1 || g.dot) {
    const r = g.rs[0] + radius;
    const dx = g.xs[0] - x;
    const dy = g.ys[0] - y;
    return dx * dx + dy * dy <= r * r;
  }
  for (let i = 1; i < n; i++) {
    const { d2, t } = distToSegmentSq(x, y, g.xs[i - 1], g.ys[i - 1], g.xs[i], g.ys[i]);
    const r = g.rs[i - 1] + (g.rs[i] - g.rs[i - 1]) * t + radius;
    if (d2 <= r * r) return true;
  }
  return false;
}

/** Hit test along a moving eraser segment (so fast eraser swipes don't skip strokes). */
export function hitStrokeSegment(
  g: StrokeGeometry,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / Math.max(radius * 0.5, 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hitStroke(g, ax + (bx - ax) * t, ay + (by - ay) * t, radius)) return true;
  }
  return false;
}
