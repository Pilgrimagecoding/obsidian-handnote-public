import type { GeometryCache } from '../document/geometry-cache';
import type { Bounds } from '../document/board';
import type { Page } from '../document/model';
import { framePage, pageRenderBox, paintBoardBackground, paintFrame, paintPaper, renderPageToCanvas } from '../rendering/paint';
import { getImage, preloadImages } from '../rendering/items-paint';
import { ensureDocPage } from '../rendering/doc-layer';
import { renderFormula } from '../rendering/formula';
import { pageToSvg } from '../rendering/svg-export';

/** Bitmap size limit of an embed's canvas (its longer side, px). */
const MAX_BITMAP = 2400;
const SHADOW = 'rgba(0,0,0,0.12)';

/**
 * One page of a ![[note.handnote]] embed. Ink, shapes, text and formulas are an inline SVG: vector,
 * so they stay sharp however far the note around them is zoomed. Only an imported document page
 * (PDF …) is a bitmap, under the SVG.
 */
export function renderEmbedPage(parent: HTMLElement, page: Page, geo: GeometryCache, width: number, dpr: number): HTMLElement {
  const b = pageRenderBox(page, geo);
  const holder = parent.createDiv({ cls: 'hn-embed-page' });
  holder.style.aspectRatio = `${b.w} / ${b.h}`;
  let scale: number;
  if (page.board) {
    // whiteboard: its whole content, as wide as the note but at most 600 px high
    const cssW = Math.min(width, (600 * b.w) / b.h);
    holder.style.maxWidth = `${Math.round(cssW)}px`;
    holder.addClass('is-board');
    scale = Math.min((cssW * dpr) / b.w, MAX_BITMAP / Math.max(b.w, b.h));
  } else scale = Math.min((width * dpr) / page.width, MAX_BITMAP / page.width);
  const docs = page.doc ? [page] : (page.board?.frames.filter((f) => f.doc).map(framePage) ?? []);
  let backdrop: HTMLCanvasElement | null = null;
  if (docs.length) {
    const canvas = holder.createEl('canvas', { cls: 'hn-embed-backdrop' });
    backdrop = canvas;
    paintBackdrop(canvas, page, b, scale);
    // the document page renders asynchronously: paint the backdrop again once
    void Promise.all(docs.map((p) => ensureDocPage(p, scale))).then(() => paintBackdrop(canvas, page, b, scale));
  }
  const draw = () => {
    holder.querySelector(':scope > .hn-embed-svg, :scope > .hn-embed-fallback')?.remove();
    const svg = vectorPage(page, geo, !backdrop);
    if (svg) {
      holder.append(svg);
      return;
    }
    // SVG markup the parser refused (should not happen): the old bitmap preview
    backdrop?.remove();
    backdrop = null;
    const canvas = holder.createEl('canvas', { cls: 'hn-embed-fallback' });
    renderPageToCanvas(canvas, page, geo, scale, page.board ? b : undefined);
    if (docs.length) void Promise.all(docs.map((p) => ensureDocPage(p, scale))).then(() => renderPageToCanvas(canvas, page, geo, scale, page.board ? b : undefined));
  };
  draw();
  // images (vault files) and typeset formulas load asynchronously: draw again once they are ready
  const waits: Promise<unknown>[] = [];
  if (page.items?.some((i) => i.type === 'image')) waits.push(preloadImages(page));
  for (const it of page.items ?? []) if (it.type === 'formula') waits.push(renderFormula(it.latex));
  if (waits.length) void Promise.allSettled(waits).then(() => draw());
  return holder;
}

function vectorPage(page: Page, geo: GeometryCache, background: boolean): SVGSVGElement | null {
  const markup = pageToSvg(page, geo, { background, imageHref: (src) => getImage(src)?.src ?? null });
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.nodeName !== 'svg' || parsed.getElementsByTagName('parsererror').length) return null;
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  // sized by the holder (CSS), not in pt
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('class', 'hn-embed-svg');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** Paper, pattern and imported document page(s) of a page with a document background. */
function paintBackdrop(canvas: HTMLCanvasElement, page: Page, b: Bounds, scale: number): void {
  const w = Math.max(1, Math.round(b.w * scale));
  const h = Math.max(1, Math.round(b.h * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
  ctx.clearRect(b.x, b.y, b.w, b.h);
  if (!page.board) {
    paintPaper(ctx, page, scale);
    return;
  }
  paintBoardBackground(ctx, page.background, b.x, b.y, b.x + b.w, b.y + b.h, scale);
  for (const f of page.board.frames) paintFrame(ctx, f, scale, SHADOW);
}
