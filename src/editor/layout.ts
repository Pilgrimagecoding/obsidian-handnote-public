import type { GeometryCache } from '../document/geometry-cache';
import type { Stroke } from '../document/model';
import { itemBounds, resolveConnectors, isLine, transformItem, type Item } from '../document/items';
import { transformStroke } from './lasso';

/**
 * Local, deterministic layout tools for a lasso selection (no AI, no network): align and
 * distribute "units". A unit is a group, a single item, or one line of handwriting (ungrouped
 * strokes whose vertical extents overlap), so tidying never pulls a word apart.
 */

export type LayoutOp = 'align-left' | 'align-center' | 'align-top' | 'distribute-v' | 'tidy';

interface Unit {
  strokes: Stroke[];
  items: Item[];
  x: number;
  y: number;
  w: number;
  h: number;
}

function strokeBox(s: Stroke, cache: GeometryCache): { x: number; y: number; w: number; h: number } {
  const b = cache.get(s).bbox;
  return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
}

function grow(u: Unit, b: { x: number; y: number; w: number; h: number }): void {
  if (!u.strokes.length && !u.items.length && u.w === 0 && u.h === 0 && u.x === 0 && u.y === 0) {
    Object.assign(u, b);
    return;
  }
  const x1 = Math.max(u.x + u.w, b.x + b.w);
  const y1 = Math.max(u.y + u.h, b.y + b.h);
  u.x = Math.min(u.x, b.x);
  u.y = Math.min(u.y, b.y);
  u.w = x1 - u.x;
  u.h = y1 - u.y;
}

export function buildUnits(strokes: Stroke[], items: Item[], cache: GeometryCache): Unit[] {
  const units: Unit[] = [];
  const groups = new Map<string, Unit>();
  const newUnit = (): Unit => ({ strokes: [], items: [], x: 0, y: 0, w: 0, h: 0 });
  const loose: Stroke[] = [];
  for (const s of strokes) {
    if (s.g) {
      let u = groups.get(s.g);
      if (!u) groups.set(s.g, (u = newUnit()));
      grow(u, strokeBox(s, cache));
      u.strokes.push(s);
    } else loose.push(s);
  }
  for (const it of items) {
    // connectors follow the boxes they are attached to; free connectors are units of their own
    if (isLine(it) && (it.from || it.to)) continue;
    const b = itemBounds(it);
    if (it.g) {
      let u = groups.get(it.g);
      if (!u) groups.set(it.g, (u = newUnit()));
      grow(u, b);
      u.items.push(it);
    } else {
      const u = newUnit();
      grow(u, b);
      u.items.push(it);
      units.push(u);
    }
  }
  units.push(...groups.values());
  // handwriting lines: sort by vertical centre, merge strokes whose extents overlap enough
  const sorted = loose.map((s) => ({ s, b: strokeBox(s, cache) })).sort((a, b) => a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2));
  let line: Unit | null = null;
  for (const { s, b } of sorted) {
    if (line) {
      const ov = Math.min(line.y + line.h, b.y + b.h) - Math.max(line.y, b.y);
      if (ov > Math.min(line.h, b.h) * 0.35) {
        grow(line, b);
        line.strokes.push(s);
        continue;
      }
    }
    line = newUnit();
    grow(line, b);
    line.strokes.push(s);
    units.push(line);
  }
  return units;
}

/**
 * Compute the new strokes / items of a page for a layout operation. Returns null when nothing
 * moves (fewer than two units, already aligned).
 */
export function layoutSelection(op: LayoutOp, page: { strokes: Stroke[]; items: Item[] }, strokes: Stroke[], items: Item[], cache: GeometryCache): { strokes: Stroke[]; items: Item[] } | null {
  const units = buildUnits(strokes, items, cache);
  if (units.length < 2) return null;
  const moves = new Map<Unit, [number, number]>();
  const left = Math.min(...units.map((u) => u.x));
  const top = Math.min(...units.map((u) => u.y));
  const right = Math.max(...units.map((u) => u.x + u.w));
  const cx = (left + right) / 2;
  const doAlign = (kind: 'left' | 'center' | 'top') => {
    for (const u of units) {
      const m = moves.get(u) ?? [0, 0];
      if (kind === 'left') m[0] = left - u.x;
      else if (kind === 'center') m[0] = cx - (u.x + u.w / 2);
      else m[1] = top - u.y;
      moves.set(u, m);
    }
  };
  const distribute = () => {
    if (units.length < 3) return;
    const byY = [...units].sort((a, b) => a.y - b.y);
    const first = byY[0];
    const last = byY[byY.length - 1];
    const total = last.y + last.h - first.y;
    const sumH = byY.reduce((a, u) => a + u.h, 0);
    const gap = Math.max(0, (total - sumH) / (byY.length - 1));
    let y = first.y;
    for (const u of byY) {
      const m = moves.get(u) ?? [0, 0];
      m[1] = y - u.y;
      moves.set(u, m);
      y += u.h + gap;
    }
  };
  if (op === 'align-left') doAlign('left');
  else if (op === 'align-center') doAlign('center');
  else if (op === 'align-top') doAlign('top');
  else if (op === 'distribute-v') distribute();
  else {
    doAlign('left');
    distribute();
  }
  let any = false;
  const sMove = new Map<string, [number, number]>();
  const iMove = new Map<string, [number, number]>();
  for (const [u, m] of moves) {
    if (Math.abs(m[0]) < 0.01 && Math.abs(m[1]) < 0.01) continue;
    any = true;
    for (const s of u.strokes) sMove.set(s.id, m);
    for (const it of u.items) iMove.set(it.id, m);
  }
  if (!any) return null;
  const newStrokes = page.strokes.map((s) => {
    const m = sMove.get(s.id);
    return m ? transformStroke(s, [0, 0], 1, 0, m[0], m[1]) : s;
  });
  const newItems = resolveConnectors(
    page.items.map((it) => {
      const m = iMove.get(it.id);
      return m ? transformItem(it, [0, 0], 1, 0, m[0], m[1], true) : it;
    }),
  );
  return { strokes: newStrokes, items: newItems };
}
