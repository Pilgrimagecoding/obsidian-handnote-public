import { paintDocPage } from './doc-layer';
import type { BoardFrame, HandNoteDocument, Page, PageBackground, Stroke } from '../document/model';
import { BOARD_MARGIN, boardExtent, type Bounds } from '../document/board';
import { paintStrokesSimplified, roughBounds, strokesIn, useSimplified } from './board-index';
import type { GeometryCache } from '../document/geometry-cache';
import { CanvasPathSink, emitGeometry } from '../ink/outline';
import type { StrokeGeometry } from '../ink/stroke-builder';
import { paintItemsAbove, paintItemsBelow, pencilFill } from './items-paint';
import { emitDashedGeometry } from './dash';

/** Shared painting routines used by the editor, embed previews and PNG export. */

export const PAGE_GAP = 28;

export interface PageRect {
  page: Page;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Vertical continuous layout, pages centered on x = 0. A whiteboard (v7) is one rect at the world
 * origin, so its page-local coordinates are world coordinates (w/h = its content extent, informative
 * only: a whiteboard has no edges).
 */
export function layoutPages(doc: HandNoteDocument): PageRect[] {
  const out: PageRect[] = [];
  if (doc.pages.length === 1 && doc.pages[0].board) {
    const page = doc.pages[0];
    return [{ page, index: 0, x: 0, y: 0, w: page.width, h: page.height }];
  }
  let y = 0;
  doc.pages.forEach((page, index) => {
    out.push({ page, index, x: -page.width / 2, y, w: page.width, h: page.height });
    y += page.height + PAGE_GAP;
  });
  return out;
}

export function documentBounds(rects: PageRect[]): { minX: number; maxX: number; height: number } {
  let minX = 0;
  let maxX = 0;
  let height = 0;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.w);
    height = r.y + r.h;
  }
  return { minX, maxX, height };
}

const pathCache = new WeakMap<StrokeGeometry, Path2D>();

export function strokePath(g: StrokeGeometry): Path2D {
  let p = pathCache.get(g);
  if (!p) {
    p = new Path2D();
    emitGeometry(new CanvasPathSink(p), g);
    pathCache.set(g, p);
  }
  return p;
}

const dashCache = { dash: new WeakMap<StrokeGeometry, Path2D>(), dot: new WeakMap<StrokeGeometry, Path2D>() };

/** Outline path of a stroke, honouring its line style (dashed / dotted). */
export function inkPath(s: Pick<Stroke, 'dash' | 'params'>, g: StrokeGeometry): Path2D {
  if (!s.dash) return strokePath(g);
  const cache = dashCache[s.dash];
  let p = cache.get(g);
  if (!p) {
    p = new Path2D();
    emitDashedGeometry(new CanvasPathSink(p), g, s.dash, s.params.width);
    cache.set(g, p);
  }
  return p;
}

/** Draw page paper and background pattern in page-local coordinates (ctx already transformed). */
export function paintPaper(ctx: CanvasRenderingContext2D, page: Page, pxPerUnit: number, texture = false): void {
  const bg = page.background;
  ctx.fillStyle = bg.paper;
  ctx.fillRect(0, 0, page.width, page.height);
  // imported document page (v6) under the pattern and the ink; no paper grain over a document
  const hasDoc = paintDocPage(ctx, page, pxPerUnit);
  if (texture && !hasDoc) paintGrain(ctx, page.width, page.height, pxPerUnit);
  paintPattern(ctx, page.width, page.height, bg, pxPerUnit);
}

let grainTile: HTMLCanvasElement | null = null;

/** A very light, fixed-seed paper grain (≈3% contrast) at constant screen size. Screen only. */
function paintGrain(ctx: CanvasRenderingContext2D, w: number, h: number, pxPerUnit: number): void {
  if (typeof document === 'undefined') return;
  if (!grainTile) {
    grainTile = document.createElement('canvas');
    grainTile.width = grainTile.height = 96;
    const g = grainTile.getContext('2d');
    if (!g) return;
    const img = g.createImageData(96, 96);
    let seed = 1234567;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      const v = seed % 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v < 128 ? 0 : 255;
      img.data[i + 3] = 6 + (seed % 7);
    }
    g.putImageData(img, 0, 0);
  }
  const pat = ctx.createPattern(grainTile, 'repeat');
  if (!pat) return;
  if (typeof DOMMatrix !== 'undefined' && pat.setTransform) pat.setTransform(new DOMMatrix().scale(1 / pxPerUnit, 1 / pxPerUnit));
  ctx.save();
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

export function paintPattern(ctx: CanvasRenderingContext2D, w: number, h: number, bg: PageBackground, pxPerUnit: number): void {
  if (bg.kind === 'blank') return;
  const sp = bg.spacing;
  // keep lines ~1 device px thick regardless of zoom, but never thicker than 0.6 units
  const lw = Math.min(0.6, 1 / Math.max(pxPerUnit, 0.01));
  ctx.save();
  ctx.strokeStyle = bg.line;
  ctx.fillStyle = bg.line;
  ctx.lineWidth = lw;
  if (bg.kind === 'ruled') {
    const top = sp * 3;
    ctx.beginPath();
    for (let y = top; y < h - sp * 0.5; y += sp) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  } else if (bg.kind === 'grid') {
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (let y = sp; y < h; y += sp) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    for (let x = sp; x < w; x += sp) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
  } else if (bg.kind === 'dots') {
    const r = Math.max(0.45, 1.1 / Math.max(pxPerUnit, 0.01));
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let y = sp; y < h; y += sp) {
      for (let x = sp; x < w; x += sp) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  ctx.restore();
}

export interface PaintOptions {
  /** Visible region in page-local coordinates; strokes outside are skipped. */
  clip?: [number, number, number, number];
}

const canAddPath = typeof Path2D !== 'undefined' && typeof (Path2D.prototype).addPath === 'function';

/**
 * Paint all strokes of a page (page-local coordinates). Highlighters go first (under the ink).
 * Highlighter strokes with the same color+opacity are merged into one path and filled once, so
 * overlapping highlighter strokes do not darken each other (the "double highlight" artifact).
 */
export function paintStrokes(
  ctx: CanvasRenderingContext2D,
  page: Page,
  cache: GeometryCache,
  opts: PaintOptions = {},
  skip?: ReadonlySet<string>,
): number {
  return paintStrokeList(ctx, page.strokes, cache, opts, skip);
}

/** paintStrokes for a list of strokes (z-order = list order). */
export function paintStrokeList(
  ctx: CanvasRenderingContext2D,
  list: readonly Stroke[],
  cache: GeometryCache,
  opts: PaintOptions = {},
  skip?: ReadonlySet<string>,
): number {
  const clip = opts.clip;
  const visible = (g: StrokeGeometry) =>
    !clip || !(g.bbox[2] < clip[0] || g.bbox[0] > clip[2] || g.bbox[3] < clip[1] || g.bbox[1] > clip[3]);
  let painted = 0;

  // highlighter groups
  const groups = new Map<string, { color: string; opacity: number; strokes: Stroke[] }>();
  for (const s of list) {
    if (s.tool !== 'highlighter' || skip?.has(s.id)) continue;
    const key = s.color + '|' + s.params.opacity;
    let grp = groups.get(key);
    if (!grp) {
      grp = { color: s.color, opacity: s.params.opacity, strokes: [] };
      groups.set(key, grp);
    }
    grp.strokes.push(s);
  }
  for (const grp of groups.values()) {
    const merged = new Path2D();
    let any = false;
    for (const s of grp.strokes) {
      const g = cache.get(s);
      if (!visible(g)) continue;
      any = true;
      painted++;
      if (canAddPath) merged.addPath(inkPath(s, g));
      else if (s.dash) emitDashedGeometry(new CanvasPathSink(merged), g, s.dash, s.params.width);
      else emitGeometry(new CanvasPathSink(merged), g);
    }
    if (!any) continue;
    ctx.save();
    ctx.globalAlpha = grp.opacity;
    ctx.fillStyle = grp.color;
    ctx.fill(merged, 'nonzero');
    ctx.restore();
  }

  // ink, in z-order
  for (const s of list) {
    if (s.tool === 'highlighter' || skip?.has(s.id)) continue;
    const g = cache.get(s);
    if (!visible(g)) continue;
    painted++;
    ctx.globalAlpha = s.params.opacity;
    ctx.fillStyle = s.tool === 'pencil' ? pencilFill(ctx, s.color) : s.color;
    ctx.fill(inkPath(s, g), 'nonzero');
  }
  ctx.globalAlpha = 1;
  return painted;
}

/** Everything on a page (page-local coordinates): images and shapes, ink, then text boxes. */
export function paintPageContent(
  ctx: CanvasRenderingContext2D,
  page: Page,
  cache: GeometryCache,
  opts: PaintOptions = {},
  skip?: ReadonlySet<string>,
): void {
  paintItemsBelow(ctx, page, skip);
  paintStrokes(ctx, page, cache, opts, skip);
  paintItemsAbove(ctx, page, skip);
}

/** Paint one ink stroke (used for incremental commits). */
export function paintInkStroke(ctx: CanvasRenderingContext2D, s: Stroke, g: StrokeGeometry): void {
  ctx.globalAlpha = s.params.opacity;
  ctx.fillStyle = s.tool === 'pencil' ? pencilFill(ctx, s.color) : s.color;
  ctx.fill(inkPath(s, g), 'nonzero');
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------------------------------
// Whiteboards (0.11)
// ------------------------------------------------------------------------------------------------

/** Smallest on-screen spacing (px) of the board texture; denser patterns are thinned out ×2. */
const MIN_PATTERN_PX = 9;
const MAX_PATTERN_DOTS = 60000;
const MAX_PATTERN_LINES = 3000;

/** Paint the whiteboard texture over the world rectangle [x0, x1] × [y0, y1], aligned to the world origin. */
export function paintBoardBackground(ctx: CanvasRenderingContext2D, bg: PageBackground, x0: number, y0: number, x1: number, y1: number, pxPerUnit: number): void {
  ctx.fillStyle = bg.paper;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  if (bg.kind === 'blank') return;
  let sp = Math.max(1, bg.spacing);
  while (sp * pxPerUnit < MIN_PATTERN_PX && sp < 1e5) sp *= 2;
  // never more than ~60k dots / 3k lines, whatever the area (a view measured very large for a
  // moment — Obsidian reloading the plugin — painted millions of dots and crashed the renderer)
  const W = Math.max(0, x1 - x0);
  const H = Math.max(0, y1 - y0);
  if (!(W < 1e7 && H < 1e7)) return;
  if (bg.kind === 'dots') while ((W / sp) * (H / sp) > MAX_PATTERN_DOTS && sp < 1e7) sp *= 2;
  else while ((W + H) / sp > MAX_PATTERN_LINES && sp < 1e7) sp *= 2;
  // one fill with a cached tile (a few µs) instead of drawing every dot / line: the texture is
  // repainted on every frame of a pinch, which on iPad took longer than a frame (the edges stayed
  // blank and the whole scene was redrawn at once when the fingers lifted)
  if (paintTiled(ctx, bg, sp, x0, y0, x1, y1, pxPerUnit)) return;
  const lead = bg.kind === 'ruled' ? 3 : 1; // paintPattern starts at sp (ruled: 3 sp)
  const ax = Math.floor(x0 / sp) * sp - sp;
  const ay = Math.floor(y0 / sp) * sp - lead * sp;
  ctx.save();
  ctx.translate(ax, ay);
  paintPattern(ctx, x1 - ax + sp, y1 - ay + sp, { ...bg, spacing: sp }, pxPerUnit);
  ctx.restore();
}

const tiles = new Map<string, HTMLCanvasElement>();

/**
 * The board texture as a repeating pattern: a tile of one cell (sp units) at the device resolution,
 * scaled so a tile is exactly sp units in the world and anchored at the world origin (so the
 * texture does not drift when the view moves). False when patterns are not available (tests).
 */
function paintTiled(ctx: CanvasRenderingContext2D, bg: PageBackground, sp: number, x0: number, y0: number, x1: number, y1: number, pxPerUnit: number): boolean {
  if (typeof document === 'undefined' || typeof DOMMatrix === 'undefined') return false;
  const T = Math.max(4, Math.min(512, Math.round(sp * pxPerUnit)));
  const key = `${bg.kind}|${bg.line}|${T}`;
  let tile = tiles.get(key);
  if (!tile) {
    if (tiles.size > 24) tiles.clear();
    tile = document.createElement('canvas');
    tile.width = tile.height = T;
    const g = tile.getContext('2d');
    if (!g) return false;
    g.fillStyle = bg.line;
    g.strokeStyle = bg.line;
    if (bg.kind === 'dots') {
      // the dot sits in the middle of the tile (the pattern is shifted by half a cell)
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(T / 2, T / 2, Math.max(0.7, Math.min(T / 6, 1.1)), 0, Math.PI * 2);
      g.fill();
    } else if (bg.kind === 'grid') {
      g.globalAlpha = 0.8;
      g.fillRect(0, 0, T, 1);
      g.fillRect(0, 0, 1, T);
    } else {
      g.fillRect(0, 0, T, 1);
    }
    tiles.set(key, tile);
  }
  const pat = ctx.createPattern(tile, 'repeat');
  if (!pat || !pat.setTransform) return false;
  const k = sp / T; // world units per tile pixel
  const off = bg.kind === 'dots' ? -sp / 2 : 0;
  pat.setTransform(new DOMMatrix().translate(off, off).scale(k, k));
  ctx.save();
  ctx.fillStyle = pat;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
  return true;
}

/** A frame as a page-shaped value, for the paper and document painters. */
export function framePage(f: BoardFrame): Page {
  return { id: f.id, width: f.width, height: f.height, background: f.background, ...(f.doc ? { doc: f.doc } : {}), strokes: [], items: [] };
}

/** Paint a frame's shadow, paper and document page (world coordinates, ctx in world units). */
export function paintFrame(ctx: CanvasRenderingContext2D, f: BoardFrame, pxPerUnit: number, shadow: string | null, texture = false): void {
  ctx.save();
  ctx.translate(f.x, f.y);
  if (shadow) {
    ctx.fillStyle = shadow;
    ctx.fillRect(1.5 / pxPerUnit, 2 / pxPerUnit, f.width, f.height);
  }
  paintPaper(ctx, framePage(f), pxPerUnit, texture);
  ctx.restore();
}

/** Whiteboard texture, frames in view and content (ctx in world units). */
export function paintBoard(
  ctx: CanvasRenderingContext2D,
  page: Page,
  cache: GeometryCache,
  view: [number, number, number, number],
  pxPerUnit: number,
  o: { shadow?: string | null; texture?: boolean; skip?: ReadonlySet<string>; skipFrames?: ReadonlySet<string> } = {},
): void {
  const [x0, y0, x1, y1] = view;
  paintBoardBackground(ctx, page.background, x0, y0, x1, y1, pxPerUnit);
  for (const f of page.board?.frames ?? []) {
    if (f.x > x1 || f.x + f.width < x0 || f.y > y1 || f.y + f.height < y0 || o.skipFrames?.has(f.id)) continue;
    paintFrame(ctx, f, pxPerUnit, o.shadow ?? null, o.texture);
  }
  // only the strokes in view (grid index); crowded and zoomed far out: simplified per-cell paths
  paintItemsBelow(ctx, page, o.skip);
  const vis = strokesIn(page, view);
  if (!o.skip?.size && useSimplified(vis.length, pxPerUnit)) paintStrokesSimplified(ctx, page, view, pxPerUnit);
  else paintStrokeList(ctx, vis, cache, { clip: view }, o.skip);
  paintItemsAbove(ctx, page, o.skip);
}

/** Stroke box from the geometry cache (the exact ink outline). */
export function cachedStrokeBox(cache: GeometryCache): (s: Stroke) => Bounds | null {
  return (s) => {
    const b = cache.get(s).bbox;
    return Number.isFinite(b[0]) ? { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] } : null;
  };
}

/**
 * What a full-page render shows, in page coordinates: the page itself, or for a whiteboard its
 * content bounds plus BOARD_MARGIN on every side.
 */
export function pageRenderBox(page: Page, cache?: GeometryCache): Bounds {
  if (!page.board) return { x: 0, y: 0, w: page.width, h: page.height };
  void cache;
  const e = boardExtent(page, roughBounds);
  return { x: e.x - BOARD_MARGIN, y: e.y - BOARD_MARGIN, w: e.w + 2 * BOARD_MARGIN, h: e.h + 2 * BOARD_MARGIN };
}

/** Render a full page into a canvas at the given scale (used by embeds and PNG export). */
export function renderPageToCanvas(
  canvas: HTMLCanvasElement,
  page: Page,
  cache: GeometryCache,
  scale: number,
  box?: Bounds,
): void {
  if (page.board) {
    const b = box ?? pageRenderBox(page, cache);
    const bw = Math.max(1, Math.round(b.w * scale));
    const bh = Math.max(1, Math.round(b.h * scale));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const bctx = canvas.getContext('2d');
    if (!bctx) return;
    bctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
    bctx.clearRect(b.x, b.y, b.w, b.h);
    paintBoard(bctx, page, cache, [b.x, b.y, b.x + b.w, b.y + b.h], scale, { shadow: 'rgba(0,0,0,0.12)' });
    return;
  }
  const w = Math.max(1, Math.round(page.width * scale));
  const h = Math.max(1, Math.round(page.height * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, page.width, page.height);
  paintPaper(ctx, page, scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, page.width, page.height);
  ctx.clip();
  paintPageContent(ctx, page, cache);
  ctx.restore();
}
