import type { Page } from '../document/model';
import { arrowEnds, arrowTangents, connectorPoints, isLine, itemCenter, shapeOutline, type ImageItem, type Item, type Pt, type ShapeItem, type TextItem } from '../document/items';
import { lineDashArray } from './dash';
import { paintFormula } from './formula';
import { paintMindMap } from '../mindmap/paint';

// ------------------------------------------------------------------------------------------------
// Image store: resolves item.src (vault path or data URL) to a loaded <img>
// ------------------------------------------------------------------------------------------------

type Resolver = (src: string) => Promise<string>;
let resolver: Resolver = async (src) => src;
interface Entry {
  img: HTMLImageElement | null;
  state: 'loading' | 'ready' | 'failed';
  waiters: (() => void)[];
}
const images = new Map<string, Entry>();
const listeners = new Set<() => void>();

/** Host hook (Obsidian: vault path → blob URL). Clears the cache. */
export function setImageResolver(r: Resolver): void {
  resolver = r;
  for (const k of [...images.keys()]) if (!k.startsWith('asset:')) images.delete(k);
}

/** Embedded images (format v4): asset id → data URL source. Ids are random, so one map serves every open note. */
const assetSources = new Map<string, string>();

/** Make a document's embedded images available to the renderer (editor, embeds, export). */
export function registerAssets(assets: Record<string, { mime: string; data: string }> | undefined): void {
  if (!assets) return;
  for (const [id, a] of Object.entries(assets)) {
    if (assetSources.has(id)) continue;
    assetSources.set(id, `data:${a.mime};base64,${a.data}`);
    // an earlier lookup before registration failed: retry
    const e = images.get(`asset:${id}`);
    if (e && e.state === 'failed') images.delete(`asset:${id}`);
  }
}

/** Data URL of an embedded image (share / export / AI input). */
export function assetDataUrl(src: string): string | null {
  return src.startsWith('asset:') ? (assetSources.get(src.slice(6)) ?? null) : null;
}

/** Called whenever an image finishes loading (editors / embeds re-render). */
export function onImageLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function load(src: string): Entry {
  let e = images.get(src);
  if (e) return e;
  e = { img: null, state: 'loading', waiters: [] };
  images.set(src, e);
  const entry = e;
  const done = (ok: boolean) => {
    entry.state = ok ? 'ready' : 'failed';
    for (const w of entry.waiters.splice(0)) w();
    for (const l of listeners) l();
  };
  if (typeof Image === 'undefined') {
    done(false);
    return entry;
  }
  const resolved = src.startsWith('asset:') ? Promise.resolve(assetSources.get(src.slice(6)) ?? Promise.reject(new Error('missing asset'))) : resolver(src);
  resolved
    .then((url) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        entry.img = img;
        done(true);
      };
      img.onerror = () => done(false);
      img.src = url;
    })
    .catch(() => done(false));
  return entry;
}

/** The loaded image, or null while loading / failed (loading starts on first call). */
export function getImage(src: string): HTMLImageElement | null {
  const e = load(src);
  return e.state === 'ready' ? e.img : null;
}

/** Resolve when every image of the page has loaded or failed (PNG export, embeds). */
export function preloadImages(page: Page): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const it of page.items ?? []) {
    if (it.type !== 'image') continue;
    const e = load(it.src);
    if (e.state === 'loading') waits.push(new Promise((res) => e.waiters.push(res)));
  }
  return Promise.all(waits).then(() => undefined);
}

/** Register an already-decoded image for a src (after inserting, avoids a second load). */
export function primeImage(src: string, img: HTMLImageElement): void {
  images.set(src, { img, state: 'ready', waiters: [] });
}

// ------------------------------------------------------------------------------------------------
// Text layout
// ------------------------------------------------------------------------------------------------

export const TEXT_PAD = 4;
export const LINE_HEIGHT = 1.35;

const FAMILIES: Record<TextItem['font'], string> = {
  sans: '-apple-system, "PingFang SC", "Helvetica Neue", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
  // clean "hand-lettered" look (like Excalidraw text) from fonts that ship with the OS
  // no generic `cursive` at the end: on iPad it resolves Chinese to a Song (serif) face
  hand: '"Chalkboard SE", "Comic Sans MS", "Segoe Print", "Kaiti SC", STKaiti, KaiTi, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
};

/** Optional downloaded hand-lettering font (LXGW WenKai, OFL) — used for the "hand" style when loaded. */
let handFont: string | null = null;
export function setHandFont(family: string | null): void {
  handFont = family;
}
export function handFontLoaded(): boolean {
  return !!handFont || handStack.length > 0;
}

/**
 * Optional Excalidraw hand-drawn fonts (Excalifont + Xiaolai, OFL), split by character ranges:
 * used first for the "hand" style. `glyphs(text)` asks the loader for the subsets a text needs;
 * when they arrive it calls `fontsChanged()` and the editors redraw.
 */
let handStack: string[] = [];
let glyphLoader: ((text: string) => void) | null = null;
export function setHandFontStack(families: string[], loader: ((text: string) => void) | null): void {
  handStack = families;
  glyphLoader = loader;
}
export function requestGlyphs(text: string): void {
  glyphLoader?.(text);
}
export function fontsChanged(): void {
  for (const fn of listeners) fn();
}

export function fontFamily(f: TextItem['font']): string {
  if (f === 'hand') {
    const pre = [...handStack, ...(handFont ? [handFont] : [])].map((x) => `"${x}"`).join(', ');
    return pre ? `${pre}, ${FAMILIES.hand}` : FAMILIES.hand;
  }
  return FAMILIES[f] ?? FAMILIES.sans;
}

export function textFont(it: Pick<TextItem, 'bold' | 'italic' | 'size' | 'font'>): string {
  return `${it.italic ? 'italic ' : ''}${it.bold ? '700' : '400'} ${it.size}px ${fontFamily(it.font)}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

function measure(ctx: CanvasRenderingContext2D | null, s: string, size: number): number {
  if (ctx) return ctx.measureText(s).width;
  return s.length * size * 0.55; // Node fallback (tests)
}

/** Break text into lines; wraps at maxWidth (CJK may break anywhere, Latin prefers spaces). */
export function layoutText(it: TextItem, ctxIn?: CanvasRenderingContext2D | null): { lines: string[]; width: number; height: number } {
  const ctx = ctxIn ?? mctx();
  if (ctx) ctx.font = textFont(it);
  const maxW = it.autoWidth ? Infinity : Math.max(it.size, it.w - TEXT_PAD * 2);
  const lines: string[] = [];
  let widest = 0;
  for (const para of it.text.split('\n')) {
    if (maxW === Infinity || measure(ctx, para, it.size) <= maxW) {
      lines.push(para);
      widest = Math.max(widest, measure(ctx, para, it.size));
      continue;
    }
    let cur = '';
    let lastSpace = -1;
    for (const ch of Array.from(para)) {
      const next = cur + ch;
      if (measure(ctx, next, it.size) > maxW && cur !== '') {
        if (ch !== ' ' && lastSpace > 0) {
          lines.push(cur.slice(0, lastSpace));
          cur = cur.slice(lastSpace + 1) + ch;
        } else {
          lines.push(cur);
          cur = ch === ' ' ? '' : ch;
        }
        lastSpace = -1;
      } else {
        cur = next;
      }
      if (ch === ' ') lastSpace = cur.length - 1;
    }
    lines.push(cur);
  }
  for (const l of lines) widest = Math.max(widest, measure(ctx, l, it.size));
  const lh = it.size * LINE_HEIGHT;
  return { lines, width: widest + TEXT_PAD * 2, height: Math.max(1, lines.length) * lh + TEXT_PAD * 2 };
}

/** Box size of a text item after an edit (auto width follows the text). */
/** Width of `s` in the item's font (page units). */
export function textWidth(it: Pick<TextItem, 'bold' | 'italic' | 'size' | 'font'>, s: string): number {
  const ctx = mctx();
  if (ctx) ctx.font = textFont(it);
  return measure(ctx, s, it.size);
}

export function fitTextBox(it: TextItem): TextItem {
  const L = layoutText(it);
  // an empty box keeps room to type into; a text is exactly as wide as it is (tight selection)
  const w = it.autoWidth ? (it.text.trim() ? L.width : Math.max(it.size * 2, L.width)) : it.w;
  return { ...it, w, h: L.height };
}

function paintText(ctx: CanvasRenderingContext2D, it: TextItem): void {
  if (!it.text) return;
  if (it.font === 'hand') requestGlyphs(it.text);
  const L = layoutText(it, ctx);
  ctx.save();
  ctx.font = textFont(it);
  ctx.fillStyle = it.color;
  ctx.textBaseline = 'alphabetic';
  const lh = it.size * LINE_HEIGHT;
  const innerW = it.w - TEXT_PAD * 2;
  L.lines.forEach((line, i) => {
    const lw = ctx.measureText(line).width;
    const x = it.align === 'center' ? it.x + TEXT_PAD + (innerW - lw) / 2 : it.align === 'right' ? it.x + it.w - TEXT_PAD - lw : it.x + TEXT_PAD;
    const y = it.y + TEXT_PAD + i * lh + it.size * 1.02;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------
// Shapes and images
// ------------------------------------------------------------------------------------------------

/** Arrow head size for a line width (page units). */
export function arrowSize(strokeWidth: number): number {
  return 5 + strokeWidth * 2.5;
}

/** Points of an arrow head at `to`, pointing away from `from`: [left barb, tip, right barb]. */
export function arrowHeadPoints(from: Pt, to: Pt, size: number): [Pt, Pt, Pt] {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const a1 = ang + Math.PI - 0.45;
  const a2 = ang + Math.PI + 0.45;
  return [[to[0] + Math.cos(a1) * size, to[1] + Math.sin(a1) * size], to, [to[0] + Math.cos(a2) * size, to[1] + Math.sin(a2) * size]];
}

function drawHead(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, it: ShapeItem): void {
  const [l, tip, r] = arrowHeadPoints(from, to, arrowSize(it.strokeWidth));
  ctx.beginPath();
  ctx.moveTo(l[0], l[1]);
  ctx.lineTo(tip[0], tip[1]);
  ctx.lineTo(r[0], r[1]);
  if ((it.head ?? 'filled') === 'filled') {
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.setLineDash([]);
    ctx.stroke();
  }
}

export function shapePath(ctx: CanvasRenderingContext2D | Path2D, it: ShapeItem): void {
  const { x, y, w, h } = it;
  if (it.kind === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, 0.01), Math.max(h / 2, 0.01), 0, 0, Math.PI * 2);
    return;
  }
  if (it.kind === 'roundrect') {
    const r = Math.min(w, h) * 0.18;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    return;
  }
  const poly = shapeOutline(it);
  poly.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
}

/** Rotate the context around the item's centre (box items with `rot`). */
function withRotation(ctx: CanvasRenderingContext2D, it: Item, draw: () => void): void {
  if (!it.rot) {
    draw();
    return;
  }
  const [cx, cy] = itemCenter(it);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(it.rot);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}

function paintConnector(ctx: CanvasRenderingContext2D, it: ShapeItem & { a: Pt; b: Pt }): void {
  const ends = arrowEnds(it);
  const tan = arrowTangents(it);
  ctx.beginPath();
  if (it.kind === 'curve' && it.c) {
    ctx.moveTo(it.a[0], it.a[1]);
    ctx.quadraticCurveTo(it.c[0], it.c[1], it.b[0], it.b[1]);
  } else {
    connectorPoints(it).forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  }
  ctx.stroke();
  if (ends.start) drawHead(ctx, tan.start[0], tan.start[1], it);
  if (ends.end) drawHead(ctx, tan.end[0], tan.end[1], it);
}

function paintShape(ctx: CanvasRenderingContext2D, it: ShapeItem): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = it.stroke;
  ctx.fillStyle = it.stroke;
  ctx.lineWidth = it.strokeWidth;
  ctx.setLineDash(lineDashArray(it.dash, it.strokeWidth));
  if (isLine(it)) {
    paintConnector(ctx, it);
    ctx.restore();
    return;
  }
  withRotation(ctx, it, () => {
    ctx.beginPath();
    shapePath(ctx, it);
    if (it.fill) {
      ctx.globalAlpha = it.fillOpacity;
      ctx.fillStyle = it.fill;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.stroke();
    if (it.label?.text) paintLabel(ctx, it);
  });
  ctx.restore();
}

/** Wrapped, centred label inside a box shape (flowchart node text). */
function paintLabel(ctx: CanvasRenderingContext2D, it: ShapeItem): void {
  const lb = it.label as NonNullable<ShapeItem['label']>;
  const inset = it.kind === 'diamond' ? 0.25 : it.kind === 'ellipse' ? 0.15 : 0.06;
  const tmp: TextItem = { id: '', type: 'text', x: 0, y: 0, w: it.w * (1 - inset * 2), h: 0, created: 0, text: lb.text, size: lb.size, color: lb.color, font: lb.font ?? 'sans', bold: false, italic: false, align: 'center', autoWidth: false };
  const L = layoutText(tmp, ctx);
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = textFont(tmp);
  ctx.fillStyle = lb.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const lh = lb.size * LINE_HEIGHT;
  const top = it.y + (it.h - L.lines.length * lh) / 2;
  L.lines.forEach((line, i) => ctx.fillText(line, it.x + it.w / 2, top + i * lh + lb.size * 1.02));
  ctx.restore();
}

function paintImage(ctx: CanvasRenderingContext2D, it: ImageItem): void {
  withRotation(ctx, it, () => {
    const img = getImage(it.src);
    if (!img) {
      ctx.save();
      ctx.fillStyle = 'rgba(128,128,128,0.12)';
      ctx.strokeStyle = 'rgba(128,128,128,0.45)';
      ctx.lineWidth = 0.75;
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeRect(it.x, it.y, it.w, it.h);
      ctx.beginPath();
      ctx.moveTo(it.x, it.y);
      ctx.lineTo(it.x + it.w, it.y + it.h);
      ctx.moveTo(it.x + it.w, it.y);
      ctx.lineTo(it.x, it.y + it.h);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const c = it.crop ?? [0, 0, 1, 1];
    const nw = img.naturalWidth || it.natW;
    const nh = img.naturalHeight || it.natH;
    ctx.drawImage(img, c[0] * nw, c[1] * nh, Math.max(1, c[2] * nw), Math.max(1, c[3] * nh), it.x, it.y, it.w, it.h);
  });
}

/** Items below the ink: images, then shapes (in list order). */
export function paintItemsBelow(ctx: CanvasRenderingContext2D, page: Page, skip?: ReadonlySet<string>): void {
  const items = page.items ?? [];
  for (const it of items) if (it.type === 'image' && !skip?.has(it.id)) paintImage(ctx, it);
  for (const it of items) if (it.type === 'shape' && !skip?.has(it.id)) paintShape(ctx, it);
  for (const it of items) if (it.type === 'mindmap' && !skip?.has(it.id)) paintMindMap(ctx, it);
}

/** Items above the ink: text boxes and formulas. */
export function paintItemsAbove(ctx: CanvasRenderingContext2D, page: Page, skip?: ReadonlySet<string>): void {
  for (const it of page.items ?? []) {
    if (skip?.has(it.id)) continue;
    if (it.type === 'text') withRotation(ctx, it, () => paintText(ctx, it));
    else if (it.type === 'formula') withRotation(ctx, it, () => paintFormula(ctx, it));
  }
}

/** Paint a single item (used for drag previews and AI previews). */
export function paintItem(ctx: CanvasRenderingContext2D, it: Item): void {
  if (it.type === 'image') paintImage(ctx, it);
  else if (it.type === 'shape') paintShape(ctx, it);
  else if (it.type === 'mindmap') paintMindMap(ctx, it);
  else if (it.type === 'formula') withRotation(ctx, it, () => paintFormula(ctx, it));
  else withRotation(ctx, it, () => paintText(ctx, it));
}

// ------------------------------------------------------------------------------------------------
// Pencil grain
// ------------------------------------------------------------------------------------------------

const pencilTiles = new Map<string, HTMLCanvasElement>();

/** Graphite-like fill: the ink colour with per-texel alpha variation (fixed seed). */
export function pencilFill(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | string {
  if (typeof document === 'undefined') return color;
  let tile = pencilTiles.get(color);
  if (!tile) {
    tile = document.createElement('canvas');
    tile.width = tile.height = 64;
    const g = tile.getContext('2d');
    if (!g) return color;
    g.fillStyle = color;
    g.fillRect(0, 0, 64, 64);
    const img = g.getImageData(0, 0, 64, 64);
    let seed = 987654321;
    for (let i = 3; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      const r = (seed % 1000) / 1000;
      img.data[i] = Math.round(255 * (r < 0.18 ? 0.25 + r : 0.62 + 0.38 * r));
    }
    g.putImageData(img, 0, 0);
    pencilTiles.set(color, tile);
  }
  const pat = ctx.createPattern(tile, 'repeat');
  if (!pat) return color;
  if (typeof DOMMatrix !== 'undefined' && pat.setTransform) pat.setTransform(new DOMMatrix().scale(0.35, 0.35));
  return pat;
}
