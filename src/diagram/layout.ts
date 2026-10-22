import { newId } from '../document/model';
import { anchorPoint, fitConnector, resolveConnectors, type Item, type ShapeItem, type ShapeKind, type TextItem } from '../document/items';
import { fitTextBox } from '../rendering/items-paint';
import type { DiagramResult } from '../recognition/types';
import type { MapThemeId } from '../mindmap/model';
import { roughMeasure, wrapText, type Measure } from '../mindmap/layout';

/**
 * Flowchart graph → editable HandNote shapes, laid out locally (layered / "Sugiyama-lite"):
 *  1. ranks = longest path from the sources (back edges of cycles are ignored for ranking);
 *  2. order inside a rank = the rough position the user drew the node at, then two barycentre
 *     sweeps to reduce crossings;
 *  3. node boxes are measured from their text (text is a label of the shape, never a separate
 *     object that could drift off), ranks are spaced by the tallest node;
 *  4. connectors are attached to their shapes, so moving a node keeps the arrows.
 * Colours come from the theme, never from the model.
 */

export interface DiagramTheme {
  font: 'sans' | 'hand';
  text: string;
  size: number;
  line: string;
  lineW: number;
  node: { stroke: string; fill: string };
  decision: { stroke: string; fill: string };
  terminal: { stroke: string; fill: string };
  io: { stroke: string; fill: string };
}

export const DIAGRAM_THEMES: Record<MapThemeId, DiagramTheme> = {
  academic: {
    font: 'sans',
    text: '#1f2933',
    size: 13,
    line: '#4c5a67',
    lineW: 1.4,
    node: { stroke: '#3b6ea5', fill: '#eef3f9' },
    decision: { stroke: '#b0702a', fill: '#fbf2e8' },
    terminal: { stroke: '#2f8079', fill: '#e9f4f3' },
    io: { stroke: '#7d5a96', fill: '#f3eef7' },
  },
  hand: {
    font: 'hand',
    text: '#1e1e1e',
    size: 15,
    line: '#1e1e1e',
    lineW: 1.6,
    node: { stroke: '#1e1e1e', fill: '#ffffff' },
    decision: { stroke: '#1e1e1e', fill: '#fff3bf' },
    terminal: { stroke: '#1e1e1e', fill: '#d3f9d8' },
    io: { stroke: '#1e1e1e', fill: '#e5dbff' },
  },
  minimal: {
    font: 'sans',
    text: '#111827',
    size: 13,
    line: '#6b7280',
    lineW: 1.2,
    node: { stroke: '#374151', fill: '#ffffff' },
    decision: { stroke: '#374151', fill: '#ffffff' },
    terminal: { stroke: '#374151', fill: '#f3f4f6' },
    io: { stroke: '#374151', fill: '#ffffff' },
  },
};

const PARALLELOGRAM = [0.14, 0, 1, 0, 0.86, 1, 0, 1];

interface Placed {
  id: string;
  rank: number;
  order: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface DiagramBuild {
  items: Item[];
  bounds: { x: number; y: number; w: number; h: number };
}

export function layoutDiagram(d: DiagramResult, origin: { x: number; y: number }, themeId: MapThemeId = 'academic', measure: Measure = roughMeasure): DiagramBuild {
  const th = DIAGRAM_THEMES[themeId] ?? DIAGRAM_THEMES.academic;
  const tb = d.direction !== 'LR';
  const ids = d.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  const inc = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of d.edges) {
    if (e.from === e.to) continue;
    out.get(e.from)?.push(e.to);
    inc.get(e.to)?.push(e.from);
  }
  // 1. ranks: DFS longest path, ignoring back edges
  const rank = new Map<string, number>();
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const posOf = (id: string) => d.nodes.find((n) => n.id === id)?.pos ?? [0.5, 0.5];
  const primary = (id: string) => (tb ? posOf(id)[1] : posOf(id)[0]);
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  const roots = [...ids].sort((a, b) => (inc.get(a)?.length ?? 0) - (inc.get(b)?.length ?? 0) || primary(a) - primary(b));
  for (const r of roots) if (!state.has(r)) visit(r);
  const topo: string[] = [];
  const seen = new Set<string>();
  const topoVisit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const p of inc.get(id) ?? []) if (!back.has(`${p}>${id}`)) topoVisit(p);
    topo.push(id);
  };
  for (const id of ids) topoVisit(id);
  for (const id of topo) {
    let r = 0;
    for (const p of inc.get(id) ?? []) if (!back.has(`${p}>${id}`)) r = Math.max(r, (rank.get(p) ?? 0) + 1);
    // isolated nodes keep their drawn row
    if (!(inc.get(id)?.length) && !(out.get(id)?.length)) r = Math.round(primary(id) * Math.max(1, ids.length - 1) * 0.5);
    rank.set(id, r);
  }
  // 2. order inside ranks
  const ranks: string[][] = [];
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    (ranks[r] ??= []).push(id);
  }
  const secondary = (id: string) => (tb ? posOf(id)[0] : posOf(id)[1]);
  for (const r of ranks) r?.sort((a, b) => secondary(a) - secondary(b));
  const orderOf = new Map<string, number>();
  const reindex = () => ranks.forEach((r) => r?.forEach((id, i) => orderOf.set(id, i)));
  reindex();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < ranks.length; i++) {
      const r = ranks[i];
      if (!r) continue;
      const bc = (id: string) => {
        const ps = (inc.get(id) ?? []).filter((p) => (rank.get(p) ?? 0) < i);
        return ps.length ? ps.reduce((a, p) => a + (orderOf.get(p) ?? 0), 0) / ps.length : (orderOf.get(id) ?? 0);
      };
      r.sort((a, b) => bc(a) - bc(b) || secondary(a) - secondary(b));
      reindex();
    }
  }
  // 3. sizes and coordinates
  const node = new Map(d.nodes.map((n) => [n.id, n]));
  const placed = new Map<string, Placed>();
  const m = (s: string) => measure(s, th.size, 400, th.font);
  for (const id of ids) {
    const n = node.get(id)!;
    const lines = wrapText(n.text || ' ', 150, m);
    const tw = Math.max(...lines.map(m), 30);
    let w = Math.max(96, tw + 28);
    let h = Math.max(40, lines.length * th.size * 1.35 + 18);
    if (n.shape === 'diamond') {
      w = Math.max(120, tw * 1.7 + 24);
      h = Math.max(64, h * 1.6);
    } else if (n.shape === 'ellipse') {
      w = tw * 1.3 + 30;
      h = Math.max(44, h * 1.15);
    } else if (n.shape === 'parallelogram') w += 24;
    placed.set(id, { id, rank: rank.get(id) ?? 0, order: orderOf.get(id) ?? 0, w: Math.ceil(w), h: Math.ceil(h), x: 0, y: 0 });
  }
  const gapRank = 56;
  const gapNode = 36;
  let along = 0;
  const rankSpans: { start: number; size: number }[] = [];
  for (const r of ranks) {
    const size = r?.length ? Math.max(...r.map((id) => (tb ? placed.get(id)!.h : placed.get(id)!.w))) : 0;
    rankSpans.push({ start: along, size });
    along += size + gapRank;
  }
  const widths = ranks.map((r) => (r ?? []).reduce((a, id) => a + (tb ? placed.get(id)!.w : placed.get(id)!.h), 0) + Math.max(0, (r?.length ?? 1) - 1) * gapNode);
  const maxW = Math.max(0, ...widths);
  ranks.forEach((r, ri) => {
    if (!r) return;
    let across = (maxW - widths[ri]) / 2;
    for (const id of r) {
      const p = placed.get(id)!;
      const span = rankSpans[ri];
      if (tb) {
        p.x = across;
        p.y = span.start + (span.size - p.h) / 2;
        across += p.w + gapNode;
      } else {
        p.y = across;
        p.x = span.start + (span.size - p.w) / 2;
        across += p.h + gapNode;
      }
    }
  });
  // 4. items
  const now = Date.now();
  const itemId = new Map<string, string>();
  const items: Item[] = [];
  for (const id of ids) {
    const n = node.get(id)!;
    const p = placed.get(id)!;
    const iid = newId('i');
    itemId.set(id, iid);
    const kind: ShapeKind = n.shape === 'parallelogram' ? 'polygon' : n.shape;
    const terminal = n.shape === 'ellipse' || (n.shape === 'roundrect' && (!(inc.get(id)?.length) || !(out.get(id)?.length)));
    const pal = n.shape === 'diamond' ? th.decision : n.shape === 'parallelogram' ? th.io : terminal ? th.terminal : th.node;
    const sh: ShapeItem = {
      id: iid,
      type: 'shape',
      kind,
      x: origin.x + p.x,
      y: origin.y + p.y,
      w: p.w,
      h: p.h,
      created: now,
      stroke: pal.stroke,
      strokeWidth: th.lineW,
      fill: pal.fill,
      fillOpacity: 1,
      label: { text: n.text, size: th.size, color: th.text, font: th.font },
    };
    if (kind === 'diamond') sh.points = [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5];
    if (kind === 'polygon') sh.points = PARALLELOGRAM;
    items.push(sh);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const e of d.edges) {
    const a = itemId.get(e.from);
    const b = itemId.get(e.to);
    if (!a || !b || a === b) continue;
    const A = byId.get(a)!;
    const B = byId.get(b)!;
    const isBack = back.has(`${e.from}>${e.to}`) || (rank.get(e.to) ?? 0) <= (rank.get(e.from) ?? 0);
    let fa: [number, number];
    let ta: [number, number];
    if (isBack) {
      fa = tb ? [1, 0.5] : [0.5, 1];
      ta = tb ? [1, 0.5] : [0.5, 1];
    } else {
      fa = tb ? [0.5, 1] : [1, 0.5];
      ta = tb ? [0.5, 0] : [0, 0.5];
    }
    const pa = anchorPoint(A, fa[0], fa[1]);
    const pb = anchorPoint(B, ta[0], ta[1]);
    const aligned = tb ? Math.abs(pa[0] - pb[0]) < 2 : Math.abs(pa[1] - pb[1]) < 2;
    const conn: ShapeItem = fitConnector({
      id: newId('i'),
      type: 'shape',
      kind: isBack ? 'curve' : aligned ? 'arrow' : 'elbow',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      created: now,
      stroke: th.line,
      strokeWidth: th.lineW,
      fill: null,
      fillOpacity: 1,
      a: pa,
      b: pb,
      ...(isBack ? { c: tb ? [Math.max(pa[0], pb[0]) + 48, (pa[1] + pb[1]) / 2] : [(pa[0] + pb[0]) / 2, Math.max(pa[1], pb[1]) + 48] } : {}),
      arrowEnd: e.arrow !== 'none',
      arrowStart: e.arrow === 'both',
      head: 'filled',
      from: { id: a, ax: fa[0], ay: fa[1] },
      to: { id: b, ax: ta[0], ay: ta[1] },
      ...(e.dashed ? { dash: 'dash' as const } : {}),
      ...(!isBack && !aligned && tb ? { vfirst: true } : {}),
    });
    items.push(conn);
    if (e.label) {
      // beside the last leg of the arrow, never on top of a line
      const vf = !isBack && !aligned && tb;
      const mx = vf ? pb[0] : (pa[0] + pb[0]) / 2;
      const my = vf ? (pa[1] + pb[1]) / 2 + (pb[1] - pa[1]) / 4 : (pa[1] + pb[1]) / 2;
      const lab: TextItem = fitTextBox({ id: newId('i'), type: 'text', x: mx + 4, y: my - th.size * 0.7, w: 10, h: 10, created: now, text: e.label.slice(0, 80), size: th.size * 0.85, color: th.line, font: th.font, bold: false, italic: false, align: 'left', autoWidth: true });
      items.push(lab);
    }
  }
  const resolved = resolveConnectors(items);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of resolved) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w);
    y1 = Math.max(y1, it.y + it.h);
  }
  return { items: resolved, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** Selected flowchart shapes + attached connectors → Mermaid `flowchart` source. */
export function itemsToMermaid(items: Item[], direction: 'TD' | 'LR' = 'TD'): string {
  const nodes = items.filter((i): i is ShapeItem => i.type === 'shape' && !i.a);
  const ids = new Map(nodes.map((n, i) => [n.id, `N${i + 1}`]));
  const esc = (s: string) => s.replace(/["\n]/g, ' ').replace(/[[\]{}()<>|]/g, ' ').trim() || ' ';
  const lines = [`flowchart ${direction}`];
  for (const n of nodes) {
    const id = ids.get(n.id) as string;
    const label = esc(n.label?.text ?? '');
    const open = n.kind === 'diamond' ? `{"${label}"}` : n.kind === 'ellipse' ? `(["${label}"])` : n.kind === 'roundrect' ? `("${label}")` : n.kind === 'polygon' ? `[/"${label}"/]` : `["${label}"]`;
    lines.push(`  ${id}${open}`);
  }
  // edge labels: the closest text item to the connector midpoint
  const texts = items.filter((i): i is TextItem => i.type === 'text');
  for (const c of items) {
    if (c.type !== 'shape' || !c.a || !c.b || !c.from || !c.to) continue;
    const a = ids.get(c.from.id);
    const b = ids.get(c.to.id);
    if (!a || !b) continue;
    const mx = (c.a[0] + c.b[0]) / 2;
    const my = (c.a[1] + c.b[1]) / 2;
    const lab = texts.find((t) => Math.hypot(t.x - mx, t.y + t.h / 2 - my) < 40);
    const arrow = c.dash ? '-.->' : c.arrowEnd === false ? '---' : '-->';
    lines.push(`  ${a} ${arrow}${lab ? `|${esc(lab.text)}|` : ''} ${b}`);
  }
  return lines.join('\n');
}
