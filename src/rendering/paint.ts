import { paintDocPage } from './doc-layer';
import type { HandNoteDocument, Page, PageBackground, Stroke } from '../document/model';
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

/** Vertical continuous layout, pages centered on x = 0. */
export function layoutPages(doc: HandNoteDocument): PageRect[] {
  const out: PageRect[] = [];
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
  const clip = opts.clip;
  const visible = (g: StrokeGeometry) =>
    !clip || !(g.bbox[2] < clip[0] || g.bbox[0] > clip[2] || g.bbox[3] < clip[1] || g.bbox[1] > clip[3]);
  let painted = 0;

  // highlighter groups
  const groups = new Map<string, { color: string; opacity: number; strokes: Stroke[] }>();
  for (const s of page.strokes) {
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
  for (const s of page.strokes) {
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

/** Render a full page into a canvas at the given scale (used by embeds and PNG export). */
export function renderPageToCanvas(
  canvas: HTMLCanvasElement,
  page: Page,
  cache: GeometryCache,
  scale: number,
): void {
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
