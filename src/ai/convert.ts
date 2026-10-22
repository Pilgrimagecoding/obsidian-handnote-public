import type { GeometryCache } from '../document/geometry-cache';
import { newId, type Stroke } from '../document/model';
import { controlFromMid, fitConnector, nearestAnchor, resolveConnectors, anchorPoint, type Item, type Pt, type ShapeItem, type TextItem } from '../document/items';
import { fitTextBox, paintItem, pencilFill } from '../rendering/items-paint';
import { inkPath } from '../rendering/paint';
import type { BBox, EditableScene } from './scene';
import type { AIImage } from './types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Render exactly the selected strokes and items (nothing else from the page or vault) onto a white
 * image for recognition. Returns the image and the page-space bounds it covers.
 */
export function rasterizeSelection(strokes: Stroke[], items: Item[], bounds: Box, cache: GeometryCache, maxSide = 1536): { image: AIImage; bounds: Box; canvas: HTMLCanvasElement } {
  const pad = Math.max(4, Math.max(bounds.w, bounds.h) * 0.03);
  const b = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  // at least ~3 px per page unit for small selections, at most maxSide on the long side
  const scale = Math.min(maxSide / Math.max(b.w, b.h), Math.max(3, 512 / Math.max(b.w, b.h)));
  const w = Math.max(16, Math.round(b.w * scale));
  const h = Math.max(16, Math.round(b.h * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
  for (const it of items) if (it.type !== 'text') paintItem(ctx, it);
  for (const s of strokes) {
    ctx.globalAlpha = s.tool === 'highlighter' ? Math.min(0.5, s.params.opacity) : 1;
    ctx.fillStyle = s.tool === 'pencil' ? pencilFill(ctx, s.color) : s.color;
    ctx.fill(inkPath(s, cache.get(s)), 'nonzero');
  }
  ctx.globalAlpha = 1;
  for (const it of items) if (it.type === 'text') paintItem(ctx, it);
  const url = cv.toDataURL('image/png');
  return { image: { mime: 'image/png', base64: url.slice(url.indexOf(',') + 1), width: w, height: h }, bounds: b, canvas: cv };
}

export interface ConvertStyle {
  color: string;
  font: TextItem['font'];
  strokeWidth: number;
}

/**
 * Turn a validated scene into HandNote items placed at `target` (page units). The scene's
 * normalized coordinates map linearly onto the target box. Returned items are new objects with
 * fresh ids; nothing is written to the page here.
 */
export function sceneToItems(scene: EditableScene, target: Box, style: ConvertStyle): Item[] {
  const P = (x: number, y: number): Pt => [target.x + x * target.w, target.y + y * target.h];
  const box = (b: BBox): Box => ({ x: target.x + b[0] * target.w, y: target.y + b[1] * target.h, w: b[2] * target.w, h: b[3] * target.h });
  const now = Date.now();
  const out: Item[] = [];
  const idMap = new Map<string, string>(); // scene id → item id (shape / node box)
  const groupOf = new Map<string, string>(); // scene id → group id
  for (const o of scene.objects) if (o.type === 'group') {
    const g = newId('g');
    for (const c of o.children) groupOf.set(c, g);
  }
  const text = (b: Box, s: string, opts: { align?: TextItem['align']; latex?: string; lines?: number; fit?: boolean } = {}): TextItem => {
    const lines = Math.max(1, opts.lines ?? s.split('\n').length);
    const size = Math.round(Math.min(72, Math.max(8, (b.h / lines / 1.35) * 0.92)) * 2) / 2;
    let it: TextItem = fitTextBox({
      id: newId('i'),
      type: 'text',
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      created: now,
      text: s,
      size,
      color: style.color,
      font: opts.latex ? 'serif' : style.font,
      bold: false,
      italic: !!opts.latex,
      align: opts.align ?? 'left',
      autoWidth: true,
      ...(opts.latex ? { latex: opts.latex } : {}),
    });
    // wrap when the text would run far past its region
    if (opts.fit || it.w > b.w * 1.35) it = fitTextBox({ ...it, autoWidth: false, w: Math.max(size * 2, b.w) });
    if (opts.align === 'center') it = { ...it, x: b.x + (b.w - it.w) / 2, y: b.y + (b.h - it.h) / 2 };
    return it;
  };
  const shape = (kind: ShapeItem['kind'], b: Box): ShapeItem => ({
    id: newId('i'),
    type: 'shape',
    kind,
    x: b.x,
    y: b.y,
    w: Math.max(4, b.w),
    h: Math.max(4, b.h),
    created: now,
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    fill: null,
    fillOpacity: 1,
    ...(kind === 'triangle' ? { points: [0.5, 0, 1, 1, 0, 1] } : kind === 'diamond' ? { points: [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5] } : {}),
  });
  const withGroup = <T extends Item>(it: T, sceneId: string, own?: string): T => {
    const g = own ?? groupOf.get(sceneId);
    return g ? { ...it, g } : it;
  };
  // boxes first (connectors attach to them)
  for (const o of scene.objects) {
    if (o.type === 'shape' || o.type === 'mindmap_node') {
      const b = box(o.bbox);
      const sh = shape(o.type === 'mindmap_node' ? 'roundrect' : o.shape, b);
      const label = o.type === 'shape' ? o.label : o.text;
      const g = label ? (groupOf.get(o.id) ?? newId('g')) : groupOf.get(o.id);
      out.push(withGroup(sh, o.id, g));
      idMap.set(o.id, sh.id);
      if (label) out.push(withGroup(text({ x: b.x + b.w * 0.06, y: b.y, w: b.w * 0.88, h: b.h }, label, { align: 'center', fit: true, lines: label.split('\n').length }), o.id, g));
    }
  }
  const byItem = new Map(out.map((i) => [i.id, i]));
  const attach = (sceneId: string | undefined, p: Pt): ShapeItem['from'] => {
    if (!sceneId) return undefined;
    const iid = idMap.get(sceneId);
    const t = iid ? byItem.get(iid) : undefined;
    if (!t) return undefined;
    const an = nearestAnchor(t, p[0], p[1]);
    return { id: t.id, ax: an.ax, ay: an.ay };
  };
  for (const o of scene.objects) {
    if (o.type === 'text') out.push(withGroup(text(box(o.bbox), o.text, { lines: o.lines }), o.id));
    else if (o.type === 'formula') out.push(withGroup(text(box(o.bbox), o.latex, { latex: o.latex, lines: 1 }), o.id));
    else if (o.type === 'connector') {
      const pts = o.points.map((p) => P(p[0], p[1]));
      const a = pts[0];
      const b = pts[pts.length - 1];
      let c: ShapeItem = {
        id: newId('i'),
        type: 'shape',
        kind: 'line',
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        created: now,
        stroke: style.color,
        strokeWidth: style.strokeWidth,
        fill: null,
        fillOpacity: 1,
        a,
        b,
        arrowStart: !!o.arrowStart,
        arrowEnd: !!o.arrowEnd,
        head: 'open',
      };
      if (o.dashed) c.dash = 'dash';
      if (pts.length >= 3 && o.curved) c = { ...c, kind: 'curve', c: controlFromMid(a, pts[Math.floor(pts.length / 2)], b) };
      else if (pts.length >= 3) c = { ...c, kind: 'polyline', pts: pts.slice(1, -1).slice(0, 20).flat() };
      const from = attach(o.from, a);
      const to = attach(o.to, b);
      if (from) c.from = from;
      if (to) c.to = to;
      out.push(withGroup(fitConnector(c), o.id));
      if (o.label) {
        const mid = pts[Math.floor(pts.length / 2)];
        out.push(withGroup(text({ x: mid[0] - 40, y: mid[1] - 18, w: 80, h: 16 }, o.label, { align: 'center' }), o.id));
      }
    }
  }
  // mind map: parent → child links
  for (const o of scene.objects) {
    if (o.type !== 'mindmap_node' || !o.parent) continue;
    const pa = idMap.get(o.parent);
    const ch = idMap.get(o.id);
    const ip = pa ? byItem.get(pa) : undefined;
    const ic = ch ? byItem.get(ch) : undefined;
    if (!ip || !ic) continue;
    const cc: Pt = [ic.x + ic.w / 2, ic.y + ic.h / 2];
    const pc: Pt = [ip.x + ip.w / 2, ip.y + ip.h / 2];
    const af = nearestAnchor(ip, cc[0], cc[1]);
    const at = nearestAnchor(ic, pc[0], pc[1]);
    const a = anchorPoint(ip, af.ax, af.ay);
    const b = anchorPoint(ic, at.ax, at.ay);
    out.push(
      fitConnector({
        id: newId('i'),
        type: 'shape',
        kind: 'line',
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        created: now,
        stroke: style.color,
        strokeWidth: style.strokeWidth,
        fill: null,
        fillOpacity: 1,
        a,
        b,
        arrowEnd: false,
        from: { id: ip.id, ax: af.ax, ay: af.ay },
        to: { id: ic.id, ax: at.ax, ay: at.ay },
      }),
    );
  }
  return resolveConnectors(out);
}

/** Where converted objects go when the originals are kept: right of the selection, else below, else in place. */
export function placementBox(src: Box, page: { width: number; height: number }): Box {
  const gap = 16;
  if (src.x + src.w * 2 + gap <= page.width) return { ...src, x: src.x + src.w + gap };
  if (src.y + src.h * 2 + gap <= page.height) return { ...src, y: src.y + src.h + gap };
  return { ...src };
}
