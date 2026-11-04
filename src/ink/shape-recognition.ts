import type { InputSample } from './types';
import type { ShapeKind } from '../document/items';

/**
 * Recognize a hand-drawn stroke as a geometric shape ("draw shape" pen).
 * Heuristic, deterministic and cheap: straightness for lines; for closed strokes a polygon
 * simplification (corner count) and an ellipse fit. Returns null when the stroke is not a clear
 * shape — then it stays ordinary ink.
 */
export interface RecognizedShape {
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** triangle / polygon vertices, normalized to the box. */
  points?: number[];
  /** connector end points (page units). */
  a?: [number, number];
  b?: [number, number];
  /** curve control point (quadratic Bézier; with c2: the first control point of a cubic). */
  c?: [number, number];
  /** second control point of a cubic curve (U, S and J shapes; 0.12). */
  c2?: [number, number];
  /** polyline interior vertices [x0, y0, ...]. */
  pts?: number[];
  /** an arrow head was drawn in the same stroke (at b). */
  arrowEnd?: boolean;
  /** rotation of the box around its centre (radians; tilted ellipses and rectangles, 0.12). */
  rot?: number;
}

type P = { x: number; y: number };

/**
 * Size-adaptive tolerances (0.12). Every threshold used to be a fixed number tuned on medium shapes
 * (≈ 50–300 units). A threshold now has two parts:
 *  - a relative part (a fraction of the shape's size) multiplied by `k`, which grows with the size:
 *    big shapes are drawn with the whole arm and wobble more, so they are judged more loosely;
 *    small ones are drawn with the fingers and are held to a tighter standard;
 *  - an absolute part for the pen itself (sensor jitter, tremor, landing / lift hooks: about the
 *    same number of units whatever the size), which matters only for small shapes.
 */
export interface ShapeTolerance {
  /** Bounding-box diagonal of the (denoised) stroke. */
  diag: number;
  /** 0 for a stroke 40 units across or less, 1 for 800 or more (log scale in between). */
  size: number;
  /** Multiplier of the relative thresholds: 0.9 (small) … 1.2 (large). */
  k: number;
  /** Absolute pen noise (page units). */
  noise: number;
  /** Corner simplification of a closed stroke (RDP epsilon, page units). */
  cornerEps: number;
  /** Mean radial error of an ellipse fit: plain / when the stroke has ≥ 5 corners (rounded polygon). */
  ellipseErr: number;
  ellipseErrRound: number;
  /** Straight line: max deviation / chord, and path length / chord. */
  lineDev: number;
  lineLen: number;
  /** Least-squares line through the middle of a wobbly stroke: core deviation / length. */
  fitDev: number;
  /** Smooth arc: quadratic fit error / chord. */
  curveErr: number;
  /** Polyline corner simplification (RDP epsilon, page units). */
  polyEps: number;
  /** Triangle / quadrilateral: largest mean distance of the stroke from its outline / diagonal. */
  polyFit: number;
}

/**
 * A curve must bow out by more than this fraction of its chord (0.12; was 6 %): a casual straight
 * line drawn by hand bows by up to ~10 % and was taken for a curve.
 */
const CURVE_MIN_BEND = 0.1;

const SMALL = 40;
const LARGE = 800;
const PEN_NOISE = 1;

export function shapeTolerance(diag: number): ShapeTolerance {
  const size = Math.min(1, Math.max(0, Math.log(Math.max(diag, 1) / SMALL) / Math.log(LARGE / SMALL)));
  const k = 0.9 + 0.3 * size;
  const n = PEN_NOISE;
  const d = Math.max(diag, 1);
  return {
    diag,
    size,
    k,
    noise: n,
    // small shapes: the pen's own noise (jitter, hooks) dominates and fakes extra corners
    cornerEps: diag * 0.055 * k + 3.5 * n,
    ellipseErr: 0.072 * k + (1.2 * n) / d,
    ellipseErrRound: 0.108 * k + (1.2 * n) / d,
    lineDev: 0.1 * k + n / d,
    lineLen: 1 + 0.16 * k + (2 * n) / d,
    fitDev: 0.045 * k + (0.5 * n) / d,
    curveErr: 0.055 * k + n / d,
    polyEps: diag * 0.045 * k + 0.6 * n,
    polyFit: 0.04 * k + n / d,
  };
}

function dist(a: P, b: P): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** Ramer–Douglas–Peucker on an open polyline. */
function rdp(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Corners of a closed polyline: simplify starting from the point farthest from the start. */
/** @internal exported for tests and tuning */
export function closedCorners(pts: P[], eps: number): P[] {
  // rotate so the polyline starts at a likely corner (farthest point from the centroid)
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  let far = 0;
  let fd = -1;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > fd) {
      fd = d;
      far = i;
    }
  });
  const ring = pts.slice(far).concat(pts.slice(0, far + 1));
  let s = rdp(ring, eps);
  s = s.slice(0, -1); // drop the duplicate closing point
  // merge corners that are very close together (pen hesitation)
  const out: P[] = [];
  for (const p of s) if (!out.length || dist(out[out.length - 1], p) > eps * 1.5) out.push(p);
  if (out.length > 2 && dist(out[0], out[out.length - 1]) < eps * 1.5) out.pop();
  // drop nearly straight vertices
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const ang = Math.abs(angleBetween(a, b, c));
      if (ang > (160 * Math.PI) / 180) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Interior angle at b (radians, 0..PI). */
function angleBetween(a: P, b: P, c: P): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d === 0) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d)));
}

function bbox(pts: P[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Uniform resampling by arc length (spacing in page units). */
function resample(pts: P[], step: number): P[] {
  if (pts.length < 2) return pts.slice();
  const out: P[] = [{ ...pts[0] }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    if (seg === 0) continue;
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

/**
 * Denoise a raw Pencil path before measuring it. Raw samples at 240 Hz carry sensor jitter and
 * hand tremor; on a slow, careful line that noise adds up to a path 30–60 % longer than the line
 * itself and fakes small corners, so straightness / corner tests failed ("casual lines are not
 * recognised"). Uniform resampling + a short moving average (end points kept) removes it while
 * real corners (which span many units) survive.
 */
export function denoisePath(raw: P[]): P[] {
  const box = bbox(raw);
  const diag = Math.hypot(box.w, box.h);
  const fine = resample(raw, 0.75);
  if (fine.length < 5) return fine;
  const half = Math.max(1, Math.min(8, Math.round(Math.max(1.5, Math.min(5, diag * 0.012)) / 0.75)));
  const sm: P[] = fine.map((p, i) => {
    if (i === 0 || i === fine.length - 1) return p;
    const k = Math.min(half, i, fine.length - 1 - i);
    let sx = 0;
    let sy = 0;
    for (let j = i - k; j <= i + k; j++) {
      sx += fine[j].x;
      sy += fine[j].y;
    }
    return { x: sx / (2 * k + 1), y: sy / (2 * k + 1) };
  });
  return resample(sm, Math.max(1.2, diag / 120));
}

/**
 * Recognise a stroke drawn at `zoom` (the camera zoom while writing). Recognition works in screen
 * pixels: a hand draws shapes of a certain size on the screen and its tremor, jitter and hooks are
 * a few pixels whatever the zoom, so the stroke is scaled by `zoom` first and the result back.
 * (At 800 % a hand-sized shape is a few page units across and was judged like a tiny one.)
 */
export function recognizeShape(samples: readonly InputSample[], zoom = 1): RecognizedShape | null {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (Math.abs(z - 1) < 1e-6) return recognizeScreen(samples);
  const r = recognizeScreen(samples.map((p) => ({ ...p, x: p.x * z, y: p.y * z })));
  return r ? scaleShape(r, 1 / z) : null;
}

/**
 * Recognise a stroke from its drawn ink when there is one (0.12): the stored centerline has the
 * Pencil's jitter smoothed out. A slow, light stroke jitters a lot (the tip barely touches the
 * glass) and its raw points failed the straightness tests — lines only snapped when pressed hard.
 * Falls back to the raw samples.
 */
export function recognizeInk(samples: readonly InputSample[], geom: { xs: number[]; ys: number[] } | undefined, zoom = 1): RecognizedShape | null {
  if (geom && geom.xs.length >= 4) {
    const r = recognizeShape(centerline(geom), zoom);
    if (r) return r;
  }
  return recognizeShape(samples, zoom);
}

/** recognizeArrowHead on the drawn ink first, then on the raw samples. */
export function recognizeInkArrowHead(samples: readonly InputSample[], geom: { xs: number[]; ys: number[] } | undefined, zoom = 1): ReturnType<typeof recognizeArrowHead> {
  if (geom && geom.xs.length >= 4) {
    const h = recognizeArrowHead(centerline(geom), zoom);
    if (h) return h;
  }
  return recognizeArrowHead(samples, zoom);
}

function centerline(g: { xs: number[]; ys: number[] }): InputSample[] {
  return g.xs.map((x, i) => ({ x, y: g.ys[i], p: 0.5, t: i }));
}

function scaleShape(r: RecognizedShape, k: number): RecognizedShape {
  const sp = (p: [number, number] | undefined): [number, number] | undefined => (p ? [p[0] * k, p[1] * k] : undefined);
  const out: RecognizedShape = { ...r, x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
  if (r.a) out.a = sp(r.a);
  if (r.b) out.b = sp(r.b);
  if (r.c) out.c = sp(r.c);
  if (r.c2) out.c2 = sp(r.c2);
  if (r.pts) out.pts = r.pts.map((v) => v * k);
  return out;
}

function recognizeScreen(samples: readonly InputSample[]): RecognizedShape | null {
  if (samples.length < 4) return null;
  const pts: P[] = denoisePath(samples.map((s) => ({ x: s.x, y: s.y })));
  if (pts.length < 4) return null;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  const box = bbox(pts);
  const diag = Math.hypot(box.w, box.h);
  if (diag < 8 || L < 10) return null; // too small to be a deliberate shape
  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = dist(first, last);
  const T = shapeTolerance(diag);

  // ---- open stroke: line, curve, polyline, or any of these with an arrow head at the end
  if (gap > Math.max(0.25 * L, 0.2 * diag)) return recognizeOpen(pts, T);

  // ---- closed stroke (a V or U whose ends nearly meet is tried as an open stroke when it is no
  // closed shape)
  const closedShape = ((): RecognizedShape | null => {
    // ---- closed stroke
    const closed = pts.concat([first]);
    const corners = closedCorners(closed, T.cornerEps);

    // ellipse fit against the bounding box
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const rx = Math.max(box.w / 2, 1e-3);
    const ry = Math.max(box.h / 2, 1e-3);
    let err = 0;
    for (const p of pts) err += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    err /= pts.length;

    // 3 or 4 corners can also be a small, wobbly ellipse: keep whichever outline fits the stroke better
    // (mean distance from the stroke, as a fraction of the size)
    const ellDist = (err * (rx + ry)) / 2 / Math.max(diag, 1e-3);
    const polyDist = (cs: P[]) => {
      let sum = 0;
      for (const p of pts) {
        let m = Infinity;
        for (let i = 0; i < cs.length; i++) m = Math.min(m, segDist(p, cs[i], cs[(i + 1) % cs.length]));
        sum += m;
      }
      return sum / pts.length / Math.max(diag, 1e-3);
    };
    if (corners.length === 3 || corners.length === 4) {
      const pd = polyDist(corners);
      if (err < T.ellipseErrRound && pd > ellDist) return snapCircle({ kind: 'ellipse', ...box });
      // neither outline follows the stroke closely, or the ends are far apart for a closed outline
      // (a wiggly writing stroke counts as "closed" by path length): not a shape
      if (pd > T.polyFit || gap > diag * 0.35) return null;
    }
    if (corners.length === 3) {
      const pnts: number[] = [];
      for (const c of corners) pnts.push(box.w > 0 ? (c.x - box.x) / box.w : 0.5, box.h > 0 ? (c.y - box.y) / box.h : 0.5);
      return { kind: 'triangle', ...box, points: pnts.map((v) => Math.round(v * 1000) / 1000) };
    }
    if (corners.length === 4) {
      // sides near the axes → rectangle; vertices near the side midpoints → diamond
      let axis = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) % (Math.PI / 2);
        const off = Math.min(ang, Math.PI / 2 - ang);
        if (off < (16 * Math.PI) / 180) axis++;
      }
      if (axis === 4) return { kind: 'rect', ...box };
      const mids: P[] = [
        { x: cx, y: box.y },
        { x: box.x + box.w, y: cy },
        { x: cx, y: box.y + box.h },
        { x: box.x, y: cy },
      ];
      const near = corners.every((c) => mids.some((m) => dist(c, m) < diag * 0.12));
      if (near) return { kind: 'diamond', ...box };
      const tr = tiltedRect(corners);
      if (tr) return tr;
      const pnts: number[] = [];
      for (const c of corners) pnts.push((c.x - box.x) / box.w, (c.y - box.y) / box.h);
      return { kind: 'polygon', ...box, points: pnts.map((v) => Math.round(v * 1000) / 1000) };
    }
    // a tilted ellipse (its bounding box does not fit it)
    const tilted = tiltedEllipse(pts, T);
    const bestEll = Math.min(ellDist, tilted?.dist ?? Infinity);
    // 5–8 corners: a pentagon, hexagon… when the corners fit clearly better than any ellipse
    // (snapped to a regular polygon when it nearly is one)
    if (corners.length >= 5 && corners.length <= 8) {
      const pd = polyDist(corners);
      if (pd < T.polyFit && pd < bestEll * 0.6 && minCornerTurn(corners) > (22 * Math.PI) / 180) return polygonShape(regularize(corners));
    }
    if (tilted && tilted.dist < ellDist * 0.8 && tilted.err < T.ellipseErr) return tilted.shape;
    if ((err < T.ellipseErrRound && corners.length >= 5) || err < T.ellipseErr) return snapCircle({ kind: 'ellipse', ...box });
    if (tilted && tilted.err < T.ellipseErr) return tilted.shape;
    return null;

  })();
  if (closedShape) return closedShape;
  return gap > 0.12 * diag ? recognizeOpen(pts, T) : null;
}

/** An ellipse whose sides differ by less than 10 % becomes a circle (same centre, mean diameter). */
function snapCircle(r: RecognizedShape): RecognizedShape {
  if (r.kind !== 'ellipse') return r;
  const m = Math.max(r.w, r.h);
  if (m <= 0 || Math.abs(r.w - r.h) / m > 0.1) return r;
  const d = (r.w + r.h) / 2;
  return { ...r, x: r.x + r.w / 2 - d / 2, y: r.y + r.h / 2 - d / 2, w: d, h: d };
}

// ------------------------------------------------------------------------------------------------
// Open strokes: lines, arcs, polylines, arrows
// ------------------------------------------------------------------------------------------------

/** Smallest turn (radians, 0 = straight) at any vertex of a closed polygon. */
function minCornerTurn(cs: P[]): number {
  let m = Math.PI;
  for (let i = 0; i < cs.length; i++) m = Math.min(m, Math.PI - angleBetween(cs[(i - 1 + cs.length) % cs.length], cs[i], cs[(i + 1) % cs.length]));
  return m;
}

/** A polygon item from its vertices (normalized to the bounding box). */
function polygonShape(cs: P[]): RecognizedShape {
  const box = bbox(cs);
  const pnts: number[] = [];
  for (const c of cs) pnts.push(box.w > 0 ? (c.x - box.x) / box.w : 0.5, box.h > 0 ? (c.y - box.y) / box.h : 0.5);
  return { kind: 'polygon', ...box, points: pnts.map((v) => Math.round(v * 1000) / 1000) };
}

/**
 * A polygon whose sides and angles are nearly equal becomes the regular polygon (same centre, mean
 * radius, first vertex kept): a hand-drawn pentagon or hexagon is meant to be regular (0.12).
 */
export function regularize(cs: P[]): P[] {
  const n = cs.length;
  const sides = cs.map((c, i) => dist(c, cs[(i + 1) % n]));
  const mean = sides.reduce((a, b) => a + b, 0) / n;
  const spread = Math.max(...sides.map((x) => Math.abs(x - mean))) / mean;
  const ideal = Math.PI - (2 * Math.PI) / n;
  let angOff = 0;
  for (let i = 0; i < n; i++) angOff = Math.max(angOff, Math.abs(angleBetween(cs[(i - 1 + n) % n], cs[i], cs[(i + 1) % n]) - ideal));
  if (spread > 0.3 || angOff > (22 * Math.PI) / 180) return cs;
  const cx = cs.reduce((a, c) => a + c.x, 0) / n;
  const cy = cs.reduce((a, c) => a + c.y, 0) / n;
  const r = cs.reduce((a, c) => a + Math.hypot(c.x - cx, c.y - cy), 0) / n;
  // orientation: average of the vertex angles relative to the regular layout (keeps the drawn tilt)
  let sx = 0;
  let sy = 0;
  const dir = signedArea(cs) >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(cs[i].y - cy, cs[i].x - cx) - (dir * 2 * Math.PI * i) / n;
    sx += Math.cos(a * n);
    sy += Math.sin(a * n);
  }
  let a0 = Math.atan2(sy, sx) / n;
  // the start angle closest to the first drawn vertex
  const first = Math.atan2(cs[0].y - cy, cs[0].x - cx);
  const step = (2 * Math.PI) / n;
  a0 += Math.round((first - a0) / step) * step;
  // a side that is nearly horizontal is made exactly horizontal (a pentagon standing on its base)
  for (let i = 0; i < n; i++) {
    const p = [a0 + dir * step * i, a0 + dir * step * (i + 1)].map((a) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }));
    const t = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
    const off = Math.atan2(Math.sin(2 * t), Math.cos(2 * t)) / 2; // to the nearest horizontal
    if (Math.abs(off) < (8 * Math.PI) / 180) {
      a0 -= off;
      break;
    }
  }
  return Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(a0 + dir * step * i), y: cy + r * Math.sin(a0 + dir * step * i) }));
}

function signedArea(cs: P[]): number {
  let a = 0;
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    const q = cs[(i + 1) % cs.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Four corners with right angles at a tilt: a rotated rectangle (0.12). */
function tiltedRect(cs: P[]): RecognizedShape | null {
  for (let i = 0; i < 4; i++) {
    const ang = angleBetween(cs[(i + 3) % 4], cs[i], cs[(i + 1) % 4]);
    if (Math.abs(ang - Math.PI / 2) > (16 * Math.PI) / 180) return null;
  }
  // mean side direction modulo 90°
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 4; i++) {
    const t = Math.atan2(cs[(i + 1) % 4].y - cs[i].y, cs[(i + 1) % 4].x - cs[i].x);
    sx += Math.cos(4 * t);
    sy += Math.sin(4 * t);
  }
  const rot = Math.atan2(sy, sx) / 4;
  if (Math.abs(rot) < (8 * Math.PI) / 180) return null;
  return rotatedBox(cs, rot, 'rect');
}

/** The box of `pts` in a frame rotated by `rot`, as a shape rotated around its centre. */
function rotatedBox(pts: P[], rot: number, kind: 'rect' | 'ellipse'): RecognizedShape {
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of pts) {
    const u = p.x * cs + p.y * sn;
    const v = -p.x * sn + p.y * cs;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const cx = cu * cs - cv * sn;
  const cy = cu * sn + cv * cs;
  const w = u1 - u0;
  const h = v1 - v0;
  return { kind, x: cx - w / 2, y: cy - h / 2, w, h, rot };
}

/** An ellipse at a tilt: principal axes of the outline, then the usual fit in that frame (0.12). */
function tiltedEllipse(pts: P[], T: ShapeTolerance): { shape: RecognizedShape; err: number; dist: number } | null {
  const ring = resample(pts.concat([pts[0]]), Math.max(1, T.diag / 100));
  const n = ring.length;
  const mx = ring.reduce((a, p) => a + p.x, 0) / n;
  const my = ring.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of ring) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // only when it is really tilted and really elongated (a circle has no axis)
  const tilt = Math.abs(Math.atan2(Math.sin(2 * rot), Math.cos(2 * rot)) / 2);
  const rotN = Math.atan2(Math.sin(2 * rot), Math.cos(2 * rot)) / 2;
  if (Math.min(tilt, Math.PI / 2 - tilt) < (8 * Math.PI) / 180) return null;
  const box = rotatedBox(pts, rotN, 'ellipse');
  const a = box.w / 2;
  const b = box.h / 2;
  if (Math.min(a, b) < 1e-3 || Math.max(a, b) / Math.min(a, b) < 1.15) return null;
  const cs = Math.cos(rotN);
  const sn = Math.sin(rotN);
  const cx = box.x + a;
  const cy = box.y + b;
  let err = 0;
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = dx * cs + dy * sn;
    const v = -dx * sn + dy * cs;
    err += Math.abs(Math.hypot(u / a, v / b) - 1);
  }
  err /= pts.length;
  return { shape: box, err, dist: (err * (a + b)) / 2 / Math.max(T.diag, 1e-3) };
}

function pathLength(pts: P[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Index of the first sample at arc length >= d from the start. */
function indexAtLength(pts: P[], d: number): number {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc >= d) return i;
  }
  return pts.length - 1;
}

function dirAngle(a: P, b: P): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/**
 * Remove the little hooks a pen makes when it lands or lifts (a few units that go in a different
 * direction than the rest of the stroke).
 */
export function trimHooks(pts: P[], end = true): P[] {
  if (pts.length < 8) return pts;
  const L = pathLength(pts);
  const h = Math.min(8, L * 0.1);
  let out = pts;
  const k = indexAtLength(out, h);
  const k2 = indexAtLength(out, h * 3);
  if (k > 0 && k2 > k && angDiff(dirAngle(out[0], out[k]), dirAngle(out[k], out[k2])) > (50 * Math.PI) / 180) out = out.slice(k);
  if (!end) return out.length >= 4 ? out : pts;
  const rev = out.slice().reverse();
  const j = indexAtLength(rev, h);
  const j2 = indexAtLength(rev, h * 3);
  if (j > 0 && j2 > j && angDiff(dirAngle(rev[0], rev[j]), dirAngle(rev[j], rev[j2])) > (50 * Math.PI) / 180) out = out.slice(0, out.length - j);
  return out.length >= 4 ? out : pts;
}

/** Least-squares quadratic Bézier with fixed end points. Returns the control point and the max error. */
export function fitQuadratic(pts: P[]): { c: P; err: number } {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const n = pts.length;
  // chord-length parametrisation, refined by re-projection
  const ts: number[] = [];
  let acc = 0;
  const L = Math.max(1e-9, pathLength(pts));
  ts.push(0);
  for (let i = 1; i < n; i++) {
    acc += dist(pts[i - 1], pts[i]);
    ts.push(acc / L);
  }
  let c: P = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (let iter = 0; iter < 4; iter++) {
    let num = 0;
    let numY = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const t = ts[i];
      const u = 1 - t;
      const k = 2 * u * t;
      const rx = pts[i].x - u * u * a.x - t * t * b.x;
      const ry = pts[i].y - u * u * a.y - t * t * b.y;
      num += k * rx;
      numY += k * ry;
      den += k * k;
    }
    if (den > 1e-12) c = { x: num / den, y: numY / den };
    // re-project each sample to its nearest parameter (coarse search around the current one)
    for (let i = 1; i < n - 1; i++) {
      let best = ts[i];
      let bd = Infinity;
      for (let s = -6; s <= 6; s++) {
        const t = Math.min(1, Math.max(0, ts[i] + s * 0.01));
        const q = qp(a, c, b, t);
        const d = (q.x - pts[i].x) ** 2 + (q.y - pts[i].y) ** 2;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      ts[i] = best;
    }
  }
  let err = 0;
  for (let i = 0; i < n; i++) {
    const q = qp(a, c, b, ts[i]);
    err = Math.max(err, Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
  }
  return { c, err };
}

function qp(a: P, c: P, b: P, t: number): P {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function headings(pts: P[], h: number): { hd: number[]; at: P[] } {
  const res: P[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc >= h) {
      res.push(pts[i]);
      acc = 0;
    }
  }
  const hd: number[] = [];
  for (let i = 1; i < res.length; i++) hd.push(dirAngle(res[i - 1], res[i]));
  return { hd, at: res };
}

/**
 * A sharp turn anywhere along the path (heading change > 50° over a short distance) — a real corner,
 * not the tight but smooth bottom of a U: there the turn is spread out, so over a third of the
 * distance it is about a third as large; at a corner it stays almost the whole turn.
 */
function hasCorner(pts: P[], L: number): boolean {
  const h = Math.max(4, L * 0.05);
  const { hd, at } = headings(pts, h);
  if (hd.length < 3) return false;
  const fine = headings(pts, h / 3);
  // largest heading change across one fine step near a point
  const sharpAt = (p: P): number => {
    let best = 0;
    for (let i = 1; i < fine.hd.length; i++) {
      if (dist(fine.at[i], p) > h * 1.5) continue;
      best = Math.max(best, angDiff(fine.hd[i], fine.hd[i - 1]));
    }
    return best;
  };
  for (let i = 1; i < hd.length; i++) {
    const turn = angDiff(hd[i], hd[i - 1]);
    const turn2 = i > 1 ? angDiff(hd[i], hd[i - 2]) : 0;
    if (turn <= (50 * Math.PI) / 180 && turn2 <= (70 * Math.PI) / 180) continue;
    if (sharpAt(at[i]) > Math.max(turn, turn2) * 0.55) return true;
  }
  return false;
}

/** Least-squares cubic Bézier with fixed end points (chord-length parameters, refined). */
export function fitCubic(pts: P[]): { c1: P; c2: P; err: number } {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const n = pts.length;
  const L = Math.max(1e-9, pathLength(pts));
  const ts: number[] = [0];
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += dist(pts[i - 1], pts[i]);
    ts.push(acc / L);
  }
  let c1: P = { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
  let c2: P = { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 };
  for (let iter = 0; iter < 5; iter++) {
    // normal equations for the two control points (B1 = 3u²t, B2 = 3ut²)
    let m11 = 0;
    let m12 = 0;
    let m22 = 0;
    let r1x = 0;
    let r1y = 0;
    let r2x = 0;
    let r2y = 0;
    for (let i = 0; i < n; i++) {
      const t = ts[i];
      const u = 1 - t;
      const b0 = u * u * u;
      const b1 = 3 * u * u * t;
      const b2 = 3 * u * t * t;
      const b3 = t * t * t;
      const rx = pts[i].x - b0 * a.x - b3 * b.x;
      const ry = pts[i].y - b0 * a.y - b3 * b.y;
      m11 += b1 * b1;
      m12 += b1 * b2;
      m22 += b2 * b2;
      r1x += b1 * rx;
      r1y += b1 * ry;
      r2x += b2 * rx;
      r2y += b2 * ry;
    }
    const det = m11 * m22 - m12 * m12;
    if (Math.abs(det) > 1e-12) {
      c1 = { x: (r1x * m22 - r2x * m12) / det, y: (r1y * m22 - r2y * m12) / det };
      c2 = { x: (r2x * m11 - r1x * m12) / det, y: (r2y * m11 - r1y * m12) / det };
    }
    for (let i = 1; i < n - 1; i++) {
      let best = ts[i];
      let bd = Infinity;
      for (let s = -6; s <= 6; s++) {
        const t = Math.min(1, Math.max(0, ts[i] + s * 0.008));
        const q = cp(a, c1, c2, b, t);
        const d = (q.x - pts[i].x) ** 2 + (q.y - pts[i].y) ** 2;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      ts[i] = best;
    }
  }
  let err = 0;
  for (let i = 0; i < n; i++) {
    const q = cp(a, c1, c2, b, ts[i]);
    err = Math.max(err, Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
  }
  return { c1, c2, err };
}

function cp(a: P, c1: P, c2: P, b: P, t: number): P {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return { x: b0 * a.x + b1 * c1.x + b2 * c2.x + b3 * b.x, y: b0 * a.y + b1 * c1.y + b2 * c2.y + b3 * b.y };
}

/**
 * Straight line by a least-squares fit of the middle 84 % of the path (landing / lift hooks and a
 * wobbly start do not count), with the ends projected onto the fitted line.
 */
function fitLine(pts: P[], L: number, T: ShapeTolerance): { a: P; b: P } | null {
  const i0 = indexAtLength(pts, L * 0.08);
  const i1 = indexAtLength(pts, L * 0.92);
  const core = pts.slice(i0, i1 + 1);
  if (core.length < 3) return null;
  let mx = 0;
  let my = 0;
  for (const p of core) {
    mx += p.x;
    my += p.y;
  }
  mx /= core.length;
  my /= core.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of core) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const proj = (p: P) => (p.x - mx) * ux + (p.y - my) * uy;
  const perp = (p: P) => Math.abs(-(p.x - mx) * uy + (p.y - my) * ux);
  const t0 = proj(pts[0]);
  const t1 = proj(pts[pts.length - 1]);
  const len = Math.abs(t1 - t0);
  if (len < 10) return null;
  let coreDev = 0;
  for (const p of core) coreDev = Math.max(coreDev, perp(p));
  let allDev = 0;
  for (const p of pts) allDev = Math.max(allDev, perp(p));
  // the core is straight; the ends may hook a little but not wander off
  if (coreDev / len > T.fitDev || allDev > Math.max(2 + 3 * T.noise, len * 0.14 * (T.k / 1.05))) return null;
  // the path must run along the line once (not back and forth)
  let mono = 0;
  for (let i = 1; i < core.length; i++) mono += Math.abs(proj(core[i]) - proj(core[i - 1]));
  if (mono > Math.abs(proj(core[core.length - 1]) - proj(core[0])) * 1.12 + 2) return null;
  return { a: { x: mx + ux * t0, y: my + uy * t0 }, b: { x: mx + ux * t1, y: my + uy * t1 } };
}

/** Shaft only (no head): line, curve or polyline. */
function recognizeShaft(pts: P[], T: ShapeTolerance): RecognizedShape | null {
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const chord = dist(first, last);
  if (chord < 10) return null;
  const L = pathLength(pts);
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, segDist(p, first, last));
  const ab = { a: [first.x, first.y] as [number, number], b: [last.x, last.y] as [number, number] };
  // straight line: small deviation relative to the chord
  if (maxDev / chord < T.lineDev && L / chord < T.lineLen) return { kind: 'line', ...bbox([first, last]), ...ab };
  // smooth arc: no corner anywhere and a quadratic fits within a few percent of the chord
  if (!hasCorner(pts, L)) {
    const { c, err } = fitQuadratic(pts);
    const mid = qp(first, c, last, 0.5);
    const sag = segDist(mid, first, last);
    if (err / chord < T.curveErr && sag / chord > CURVE_MIN_BEND) {
      const box = bbox([first, last, mid, qp(first, c, last, 0.25), qp(first, c, last, 0.75)]);
      return { kind: 'curve', ...box, ...ab, c: [c.x, c.y] };
    }
    // a deeper U, an S or a J: a cubic (relative to the stroke's own size — a U's chord is short)
    const size = Math.max(chord, Math.hypot(bbox(pts).w, bbox(pts).h));
    const cu = fitCubic(pts);
    if (cu.err / size < T.curveErr && Math.max(sag, ...pts.map((p) => segDist(p, first, last))) / size > CURVE_MIN_BEND) {
      const samp = [0, 0.25, 0.5, 0.75, 1].map((t) => cp(first, cu.c1, cu.c2, last, t));
      return { kind: 'curve', ...bbox(samp), ...ab, c: [cu.c1.x, cu.c1.y], c2: [cu.c2.x, cu.c2.y] };
    }
  }
  // a wobbly / hooked hand-drawn line
  const fitted = fitLine(pts, L, T);
  if (fitted) return { kind: 'line', ...bbox([fitted.a, fitted.b]), a: [fitted.a.x, fitted.a.y], b: [fitted.b.x, fitted.b.y] };
  // corners → polyline
  const simp = rdp(pts, T.polyEps);
  // a landing / lift hook the hook trimmer missed shows up as a very short first or last segment
  const hook = Math.max(2 + 3 * T.noise, chord * 0.15);
  // vertices that barely turn (> 150°) are wobble, not corners
  for (let i = 1; i < simp.length - 1 && simp.length > 2; ) {
    if (angleBetween(simp[i - 1], simp[i], simp[i + 1]) > (150 * Math.PI) / 180) simp.splice(i, 1);
    else i++;
  }
  while (simp.length > 3 && dist(simp[0], simp[1]) < hook) simp.shift();
  while (simp.length > 3 && dist(simp[simp.length - 1], simp[simp.length - 2]) < hook) simp.pop();
  if (simp[0] !== first || simp[simp.length - 1] !== last) {
    ab.a = [simp[0].x, simp[0].y];
    ab.b = [simp[simp.length - 1].x, simp[simp.length - 1].y];
  }
  const sharp: number[] = [];
  for (let i = 1; i < simp.length - 1; i++) if (angleBetween(simp[i - 1], simp[i], simp[i + 1]) < (145 * Math.PI) / 180) sharp.push(i);
  if (simp.length >= 3 && simp.length <= 7 && sharp.length === simp.length - 2) {
    // every segment long enough to be deliberate
    const segs = simp.slice(1).map((p, i) => dist(simp[i], p));
    if (Math.min(...segs) > Math.max(6, chord * 0.08)) {
      const inner: number[] = [];
      for (let i = 1; i < simp.length - 1; i++) inner.push(simp[i].x, simp[i].y);
      return { kind: 'polyline', ...bbox(simp), ...ab, pts: inner };
    }
  }
  return null;
}

/** A head drawn after the shaft in the same stroke: find the tip and check the barbs. */
function splitArrow(pts: P[], accept: (shaft: P[]) => boolean, twoBarbs = false): { shaft: P[]; tip: P } | null {
  const L = pathLength(pts);
  // tolerance relative to a typical head (not the whole stroke): small heads on long shafts
  const eps = Math.max(1.5, Math.min(L * 0.02, 4));
  const simp = rdp(pts, eps);
  if (simp.length < 3) return null;
  // try the vertices (from the end) as tip candidates
  for (let vi = simp.length - 2; vi >= 1; vi--) {
    const tip = simp[vi];
    const idx = pts.indexOf(tip);
    if (idx < 3) continue;
    const shaft = pts.slice(0, idx + 1);
    const head = pts.slice(idx);
    const shaftL = pathLength(shaft);
    const headL = pathLength(head);
    if (headL > shaftL * 0.6 || headL < Math.max(4, shaftL * 0.06)) continue;
    // the head stays near the tip
    const R = Math.max(10, shaftL * 0.4);
    if (head.some((p) => dist(p, tip) > R)) continue;
    // first barb points back along the shaft (15°–75° off the reversed shaft direction)
    const shaftDir = dirAngle(shaft[shaft.length - 1 - Math.max(1, indexAtLength(shaft.slice().reverse(), Math.min(shaftL * 0.2, 25)))], tip);
    // the head: one barb (short, 20°–60° off the shaft) or two barbs (a V / closed triangle)
    const hs = rdp(head, Math.max(1.5, headL * 0.12));
    const barbEnd = hs[1] ?? head[head.length - 1];
    const barb = dirAngle(tip, barbEnd);
    const rel = angDiff(barb, shaftDir + Math.PI);
    if (hs.length <= 2) {
      // one barb after a zig-zag shaft is just one more segment of the zig-zag
      if (twoBarbs) continue;
      if (headL > shaftL * 0.28 || rel < (20 * Math.PI) / 180 || rel > (60 * Math.PI) / 180) continue;
    } else {
      if (rel < (15 * Math.PI) / 180 || rel > (75 * Math.PI) / 180) continue;
      // second barb on the other side of the shaft
      const other = hs[hs.length - 1];
      const rel2 = angDiff(dirAngle(tip, other), shaftDir + Math.PI);
      const side = (a: P) => Math.sign(Math.cos(shaftDir) * (a.y - tip.y) - Math.sin(shaftDir) * (a.x - tip.x));
      const twoSided = side(barbEnd) !== side(other) && rel2 < (80 * Math.PI) / 180;
      const backToTip = hs.length >= 3 && dist(hs[2], tip) < Math.max(4, headL * 0.25);
      if (!twoSided && !backToTip) continue;
    }
    // several vertices can pass the head test (the barb ends): take the one that leaves a clean shaft
    if (!accept(shaft)) continue;
    return { shaft, tip };
  }
  return null;
}

function recognizeOpen(raw: P[], T: ShapeTolerance): RecognizedShape | null {
  // single-stroke arrow (shaft + head). Only the landing hook is trimmed here: the end of the stroke
  // is the head and must stay intact.
  const startTrimmed = trimHooks(raw, false);
  // prefer a straight / curved shaft; a polyline shaft only when nothing simpler fits
  for (const kinds of [['line', 'curve'], ['polyline']]) {
    let shaftShape: RecognizedShape | null = null;
    const arrow = splitArrow(
      startTrimmed,
      (shaft) => {
        const r = recognizeShaft(shaft, T);
        if (r && kinds.includes(r.kind)) {
          shaftShape = r;
          return true;
        }
        return false;
      },
      kinds.includes('polyline'),
    );
    if (arrow && shaftShape) return { ...(shaftShape as RecognizedShape), arrowEnd: true };
  }
  return recognizeShaft(trimHooks(raw), T);
}

/**
 * A separate "V" stroke drawn as an arrow head: returns the tip and the direction it points to
 * (unit vector), or null.
 */
export function recognizeArrowHead(samples: readonly InputSample[], zoom = 1): { tip: [number, number]; dir: [number, number]; size: number } | null {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (Math.abs(z - 1) > 1e-6) {
    const r = recognizeArrowHead(samples.map((p) => ({ ...p, x: p.x * z, y: p.y * z })), 1);
    return r ? { tip: [r.tip[0] / z, r.tip[1] / z], dir: r.dir, size: r.size / z } : null;
  }
  if (samples.length < 4) return null;
  const pts = trimHooks(samples.map((s) => ({ x: s.x, y: s.y })));
  const box = bbox(pts);
  const diag = Math.hypot(box.w, box.h);
  if (diag < 4 || diag > 80) return null;
  const simp = rdp(pts, Math.max(1.5, diag * 0.12));
  if (simp.length !== 3) return null;
  const [l, apex, r] = simp;
  const la = dist(l, apex);
  const ra = dist(r, apex);
  if (Math.min(la, ra) < 3 || Math.max(la, ra) / Math.min(la, ra) > 2.6) return null;
  const ang = angleBetween(l, apex, r);
  if (ang < (20 * Math.PI) / 180 || ang > (130 * Math.PI) / 180) return null;
  const mx = (l.x + r.x) / 2;
  const my = (l.y + r.y) / 2;
  const d = Math.hypot(apex.x - mx, apex.y - my) || 1;
  return { tip: [apex.x, apex.y], dir: [(apex.x - mx) / d, (apex.y - my) / d], size: (la + ra) / 2 };
}
