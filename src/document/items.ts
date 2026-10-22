/**
 * Page objects besides ink: text boxes, images and shapes (v0.3, file format version 3; v0.4 adds
 * rotation, groups, line styles, arrow options and curve / polyline connectors — format 4).
 *
 * Items are immutable values: every edit creates a new item object and a new `page.items` array,
 * which keeps undo/redo trivial (see the `set-items` history operation).
 * Coordinates are page units (1 unit = 1 pt; A4 = 595 × 842).
 */

import type { StrokeDash } from './model';
import type { MapLayoutId, MapThemeId, MindNode } from '../mindmap/model';

export type TextFont = 'sans' | 'serif' | 'mono' | 'hand';
export type TextAlign = 'left' | 'center' | 'right';
export type ShapeKind = 'rect' | 'roundrect' | 'ellipse' | 'triangle' | 'diamond' | 'polygon' | 'line' | 'arrow' | 'elbow' | 'curve' | 'polyline';
export const LINE_KINDS: readonly ShapeKind[] = ['line', 'arrow', 'elbow', 'curve', 'polyline'];
export type ArrowHead = 'open' | 'filled';

export interface ItemBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  created: number;
  /** Rotation around the box centre in radians (v4; box items only — connectors rotate their points). */
  rot?: number;
  /** Group id (v4). */
  g?: string;
}

export interface TextItem extends ItemBase {
  type: 'text';
  text: string;
  /** Font size in page units (pt). */
  size: number;
  color: string;
  font: TextFont;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Width follows the text (true until the user resizes the box). */
  autoWidth: boolean;
  /** LaTeX source when the text is a formula (AI conversion). Shown as text; copied as $…$. */
  latex?: string;
}

export interface ImageItem extends ItemBase {
  type: 'image';
  /** Vault path of the attachment (Obsidian), `asset:<id>` (embedded, v4) or a data: URL. */
  src: string;
  natW: number;
  natH: number;
  /** Visible part of the source image, normalized [x, y, w, h] (non-destructive crop). */
  crop?: [number, number, number, number];
}

/** Connector end attached to another item: the end follows that item at a normalized anchor. */
export interface Attachment {
  id: string;
  ax: number;
  ay: number;
}

export interface ShapeItem extends ItemBase {
  type: 'shape';
  kind: ShapeKind;
  stroke: string;
  strokeWidth: number;
  fill: string | null;
  fillOpacity: number;
  /** triangle / polygon: vertices normalized to the box, [x0, y0, x1, y1, ...]. */
  points?: number[];
  /** connectors: end points in page units (x, y, w, h are the bounding box of the path). */
  a?: [number, number];
  b?: [number, number];
  /** curve: quadratic Bézier control point (page units). */
  c?: [number, number];
  /** polyline: interior vertices in page units [x0, y0, x1, y1, ...] (between a and b). */
  pts?: number[];
  from?: Attachment;
  to?: Attachment;
  /** Line style (v4). Missing = solid. */
  dash?: StrokeDash;
  /** Arrow heads (v4). Missing = legacy default: arrow / elbow have an end head. */
  arrowStart?: boolean;
  arrowEnd?: boolean;
  head?: ArrowHead;
  /** elbow: route vertically first (top-down flowcharts, v5). */
  vfirst?: boolean;
  /** Text inside a box shape (v5: flowchart nodes). Kept separate from the outline, centred and wrapped to the box. */
  label?: ShapeLabel;
}

export interface ShapeLabel {
  text: string;
  size: number;
  color: string;
  font?: TextFont;
}

/** Editable formula (v5): LaTeX source rendered with Obsidian's MathJax; box follows the rendering. */
export interface FormulaItem extends ItemBase {
  type: 'formula';
  latex: string;
  color: string;
  /** Font size of the rendering (page units). */
  size: number;
}

/**
 * Editable mind map (v5): one item holding a topic tree. Topic positions are never stored; the
 * local layout computes them (src/mindmap/layout.ts). x / y / w / h = the laid-out bounds × scale.
 */
export interface MindMapItem extends ItemBase {
  type: 'mindmap';
  root: MindNode;
  theme: MapThemeId;
  layout: MapLayoutId;
  scale: number;
}

export type Item = TextItem | ImageItem | ShapeItem | FormulaItem | MindMapItem;
export type Pt = [number, number];

export function isLine(it: Item): it is ShapeItem & { a: Pt; b: Pt } {
  return it.type === 'shape' && LINE_KINDS.includes(it.kind) && !!it.a && !!it.b;
}

export function lineBox(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

/** Arrow heads of a connector (with the legacy defaults of format v3). */
export function arrowEnds(it: ShapeItem): { start: boolean; end: boolean } {
  return { start: it.arrowStart === true, end: it.arrowEnd ?? (it.kind === 'arrow' || it.kind === 'elbow') };
}

/** Default vertices for triangle / diamond (normalized to the box). */
export function defaultPoints(kind: ShapeKind): number[] | undefined {
  if (kind === 'triangle') return [0.5, 0, 1, 1, 0, 1];
  if (kind === 'diamond') return [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5];
  return undefined;
}

// ------------------------------------------------------------------------------------------------
// Connector geometry
// ------------------------------------------------------------------------------------------------

export function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** The point on the curve at t = 0.5 (used as the curve's drag handle). */
export function curveMid(a: Pt, c: Pt, b: Pt): Pt {
  return quadPoint(a, c, b, 0.5);
}

/** Control point that makes the curve pass through `m` at t = 0.5. */
export function controlFromMid(a: Pt, m: Pt, b: Pt): Pt {
  return [2 * m[0] - (a[0] + b[0]) / 2, 2 * m[1] - (a[1] + b[1]) / 2];
}

/** Polyline of an elbow connector (horizontal-first orthogonal route). */
export function elbowPath(a: Pt, b: Pt, verticalFirst = false): Pt[] {
  if (verticalFirst) {
    const my = (a[1] + b[1]) / 2;
    return [a, [a[0], my], [b[0], my], b];
  }
  const mx = (a[0] + b[0]) / 2;
  return [a, [mx, a[1]], [mx, b[1]], b];
}

function polyPts(it: ShapeItem & { a: Pt; b: Pt }): Pt[] {
  const out: Pt[] = [it.a];
  const p = it.pts ?? [];
  for (let i = 0; i + 1 < p.length; i += 2) out.push([p[i], p[i + 1]]);
  out.push(it.b);
  return out;
}

/** The connector's path as a polyline (curves are sampled with `n` segments). */
export function connectorPoints(it: ShapeItem & { a: Pt; b: Pt }, n = 32): Pt[] {
  if (it.kind === 'elbow') return elbowPath(it.a, it.b, it.vfirst === true);
  if (it.kind === 'polyline') return polyPts(it);
  if (it.kind === 'curve' && it.c) {
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) out.push(quadPoint(it.a, it.c, it.b, i / n));
    return out;
  }
  return [it.a, it.b];
}

/** Direction points for the arrow heads: [from, tip] at the start and at the end. */
export function arrowTangents(it: ShapeItem & { a: Pt; b: Pt }): { start: [Pt, Pt]; end: [Pt, Pt] } {
  if (it.kind === 'curve' && it.c) {
    // tangent at the ends of a quadratic is towards the control point (fallback: the chord)
    const cs = Math.hypot(it.c[0] - it.a[0], it.c[1] - it.a[1]) > 0.01 ? it.c : it.b;
    const ce = Math.hypot(it.c[0] - it.b[0], it.c[1] - it.b[1]) > 0.01 ? it.c : it.a;
    return { start: [cs, it.a], end: [ce, it.b] };
  }
  const pts = connectorPoints(it);
  return { start: [pts[1], pts[0]], end: [pts[pts.length - 2], pts[pts.length - 1]] };
}

function boundsOf(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Recompute x, y, w, h of a connector from its geometry. */
export function fitConnector<T extends ShapeItem>(it: T): T {
  if (!isLine(it)) return it;
  return { ...it, ...boundsOf(connectorPoints(it, 24)) };
}

// ------------------------------------------------------------------------------------------------
// Rotation
// ------------------------------------------------------------------------------------------------

export function itemCenter(it: Item): Pt {
  return [it.x + it.w / 2, it.y + it.h / 2];
}

export function rotatePt(p: Pt, c: Pt, ang: number): Pt {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs];
}

/** Item-local (unrotated) coordinates of a page point. */
export function toItemLocal(it: Item, x: number, y: number): Pt {
  if (!it.rot) return [x, y];
  return rotatePt([x, y], itemCenter(it), -it.rot);
}

/** Corners of the (possibly rotated) box: nw, ne, se, sw. */
export function itemCorners(it: Item): Pt[] {
  const c: Pt[] = [
    [it.x, it.y],
    [it.x + it.w, it.y],
    [it.x + it.w, it.y + it.h],
    [it.x, it.y + it.h],
  ];
  if (!it.rot) return c;
  const ctr = itemCenter(it);
  return c.map((p) => rotatePt(p, ctr, it.rot as number));
}

/** Axis-aligned bounds of an item as drawn (rotation and curve bulge included). */
export function itemBounds(it: Item): { x: number; y: number; w: number; h: number } {
  if (isLine(it)) return boundsOf(connectorPoints(it, 24));
  if (!it.rot) return { x: it.x, y: it.y, w: it.w, h: it.h };
  return boundsOf(itemCorners(it));
}

/** Point on an item's box for a normalized anchor (rotation applied). */
export function anchorPoint(it: Item, ax: number, ay: number): Pt {
  const p: Pt = [it.x + it.w * ax, it.y + it.h * ay];
  return it.rot ? rotatePt(p, itemCenter(it), it.rot) : p;
}

/** Snap a page point to the nearest of an item's anchors (side midpoints). */
export function nearestAnchor(it: Item, x: number, y: number): { ax: number; ay: number; d: number } {
  const anchors: Pt[] = [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ];
  let best = { ax: 0.5, ay: 0.5, d: Infinity };
  for (const [ax, ay] of anchors) {
    const [px, py] = anchorPoint(it, ax, ay);
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { ax, ay, d };
  }
  return best;
}

/**
 * Re-resolve connector ends attached to other items (after a move/resize). Returns a new array
 * when anything changed, otherwise the same array.
 */
export function resolveConnectors(items: Item[]): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  let changed = false;
  const out = items.map((it) => {
    if (!isLine(it) || (!it.from && !it.to)) return it;
    let a = it.a;
    let b = it.b;
    if (it.from) {
      const t = byId.get(it.from.id);
      if (t && t !== it) a = anchorPoint(t, it.from.ax, it.from.ay);
    }
    if (it.to) {
      const t = byId.get(it.to.id);
      if (t && t !== it) b = anchorPoint(t, it.to.ax, it.to.ay);
    }
    if (a[0] === it.a[0] && a[1] === it.a[1] && b[0] === it.b[0] && b[1] === it.b[1]) return it;
    changed = true;
    // a curve keeps its bulge relative to the moved chord
    let c = it.c;
    if (c) {
      const m = curveMid(it.a, c, it.b);
      const off: Pt = [m[0] - (it.a[0] + it.b[0]) / 2, m[1] - (it.a[1] + it.b[1]) / 2];
      c = controlFromMid(a, [(a[0] + b[0]) / 2 + off[0], (a[1] + b[1]) / 2 + off[1]], b);
    }
    return fitConnector({ ...it, a, b, ...(c ? { c } : {}) });
  });
  return changed ? out : items;
}

/** Remove attachments that point at items no longer on the page. */
export function detachMissing(items: Item[]): Item[] {
  const ids = new Set(items.map((i) => i.id));
  let changed = false;
  const out = items.map((it) => {
    if (it.type !== 'shape') return it;
    const from = it.from && !ids.has(it.from.id) ? undefined : it.from;
    const to = it.to && !ids.has(it.to.id) ? undefined : it.to;
    if (from === it.from && to === it.to) return it;
    changed = true;
    const n: ShapeItem = { ...it };
    if (from) n.from = from;
    else delete n.from;
    if (to) n.to = to;
    else delete n.to;
    return n;
  });
  return changed ? out : items;
}

/** Distance from a point to segment ab. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

/** Hit test in page units; `tol` is the touch tolerance in page units. */
export function hitItem(it: Item, x: number, y: number, tol: number): boolean {
  if (isLine(it)) {
    const pts = connectorPoints(it, 24);
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= tol + it.strokeWidth / 2) return true;
    }
    return false;
  }
  const [lx, ly] = toItemLocal(it, x, y);
  return lx >= it.x - tol && lx <= it.x + it.w + tol && ly >= it.y - tol && ly <= it.y + it.h + tol;
}

/** Does a circle touch the shape's outline (used by the eraser on shapes)? */
export function shapeTouchesCircle(it: ShapeItem, x: number, y: number, r: number): boolean {
  if (isLine(it)) return hitItem(it, x, y, r);
  const [lx, ly] = toItemLocal(it, x, y);
  const pad = r + it.strokeWidth / 2;
  if (lx < it.x - pad || lx > it.x + it.w + pad || ly < it.y - pad || ly > it.y + it.h + pad) return false;
  const poly = shapeOutline(it, 24);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (distToSegment(lx, ly, p[0], p[1], q[0], q[1]) <= pad) return true;
  }
  return !!it.fill && lx >= it.x && lx <= it.x + it.w && ly >= it.y && ly <= it.y + it.h;
}

/** Closed outline polygon of a box shape (unrotated page units); ellipses are sampled with `n` points. */
export function shapeOutline(it: ShapeItem, n = 48): Pt[] {
  const { x, y, w, h } = it;
  switch (it.kind) {
    case 'ellipse': {
      const out: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        out.push([x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2]);
      }
      return out;
    }
    case 'triangle':
    case 'diamond':
    case 'polygon': {
      const pts = it.points ?? defaultPoints(it.kind) ?? [0, 0, 1, 0, 1, 1, 0, 1];
      const out: Pt[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) out.push([x + pts[i] * w, y + pts[i + 1] * h]);
      return out;
    }
    default:
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
  }
}

/** Apply a point mapping to every geometric point of a connector. */
function mapConnector(it: ShapeItem & { a: Pt; b: Pt }, f: (p: Pt) => Pt): ShapeItem {
  const n: ShapeItem = { ...it, a: f(it.a), b: f(it.b) };
  if (it.c) n.c = f(it.c);
  if (it.pts) {
    const out: number[] = [];
    for (let i = 0; i + 1 < it.pts.length; i += 2) out.push(...f([it.pts[i], it.pts[i + 1]]));
    n.pts = out;
  }
  return fitConnector(n);
}

/** Move an item by (dx, dy); a connector moved on its own is detached from its items. */
export function moveItem(it: Item, dx: number, dy: number, keepAttachments = false): Item {
  if (isLine(it)) {
    const n = mapConnector(it, (p) => [p[0] + dx, p[1] + dy]);
    if (!keepAttachments) {
      delete n.from;
      delete n.to;
    }
    return n;
  }
  return { ...it, x: it.x + dx, y: it.y + dy };
}

/** Resize to a new box (connectors map their points proportionally). Works in the unrotated frame. */
export function resizeItem(it: Item, box: { x: number; y: number; w: number; h: number }): Item {
  const w = Math.max(box.w, 1);
  const h = Math.max(box.h, 1);
  if (isLine(it)) {
    const ob = { x: it.x, y: it.y, w: it.w, h: it.h };
    return mapConnector(it, (p) => [box.x + (ob.w > 0 ? ((p[0] - ob.x) / ob.w) * w : w / 2), box.y + (ob.h > 0 ? ((p[1] - ob.y) / ob.h) * h : h / 2)]);
  }
  if (it.type === 'text') return { ...it, x: box.x, y: box.y, w, h, autoWidth: false };
  if (it.type === 'formula' || it.type === 'mindmap') {
    // content keeps its aspect ratio: uniform scale that fits the requested box
    const s = Math.max(0.05, Math.min(w / Math.max(it.w, 1), h / Math.max(it.h, 1)));
    const n = { ...it, x: box.x, y: box.y, w: it.w * s, h: it.h * s };
    if (n.type === 'formula') n.size = Math.min(400, Math.max(4, it.type === 'formula' ? it.size * s : 12));
    else n.scale = Math.min(8, Math.max(0.1, (it as MindMapItem).scale * s));
    return n;
  }
  return { ...it, x: box.x, y: box.y, w, h };
}

/**
 * Similarity transform used by the lasso: uniform scale `s` and rotation `ang` around `pivot`, then
 * translation (tx, ty). Connectors transform their points; box items transform their centre, scale
 * their size (and font size / line width) and add the rotation.
 */
export function transformItem(it: Item, pivot: Pt, s: number, ang: number, tx: number, ty: number, keepAttachments = true): Item {
  const f = (p: Pt): Pt => {
    const r = rotatePt([pivot[0] + (p[0] - pivot[0]) * s, pivot[1] + (p[1] - pivot[1]) * s], pivot, ang);
    return [r[0] + tx, r[1] + ty];
  };
  if (isLine(it)) {
    const n = mapConnector(it, f);
    n.strokeWidth = clampW(it.strokeWidth * s);
    if (!keepAttachments) {
      delete n.from;
      delete n.to;
    }
    return n;
  }
  const c = f(itemCenter(it));
  const w = it.w * s;
  const h = it.h * s;
  const rot = normAngle((it.rot ?? 0) + ang);
  const base = { x: c[0] - w / 2, y: c[1] - h / 2, w, h };
  const withRot = <T extends Item>(n: T): T => {
    if (Math.abs(rot) < 1e-4) delete n.rot;
    else n.rot = rot;
    return n;
  };
  if (it.type === 'text') return withRot({ ...it, ...base, size: Math.min(400, Math.max(4, it.size * s)) });
  if (it.type === 'formula') return withRot({ ...it, ...base, size: Math.min(400, Math.max(4, it.size * s)) });
  // mind maps stay upright (their layout is horizontal); the lasso rotation only moves them
  if (it.type === 'mindmap') return { ...it, ...base, scale: Math.min(8, Math.max(0.1, it.scale * s)) };
  if (it.type === 'shape' && it.label) return withRot({ ...it, ...base, strokeWidth: clampW(it.strokeWidth * s), label: { ...it.label, size: Math.min(200, Math.max(4, it.label.size * s)) } });
  if (it.type === 'shape') return withRot({ ...it, ...base, strokeWidth: clampW(it.strokeWidth * s) });
  return withRot({ ...it, ...base });
}

function clampW(w: number): number {
  return Math.min(40, Math.max(0.1, w));
}

export function normAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}
