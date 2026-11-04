import { itemBounds, moveItem } from './items';
import { quantizeGeometry } from '../ink/stroke-builder';
import { createDocument, defaultBackground, newId, type Board, type BoardFrame, type HandNoteDocument, type Page, type PageBackground, type Stroke } from './model';

/**
 * Infinite whiteboards (format v7). A whiteboard is a document with exactly one page that carries
 * `board`; its coordinates are unbounded (negative values allowed). Converted pages become frames,
 * laid out left to right with their tops aligned.
 */

/** Gap between frames when a note with pages is converted (page units). */
export const FRAME_GAP = 40;
/** Margin around the content bounds for exports, embeds and thumbnails. */
export const BOARD_MARGIN = 24;
/** Size of an empty whiteboard's bounds (what an empty board's thumbnail shows). */
const EMPTY_W = 595;
const EMPTY_H = 842;

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function isBoard(doc: HandNoteDocument): boolean {
  return doc.pages.length === 1 && !!doc.pages[0].board;
}

export function isBoardPage(page: Page | undefined | null): page is Page & { board: Board } {
  return !!page?.board;
}

/** Default texture of a new whiteboard: dots on white. */
export function defaultBoardBackground(): PageBackground {
  return defaultBackground('dots');
}

export function createBoardPage(background: PageBackground = defaultBoardBackground()): Page {
  return { id: newId('p'), width: EMPTY_W, height: EMPTY_H, background: { ...background }, board: { origin: [0, 0], frames: [] }, strokes: [], items: [] };
}

export function createBoardDocument(opts: { device?: string; background?: PageBackground } = {}): HandNoteDocument {
  const doc = createDocument({ device: opts.device });
  doc.pages = [createBoardPage(opts.background)];
  return doc;
}

export function strokeBounds(s: Stroke): Bounds | null {
  if (!s.samples.length) return null;
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
  const r = (s.params.width || 1) / 2 + 1;
  return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
}

function grow(b: Bounds | null, o: Bounds): Bounds {
  if (!b) return { ...o };
  const x1 = Math.max(b.x + b.w, o.x + o.w);
  const y1 = Math.max(b.y + b.h, o.y + o.h);
  const x = Math.min(b.x, o.x);
  const y = Math.min(b.y, o.y);
  return { x, y, w: x1 - x, h: y1 - y };
}

export function frameBounds(f: BoardFrame): Bounds {
  return { x: f.x, y: f.y, w: f.width, h: f.height };
}

/** Bounds of everything on a whiteboard (frames, strokes, items); null when it is empty. */
export function contentBounds(page: Page, strokeBox: (s: Stroke) => Bounds | null = strokeBounds): Bounds | null {
  let b: Bounds | null = null;
  for (const f of page.board?.frames ?? []) b = grow(b, frameBounds(f));
  for (const s of page.strokes) {
    const sb = strokeBox(s);
    if (sb) b = grow(b, sb);
  }
  for (const it of page.items ?? []) b = grow(b, itemBounds(it));
  return b;
}

/** Content bounds (or the empty-board default), rounded outwards to whole units. */
export function boardExtent(page: Page, strokeBox?: (s: Stroke) => Bounds | null): Bounds {
  const b = contentBounds(page, strokeBox);
  if (!b) return { x: 0, y: 0, w: EMPTY_W, h: EMPTY_H };
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
}

/** Store the content bounds in `origin` + `width/height` (for embeds, exports and old readers). */
export function updateBoardExtent(page: Page, strokeBox?: (s: Stroke) => Bounds | null): void {
  if (!page.board) return;
  const e = boardExtent(page, strokeBox);
  page.board.origin = [e.x, e.y];
  page.width = e.w;
  page.height = e.h;
}

function translateStroke(s: Stroke, dx: number, dy: number): Stroke {
  if (!dx && !dy) return s;
  const out: Stroke = { ...s, samples: s.samples.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  if (s.geom) out.geom = quantizeGeometry({ xs: s.geom.xs.map((x) => x + dx), ys: s.geom.ys.map((y) => y + dy), rs: s.geom.rs });
  return out;
}

/**
 * The whiteboard page a note with pages becomes: page i is a frame at the right of page i − 1
 * (tops aligned, FRAME_GAP apart) and its strokes and items move with it. The input pages are not
 * changed (undo puts them back as they were).
 */
export function convertPagesToBoard(pages: Page[], background: PageBackground = defaultBoardBackground()): Page {
  const board = createBoardPage(background);
  let x = 0;
  for (const p of pages) {
    const frame: BoardFrame = { id: newId('f'), x, y: 0, width: p.width, height: p.height, background: { ...p.background }, ...(p.doc ? { doc: { ...p.doc } } : {}) };
    board.board!.frames.push(frame);
    for (const s of p.strokes) board.strokes.push(translateStroke(s, x, 0));
    for (const it of p.items ?? []) board.items.push(moveItem(it, x, 0, true));
    x += p.width + FRAME_GAP;
  }
  updateBoardExtent(board);
  return board;
}

/** Ids of the frames, in board order (left to right, then top to bottom). */
export function framesInOrder(page: Page): BoardFrame[] {
  return [...(page.board?.frames ?? [])].sort((a, b) => a.x - b.x || a.y - b.y);
}
