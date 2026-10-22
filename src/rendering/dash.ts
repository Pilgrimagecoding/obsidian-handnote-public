import type { StrokeDash } from '../document/model';
import type { StrokeGeometry } from '../ink/stroke-builder';
import { emitCircle, emitStroke, type PathSink } from '../ink/outline';

/**
 * Dashed and dotted line styles.
 *
 * Ink strokes are filled outlines with a variable radius, so a dash pattern cannot simply be a
 * canvas line-dash. Instead the stroke's centreline is walked by arc length and only the "on"
 * intervals are emitted (dashes keep the pressure-dependent width; dots are circles with the local
 * radius). The same function feeds Canvas (Path2D) and SVG export, so screen, PNG and SVG match.
 */

/** Dash and gap length (page units) for a nominal line width. */
export function dashLengths(dash: StrokeDash, width: number): { on: number; off: number } {
  const w = Math.max(0.3, width);
  if (dash === 'dot') return { on: 0, off: Math.max(2.2, w * 2.4) };
  return { on: Math.max(2.5, w * 3.4), off: Math.max(2.2, w * 2.4) };
}

/** Canvas / SVG dash array for stroked shapes (use with round caps). */
export function lineDashArray(dash: StrokeDash | undefined, width: number): number[] {
  if (!dash) return [];
  const { on, off } = dashLengths(dash, width);
  // a zero-length dash with a round cap draws a dot of diameter = line width
  return dash === 'dot' ? [0.001, off] : [on, off + width];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Emit the dashed / dotted version of a stroke geometry. `width` is the stroke's nominal width
 * (pen parameter), which sets the pattern scale.
 */
export function emitDashedGeometry(sink: PathSink, g: StrokeGeometry, dash: StrokeDash, width: number): void {
  const n = g.xs.length;
  if (n === 0) return;
  if (g.dot || n === 1) {
    emitCircle(sink, g.xs[0], g.ys[0], g.rs[0]);
    return;
  }
  // cumulative arc length
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(g.xs[i] - g.xs[i - 1], g.ys[i] - g.ys[i - 1]);
  const total = s[n - 1];
  const { on, off } = dashLengths(dash, width);
  const at = (d: number): [number, number, number] => {
    // binary search the segment containing arc length d
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = s[hi] - s[lo];
    const t = seg > 0 ? (d - s[lo]) / seg : 0;
    return [lerp(g.xs[lo], g.xs[hi], t), lerp(g.ys[lo], g.ys[hi], t), lerp(g.rs[lo], g.rs[hi], t)];
  };
  if (dash === 'dot') {
    // evenly distributed dots, first and last exactly at the stroke ends
    const count = Math.max(1, Math.round(total / off));
    for (let k = 0; k <= count; k++) {
      const p = at((total * k) / count);
      emitCircle(sink, p[0], p[1], p[2]);
    }
    return;
  }
  const period = on + off;
  // stretch the pattern slightly so the stroke starts and ends with a dash
  const periods = Math.max(1, Math.round((total + off) / period));
  const k = (total + off) / (periods * period);
  let i = 0;
  for (let p = 0; p < periods; p++) {
    const d0 = p * period * k;
    const d1 = Math.min(total, d0 + on * k);
    const xs: number[] = [];
    const ys: number[] = [];
    const rs: number[] = [];
    const a = at(d0);
    xs.push(a[0]);
    ys.push(a[1]);
    rs.push(a[2]);
    while (i < n && s[i] <= d0) i++;
    let j = i;
    while (j < n && s[j] < d1) {
      xs.push(g.xs[j]);
      ys.push(g.ys[j]);
      rs.push(g.rs[j]);
      j++;
    }
    const b = at(d1);
    xs.push(b[0]);
    ys.push(b[1]);
    rs.push(b[2]);
    emitStroke(sink, xs, ys, rs, 0, false);
  }
}
