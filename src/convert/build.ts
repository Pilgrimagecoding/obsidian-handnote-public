import { newId, type Stroke } from '../document/model';
import type { FormulaItem, MindMapItem, TextItem } from '../document/items';
import { fitTextBox, textWidth } from '../rendering/items-paint';
import { formulaBoxSize, type FormulaDrawing } from '../rendering/formula';
import { dominantColor, segmentLines, strokeBox } from '../recognition/ink-analysis';
import type { InkLine, MindTreeNode, TextLineResult } from '../recognition/types';
import { fromTree, type MapLayoutId, type MapThemeId, type MindNode } from '../mindmap/model';
import { fitMindMap, mapLayout } from '../mindmap/paint';

/**
 * Recognition result → new document items (pure: nothing is written here). Positions come from the
 * local ink analysis, never from the model:
 *  - text: one text box per handwritten line, at the line's position, in the writer's ink colour,
 *    sized from the handwriting; if the model returned a different number of lines, the lines are
 *    stacked from the top-left of the selection instead;
 *  - formula: one formula at the selection, sized like the handwriting;
 *  - mind map: one map item, laid out locally, scaled to roughly the selection's size.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inkLines(strokes: Stroke[]): InkLine[] {
  return segmentLines(strokes.filter((s) => s.tool !== 'highlighter' && s.samples.length).map(strokeBox));
}

/** Font size that matches handwriting of this line height (CJK glyphs fill ~80 % of a line band). */
export function sizeForLine(h: number): number {
  return Math.round(Math.min(96, Math.max(9, h * 0.72)) * 2) / 2;
}

export interface TextBuildOpts {
  font: TextItem['font'];
  color: string;
  /** Where to put the result: on top of the ink (`dx = 0`) or offset next to it. */
  dx: number;
  dy: number;
}

export function buildTextItems(lines: TextLineResult[], ink: InkLine[], bounds: Box, opts: TextBuildOpts): TextItem[] {
  const now = Date.now();
  const texts = lines.map((l) => l.text).filter((s) => s.trim());
  if (!texts.length) return [];
  const sizes = ink.map((l) => sizeForLine(l.h));
  const median = sizes.length ? [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : sizeForLine(Math.min(bounds.h, 40));
  const mk = (text: string, x: number, y: number, size: number): TextItem =>
    fitTextBox({ id: newId('i'), type: 'text', x: x + opts.dx, y: y + opts.dy, w: size * 2, h: size, created: now, text, size, color: opts.color, font: opts.font, bold: false, italic: false, align: 'left', autoWidth: true });
  if (ink.length === texts.length) {
    // line by line, where it was written; a single size for the block keeps it tidy
    const size = median;
    return texts.map((t, i) => {
      const l = ink[i];
      return mk(t, l.x - 4, l.y + l.h / 2 - (size * 1.35) / 2 - 4, size);
    });
  }
  const out: TextItem[] = [];
  let y = bounds.y;
  for (const t of texts) {
    const it = mk(t, bounds.x - 4, y, median);
    out.push(it);
    y += it.h;
  }
  return out;
}

/**
 * The converted text as ONE text box (what the lasso picked is one unit: a tap edits all of it,
 * the text tool selects all of it): one line per handwritten line, starting where the first line
 * was written, at the handwriting's size.
 */
export function buildTextBlock(lines: TextLineResult[], ink: InkLine[], bounds: Box, opts: TextBuildOpts): TextItem | null {
  const texts = lines.map((l) => l.text.trim()).filter(Boolean);
  if (!texts.length) return null;
  // size: each line about as wide as it was written (the height alone is misleading for English
  // handwriting — ascenders, descenders, loose letters: "Today is Saturday" came out half again
  // as wide as the ink on the iPad)
  const style = { font: opts.font, bold: false, italic: false };
  const fitted = texts.map((t, i) => {
    const l = ink.length === texts.length ? ink[i] : null;
    const s = sizeForLine(l ? l.h : Math.min(bounds.h / texts.length, 40));
    const width = l ? textWidth({ ...style, size: s }, t) : 0;
    // as wide as written; within 0.5–1.3× the size the height suggests (a word written very
    // loosely does not become huge, a cramped one not tiny)
    return l && width > 0 && l.w > 0 ? Math.max(s * 0.5, Math.min(s * 1.3, (s * l.w) / width)) : s;
  });
  const size = Math.round([...fitted].sort((a, b) => a - b)[Math.floor(fitted.length / 2)] * 2) / 2;
  const x = ink.length ? Math.min(...ink.map((l) => l.x)) - 4 : bounds.x - 4;
  const y = ink.length ? ink[0].y + ink[0].h / 2 - (size * 1.35) / 2 - 4 : bounds.y;
  return fitTextBox({ id: newId('i'), type: 'text', x: x + opts.dx, y: y + opts.dy, w: size * 2, h: size, created: Date.now(), text: texts.join('\n'), size, color: opts.color, font: opts.font, bold: false, italic: false, align: 'left', autoWidth: true });
}

export function inkColor(strokes: Stroke[], fallback: string): string {
  return dominantColor(strokes, fallback);
}

export function buildFormulaItem(latex: string, drawing: FormulaDrawing, bounds: Box, color: string, dx: number, dy: number): FormulaItem {
  // match the handwriting height, within reason
  const size = Math.min(72, Math.max(12, (bounds.h / Math.max(drawing.h + 0.5, 1)) * 0.9));
  const box = formulaBoxSize(drawing, size);
  return { id: newId('i'), type: 'formula', latex, color, size, x: bounds.x + dx, y: bounds.y + bounds.h / 2 - box.h / 2 + dy, w: box.w, h: box.h, created: Date.now() };
}

export function buildMindMapItem(tree: MindTreeNode | MindNode, bounds: Box, theme: MapThemeId, layout: MapLayoutId, dx: number, dy: number, page: { width: number; height: number }): MindMapItem {
  const root = 'id' in tree ? (tree) : fromTree(tree);
  const proto: MindMapItem = { id: newId('i'), type: 'mindmap', root, theme, layout, scale: 1, x: 0, y: 0, w: 0, h: 0, created: Date.now() };
  const l = mapLayout(proto);
  // readable but not huge: the selection's size, never below 60 % or above 140 % of natural size,
  // and never wider than the page
  const fit = Math.min(bounds.w / l.bounds.w, bounds.h / l.bounds.h);
  let scale = Math.min(1.4, Math.max(0.6, fit));
  scale = Math.min(scale, (page.width - 24) / l.bounds.w, (page.height - 24) / l.bounds.h);
  scale = Math.max(0.3, scale);
  const it = fitMindMap({ ...proto, scale });
  const x = Math.min(Math.max(12, bounds.x + dx), Math.max(12, page.width - it.w - 12));
  const y = Math.min(Math.max(12, bounds.y + dy), Math.max(12, page.height - it.h - 12));
  return { ...it, x, y };
}

/**
 * Free place for a converted result next to the selection (keep-ink mode): right, below, left,
 * above, then further down the page — the first spot inside the page that overlaps neither the
 * selection nor anything else on the page. Falls back to the plain beside offset.
 */
export function freeSpotOffset(src: Box, result: Box, page: { width: number; height: number }, occupied: Box[]): { dx: number; dy: number } {
  const gap = 16;
  const inside = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= page.width && b.y + b.h <= page.height;
  const at = (x: number, y: number): Box => ({ x, y, w: result.w, h: result.h });
  const cands: Box[] = [
    at(src.x + src.w + gap, src.y),
    at(src.x, src.y + src.h + gap),
    at(src.x - gap - result.w, src.y),
    at(src.x, src.y - gap - result.h),
  ];
  for (let y = src.y + src.h + gap; y + result.h <= page.height; y += 24) cands.push(at(Math.min(Math.max(8, src.x), Math.max(8, page.width - result.w - 8)), y));
  for (let y = 8; y + result.h <= page.height; y += 24) cands.push(at(Math.max(8, page.width - result.w - 8), y));
  const all = [...occupied, src];
  for (const c of cands) {
    if (inside(c) && !all.some((o) => c.x < o.x + o.w + 4 && o.x < c.x + c.w + 4 && c.y < o.y + o.h + 4 && o.y < c.y + c.h + 4)) return { dx: c.x - result.x, dy: c.y - result.y };
  }
  const b = besideOffset(src, result, page);
  return { dx: src.x + b.dx - result.x, dy: src.y + b.dy - result.y };
}

/** Offset that places a converted result next to the selection (keep-ink mode). */
export function besideOffset(src: Box, result: { w: number; h: number }, page: { width: number; height: number }): { dx: number; dy: number } {
  const gap = 16;
  if (src.x + src.w + gap + result.w <= page.width) return { dx: src.w + gap, dy: 0 };
  if (src.y + src.h + gap + result.h <= page.height) return { dx: 0, dy: src.h + gap };
  return { dx: 0, dy: 0 };
}
