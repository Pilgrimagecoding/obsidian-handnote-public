import type { MapLayoutId, MapThemeId, MindNode } from './model';
import { levelStyle, themeOf, tintColor, type LevelStyle, type MapTheme, type TopicShape } from './theme';

/**
 * Deterministic mind map layout (no model coordinates). Tidy horizontal tree:
 *  - every topic is measured from its text (wrapped at the theme's max width), so a box always
 *    contains its text and nothing overlaps;
 *  - a subtree occupies a vertical band = max(own height, sum of child bands + gaps); siblings are
 *    stacked inside the parent's band and centred on it;
 *  - "balanced" splits the root's topics into a right and a left side with the most even height
 *    (clockwise order, like Xmind); "right" puts everything on the right.
 * Units are layout units at scale 1 (the page item applies its own scale).
 */

export type Measure = (text: string, size: number, weight: number, font: 'sans' | 'hand') => number;

export interface LNode {
  id: string;
  depth: number;
  /** Index of the level-1 branch (-1 for the root). */
  branch: number;
  side: 1 | -1 | 0;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  style: LevelStyle;
  shape: TopicShape;
  color: string;
  fill: string | null;
  stroke: string | null;
  textColor: string;
  /** Hidden descendants (collapsed). */
  hidden: number;
  hasChildren: boolean;
}

export interface LEdge {
  from: string;
  to: string;
  color: string;
  width: number;
  /** curve: [a, c1, c2, b]; elbow: polyline */
  pts: [number, number][];
  kind: 'curve' | 'elbow';
}

export interface MapLayout {
  nodes: LNode[];
  edges: LEdge[];
  bounds: { x: number; y: number; w: number; h: number };
  theme: MapTheme;
  byId: Map<string, LNode>;
}

const LINE_H = 1.3;
const BADGE_R = 8;

/** Fallback measure (Node / tests): ~0.55 em per Latin char, 1 em per CJK char. */
export const roughMeasure: Measure = (t, size, weight) => {
  let w = 0;
  for (const ch of t) w += /[⺀-鿿가-힯＀-￯]/.test(ch) ? 1 : ch === ' ' ? 0.3 : 0.56;
  return w * size * (weight >= 600 ? 1.05 : 1);
};

export function wrapText(text: string, maxW: number, m: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of (text || ' ').split('\n')) {
    if (m(para) <= maxW) {
      out.push(para);
      continue;
    }
    let cur = '';
    let lastSpace = -1;
    for (const ch of Array.from(para)) {
      const next = cur + ch;
      if (m(next) > maxW && cur !== '') {
        if (ch !== ' ' && lastSpace > 0) {
          out.push(cur.slice(0, lastSpace));
          cur = cur.slice(lastSpace + 1) + ch;
        } else {
          out.push(cur);
          cur = ch === ' ' ? '' : ch;
        }
        lastSpace = -1;
      } else cur = next;
      if (ch === ' ') lastSpace = cur.length - 1;
    }
    out.push(cur);
  }
  return out.slice(0, 12);
}

function countAll(n: MindNode): number {
  return n.children.reduce((a, c) => a + 1 + countAll(c), 0);
}

export function layoutMindMap(root: MindNode, themeId: MapThemeId, layoutId: MapLayoutId, measure: Measure = roughMeasure): MapLayout {
  const theme = themeOf(themeId);
  const nodes: LNode[] = [];
  const edges: LEdge[] = [];
  const byId = new Map<string, LNode>();
  const sub = new Map<string, number>();

  const make = (n: MindNode, depth: number, branch: number): LNode => {
    const st = levelStyle(theme, depth);
    const m = (s: string) => measure(s, st.size, st.weight, theme.font);
    const lines = wrapText(n.text.trim() || ' ', st.maxW, m);
    const tw = Math.max(...lines.map(m), st.size * 1.5);
    const color = depth === 0 ? theme.rootStroke : theme.palette[(branch < 0 ? 0 : branch) % theme.palette.length];
    let fill: string | null = null;
    let stroke: string | null = null;
    let textColor = depth >= 2 ? theme.subText : theme.text;
    if (depth === 0) {
      fill = theme.rootFill;
      stroke = theme.rootStroke;
      textColor = theme.rootText;
    } else if (st.shape === 'box' || st.shape === 'pill') {
      fill = theme.tint > 0 ? tintColor(color, theme.tint) : '#ffffff';
      stroke = color;
    } else if (st.shape === 'underline') {
      stroke = color;
    }
    const ln: LNode = {
      id: n.id,
      depth,
      branch,
      side: 0,
      x: 0,
      y: 0,
      w: Math.ceil(tw + st.padX * 2),
      h: Math.ceil(lines.length * st.size * LINE_H + st.padY * 2),
      lines,
      style: st,
      shape: depth === 0 && st.shape === 'underline' ? 'box' : st.shape,
      color,
      fill,
      stroke,
      textColor,
      hidden: n.collapsed ? countAll(n) : 0,
      hasChildren: n.children.length > 0,
    };
    byId.set(n.id, ln);
    nodes.push(ln);
    return ln;
  };

  const kids = (n: MindNode) => (n.collapsed ? [] : n.children);

  // measure pass + subtree band heights
  const measurePass = (n: MindNode, depth: number, branch: number): number => {
    const ln = make(n, depth, branch);
    const cs = kids(n);
    let total = 0;
    cs.forEach((c, i) => {
      total += measurePass(c, depth + 1, depth === 0 ? i : branch) + (i ? theme.vGap * (depth === 0 ? 1.6 : 1) : 0);
    });
    const band = Math.max(ln.h + (ln.hidden ? 4 : 0), total);
    sub.set(n.id, band);
    return band;
  };
  measurePass(root, 0, -1);

  const anchor = (ln: LNode, side: 1 | -1, outgoing: boolean): [number, number] => {
    // outgoing: edge leaves this node towards `side`; else it enters from the side opposite
    const x = outgoing ? (side === 1 ? ln.x + ln.w : ln.x) : side === 1 ? ln.x : ln.x + ln.w;
    const y = ln.shape === 'underline' || ln.shape === 'plain' ? (ln.shape === 'underline' ? ln.y + ln.h : ln.y + ln.h / 2) : ln.y + ln.h / 2;
    return [x, y];
  };

  const edgeW = (depth: number) => {
    const [a, b] = theme.edgeW;
    return Math.max(b, a - (depth - 1) * ((a - b) / 3));
  };

  const place = (n: MindNode, edgeX: number, cy: number, side: 1 | -1) => {
    const ln = byId.get(n.id) as LNode;
    ln.side = side;
    ln.x = side === 1 ? edgeX : edgeX - ln.w;
    ln.y = cy - ln.h / 2;
    placeChildren(n, ln, side, kids(n));
  };

  const placeChildren = (n: MindNode, ln: LNode, side: 1 | -1, cs: MindNode[]) => {
    if (!cs.length) return;
    const gap = theme.vGap * (ln.depth === 0 ? 1.6 : 1);
    const total = cs.reduce((a, c) => a + (sub.get(c.id) as number), 0) + gap * (cs.length - 1);
    let y = ln.y + ln.h / 2 - total / 2;
    const childEdge = side === 1 ? ln.x + ln.w + theme.hGap * (ln.depth === 0 ? 1.25 : 1) : ln.x - theme.hGap * (ln.depth === 0 ? 1.25 : 1);
    for (const c of cs) {
      const band = sub.get(c.id) as number;
      place(c, childEdge, y + band / 2, side);
      y += band + gap;
      const cl = byId.get(c.id) as LNode;
      const a = ln.depth === 0 ? ([side === 1 ? ln.x + ln.w : ln.x, ln.y + ln.h / 2] as [number, number]) : anchor(ln, side, true);
      const b = anchor(cl, side, false);
      const color = theme.edgeColor ?? cl.color;
      const width = edgeW(cl.depth);
      if (theme.edge === 'elbow') {
        const mx = a[0] + (b[0] - a[0]) * 0.5;
        edges.push({ from: n.id, to: c.id, color, width, kind: 'elbow', pts: [a, [mx, a[1]], [mx, b[1]], b] });
      } else {
        const dx = b[0] - a[0];
        edges.push({ from: n.id, to: c.id, color, width, kind: 'curve', pts: [a, [a[0] + dx * 0.55, a[1]], [b[0] - dx * 0.45, b[1]], b] });
      }
    }
  };

  // root
  const r = byId.get(root.id) as LNode;
  r.x = -r.w / 2;
  r.y = -r.h / 2;
  const cs = kids(root);
  if (layoutId === 'right' || cs.length < 2) {
    placeChildren(root, r, 1, cs);
  } else {
    // most even split of the clockwise order: right = first k (top→bottom), left = rest (bottom→top)
    const hs = cs.map((c) => sub.get(c.id) as number);
    const all = hs.reduce((a, b) => a + b, 0);
    let best = 1;
    let bestD = Infinity;
    let acc = 0;
    for (let k = 1; k < cs.length; k++) {
      acc += hs[k - 1];
      const d = Math.abs(acc - (all - acc));
      if (d < bestD - 1e-6) {
        bestD = d;
        best = k;
      }
    }
    best = Math.max(best, Math.ceil(cs.length / 2) - (cs.length > 3 ? 1 : 0));
    best = Math.min(best, cs.length - 1);
    placeChildren(root, r, 1, cs.slice(0, best));
    placeChildren(root, r, -1, cs.slice(best).reverse());
  }

  // bounds of the visible topics (collapsed subtrees were measured but not placed); badges included
  const pad = 6;
  const placed = new Set<string>([root.id]);
  const mark = (n: MindNode) => {
    for (const c of kids(n)) {
      placed.add(c.id);
      mark(c);
    }
  };
  mark(root);
  const visible = nodes.filter((n) => placed.has(n.id));
  for (const id of [...byId.keys()]) if (!placed.has(id)) byId.delete(id);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of visible) {
    const bx = n.hidden ? BADGE_R * 2 + 4 : 0;
    x0 = Math.min(x0, n.x - (n.side === -1 ? bx : 0));
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w + (n.side !== -1 ? bx : 0));
    y1 = Math.max(y1, n.y + n.h);
  }
  return { nodes: visible, edges, bounds: { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }, theme, byId };
}

export const MAP_BADGE_R = BADGE_R;

/** Overlap check (tests / diagnostics): pairs of topic boxes that intersect. */
export function overlaps(l: MapLayout): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < l.nodes.length; i++) {
    for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i];
      const b = l.nodes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push([a.id, b.id]);
    }
  }
  return out;
}
