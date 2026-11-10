import type { StrokeAnchor } from '../document/model';

/**
 * Ink on Markdown (0.12): which line of the note a stroke belongs to.
 *
 * While the note is open, the editor maps the anchor's position through every edit (CodeMirror
 * ChangeSet.mapPos), so typing above a stroke moves it down with its line. When the note was
 * changed while it was closed (another device, another app), the line is found again by its
 * number and the start of its text. If it cannot be found, the stroke stays where it was — it is
 * never dropped.
 */

/** How much of the line's text identifies it. */
export const ANCHOR_TEXT_LEN = 48;

export function anchorText(line: string): string {
  return line.trim().slice(0, ANCHOR_TEXT_LEN);
}

/** The part of a CodeMirror `Text` the anchors need (1-based lines). */
export interface DocLines {
  readonly lines: number;
  line(n: number): { from: number; text: string };
}

/** Furthest a moved line is searched for, in lines each way. */
const SEARCH_LINES = 4000;

/** Line number where the anchor's line is now (1-based). */
export function relocateLine(a: StrokeAnchor, doc: DocLines): number {
  const n = Math.min(doc.lines, Math.max(1, Math.round(a.line)));
  if (!a.text) return n;
  if (anchorText(doc.line(n).text) === a.text) return n;
  // nearest line with the same text: the line moved (lines added or removed above it)
  for (let d = 1; d <= SEARCH_LINES; d++) {
    const up = n - d;
    const down = n + d;
    if (up < 1 && down > doc.lines) break;
    if (up >= 1 && anchorText(doc.line(up).text) === a.text) return up;
    if (down <= doc.lines && anchorText(doc.line(down).text) === a.text) return down;
  }
  return n;
}

/**
 * The line to anchor a stroke to: the line at its vertical centre, or the nearest line with text
 * within a few lines (empty lines are not recognisable after edits).
 */
export function pickAnchorLine(centerLine: number, doc: DocLines, reach = 3): number {
  const n = Math.min(doc.lines, Math.max(1, centerLine));
  if (anchorText(doc.line(n).text)) return n;
  for (let d = 1; d <= reach; d++) {
    if (n - d >= 1 && anchorText(doc.line(n - d).text)) return n - d;
    if (n + d <= doc.lines && anchorText(doc.line(n + d).text)) return n + d;
  }
  return n;
}

/** Bounding box of a stroke's samples widened by its half width (document px). */
export function sampleBounds(samples: readonly { x: number; y: number }[], width: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of samples) {
    if (s.x < x0) x0 = s.x;
    if (s.y < y0) y0 = s.y;
    if (s.x > x1) x1 = s.x;
    if (s.y > y1) y1 = s.y;
  }
  const r = width / 2 + 2;
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}
