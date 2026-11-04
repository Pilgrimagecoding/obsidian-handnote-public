import type { Page, Stroke } from '../document/model';

/**
 * Whiteboard rendering at scale (0.11). A whiteboard is one unbounded page, so it can hold tens of
 * thousands of strokes; every frame used to look at all of them.
 *
 *  - A uniform grid (CELL units) lists the strokes touching each cell: a frame only looks at the
 *    strokes in the cells it shows. Adding strokes updates the grid; any other change rebuilds it.
 *  - Zoomed far out with many strokes in view, each cell is drawn as one simplified path per
 *    colour (the stroke spines, a few points each) instead of one filled outline per stroke —
 *    at that size the difference does not show, and it is tens of times faster.
 *
 * Nothing here is saved; it is rebuilt from the strokes when needed.
 */

export const CELL = 1024;
/** Below this many device pixels per page unit, crowded views are drawn simplified. */
export const LOD_PX_PER_UNIT = 0.75;
/** …when at least this many strokes are in view. */
export const LOD_MIN_STROKES = 1500;
/** Spine points closer than this (page units) are dropped in the simplified path. */
const LOD_STEP = 3;
/** Cell ranges larger than this are scanned linearly instead (cheaper than visiting cells). */
const MAX_CELLS = 4096;

interface LodGroup {
  color: string;
  alpha: number;
  width: number;
  highlighter: boolean;
  path: Path2D;
}

interface LodCell {
  /** Bounds of the strokes whose centre is in this cell (they may reach outside it). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Indices of those strokes. */
  members: number[];
  groups: LodGroup[] | null;
}

interface Grid {
  arr: Stroke[];
  n: number;
  lastId: string;
  cells: Map<number, number[]>;
  lod: Map<number, LodCell>;
  /** Visit stamps per stroke (deduplication while collecting). */
  stamp: Uint32Array;
  tick: number;
}

const grids = new WeakMap<Page, Grid>();

/**
 * Bounds of a stroke from its points (padded by its width): no outline needs to be built, so a
 * whiteboard with many strokes opens without computing the ink of strokes that are not in view.
 * Slightly larger than the outline (taper, nib), which only matters for culling.
 */
const boxes = new WeakMap<Stroke, [number, number, number, number]>();
export function roughBox(s: Stroke): [number, number, number, number] {
  let b = boxes.get(s);
  if (b) return b;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.samples) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const r = (s.params.width || 1) * 1.5 + 1;
  b = [x0 - r, y0 - r, x1 + r, y1 + r];
  boxes.set(s, b);
  return b;
}

function key(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}

function cellOf(v: number): number {
  return Math.floor(v / CELL);
}

function addStroke(g: Grid, s: Stroke, i: number): void {
  const b = roughBox(s);
  if (!Number.isFinite(b[0])) return;
  const cx0 = cellOf(b[0]);
  const cy0 = cellOf(b[1]);
  const cx1 = cellOf(b[2]);
  const cy1 = cellOf(b[3]);
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const k = key(cx, cy);
      let list = g.cells.get(k);
      if (!list) g.cells.set(k, (list = []));
      list.push(i);
    }
  // home cell (by centre) for the simplified drawing
  const hk = key(cellOf((b[0] + b[2]) / 2), cellOf((b[1] + b[3]) / 2));
  let lc = g.lod.get(hk);
  if (!lc) g.lod.set(hk, (lc = { x0: b[0], y0: b[1], x1: b[2], y1: b[3], members: [], groups: null }));
  else {
    lc.x0 = Math.min(lc.x0, b[0]);
    lc.y0 = Math.min(lc.y0, b[1]);
    lc.x1 = Math.max(lc.x1, b[2]);
    lc.y1 = Math.max(lc.y1, b[3]);
    lc.groups = null; // rebuilt with the new member
  }
  lc.members.push(i);
}

/** The page's grid, built or brought up to date. */
function gridOf(page: Page): Grid {
  const arr = page.strokes;
  let g = grids.get(page);
  const lastId = arr.length ? arr[arr.length - 1].id : '';
  if (g && g.arr === arr && g.n === arr.length && g.lastId === lastId) return g;
  // strokes appended to the same array (a new stroke): add them; anything else: rebuild
  const appended = g && g.arr === arr && arr.length > g.n && (g.n === 0 || arr[g.n - 1]?.id === g.lastId);
  if (!g || !appended) {
    g = { arr, n: 0, lastId: '', cells: new Map(), lod: new Map(), stamp: new Uint32Array(Math.max(16, arr.length * 2)), tick: 0 };
    grids.set(page, g);
  }
  if (g.stamp.length < arr.length) {
    const st = new Uint32Array(arr.length * 2);
    st.set(g.stamp);
    g.stamp = st;
  }
  for (let i = g.n; i < arr.length; i++) addStroke(g, arr[i], i);
  g.n = arr.length;
  g.lastId = lastId;
  return g;
}

/** roughBox as {x, y, w, h} (for the content bounds of a whiteboard). */
export function roughBounds(s: Stroke): { x: number; y: number; w: number; h: number } | null {
  if (!s.samples.length) return null;
  const b = roughBox(s);
  return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
}

/** Strokes whose bounds meet the rectangle, in z-order (page order). */
export function strokesIn(page: Page, r: [number, number, number, number]): Stroke[] {
  const arr = page.strokes;
  const cx0 = cellOf(r[0]);
  const cy0 = cellOf(r[1]);
  const cx1 = cellOf(r[2]);
  const cy1 = cellOf(r[3]);
  const meets = (s: Stroke) => {
    const b = roughBox(s);
    return !(b[2] < r[0] || b[0] > r[2] || b[3] < r[1] || b[1] > r[3]);
  };
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS || !(Number.isFinite(cx0) && Number.isFinite(cy1))) return arr.filter(meets);
  const g = gridOf(page);
  g.tick = (g.tick + 1) >>> 0 || 1;
  const t = g.tick;
  const idx: number[] = [];
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const list = g.cells.get(key(cx, cy));
      if (!list) continue;
      for (const i of list) {
        if (g.stamp[i] === t) continue;
        g.stamp[i] = t;
        if (meets(arr[i])) idx.push(i);
      }
    }
  idx.sort((a, b) => a - b);
  return idx.map((i) => arr[i]);
}

function buildGroups(g: Grid, lc: LodCell): LodGroup[] {
  const by = new Map<string, LodGroup>();
  for (const i of lc.members) {
    const s = g.arr[i];
    const hl = s.tool === 'highlighter';
    const k = `${hl ? 'h' : 'i'}|${s.color}|${s.params.opacity}`;
    let grp = by.get(k);
    if (!grp) by.set(k, (grp = { color: s.color, alpha: s.params.opacity, width: 0, highlighter: hl, path: new Path2D() }));
    // the stroke's spine from its points, at its nominal width (pressure does not show at this size)
    grp.width = Math.max(grp.width, s.params.width);
    const pts = s.samples;
    if (!pts.length) continue;
    grp.path.moveTo(pts[0].x, pts[0].y);
    let lx = pts[0].x;
    let ly = pts[0].y;
    let n = 0;
    for (let j = 1; j < pts.length; j++) {
      const p = pts[j];
      if (Math.abs(p.x - lx) + Math.abs(p.y - ly) < LOD_STEP && j < pts.length - 1) continue;
      grp.path.lineTo(p.x, p.y);
      lx = p.x;
      ly = p.y;
      n++;
    }
    if (!n) grp.path.lineTo(lx + 0.01, ly); // a dot
  }
  // highlighters under the ink
  return [...by.values()].sort((a, b) => Number(b.highlighter) - Number(a.highlighter));
}

/** Draw the strokes in view as simplified per-cell paths (crowded, zoomed-out whiteboards). */
export function paintStrokesSimplified(ctx: CanvasRenderingContext2D, page: Page, view: [number, number, number, number], pxPerUnit: number): void {
  const g = gridOf(page);
  const minW = 0.8 / Math.max(pxPerUnit, 1e-3); // at least ~1 device px
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of [true, false]) {
    for (const lc of g.lod.values()) {
      if (lc.x0 > view[2] || lc.x1 < view[0] || lc.y0 > view[3] || lc.y1 < view[1]) continue;
      lc.groups ??= buildGroups(g, lc);
      for (const grp of lc.groups) {
        if (grp.highlighter !== pass) continue;
        ctx.globalAlpha = grp.alpha;
        ctx.strokeStyle = grp.color;
        ctx.lineWidth = Math.max(minW, grp.width);
        ctx.stroke(grp.path);
      }
    }
  }
  ctx.restore();
}

/** Whether a view of a whiteboard should be drawn simplified. */
export function useSimplified(visibleStrokes: number, pxPerUnit: number): boolean {
  return pxPerUnit < LOD_PX_PER_UNIT && visibleStrokes >= LOD_MIN_STROKES;
}
