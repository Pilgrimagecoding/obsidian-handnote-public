import type { GeometryCache } from '../document/geometry-cache';
import type { Op } from '../document/history';
import { newId, type Asset, type Page, type Stroke } from '../document/model';
import { detachMissing, isLine, itemBounds, itemCenter, itemCorners, connectorPoints, resolveConnectors, transformItem, type Item, type Pt, type ShapeItem, type TextItem } from '../document/items';
import { quantizeSample } from '../document/codec';
import { sanitizeParams } from '../ink/presets';
import { recognizeShape } from '../ink/shape-recognition';
import { inkPath, type PageRect } from '../rendering/paint';
import { fitTextBox, layoutText, LINE_HEIGHT, paintItem, pencilFill, TEXT_PAD, textWidth } from '../rendering/items-paint';
import type { Camera } from './camera';
import type { EditorSettings, LassoFilter } from './settings';
import { el, hide, show } from '../ui/dom';
import { setHnIcon } from '../ui/icons';
import { t } from '../ui/i18n';
import { onTap } from '../ui/tap';

/** What the lasso needs from the editor. */
export interface LassoHost {
  viewport: HTMLElement;
  cache: GeometryCache;
  rects(): PageRect[];
  camera(): Camera;
  dpr(): number;
  settings(): EditorSettings;
  readOnly(): boolean;
  /** Hide these strokes / items from the scene (they are drawn on the transform layer). */
  setSkip(ids: ReadonlySet<string>): void;
  requestScene(): void;
  /** Apply an operation and record it for undo. */
  push(op: Op): void;
  notify(msg: string): void;
  assets(): Record<string, Asset>;
  addAssets(a: Record<string, Asset>): void;
  /** Floating-bar actions handled by the editor (AI menu, colour). */
  action(name: 'ai' | 'convert' | 'color', anchor: HTMLElement): void;
  selectionChanged(sel: LassoSelection | null): void;
  /** A lasso tap on an object: open it for editing (mind map, formula, text, labelled shape). */
  tapItem?(r: PageRect, x: number, y: number): boolean;
  /** A new loop starts (object editing ends). */
  loopStart?(): void;
  /** A selection was copied (the plain text of its text / formula items, possibly empty). */
  copied?(plain: string): void;
  /** Pen / mouse held still at the start of a loop: open the page context menu there. */
  contextMenu?(r: PageRect, x: number, y: number): void;
}

export interface LassoSelection {
  pageId: string;
  strokeIds: Set<string>;
  itemIds: Set<string>;
}

export interface Clip {
  strokes: Stroke[];
  items: Item[];
  assets: Record<string, Asset>;
  box: Box;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = 'move' | 'nw' | 'ne' | 'se' | 'sw' | 'rot';

interface Drag {
  pointerId: number;
  handle: Handle;
  rect: PageRect;
  start: Pt; // page-local
  pivot: Pt;
  box: Box;
  k: number;
  ang: number;
  tx: number;
  ty: number;
  moved: boolean;
  float: HTMLCanvasElement;
  floatOrigin: Pt; // screen px of the float canvas top-left
  /** a pending text split was put on the page for the drag: the page's items before it */
  realBefore: Item[] | null;
}

/** Clipboard shared by every open HandNote (copy in one note, paste in another). */
let clipboard: Clip | null = null;

export function lassoClipboard(): Clip | null {
  return clipboard;
}

/** Replace the shared clipboard (object copy, tests). */
export function setLassoClipboard(c: Clip | null): void {
  clipboard = c;
}

/** Plain text of copied objects (text boxes and formulas, top to bottom) for the system clipboard. */
export function clipPlainText(items: readonly Item[]): string {
  const parts: { y: number; x: number; s: string }[] = [];
  for (const it of items) {
    if (it.type === 'text' && it.text.trim()) parts.push({ y: it.y, x: it.x, s: it.latex ? `$${it.latex}$` : it.text });
    else if (it.type === 'formula' && it.latex.trim()) parts.push({ y: it.y, x: it.x, s: `$$${it.latex}$$` });
  }
  parts.sort((a, b) => a.y - b.y || a.x - b.x);
  return parts.map((p) => p.s).join('\n');
}

const PAD_PX = 8;

/** Point-in-polygon (even-odd). */
export function inPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Which strokes / items of a page a lasso polygon (page-local) picks up. */
export function lassoPick(page: Page, poly: Pt[], filter: LassoFilter, cache: GeometryCache): { strokeIds: Set<string>; itemIds: Set<string> } {
  const strokeIds = new Set<string>();
  const itemIds = new Set<string>();
  if (poly.length < 3) return { strokeIds, itemIds };
  const frac = (pts: Pt[]) => {
    if (!pts.length) return 0;
    let n = 0;
    for (const p of pts) if (inPolygon(p[0], p[1], poly)) n++;
    return n / pts.length;
  };
  for (const s of page.strokes) {
    if (s.tool === 'highlighter' ? !filter.highlighter : !filter.ink) continue;
    const g = cache.get(s);
    const step = Math.max(1, Math.floor(g.xs.length / 40));
    const pts: Pt[] = [];
    for (let i = 0; i < g.xs.length; i += step) pts.push([g.xs[i], g.ys[i]]);
    pts.push([g.xs[g.xs.length - 1], g.ys[g.ys.length - 1]]);
    if (frac(pts) >= 0.5) strokeIds.add(s.id);
  }
  for (const it of page.items) {
    const ok = it.type === 'text' || it.type === 'formula' ? filter.text : it.type === 'image' ? filter.images : isLine(it) ? filter.connectors : filter.shapes;
    if (!ok) continue;
    const pts = isLine(it) ? connectorPoints(it, 12) : [...itemCorners(it), itemCenter(it)];
    const c = isLine(it) ? null : itemCenter(it);
    if (frac(pts) >= 0.5 || (c && inPolygon(c[0], c[1], poly))) itemIds.add(it.id);
  }
  // groups are selected as a whole
  const groups = new Set<string>();
  for (const s of page.strokes) if (s.g && strokeIds.has(s.id)) groups.add(s.g);
  for (const it of page.items) if (it.g && itemIds.has(it.id)) groups.add(it.g);
  if (groups.size) {
    for (const s of page.strokes) if (s.g && groups.has(s.g)) strokeIds.add(s.id);
    for (const it of page.items) if (it.g && groups.has(it.g)) itemIds.add(it.id);
  }
  return { strokeIds, itemIds };
}

/**
 * Lasso over part of a text box (converted handwriting): the characters whose centres lie inside
 * the loop become their own text box, the rest stay exactly where they were — so "今" of "今天"
 * can be selected, moved or recoloured on its own. Within one line the cut is per character; a
 * loop over several lines takes those lines. Left-aligned, unrotated, ungrouped boxes whose lines
 * are not wrapped. Returns the replacement boxes and the selected one, or null when nothing is to
 * split (nothing inside, or the whole text inside).
 */
export function splitTextByLoop(it: TextItem, poly: Pt[]): { pieces: TextItem[]; picked: TextItem } | null {
  if (it.type !== 'text' || it.rot || it.g || it.align !== 'left') return null;
  const L = layoutText(it);
  if (L.lines.join('\n') !== it.text) return null; // wrapped: positions are not per source line
  const lines = L.lines.map((l) => Array.from(l));
  if (lines.flat().filter((ch) => ch.trim()).length < 2) return null;
  const lh = it.size * LINE_HEIGHT;
  const lineY = (i: number) => it.y + i * lh;
  const hits = lines.map((chars, li) => {
    const cy = lineY(li) + TEXT_PAD + it.size * 0.62;
    let prefix = '';
    return chars.map((ch) => {
      const a = textWidth(it, prefix);
      prefix += ch;
      const b = textWidth(it, prefix);
      return !!ch.trim() && inPolygon(it.x + TEXT_PAD + (a + b) / 2, cy, poly);
    });
  });
  const touched = hits.map((h) => h.includes(true));
  const l0 = touched.indexOf(true);
  if (l0 < 0) return null;
  const l1 = touched.lastIndexOf(true);
  const now = Date.now();
  const make = (text: string, x: number, y: number) => fitTextBox({ ...it, id: newId('i'), text, x, y, autoWidth: true, created: now });
  const parts: { text: string; x: number; y: number; picked: boolean }[] = [];
  if (l0 > 0) parts.push({ text: lines.slice(0, l0).map((c) => c.join('')).join('\n'), x: it.x, y: lineY(0), picked: false });
  if (l0 === l1) {
    const chars = lines[l0];
    const first = hits[l0].indexOf(true);
    const last = hits[l0].lastIndexOf(true);
    const at = (k: number) => it.x + textWidth(it, chars.slice(0, k).join(''));
    parts.push({ text: chars.slice(0, first).join(''), x: at(0), y: lineY(l0), picked: false });
    parts.push({ text: chars.slice(first, last + 1).join(''), x: at(first), y: lineY(l0), picked: true });
    parts.push({ text: chars.slice(last + 1).join(''), x: at(last + 1), y: lineY(l0), picked: false });
  } else {
    parts.push({ text: lines.slice(l0, l1 + 1).map((c) => c.join('')).join('\n'), x: it.x, y: lineY(l0), picked: true });
  }
  if (l1 < lines.length - 1) parts.push({ text: lines.slice(l1 + 1).map((c) => c.join('')).join('\n'), x: it.x, y: lineY(l1 + 1), picked: false });
  const kept = parts.filter((p) => p.text.trim());
  // the whole text is inside the loop → the box itself is selected, nothing to split
  if (kept.length < 2) return null;
  let picked: TextItem | null = null;
  const pieces = kept.map((p) => {
    const piece = make(p.text, p.x, p.y);
    if (p.picked) picked = piece;
    return piece;
  });
  return picked ? { pieces, picked } : null;
}

/** Similarity transform of an ink stroke (geometry scales exactly: zoom compensates the scale). */
export function transformStroke(s: Stroke, pivot: Pt, k: number, ang: number, tx: number, ty: number): Stroke {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const samples = s.samples.map((p) => {
    const dx = (p.x - pivot[0]) * k;
    const dy = (p.y - pivot[1]) * k;
    return quantizeSample({ ...p, x: pivot[0] + dx * cs - dy * sn + tx, y: pivot[1] + dx * sn + dy * cs + ty });
  });
  const params = { ...s.params, width: s.params.width * k };
  if (params.nibFlatness > 0 && ang) params.nibAngle = (((params.nibAngle + (ang * 180) / Math.PI) % 180) + 180) % 180;
  return { ...s, samples, params: k === 1 ? s.params : sanitizeParams(s.tool, params), zoom: Math.round((s.zoom / k) * 1000) / 1000 || s.zoom };
}

function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, cls: string, parent: Element): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  n.setAttribute('class', cls);
  parent.appendChild(n);
  return n;
}

/**
 * SVG path through the points, smoothed like ink: quadratic curves through the midpoints of the
 * samples (the line follows the pen without the corners of a polyline).
 */
export function smoothPathD(pts: Pt[], closed: boolean): string {
  if (!pts.length) return '';
  const f = (v: number) => Math.round(v * 10) / 10;
  if (pts.length < 3) return `M${f(pts[0][0])} ${f(pts[0][1])}` + pts.slice(1).map((p) => `L${f(p[0])} ${f(p[1])}`).join('') + (closed ? 'Z' : '');
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const z = pts[pts.length - 1];
  d += `L${f(z[0])} ${f(z[1])}`;
  return closed ? `${d}Z` : d;
}

function mapPt(p: Pt, pivot: Pt, k: number, ang: number, tx: number, ty: number): Pt {
  const dx = (p[0] - pivot[0]) * k;
  const dy = (p[1] - pivot[1]) * k;
  const c = Math.cos(ang);
  const sn = Math.sin(ang);
  return [pivot[0] + dx * c - dy * sn + tx, pivot[1] + dx * sn + dy * c + ty];
}

/** Largest preview bitmap while dragging a selection (device pixels). */
const MAX_FLOAT_PX = 6_000_000;

/** Remove a canvas and free its bitmap right away (iOS keeps it until garbage collection). */
function dropCanvas(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
  c.remove();
}

/**
 * Lasso tool: draw a free or rectangular loop to select ink and objects, then move, scale, rotate,
 * copy, cut, delete, group, recolour or convert them (floating bar). Transforms are previewed on a
 * separate canvas with a CSS transform and applied to the document once on release (one undo step).
 */
export class LassoController {
  private sel: LassoSelection | null = null;
  private path: Pt[] = [];
  private pathRect: PageRect | null = null;
  private pathPointer: number | null = null;
  private drag: Drag | null = null;
  /** the loop being drawn (an SVG path: no bitmap to allocate per loop) */
  private readonly live: SVGSVGElement;
  private readonly livePath: SVGPathElement;
  private liveRaf = 0;
  private liveRafAt = 0;
  /** the loop the selection was made with (page-local): shown as the selection's outline */
  private outline: Pt[] | null = null;
  /**
   * Part of a text box picked by the loop: the split is only previewed (selection = the piece)
   * and becomes real with the first action on it (move, colour, delete…) — in the same undo step.
   * Lassoing and letting go changes nothing.
   */
  private pending: { pageId: string; base: Item[]; items: Item[] } | null = null;
  private readonly box: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly outlineSvg: SVGSVGElement;
  private readonly outlinePath: SVGPathElement;
  private readonly bar: HTMLElement;
  private pasteBubble: HTMLElement | null = null;
  private longPress = 0;

  constructor(
    private readonly h: LassoHost,
    overlay: HTMLElement,
  ) {
    this.live = svg('svg', 'hn-lasso-live', h.viewport);
    this.livePath = svg('path', 'hn-lasso-live-path', this.live);
    hide(this.live);
    this.box = el('div', 'hn-lasso-sel hn-ov-int', overlay);
    hide(this.box);
    this.box.dataset.h = 'move';
    this.outlineSvg = svg('svg', 'hn-lasso-outline', this.box);
    this.outlinePath = svg('path', 'hn-lasso-outline-path', this.outlineSvg);
    // the content's own bounds (tight): the resize / rotate handles sit on its corners
    this.frame = el('div', 'hn-lasso-frame', this.box);
    this.frame.dataset.h = 'move';
    for (const hd of ['nw', 'ne', 'se', 'sw', 'rot'] as Handle[]) {
      const d = el('div', `hn-handle hn-lh-${hd}`, this.frame);
      d.dataset.h = hd;
    }
    this.bar = el('div', 'hn-objbar hn-lasso-bar hn-ov-int', overlay);
    hide(this.bar);
    this.bindBox();
  }

  get selection(): LassoSelection | null {
    return this.sel;
  }

  /** The loop of the current selection (page-local), if it was made with one. */
  get outlinePoints(): Pt[] | null {
    return this.outline;
  }

  get busy(): boolean {
    return !!this.drag || this.pathPointer !== null;
  }

  // ---------------------------------------------------------------------------------------------
  // Drawing the loop
  // ---------------------------------------------------------------------------------------------

  pointerBegin(r: PageRect, x: number, y: number, pointerId: number): void {
    this.hidePaste();
    this.h.loopStart?.();
    if (this.sel) this.clear();
    this.path = [[x, y]];
    this.pathRect = r;
    this.pathPointer = pointerId;
    show(this.live);
    this.drawPath();
    window.clearTimeout(this.longPress);
    this.longPress = window.setTimeout(() => {
      if (this.pathPointer === pointerId && this.path.length < 4 && (clipboard || this.h.contextMenu)) {
        const pr = this.pathRect;
        this.cancelPath();
        if (pr && this.h.contextMenu) this.h.contextMenu(pr, x, y);
        else if (pr) this.showPaste(pr, x, y);
      }
    }, 600);
  }

  /** A loop point (call once per coalesced pointer sample for the full pen resolution). */
  pointerMove(_r: PageRect, x: number, y: number): void {
    if (this.pathPointer === null) return;
    const last = this.path[this.path.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) * this.h.camera().zoom < 1.5) return;
    this.path.push([x, y]);
    if (this.path.length > 3) window.clearTimeout(this.longPress);
    if (!this.liveRaf) {
      this.liveRafAt = performance.now();
      this.liveRaf = window.requestAnimationFrame(() => {
        this.liveRaf = 0;
        this.drawPath();
      });
    } else if (performance.now() - this.liveRafAt > 100) {
      // requestAnimationFrame stalled (iPad WebView): draw now
      this.drawPath();
    }
  }

  pointerEnd(_r: PageRect | null, commit: boolean): void {
    window.clearTimeout(this.longPress);
    if (this.pathPointer === null) return;
    const r = this.pathRect;
    const path = this.path;
    this.cancelPath();
    if (!commit || !r) return;
    const poly = this.polygon(path);
    const z = this.h.camera().zoom;
    const span = unionBox(poly.map((p) => ({ x: p[0], y: p[1], w: 0, h: 0 })));
    if (!span || Math.max(span.w, span.h) * z < 8) {
      // a tap: deselected; on an object it opens that object (tap a text to type in it)
      this.h.tapItem?.(r, path[0][0], path[0][1]);
      return;
    }
    const page = r.page;
    const pick = lassoPick(page, poly, this.h.settings().lasso.filter, this.h.cache);
    // part of a text box inside the loop → those characters are selected as their own box
    // (previewed; the page changes only when something is done with them)
    let pending: { pageId: string; base: Item[]; items: Item[] } | null = null;
    if (this.h.settings().lasso.filter.text && !this.h.readOnly()) {
      let items = page.items;
      for (const it of page.items) {
        if (it.type !== 'text') continue;
        const sp = splitTextByLoop(it, poly);
        if (!sp) continue;
        items = items.flatMap((x) => (x.id === it.id ? sp.pieces : [x]));
        pick.itemIds.delete(it.id);
        pick.itemIds.add(sp.picked.id);
      }
      if (items !== page.items) pending = { pageId: page.id, base: page.items, items };
    }
    if (!pick.strokeIds.size && !pick.itemIds.size) return;
    this.setSelection({ pageId: page.id, ...pick }, poly, pending);
  }

  private polygon(path: Pt[]): Pt[] {
    if (this.h.settings().lasso.mode === 'rect' && path.length) {
      const a = path[0];
      const b = path[path.length - 1];
      return [
        [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
        [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
        [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        [Math.min(a[0], b[0]), Math.max(a[1], b[1])],
      ];
    }
    return path;
  }

  private cancelPath(): void {
    this.pathPointer = null;
    this.path = [];
    this.pathRect = null;
    if (this.liveRaf) cancelAnimationFrame(this.liveRaf);
    this.liveRaf = 0;
    this.livePath.setAttribute('d', '');
    hide(this.live);
  }

  private toScreen(r: PageRect, x: number, y: number): Pt {
    const c = this.h.camera();
    return [(r.x + x - c.x) * c.zoom, (r.y + y - c.y) * c.zoom];
  }

  private drawPath(): void {
    const r = this.pathRect;
    if (!r) return;
    const rect = this.h.settings().lasso.mode === 'rect';
    const pts = this.polygon(this.path).map((p) => this.toScreen(r, p[0], p[1]));
    this.livePath.setAttribute('d', rect ? smoothPathD(pts, true) : smoothPathD(pts, false));
  }

  // ---------------------------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------------------------

  private rectOf(pageId: string): PageRect | undefined {
    return this.h.rects().find((r) => r.page.id === pageId);
  }

  /**
   * Select strokes / items. `outline`: the loop that picked them (page-local), drawn as the
   * selection's outline; `pending`: a previewed text split the selection refers to.
   */
  setSelection(sel: LassoSelection | null, outline: Pt[] | null = null, pending: { pageId: string; base: Item[]; items: Item[] } | null = null): void {
    this.sel = sel && (sel.strokeIds.size || sel.itemIds.size) ? sel : null;
    this.outline = this.sel ? outline : null;
    this.pending = this.sel ? pending : null;
    this.sync();
    this.h.selectionChanged(this.sel);
  }

  /** The page's items as the selection sees them (with a previewed text split). */
  private itemsOf(page: Page): Item[] {
    const p = this.pending;
    return p && p.pageId === page.id && page.items === p.base ? p.items : page.items;
  }

  /** Make a previewed text split real (one undo step) — before another tool changes the page. */
  realize(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const rect = this.rectOf(p.pageId);
    if (!rect || rect.page.items !== p.base || this.h.readOnly()) return;
    this.h.push({ kind: 'set-items', pageId: p.pageId, before: p.base, after: p.items });
  }

  clear(): void {
    if (!this.sel && !this.pasteBubble) return;
    this.hidePaste();
    this.setSelection(null);
  }

  /** Selected strokes and items (current objects of the page). */
  selected(): { rect: PageRect; strokes: Stroke[]; items: Item[] } | null {
    const s = this.sel;
    if (!s) return null;
    const rect = this.rectOf(s.pageId);
    if (!rect) return null;
    const strokes = rect.page.strokes.filter((x) => s.strokeIds.has(x.id));
    const items = this.itemsOf(rect.page).filter((x) => s.itemIds.has(x.id));
    if (!strokes.length && !items.length) return null;
    return { rect, strokes, items };
  }

  /** Bounds of the selection (page-local). */
  bounds(): Box | null {
    const f = this.selected();
    if (!f) return null;
    const boxes: Box[] = [];
    for (const s of f.strokes) {
      const g = this.h.cache.get(s);
      boxes.push({ x: g.bbox[0], y: g.bbox[1], w: g.bbox[2] - g.bbox[0], h: g.bbox[3] - g.bbox[1] });
    }
    for (const it of f.items) {
      const b = itemBounds(it);
      // text: the letters themselves, not the box's inner padding (the handles hug what was picked)
      const pad = it.type === 'shape' ? it.strokeWidth / 2 : it.type === 'text' && !it.rot ? -TEXT_PAD : 0;
      boxes.push({ x: b.x - pad, y: b.y - pad, w: Math.max(1, b.w + pad * 2), h: Math.max(1, b.h + pad * 2) });
    }
    return unionBox(boxes);
  }

  /** Re-position the box and bar (camera or document changed). */
  sync(): void {
    if (this.drag) return;
    const f = this.selected();
    const b = f ? this.bounds() : null;
    if (!f || !b) {
      if (this.sel) {
        this.sel = null;
        this.outline = null;
        this.pending = null;
        this.h.selectionChanged(null);
      }
      hide(this.box);
      hide(this.bar);
      return;
    }
    const p0 = this.toScreen(f.rect, b.x, b.y);
    const z = this.h.camera().zoom;
    // the box is the drag area: the content and the loop around it; the outline is the loop as
    // drawn (MyScript Notes / GoodNotes), the handles sit on the content's own bounds
    const loop = this.outline?.map((p) => this.toScreen(f.rect, p[0], p[1])) ?? null;
    let x0 = p0[0] - PAD_PX;
    let y0 = p0[1] - PAD_PX;
    let x1 = p0[0] + b.w * z + PAD_PX;
    let y1 = p0[1] + b.h * z + PAD_PX;
    if (loop) {
      for (const [x, y] of loop) {
        x0 = Math.min(x0, x - 2);
        y0 = Math.min(y0, y - 2);
        x1 = Math.max(x1, x + 2);
        y1 = Math.max(y1, y + 2);
      }
    }
    const bx = this.box;
    show(bx);
    bx.style.removeProperty('transform');
    bx.style.left = `${x0}px`;
    bx.style.top = `${y0}px`;
    bx.style.width = `${x1 - x0}px`;
    bx.style.height = `${y1 - y0}px`;
    bx.classList.toggle('is-readonly', this.h.readOnly());
    bx.classList.toggle('has-loop', !!loop);
    this.outlinePath.setAttribute('d', loop ? smoothPathD(loop.map((p) => [p[0] - x0, p[1] - y0] as Pt), true) : '');
    const fr = this.frame.style;
    const fp = 2;
    fr.left = `${p0[0] - x0 - fp}px`;
    fr.top = `${p0[1] - y0 - fp}px`;
    fr.width = `${b.w * z + fp * 2}px`;
    fr.height = `${b.h * z + fp * 2}px`;
    this.renderBar(f, [x0 + PAD_PX, y0 + PAD_PX], x1 - x0 - PAD_PX * 2, y1 - y0 - PAD_PX * 2);
  }

  private renderBar(f: { strokes: Stroke[]; items: Item[] }, p0: Pt, w: number, hgt: number): void {
    const bar = this.bar;
    bar.textContent = '';
    show(bar);
    const ro = this.h.readOnly();
    const add = (icon: string, label: string, run: (b: HTMLElement) => void, cls = '') => {
      const b = el('button', `hn-btn ${cls}`.trim(), bar);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.dataset.action = icon;
      setHnIcon(b, icon);
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      onTap(b, () => run(b));
    };
    add('copy', t('copy'), () => this.copy());
    if (!ro) {
      add('cut', t('cutItem'), () => this.cut());
      add('trash', t('delete'), () => this.deleteSelection(), 'is-danger');
      add('fill', t('color'), (b) => this.h.action('color', b));
      const grouped = this.isGrouped(f);
      add(grouped ? 'ungroup' : 'group', t(grouped ? 'ungroup' : 'group'), () => (grouped ? this.ungroup() : this.group()));
      // Convert = recognise the ink itself (text / math / shapes); AI tools = vision-model features
      if (f.strokes.some((s) => s.tool !== 'highlighter')) add('to-text', t('convertMenu'), (b) => this.h.action('convert', b), 'is-primary');
      add('sparkles', t('aiToolsMenu'), (b) => this.h.action('ai', b));
    }
    const vw = this.h.viewport.clientWidth;
    const bw = bar.offsetWidth || 300;
    const above = p0[1] - PAD_PX - 90; // clear of the rotate handle
    const top = above > 8 ? above : p0[1] + hgt + PAD_PX + 16;
    bar.style.top = `${Math.min(top, this.h.viewport.clientHeight - 52)}px`;
    bar.style.left = `${Math.max(8, Math.min(vw - bw - 8, p0[0] + w / 2 - bw / 2))}px`;
  }

  private isGrouped(f: { strokes: Stroke[]; items: Item[] }): boolean {
    const gs = new Set<string | undefined>([...f.strokes.map((s) => s.g), ...f.items.map((i) => i.g)]);
    return gs.size === 1 && !gs.has(undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------

  /** Replace strokes / items of the selection's page in one undo step. */
  private apply(page: Page, strokes: Stroke[] | null, items: Item[] | null, itemsBefore?: Item[]): void {
    const p = this.pending;
    const split = !!p && p.pageId === page.id && page.items === p.base;
    // a previewed text split becomes real together with the action (one undo step)
    if (split && !items) items = (p as { items: Item[] }).items;
    this.pending = null;
    const ops: Op[] = [];
    if (strokes) ops.push({ kind: 'set-strokes', pageId: page.id, before: page.strokes, after: strokes });
    if (items) ops.push({ kind: 'set-items', pageId: page.id, before: itemsBefore ?? page.items, after: items });
    if (!ops.length) return;
    this.h.push(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
  }

  copy(): void {
    const f = this.selected();
    const b = this.bounds();
    if (!f || !b) return;
    const assets: Record<string, Asset> = {};
    const all = this.h.assets();
    for (const it of f.items) if (it.type === 'image' && it.src.startsWith('asset:') && all[it.src.slice(6)]) assets[it.src.slice(6)] = all[it.src.slice(6)];
    clipboard = { strokes: f.strokes, items: f.items, assets, box: b };
    this.h.copied?.(clipPlainText(f.items));
    this.h.notify(t('copiedN'));
  }

  cut(): void {
    this.copy();
    this.deleteSelection();
  }

  deleteSelection(): void {
    const f = this.selected();
    const s = this.sel;
    if (!f || !s || this.h.readOnly()) return;
    const page = f.rect.page;
    const strokes = f.strokes.length ? page.strokes.filter((x) => !s.strokeIds.has(x.id)) : null;
    const items = f.items.length ? detachMissing(this.itemsOf(page).filter((x) => !s.itemIds.has(x.id))) : null;
    this.setSelection(null);
    this.apply(page, strokes, items);
  }

  /** Paste the clipboard centred at a page point (or offset from the original position). */
  paste(r: PageRect, at?: Pt): void {
    const c = clipboard;
    if (!c || this.h.readOnly()) return;
    this.hidePaste();
    const dx = at ? at[0] - (c.box.x + c.box.w / 2) : 16;
    const dy = at ? at[1] - (c.box.y + c.box.h / 2) : 16;
    const idMap = new Map<string, string>();
    const gMap = new Map<string, string>();
    const gid = (g?: string) => (g ? (gMap.get(g) ?? (gMap.set(g, newId('g')), gMap.get(g))) : undefined);
    const strokes = c.strokes.map((s) => {
      const n = transformStroke({ ...s, id: newId('s'), created: Date.now() }, [0, 0], 1, 0, dx, dy);
      const g = gid(s.g);
      if (g) n.g = g;
      else delete n.g;
      return n;
    });
    for (const it of c.items) idMap.set(it.id, newId('i'));
    const items = c.items.map((it) => {
      const n = transformItem({ ...it, id: idMap.get(it.id) as string, created: Date.now() }, [0, 0], 1, 0, dx, dy);
      const g = gid(it.g);
      if (g) n.g = g;
      else delete n.g;
      if (n.type === 'shape') {
        // keep attachments between pasted objects only
        if (n.from) n.from = idMap.has(n.from.id) ? { ...n.from, id: idMap.get(n.from.id) as string } : undefined;
        if (n.to) n.to = idMap.has(n.to.id) ? { ...n.to, id: idMap.get(n.to.id) as string } : undefined;
        if (!n.from) delete n.from;
        if (!n.to) delete n.to;
      }
      return n;
    });
    if (Object.keys(c.assets).length) this.h.addAssets(c.assets);
    const page = r.page;
    this.apply(page, strokes.length ? [...page.strokes, ...strokes] : null, items.length ? resolveConnectors([...page.items, ...items]) : null);
    this.setSelection({ pageId: page.id, strokeIds: new Set(strokes.map((s) => s.id)), itemIds: new Set(items.map((i) => i.id)) });
  }

  private showPaste(r: PageRect, x: number, y: number): void {
    this.hidePaste();
    const s = this.toScreen(r, x, y);
    const b = el('button', 'hn-paste-bubble hn-ov-int', this.box.parentElement as HTMLElement);
    b.type = 'button';
    setHnIcon(el('span', 'hn-ic', b), 'paste');
    el('span', 'hn-btn-label', b, t('paste'));
    b.style.left = `${s[0]}px`;
    b.style.top = `${s[1] - 44}px`;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    onTap(b, () => this.paste(r, [x, y]));
    this.pasteBubble = b;
  }

  private hidePaste(): void {
    this.pasteBubble?.remove();
    this.pasteBubble = null;
  }

  group(): void {
    const f = this.selected();
    const s = this.sel;
    if (!f || !s) return;
    const g = newId('g');
    const page = f.rect.page;
    this.apply(
      page,
      f.strokes.length ? page.strokes.map((x) => (s.strokeIds.has(x.id) ? { ...x, g } : x)) : null,
      f.items.length ? this.itemsOf(page).map((x) => (s.itemIds.has(x.id) ? ({ ...x, g }) : x)) : null,
    );
    this.sync();
  }

  ungroup(): void {
    const f = this.selected();
    const s = this.sel;
    if (!f || !s) return;
    const page = f.rect.page;
    const strip = <T extends { g?: string }>(x: T): T => {
      const n = { ...x };
      delete n.g;
      return n;
    };
    this.apply(
      page,
      f.strokes.length ? page.strokes.map((x) => (s.strokeIds.has(x.id) ? strip(x) : x)) : null,
      f.items.length ? this.itemsOf(page).map((x) => (s.itemIds.has(x.id) ? strip(x) : x)) : null,
    );
    this.sync();
  }

  /** Recolour the selection (ink colour, shape outline, text colour). */
  recolor(color: string): void {
    const f = this.selected();
    const s = this.sel;
    if (!f || !s) return;
    const page = f.rect.page;
    this.apply(
      page,
      f.strokes.length ? page.strokes.map((x) => (s.strokeIds.has(x.id) ? { ...x, color } : x)) : null,
      f.items.length
        ? this.itemsOf(page).map((x) => {
            if (!s.itemIds.has(x.id)) return x;
            if (x.type === 'shape' && !x.label) return { ...x, stroke: color, fill: x.fill ? color : null };
            if (x.type === 'text' || x.type === 'formula') return { ...x, color };
            if (x.type === 'shape' && x.label) return { ...x, stroke: color, label: { ...x.label, color } };
            return x;
          })
        : null,
    );
    this.sync();
  }

  /** Local (no AI) beautify: every selected ink stroke that looks like a shape becomes a shape. */
  convertToShapes(): number {
    const f = this.selected();
    const s = this.sel;
    if (!f || !s) return 0;
    const page = f.rect.page;
    const made: ShapeItem[] = [];
    const replaced = new Set<string>();
    for (const st of f.strokes) {
      if (st.tool === 'highlighter') continue;
      const rec = recognizeShape(st.samples);
      if (!rec) continue;
      const item: ShapeItem = {
        id: newId('i'),
        type: 'shape',
        kind: rec.kind,
        x: rec.x,
        y: rec.y,
        w: rec.w,
        h: rec.h,
        created: Date.now(),
        stroke: st.color,
        strokeWidth: Math.max(0.6, Math.min(8, st.params.width * 0.8)),
        fill: null,
        fillOpacity: 1,
      };
      if (rec.points) item.points = rec.points;
      if (rec.a && rec.b) {
        item.a = rec.a;
        item.b = rec.b;
        if (rec.c) item.c = rec.c;
        if (rec.pts) item.pts = rec.pts;
        item.arrowEnd = !!rec.arrowEnd;
        if (rec.arrowEnd) item.head = 'open';
      }
      if (st.dash) item.dash = st.dash;
      if (st.g) item.g = st.g;
      made.push(item);
      replaced.add(st.id);
    }
    if (!made.length) {
      this.h.notify(t('noShapesFound'));
      return 0;
    }
    this.apply(
      page,
      page.strokes.filter((x) => !replaced.has(x.id)),
      [...this.itemsOf(page), ...made],
    );
    const strokeIds = new Set([...s.strokeIds].filter((id) => !replaced.has(id)));
    const itemIds = new Set([...s.itemIds, ...made.map((m) => m.id)]);
    this.setSelection({ pageId: page.id, strokeIds, itemIds }, this.outline);
    this.h.notify(`${t('convertedShapes')} ${made.length}`);
    return made.length;
  }

  // ---------------------------------------------------------------------------------------------
  // Move / scale / rotate
  // ---------------------------------------------------------------------------------------------

  private bindBox(): void {
    this.box.addEventListener('pointerdown', (e) => {
      if (this.h.readOnly() || this.drag) return;
      const f = this.selected();
      const b = this.bounds();
      if (!f || !b) return;
      e.preventDefault();
      e.stopPropagation();
      this.hidePaste();
      const handle = ((e.target as HTMLElement).dataset?.h as Handle | undefined) ?? 'move';
      try {
        this.box.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      const start = this.clientToPage(f.rect, e.clientX, e.clientY);
      const pivot: Pt =
        handle === 'nw' ? [b.x + b.w, b.y + b.h] : handle === 'ne' ? [b.x, b.y + b.h] : handle === 'se' ? [b.x, b.y] : handle === 'sw' ? [b.x + b.w, b.y] : [b.x + b.w / 2, b.y + b.h / 2];
      const { float, origin } = this.renderFloat(f, b);
      // a previewed text split: the rest of the text must stay visible while the piece moves
      let realBefore: Item[] | null = null;
      const p = this.pending;
      if (p && p.pageId === f.rect.page.id && f.rect.page.items === p.base && !this.h.readOnly()) {
        realBefore = p.base;
        f.rect.page.items = p.items;
      }
      this.drag = { pointerId: e.pointerId, handle, rect: f.rect, start, pivot, box: b, k: 1, ang: 0, tx: 0, ty: 0, moved: false, float, floatOrigin: origin, realBefore };
      hide(this.bar);
      this.box.classList.add('is-dragging');
      const ids = new Set<string>([...(this.sel?.strokeIds ?? []), ...(this.sel?.itemIds ?? [])]);
      this.h.setSkip(ids);
      this.h.requestScene();
    });
    this.box.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault();
      const p = this.clientToPage(d.rect, e.clientX, e.clientY);
      const z = this.h.camera().zoom;
      if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) * z < 3) return;
      d.moved = true;
      if (d.handle === 'move') {
        d.tx = p[0] - d.start[0];
        d.ty = p[1] - d.start[1];
      } else if (d.handle === 'rot') {
        const a0 = Math.atan2(d.start[1] - d.pivot[1], d.start[0] - d.pivot[0]);
        const a1 = Math.atan2(p[1] - d.pivot[1], p[0] - d.pivot[0]);
        let ang = a1 - a0;
        const step = Math.PI / 12; // snap to 15° when close
        const snapped = Math.round(ang / step) * step;
        if (Math.abs(ang - snapped) < (3 * Math.PI) / 180) ang = snapped;
        d.ang = ang;
      } else {
        const d0 = Math.hypot(d.start[0] - d.pivot[0], d.start[1] - d.pivot[1]);
        const d1 = Math.hypot(p[0] - d.pivot[0], p[1] - d.pivot[1]);
        d.k = Math.min(10, Math.max(0.1, d0 > 0.5 ? d1 / d0 : 1));
      }
      this.previewTransform(d);
    });
    const up = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.pointerId !== e.pointerId) return;
      this.drag = null;
      dropCanvas(d.float);
      this.box.classList.remove('is-dragging');
      this.box.style.removeProperty('transform');
      this.h.setSkip(new Set());
      if (d.moved && e.type === 'pointerup') this.bake(d);
      else {
        // nothing done: the page goes back to how it was (the split stays a preview)
        if (d.realBefore && this.pending) d.rect.page.items = d.realBefore;
        this.h.requestScene();
        // a tap on a selected text / formula (just converted, say): type in it
        const f = this.selected();
        if (e.type === 'pointerup' && d.handle === 'move' && f && !f.strokes.length && f.items.length === 1 && (f.items[0].type === 'text' || f.items[0].type === 'formula') && !this.pending) {
          this.sync();
          this.h.tapItem?.(d.rect, d.start[0], d.start[1]);
          return;
        }
      }
      this.sync();
    };
    this.box.addEventListener('pointerup', up);
    this.box.addEventListener('pointercancel', up);
  }

  private clientToPage(r: PageRect, cx: number, cy: number): Pt {
    const vr = this.h.viewport.getBoundingClientRect();
    const c = this.h.camera();
    return [(cx - vr.left) / c.zoom + c.x - r.x, (cy - vr.top) / c.zoom + c.y - r.y];
  }

  /** Draw the selection alone onto a canvas covering its screen bounds. */
  private renderFloat(f: { rect: PageRect; strokes: Stroke[]; items: Item[] }, b: Box): { float: HTMLCanvasElement; origin: Pt } {
    const z = this.h.camera().zoom;
    const dpr = this.h.dpr();
    const m = 24;
    const p0 = this.toScreen(f.rect, b.x, b.y);
    const vw = this.h.viewport.clientWidth;
    const vh = this.h.viewport.clientHeight;
    // Only the visible part (plus a margin) is rendered: a selection larger than the screen used
    // to allocate a canvas of several viewport sizes, which on iPad exhausts the web view's canvas
    // memory (other canvases then turn black and the editor stops responding).
    const x0 = Math.max(p0[0] - m, -m * 4);
    const y0 = Math.max(p0[1] - m, -m * 4);
    const x1 = Math.min(p0[0] + b.w * z + m, vw + m * 4);
    const y1 = Math.min(p0[1] + b.h * z + m, vh + m * 4);
    const cv = el('canvas', 'hn-lasso-float', this.h.viewport);
    const w = Math.max(1, x1 - x0);
    const hgt = Math.max(1, y1 - y0);
    const k0 = Math.min(dpr, Math.sqrt(MAX_FLOAT_PX / (w * hgt)));
    cv.width = Math.max(1, Math.round(w * k0));
    cv.height = Math.max(1, Math.round(hgt * k0));
    cv.style.width = `${w}px`;
    cv.style.height = `${hgt}px`;
    cv.style.left = `${x0}px`;
    cv.style.top = `${y0}px`;
    const ctx = cv.getContext('2d');
    if (ctx) {
      const c = this.h.camera();
      const k = k0 * z;
      ctx.setTransform(k, 0, 0, k, k0 * ((f.rect.x - c.x) * z - x0), k0 * ((f.rect.y - c.y) * z - y0));
      for (const it of f.items) if (it.type !== 'text' && it.type !== 'formula') paintItem(ctx, it);
      for (const s of f.strokes) {
        ctx.globalAlpha = s.params.opacity;
        ctx.fillStyle = s.tool === 'pencil' ? pencilFill(ctx, s.color) : s.color;
        ctx.fill(inkPath(s, this.h.cache.get(s)), 'nonzero');
      }
      ctx.globalAlpha = 1;
      for (const it of f.items) if (it.type === 'text' || it.type === 'formula') paintItem(ctx, it);
    }
    return { float: cv, origin: [x0, y0] };
  }

  private previewTransform(d: Drag): void {
    const z = this.h.camera().zoom;
    const ps = this.toScreen(d.rect, d.pivot[0], d.pivot[1]);
    const css = `translate(${d.tx * z}px, ${d.ty * z}px) rotate(${d.ang}rad) scale(${d.k})`;
    d.float.style.transformOrigin = `${ps[0] - d.floatOrigin[0]}px ${ps[1] - d.floatOrigin[1]}px`;
    d.float.style.transform = css;
    const bl = parseFloat(this.box.style.left) || 0;
    const bt = parseFloat(this.box.style.top) || 0;
    this.box.style.transformOrigin = `${ps[0] - bl}px ${ps[1] - bt}px`;
    this.box.style.transform = css;
  }

  /** Apply the previewed transform to the document (one undo step). */
  private bake(d: Drag): void {
    const s = this.sel;
    if (!s) return;
    const page = d.rect.page;
    const strokes = s.strokeIds.size ? page.strokes.map((x) => (s.strokeIds.has(x.id) ? transformStroke(x, d.pivot, d.k, d.ang, d.tx, d.ty) : x)) : null;
    let items: Item[] | null = null;
    if (s.itemIds.size) {
      items = this.itemsOf(page).map((x) => {
        if (!s.itemIds.has(x.id)) return x;
        // keep a connector's attachments only when the attached item moves with it
        const keep = x.type !== 'shape' || ((!x.from || s.itemIds.has(x.from.id)) && (!x.to || s.itemIds.has(x.to.id)));
        return transformItem(x, d.pivot, d.k, d.ang, d.tx, d.ty, keep);
      });
      items = resolveConnectors(items);
    }
    if (this.outline) this.outline = this.outline.map((p) => mapPt(p, d.pivot, d.k, d.ang, d.tx, d.ty));
    this.apply(page, strokes, items, d.realBefore ?? undefined);
  }

  destroy(): void {
    window.clearTimeout(this.longPress);
    if (this.drag) dropCanvas(this.drag.float);
    this.cancelPath();
    this.live.remove();
    this.box.remove();
    this.bar.remove();
    this.hidePaste();
  }
}
