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
  /** curve control point (quadratic Bézier). */
  c?: [number, number];
  /** polyline interior vertices [x0, y0, ...]. */
  pts?: number[];
  /** an arrow head was drawn in the same stroke (at b). */
  arrowEnd?: boolean;
}

type P = { x: number; y: number };

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
function closedCorners(pts: P[], eps: number): P[] {
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

export function recognizeShape(samples: readonly InputSample[]): RecognizedShape | null {
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

  // ---- open stroke: line, curve, polyline, or any of these with an arrow head at the end
  if (gap > Math.max(0.25 * L, 0.2 * diag)) return recognizeOpen(pts);

  // ---- closed stroke
  const closed = pts.concat([first]);
  const eps = Math.max(2, diag * 0.06);
  const corners = closedCorners(closed, eps);

  // ellipse fit against the bounding box
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = Math.max(box.w / 2, 1e-3);
  const ry = Math.max(box.h / 2, 1e-3);
  let err = 0;
  for (const p of pts) err += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
  err /= pts.length;

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
    const pnts: number[] = [];
    for (const c of corners) pnts.push((c.x - box.x) / box.w, (c.y - box.y) / box.h);
    return { kind: 'polygon', ...box, points: pnts.map((v) => Math.round(v * 1000) / 1000) };
  }
  if (err < 0.12 && corners.length >= 5) return { kind: 'ellipse', ...box };
  if (err < 0.08) return { kind: 'ellipse', ...box };
  return null;
}

// ------------------------------------------------------------------------------------------------
// Open strokes: lines, arcs, polylines, arrows
// ------------------------------------------------------------------------------------------------

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

/** A sharp turn anywhere along the path (heading change > 50° over a short distance). */
function hasCorner(pts: P[], L: number): boolean {
  const h = Math.max(4, L * 0.05);
  const res: P[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc >= h) {
      res.push(pts[i]);
      acc = 0;
    }
  }
  if (res.length < 4) return false;
  const hd: number[] = [];
  for (let i = 1; i < res.length; i++) hd.push(dirAngle(res[i - 1], res[i]));
  for (let i = 1; i < hd.length; i++) {
    if (angDiff(hd[i], hd[i - 1]) > (50 * Math.PI) / 180) return true;
    if (i > 1 && angDiff(hd[i], hd[i - 2]) > (70 * Math.PI) / 180) return true;
  }
  return false;
}

/**
 * Straight line by a least-squares fit of the middle 84 % of the path (landing / lift hooks and a
 * wobbly start do not count), with the ends projected onto the fitted line.
 */
function fitLine(pts: P[], L: number): { a: P; b: P } | null {
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
  if (coreDev / len > 0.05 || allDev > Math.max(5, len * 0.14)) return null;
  // the path must run along the line once (not back and forth)
  let mono = 0;
  for (let i = 1; i < core.length; i++) mono += Math.abs(proj(core[i]) - proj(core[i - 1]));
  if (mono > Math.abs(proj(core[core.length - 1]) - proj(core[0])) * 1.12 + 2) return null;
  return { a: { x: mx + ux * t0, y: my + uy * t0 }, b: { x: mx + ux * t1, y: my + uy * t1 } };
}

/** Shaft only (no head): line, curve or polyline. */
function recognizeShaft(pts: P[]): RecognizedShape | null {
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
  if (maxDev / chord < 0.075 && L / chord < 1.15) return { kind: 'line', ...bbox([first, last]), ...ab };
  // smooth arc: no corner anywhere and a quadratic fits within a few percent of the chord
  if (!hasCorner(pts, L)) {
    const { c, err } = fitQuadratic(pts);
    const mid = qp(first, c, last, 0.5);
    const sag = segDist(mid, first, last);
    if (err / chord < 0.06 && sag / chord > 0.06) {
      const box = bbox([first, last, mid, qp(first, c, last, 0.25), qp(first, c, last, 0.75)]);
      return { kind: 'curve', ...box, ...ab, c: [c.x, c.y] };
    }
  }
  // a wobbly / hooked hand-drawn line
  const fitted = fitLine(pts, L);
  if (fitted) return { kind: 'line', ...bbox([fitted.a, fitted.b]), a: [fitted.a.x, fitted.a.y], b: [fitted.b.x, fitted.b.y] };
  // corners → polyline
  const eps = Math.max(2, Math.hypot(bbox(pts).w, bbox(pts).h) * 0.05);
  const simp = rdp(pts, eps);
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
function splitArrow(pts: P[], accept: (shaft: P[]) => boolean): { shaft: P[]; tip: P } | null {
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

function recognizeOpen(raw: P[]): RecognizedShape | null {
  // single-stroke arrow (shaft + head). Only the landing hook is trimmed here: the end of the stroke
  // is the head and must stay intact.
  const startTrimmed = trimHooks(raw, false);
  // prefer a straight / curved shaft; a polyline shaft only when nothing simpler fits
  for (const kinds of [['line', 'curve'], ['polyline']]) {
    let shaftShape: RecognizedShape | null = null;
    const arrow = splitArrow(startTrimmed, (shaft) => {
      const r = recognizeShaft(shaft);
      if (r && kinds.includes(r.kind)) {
        shaftShape = r;
        return true;
      }
      return false;
    });
    if (arrow && shaftShape) return { ...(shaftShape as RecognizedShape), arrowEnd: true };
  }
  return recognizeShaft(trimHooks(raw));
}

/**
 * A separate "V" stroke drawn as an arrow head: returns the tip and the direction it points to
 * (unit vector), or null.
 */
export function recognizeArrowHead(samples: readonly InputSample[]): { tip: [number, number]; dir: [number, number]; size: number } | null {
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
