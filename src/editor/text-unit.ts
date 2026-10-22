import { newId } from '../document/model';
import type { Item, TextItem } from '../document/items';
import { fitTextBox, LINE_HEIGHT, TEXT_PAD, textWidth } from '../rendering/items-paint';

/**
 * Text pieces that belong together (a converted sentence whose word was lassoed out and put back,
 * then grouped) read as ONE text: the text tool, a finger tap and a lasso tap edit all of it.
 *
 * `textUnit` = the text boxes of the item's group (unrotated text only), or null when the item
 * stands alone. `mergeTextPieces` joins them in reading order: physical lines are clustered by
 * height, pieces of a line sorted left to right, a space put back where the pieces had a gap.
 */

export function textUnit(items: Item[], id: string): TextItem[] | null {
  const it = items.find((i) => i.id === id);
  if (!it || it.type !== 'text' || !it.g) return null;
  const g = it.g;
  const members = items.filter((i): i is TextItem => i.type === 'text' && i.g === g && !i.rot);
  return members.length > 1 ? members : null;
}

interface Seg {
  x: number;
  y: number;
  text: string;
  item: TextItem;
}

export function mergeTextPieces(members: TextItem[]): TextItem {
  const segs: Seg[] = [];
  for (const m of members) {
    const lh = m.size * LINE_HEIGHT;
    m.text.split('\n').forEach((text, k) => segs.push({ x: m.x, y: m.y + k * lh, text, item: m }));
  }
  segs.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Seg[][] = [];
  for (const s of segs) {
    const row = rows[rows.length - 1];
    const tol = s.item.size * LINE_HEIGHT * 0.5;
    if (row && Math.abs(row[0].y - s.y) < tol) row.push(s);
    else rows.push([s]);
  }
  const lines = rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let out = '';
    let end = -Infinity;
    for (const s of row) {
      const gap = s.x + TEXT_PAD - end;
      if (out && !/\s$/.test(out) && !/^\s/.test(s.text) && gap > s.item.size * 0.25) out += ' ';
      out += s.text;
      end = s.x + TEXT_PAD + textWidth(s.item, s.text);
    }
    return out;
  });
  // the style of the first piece in reading order (top-left)
  const first = segs[0].item;
  const x = Math.min(...members.map((m) => m.x));
  const y = Math.min(...members.map((m) => m.y));
  return fitTextBox({ ...first, id: newId('i'), x, y, text: lines.join('\n'), autoWidth: true, align: 'left', created: Date.now() });
}
