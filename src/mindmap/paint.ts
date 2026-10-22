import type { MindMapItem } from '../document/items';
import { fontFamily, requestGlyphs } from '../rendering/items-paint';
import { layoutMindMap, MAP_BADGE_R, roughMeasure, type LNode, type MapLayout, type Measure } from './layout';
import type { MindNode } from './model';

/** Canvas text measurer for the layout (falls back to an estimate outside a browser). */
let mctx: CanvasRenderingContext2D | null = null;
export const canvasMeasure: Measure = (t, size, weight, font) => {
  if (!mctx && typeof document !== 'undefined') mctx = document.createElement('canvas').getContext('2d');
  if (!mctx) return roughMeasure(t, size, weight, font);
  mctx.font = topicFont(size, weight, font);
  return mctx.measureText(t).width;
};

export function topicFont(size: number, weight: number, font: 'sans' | 'hand'): string {
  return `${font === 'hand' ? 400 : weight} ${size}px ${fontFamily(font)}`;
}

const cache = new WeakMap<MindNode, Map<string, MapLayout>>();

/** Layout of a map item (cached per tree object — trees are immutable). */
export function mapLayout(it: Pick<MindMapItem, 'root' | 'theme' | 'layout'>): MapLayout {
  let m = cache.get(it.root);
  if (!m) {
    m = new Map();
    cache.set(it.root, m);
  }
  const k = `${it.theme}|${it.layout}`;
  let l = m.get(k);
  if (!l) {
    l = layoutMindMap(it.root, it.theme, it.layout, canvasMeasure);
    m.set(k, l);
  }
  return l;
}

/** Page point of a layout point. */
export function mapToPage(it: MindMapItem, l: MapLayout, x: number, y: number): [number, number] {
  return [it.x + (x - l.bounds.x) * it.scale, it.y + (y - l.bounds.y) * it.scale];
}

export function pageToMap(it: MindMapItem, l: MapLayout, x: number, y: number): [number, number] {
  return [(x - it.x) / it.scale + l.bounds.x, (y - it.y) / it.scale + l.bounds.y];
}

/**
 * Fit the item box to its (new) layout. With `keep`, the topic `keep` (default: the root) stays
 * where it was on the page, so editing never makes the map jump.
 */
export function fitMindMap(next: MindMapItem, prev?: MindMapItem, keep?: string): MindMapItem {
  const l = mapLayout(next);
  let x = next.x;
  let y = next.y;
  if (prev) {
    const pl = mapLayout(prev);
    const id = keep && pl.byId.has(keep) && l.byId.has(keep) ? keep : prev.root.id;
    const a = pl.byId.get(id);
    const b = l.byId.get(id) ?? l.byId.get(next.root.id);
    if (a && b) {
      const [px, py] = mapToPage(prev, pl, a.x, a.y);
      x = px - (b.x - l.bounds.x) * next.scale;
      y = py - (b.y - l.bounds.y) * next.scale;
    }
  }
  return { ...next, x, y, w: l.bounds.w * next.scale, h: l.bounds.h * next.scale };
}

/** Topic under a page point. */
export function mapNodeAt(it: MindMapItem, x: number, y: number, tol = 0): LNode | null {
  const l = mapLayout(it);
  const [lx, ly] = pageToMap(it, l, x, y);
  const t = tol / it.scale;
  let best: LNode | null = null;
  for (const n of l.nodes) {
    if (lx >= n.x - t && lx <= n.x + n.w + t && ly >= n.y - t && ly <= n.y + n.h + t) {
      if (!best || n.depth > best.depth) best = n;
    }
  }
  return best;
}

/** Collapse badge under a page point (returns the topic id). */
export function mapBadgeAt(it: MindMapItem, x: number, y: number, tol = 4): string | null {
  const l = mapLayout(it);
  const [lx, ly] = pageToMap(it, l, x, y);
  for (const n of l.nodes) {
    if (!n.hasChildren || n.depth === 0) continue;
    const [bx, by] = badgePos(n);
    if (Math.hypot(lx - bx, ly - by) <= MAP_BADGE_R + tol / it.scale) return n.id;
  }
  return null;
}

function badgePos(n: LNode): [number, number] {
  const cy = n.shape === 'underline' ? n.y + n.h : n.y + n.h / 2;
  return [n.side === -1 ? n.x - MAP_BADGE_R - 2 : n.x + n.w + MAP_BADGE_R + 2, cy];
}

/** Deterministic wobble for the hand-drawn theme. */
function jitter(seed: string, i: number): number {
  let h = 2166136261;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  h = Math.imul(h ^ i, 2246822519);
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function sketchRect(ctx: CanvasRenderingContext2D, n: LNode, r: number): void {
  // two slightly offset rounded outlines, like Excalidraw's "artist" sloppiness
  for (let pass = 0; pass < 2; pass++) {
    const j = (i: number) => jitter(n.id, i + pass * 10) * 1.6;
    ctx.beginPath();
    roundRect(ctx, n.x + j(1), n.y + j(2), n.w + j(3), n.h + j(4), r);
    ctx.stroke();
  }
}

export interface MapPaintOptions {
  /** Selected topic (editor). */
  selected?: string | null;
  /** Drop target highlight while dragging a topic. */
  dropTarget?: string | null;
  /** Topic being dragged (drawn faded). */
  dragging?: string | null;
}

/** Editor UI state of the one map being edited (selected topic, drag feedback). */
let ui: (MapPaintOptions & { itemId: string }) | null = null;
export function setMapUi(state: (MapPaintOptions & { itemId: string }) | null): void {
  ui = state;
}

export function paintMindMap(ctx: CanvasRenderingContext2D, it: MindMapItem, optsIn?: MapPaintOptions): void {
  const opts: MapPaintOptions = optsIn ?? (ui && ui.itemId === it.id ? ui : {});
  const l = mapLayout(it);
  const t = l.theme;
  ctx.save();
  ctx.translate(it.x, it.y);
  ctx.scale(it.scale, it.scale);
  ctx.translate(-l.bounds.x, -l.bounds.y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // edges below topics
  for (const e of l.edges) {
    ctx.strokeStyle = e.color;
    ctx.lineWidth = e.width;
    ctx.beginPath();
    const p = e.pts;
    if (e.kind === 'curve') {
      const w = t.rough ? (i: number) => jitter(e.to, i) * 2 : () => 0;
      ctx.moveTo(p[0][0], p[0][1]);
      ctx.bezierCurveTo(p[1][0], p[1][1] + w(1), p[2][0], p[2][1] + w(2), p[3][0], p[3][1]);
    } else {
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    }
    ctx.stroke();
  }
  for (const n of l.nodes) {
    const st = n.style;
    ctx.globalAlpha = opts.dragging === n.id ? 0.35 : 1;
    const r = n.shape === 'pill' ? n.h / 2 : Math.min(8, n.h * 0.28);
    if (n.fill || (n.stroke && (n.shape === 'box' || n.shape === 'pill'))) {
      ctx.beginPath();
      roundRect(ctx, n.x, n.y, n.w, n.h, r);
      if (n.fill) {
        ctx.fillStyle = n.fill;
        ctx.fill();
      }
      if (n.stroke) {
        ctx.strokeStyle = n.stroke;
        ctx.lineWidth = n.depth === 0 ? 2 : 1.4;
        if (t.rough) sketchRect(ctx, n, r);
        else ctx.stroke();
      }
    } else if (n.shape === 'underline' && n.stroke) {
      ctx.strokeStyle = n.stroke;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y + n.h);
      ctx.lineTo(n.x + n.w, n.y + n.h);
      ctx.stroke();
    }
    // text
    ctx.fillStyle = n.textColor;
    ctx.font = topicFont(st.size, st.weight, t.font);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    const lh = st.size * 1.3;
    const top = n.y + (n.h - n.lines.length * lh) / 2;
    if (t.font === 'hand') requestGlyphs(n.lines.join(''));
    n.lines.forEach((line, i) => ctx.fillText(line, n.x + n.w / 2, top + i * lh + st.size * 1.0));
    // collapse badge
    if (n.hasChildren && n.depth > 0 && (n.hidden || opts.selected === n.id)) {
      const [bx, by] = badgePos(n);
      ctx.beginPath();
      ctx.arc(bx, by, MAP_BADGE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = n.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = n.color;
      ctx.font = `600 ${n.hidden > 99 ? 7 : 9}px ${fontFamily('sans')}`;
      ctx.textAlign = 'center';
      ctx.fillText(n.hidden ? String(n.hidden) : '−', bx, by + 3.2);
    }
    if (opts.selected === n.id || opts.dropTarget === n.id) {
      ctx.strokeStyle = opts.dropTarget === n.id ? '#2f9e44' : '#4c8bf5';
      ctx.lineWidth = 2 / Math.max(it.scale, 0.3);
      ctx.setLineDash(opts.dropTarget === n.id ? [4, 3] : []);
      ctx.beginPath();
      roundRect(ctx, n.x - 3, n.y - 3, n.w + 6, n.h + 6, r + 3);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}
