import type { Page } from '../document/model';
import { newId } from '../document/model';
import {
  anchorPoint,
  controlFromMid,
  curveMid,
  defaultPoints,
  detachMissing,
  fitConnector,
  hitItem,
  isLine,
  moveItem,
  nearestAnchor,
  resizeItem,
  resolveConnectors,
  LINE_KINDS,
  type ImageItem,
  type Item,
  type MindMapItem,
  type Pt,
  type ShapeItem,
  type TextItem,
} from '../document/items';
import { addChild, addSibling, findNode, findParent, isDescendant, moveNode, removeNode, setText, toMarkdown, toMermaidMindmap, toggleCollapsed, MAP_LAYOUTS, MAP_THEMES } from '../mindmap/model';
import { fitMindMap, mapBadgeAt, mapLayout, mapNodeAt, mapToPage, setMapUi, topicFont } from '../mindmap/paint';
import { formulaMarkdown } from '../rendering/formula';
import { fitQuadratic } from '../ink/shape-recognition';
import { onTap } from '../ui/tap';
import { LINE_HEIGHT, TEXT_PAD, fitTextBox, fontFamily } from '../rendering/items-paint';
import type { PageRect } from '../rendering/paint';
import type { Camera } from './camera';
import type { EditorSettings } from './settings';
import { el, hide, show } from '../ui/dom';
import { mergeTextPieces, textUnit } from './text-unit';
import { setHnIcon } from '../ui/icons';
import { t } from '../ui/i18n';

/** What the object controller needs from the editor. */
export interface ObjectHost {
  root: HTMLElement;
  viewport: HTMLElement;
  rects(): PageRect[];
  camera(): Camera;
  settings(): EditorSettings;
  readOnly(): boolean;
  /** Re-render the scene (items changed live). */
  requestScene(): void;
  /** Hide these items from the canvas (the text being edited is shown in a textarea instead). */
  setSkip(ids: ReadonlySet<string>): void;
  /** Record an item change (already applied to page.items) for undo/redo and saving. */
  commit(pageId: string, before: Item[], after: Item[]): void;
  notify(msg: string): void;
  /** Bytes of an image item (share). */
  imageBlob(src: string): Promise<Blob | null>;
  /** The selection changed (the sub-toolbar shows the selected item's style). */
  onSelection(it: Item | null): void;
  /** A grouped item was tapped: select the whole group (lasso selection). */
  selectGroup(pageId: string, g: string): void;
  /** A text box got focus for editing (keyboard checks). */
  onEditStart(ta: HTMLTextAreaElement): void;
  /** Open the LaTeX editor of a formula item. */
  editFormula(pageId: string, id: string): void;
  /** Copy plain text to the clipboard. */
  copyText(text: string): Promise<boolean>;
  /** An object was copied (shared clipboard + system clipboard). */
  copied?(page: Page, item: Item): void;
  /** Long press on an empty spot (pen / mouse with an object tool): open the context menu. */
  contextMenu?(r: PageRect, x: number, y: number): void;
}

interface Selection {
  pageId: string;
  id: string;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'a' | 'b' | 'c' | `p${number}`;

interface Drag {
  pointerId: number;
  kind: 'move' | 'resize' | 'create' | 'crop' | 'topic';
  /** mind map: the topic pressed and the topic it would be dropped on */
  topic?: string;
  badge?: string | null;
  drop?: string | null;
  handle?: Handle;
  pageId: string;
  id: string;
  startX: number; // page-local
  startY: number;
  before: Item[];
  orig: Item;
  moved: boolean;
  /** freehand path of a curve being drawn (page-local) */
  path?: Pt[];
}

const TAP_SLOP_PX = 6;
const SNAP_PX = 18;

/**
 * Text boxes, images and shapes: selection (box, handles, floating action bar), moving, resizing,
 * cropping, connector attachment and in-place text editing.
 *
 * Changes are applied to page.items live (as new immutable item objects) and recorded as one
 * `set-items` operation when the gesture ends.
 */
export class ObjectController {
  readonly overlay: HTMLElement;
  private selBox: HTMLElement;
  private bar: HTMLElement;
  private endHandles: HTMLElement[] = [];
  private sel: Selection | null = null;
  private drag: Drag | null = null;
  private cropMode = false;
  private editor: { pageId: string; id: string; ta: HTMLTextAreaElement; before: Item[]; isNew: boolean; kind: 'text' | 'label' | 'topic'; topic?: string; unit?: { ids: string[]; text: string } } | null = null;
  /** Selected topic of the selected mind map. */
  private topic: string | null = null;
  private clipboard: Item[] = [];
  /**
   * iOS shows the keyboard only when focus() runs inside a touch gesture (touchend / click), not
   * inside pointerup. The editor focuses this textarea from its touchend listener.
   */
  pendingFocus: HTMLTextAreaElement | null = null;
  private pasteBubble: HTMLElement | null = null;
  private longPress = 0;

  constructor(private readonly h: ObjectHost) {
    this.overlay = el('div', 'hn-overlay', h.viewport);
    this.selBox = el('div', 'hn-sel hn-ov-int', this.overlay);
    hide(this.selBox);
    for (const hd of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Handle[]) {
      const d = el('div', `hn-handle hn-h-${hd}`, this.selBox);
      d.dataset.h = hd;
    }
    for (const hd of ['a', 'b', 'c'] as Handle[]) this.addEndHandle(hd);
    this.bar = el('div', 'hn-objbar hn-ov-int', this.overlay);
    hide(this.bar);
    this.bindSelection();
  }

  private addEndHandle(hd: Handle): HTMLElement {
    const d = el('div', 'hn-handle hn-end-handle hn-ov-int', this.overlay);
    d.dataset.h = hd;
    if (hd === 'c') d.classList.add('hn-ctrl-handle');
    if (hd.startsWith('p')) d.classList.add('hn-vertex-handle');
    hide(d);
    this.endHandles.push(d);
    if (this.handleBinder) this.handleBinder(d);
    return d;
  }

  private handleBinder: ((d: HTMLElement) => void) | null = null;

  // ---------------------------------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------------------------------

  private rectOf(pageId: string): PageRect | undefined {
    return this.h.rects().find((r) => r.page.id === pageId);
  }

  private pageOf(pageId: string): Page | undefined {
    return this.rectOf(pageId)?.page;
  }

  private find(): { page: Page; rect: PageRect; item: Item } | null {
    if (!this.sel) return null;
    const rect = this.rectOf(this.sel.pageId);
    if (!rect) return null;
    const item = rect.page.items.find((i) => i.id === this.sel?.id);
    return item ? { page: rect.page, rect, item } : null;
  }

  /** Page-local → viewport (CSS px). */
  private toScreen(r: PageRect, x: number, y: number): { x: number; y: number } {
    const c = this.h.camera();
    return { x: (r.x + x - c.x) * c.zoom, y: (r.y + y - c.y) * c.zoom };
  }

  /** Client point → page-local of a given page. */
  private clientToPage(r: PageRect, cx: number, cy: number): { x: number; y: number } {
    const vr = this.h.viewport.getBoundingClientRect();
    const c = this.h.camera();
    return { x: (cx - vr.left) / c.zoom + c.x - r.x, y: (cy - vr.top) / c.zoom + c.y - r.y };
  }

  private replace(page: Page, item: Item): void {
    page.items = resolveConnectors(page.items.map((i) => (i.id === item.id ? item : i)));
  }

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------

  get selected(): Item | null {
    return this.find()?.item ?? null;
  }

  get isEditingText(): boolean {
    return !!this.editor;
  }

  get busy(): boolean {
    return !!this.drag;
  }

  /** Topmost item under a page-local point (text above shapes above images). */
  hit(page: Page, x: number, y: number): Item | null {
    const tol = 8 / this.h.camera().zoom;
    const order: Item['type'][] = ['text', 'formula', 'shape', 'mindmap', 'image'];
    for (const type of order) {
      const list = page.items.filter((i) => i.type === type);
      for (let i = list.length - 1; i >= 0; i--) if (hitItem(list[i], x, y, tol)) return list[i];
    }
    return null;
  }

  select(pageId: string, id: string | null): void {
    if (this.editor && (!id || this.editor.id !== id)) this.finishEdit();
    this.cropMode = false;
    if (!id || this.sel?.id !== id) this.topic = null;
    this.sel = id ? { pageId, id } : null;
    this.hidePaste();
    this.updateMapUi();
    this.sync();
    this.h.onSelection(this.selected);
  }

  deselect(): void {
    if (this.sel || this.editor) this.select('', null);
  }

  /** A tap on the page with an object tool (pen tap, finger tap or mouse click). */
  tap(r: PageRect, x: number, y: number): void {
    if (this.h.readOnly()) return;
    this.hidePaste();
    const hit = this.hit(r.page, x, y);
    const tool = this.h.settings().tool;
    if (hit) {
      // text tool on a text box: type in it at once; grouped text pieces are edited as one text
      if (tool === 'text' && hit.type === 'text') {
        this.editTextUnit(r.page.id, hit.id);
        return;
      }
      if (hit.g && !(hit.type === 'text' && this.sel?.id === hit.id)) {
        this.deselect();
        this.h.selectGroup(r.page.id, hit.g);
        return;
      }
      if (this.sel?.id === hit.id && !this.editor && this.tapSelected(r.page.id, hit, x, y)) return;
      this.select(r.page.id, hit.id);
      if (hit.type === 'mindmap') this.tapMap(hit, x, y, false);
      return;
    }
    if (this.sel || this.editor) {
      this.deselect();
      return;
    }
    if (tool === 'text') this.createText(r, x, y);
  }

  /** Second tap on the selected item: edit its content. Returns true when handled. */
  private tapSelected(pageId: string, it: Item, x: number, y: number): boolean {
    if (this.h.readOnly()) return false;
    if (it.type === 'text') {
      this.startEdit(pageId, it.id, false);
      return true;
    }
    if (it.type === 'formula') {
      this.h.editFormula(pageId, it.id);
      return true;
    }
    if (it.type === 'shape' && !isLine(it)) {
      this.startEdit(pageId, it.id, false, undefined, 'label');
      return true;
    }
    if (it.type === 'mindmap') {
      this.tapMap(it, x, y, true);
      return true;
    }
    return false;
  }

  /** Tap inside a mind map: badge → collapse / expand, topic → select (again → edit). */
  private tapMap(it: MindMapItem, x: number, y: number, wasSelected: boolean): void {
    const tol = 6 / this.h.camera().zoom;
    const badge = mapBadgeAt(it, x, y, tol);
    if (badge && wasSelected) {
      this.updateMap(toggleCollapsed(it.root, badge), badge);
      this.topic = badge;
      this.updateMapUi();
      this.sync();
      return;
    }
    const n = mapNodeAt(it, x, y, tol);
    if (n && wasSelected && this.topic === n.id) {
      this.startEdit(this.sel?.pageId ?? '', it.id, false, undefined, 'topic', n.id);
      return;
    }
    this.topic = n ? n.id : null;
    this.updateMapUi();
    this.sync();
  }

  private updateMapUi(drag?: { dragging?: string | null; dropTarget?: string | null }): void {
    const it = this.selected;
    if (it?.type === 'mindmap') setMapUi({ itemId: it.id, selected: this.topic, ...(drag ?? {}) });
    else setMapUi(null);
    this.h.requestScene();
  }

  /** Replace the selected map's tree (one undo step); `keep` = topic that must not move on screen. */
  private updateMap(root: MindMapItem['root'], keep?: string | null): void {
    const f = this.find();
    if (!f || f.item.type !== 'mindmap' || root === f.item.root) return;
    const before = f.page.items;
    const next = fitMindMap({ ...f.item, root }, f.item, keep ?? undefined);
    this.replace(f.page, next);
    this.h.commit(f.page.id, before, f.page.items);
    this.h.requestScene();
  }

  private mapAction(op: 'child' | 'sibling' | 'delete' | 'collapse' | 'theme' | 'layout' | 'md' | 'mermaid'): void {
    const f = this.find();
    if (!f || f.item.type !== 'mindmap') return;
    const it = f.item;
    const topic = this.topic && findNode(it.root, this.topic) ? this.topic : null;
    if (op === 'md' || op === 'mermaid') {
      void this.h.copyText(op === 'md' ? toMarkdown(it.root) : '```mermaid\n' + toMermaidMindmap(it.root) + '\n```').then((ok) => ok && this.h.notify(t('mapCopied')));
      return;
    }
    if (this.h.readOnly()) return;
    if (op === 'theme' || op === 'layout') {
      const before = f.page.items;
      const next =
        op === 'theme'
          ? { ...it, theme: MAP_THEMES[(MAP_THEMES.indexOf(it.theme) + 1) % MAP_THEMES.length] }
          : { ...it, layout: MAP_LAYOUTS[(MAP_LAYOUTS.indexOf(it.layout) + 1) % MAP_LAYOUTS.length] };
      this.replace(f.page, fitMindMap(next, it, it.root.id));
      this.h.commit(f.page.id, before, f.page.items);
      this.updateMapUi();
      this.sync();
      return;
    }
    const target = topic ?? it.root.id;
    if (op === 'child' || op === 'sibling') {
      const res = op === 'child' ? addChild(it.root, target, t('topicNew')) : addSibling(it.root, target, t('topicNew'));
      this.updateMap(res.root, target);
      this.topic = res.id;
      this.updateMapUi();
      this.sync();
      // type the new topic's text right away (Xmind behaviour)
      this.startEdit(f.page.id, it.id, false, undefined, 'topic', res.id, true);
      return;
    }
    if (op === 'delete') {
      if (!topic || topic === it.root.id) {
        this.h.notify(t('mapRootDelete'));
        return;
      }
      const parent = findParent(it.root, topic);
      this.updateMap(removeNode(it.root, topic), parent?.id ?? it.root.id);
      this.topic = parent?.id ?? null;
      this.updateMapUi();
      this.sync();
      return;
    }
    if (op === 'collapse' && topic) {
      this.updateMap(toggleCollapsed(it.root, topic), topic);
      this.updateMapUi();
      this.sync();
    }
  }

  /** Long press on empty page: offer "Paste" when the clipboard has something. */
  longPressAt(r: PageRect, x: number, y: number): void {
    if (this.h.readOnly()) return;
    if (this.h.contextMenu) {
      this.h.contextMenu(r, x, y);
      return;
    }
    if (!this.clipboard.length) return;
    this.hidePaste();
    const s = this.toScreen(r, x, y);
    const b = el('button', 'hn-paste-bubble hn-ov-int', this.overlay);
    b.type = 'button';
    setHnIcon(el('span', 'hn-ic', b), 'paste');
    el('span', 'hn-btn-label', b, t('paste'));
    b.style.left = `${s.x}px`;
    b.style.top = `${s.y - 44}px`;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    onTap(b, () => this.paste(r, x, y));
    this.pasteBubble = b;
  }

  private hidePaste(): void {
    this.pasteBubble?.remove();
    this.pasteBubble = null;
  }

  /**
   * Pen / mouse pointer with an object tool. Returns true when the controller handled it
   * (shape drawing or a tap); `move`/`end` follow.
   */
  pointerBegin(r: PageRect, x: number, y: number, pointerId: number): void {
    this.hidePaste();
    const s = this.h.settings();
    window.clearTimeout(this.longPress);
    // shape tool: a drag always draws (a connector may start on a shape); a tap selects
    if (s.tool === 'shape' && !this.h.readOnly()) {
      if (this.sel || this.editor) this.deselect();
      this.beginCreate(r, x, y, pointerId);
      return;
    }
    this.drag = { pointerId, kind: 'move', pageId: r.page.id, id: '', startX: x, startY: y, before: r.page.items, orig: null as unknown as Item, moved: false };
    this.longPress = window.setTimeout(() => {
      if (this.drag && !this.drag.moved && !this.drag.id && !this.hit(r.page, x, y)) {
        this.drag = null;
        this.longPressAt(r, x, y);
      }
    }, 600);
  }

  pointerMove(r: PageRect, x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const z = this.h.camera().zoom;
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) * z > TAP_SLOP_PX) d.moved = true;
    if (d.kind === 'create') {
      if (d.path) {
        const last = d.path[d.path.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) * z >= 2) d.path.push([x, y]);
      }
      this.updateCreate(r, x, y);
    }
  }

  pointerEnd(r: PageRect | null, x: number, y: number): void {
    window.clearTimeout(this.longPress);
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'create') {
      this.endCreate(d);
      return;
    }
    if (!d.moved && r) this.tap(r, x, y);
  }

  /** Cancel an in-progress create gesture (tool change, reset). */
  cancel(): void {
    window.clearTimeout(this.longPress);
    if (this.drag?.kind === 'create') {
      const page = this.pageOf(this.drag.pageId);
      if (page) page.items = this.drag.before;
      this.h.requestScene();
    }
    this.drag = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Creating shapes (drag) and connectors
  // ---------------------------------------------------------------------------------------------

  private beginCreate(r: PageRect, x: number, y: number, pointerId: number): void {
    const s = this.h.settings().shape;
    const id = newId('i');
    const base = { id, created: Date.now(), x, y, w: 0, h: 0 };
    let item: ShapeItem;
    if (LINE_KINDS.includes(s.kind)) {
      const a: [number, number] = [x, y];
      const arrowed = s.kind !== 'line';
      item = {
        ...base,
        type: 'shape',
        kind: s.kind,
        stroke: s.color,
        strokeWidth: s.strokeWidth,
        fill: null,
        fillOpacity: 1,
        a,
        b: [x, y],
        arrowEnd: arrowed && s.arrows !== 'none',
        arrowStart: arrowed && s.arrows === 'both',
        head: s.head,
      };
      if (s.kind === 'curve') item.c = [x, y];
      const target = this.attachTarget(r.page, x, y, id);
      if (target) {
        const an = nearestAnchor(target, x, y);
        item.from = { id: target.id, ax: an.ax, ay: an.ay };
        item.a = [target.x + target.w * an.ax, target.y + target.h * an.ay];
      }
    } else {
      item = { ...base, type: 'shape', kind: s.kind, stroke: s.color, strokeWidth: s.strokeWidth, fill: s.fill ? s.color : null, fillOpacity: s.fillOpacity };
      const pts = defaultPoints(s.kind);
      if (pts) item.points = pts;
    }
    if (s.dash !== 'solid') item.dash = s.dash;
    const before = r.page.items;
    r.page.items = [...before, item];
    this.drag = { pointerId, kind: 'create', pageId: r.page.id, id, startX: x, startY: y, before, orig: item, moved: false, ...(s.kind === 'curve' ? { path: [[x, y] as Pt] } : {}) };
    this.h.requestScene();
  }

  /** A box shape near a page point that a connector end can attach to. */
  private attachTarget(page: Page, x: number, y: number, exclude: string): Item | null {
    const tol = SNAP_PX / this.h.camera().zoom;
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (it.id === exclude || isLine(it)) continue;
      if (x >= it.x - tol && x <= it.x + it.w + tol && y >= it.y - tol && y <= it.y + it.h + tol) return it;
    }
    return null;
  }

  private updateCreate(r: PageRect, x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const page = r.page.id === d.pageId ? r.page : this.pageOf(d.pageId);
    if (!page) return;
    const cur = page.items.find((i) => i.id === d.id) as ShapeItem | undefined;
    if (!cur) return;
    let next: ShapeItem;
    if (isLine(cur)) {
      const b: [number, number] = [x, y];
      if (cur.kind === 'curve' && d.path && d.path.length >= 3) {
        // the drawn path is fitted with a smooth quadratic arc (DrawShape-style)
        const fit = fitQuadratic([...d.path, [x, y] as Pt].map((p) => ({ x: p[0], y: p[1] })));
        next = fitConnector({ ...cur, b, c: [fit.c.x, fit.c.y] });
      } else if (cur.kind === 'curve') {
        next = fitConnector({ ...cur, b, c: [(cur.a[0] + x) / 2, (cur.a[1] + y) / 2] });
      } else next = fitConnector({ ...cur, b });
    } else {
      next = { ...cur, x: Math.min(d.startX, x), y: Math.min(d.startY, y), w: Math.abs(x - d.startX), h: Math.abs(y - d.startY) };
    }
    page.items = page.items.map((i) => (i.id === d.id ? next : i));
    this.h.requestScene();
  }

  private endCreate(d: Drag): void {
    const page = this.pageOf(d.pageId);
    if (!page) return;
    const cur = page.items.find((i) => i.id === d.id) as ShapeItem | undefined;
    const z = this.h.camera().zoom;
    const size = cur ? (isLine(cur) ? Math.hypot(cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]) : Math.max(cur.w, cur.h)) : 0;
    if (!cur || !d.moved || size * z < 8) {
      page.items = d.before;
      this.h.requestScene();
      const r = this.rectOf(d.pageId);
      if (r) this.tap(r, d.startX, d.startY);
      return;
    }
    let final: ShapeItem = cur;
    if (isLine(cur)) {
      const target = this.attachTarget(page, cur.b[0], cur.b[1], cur.id);
      if (target && target.id !== cur.from?.id) {
        const an = nearestAnchor(target, cur.b[0], cur.b[1]);
        final = { ...cur, to: { id: target.id, ax: an.ax, ay: an.ay } };
      }
    }
    page.items = resolveConnectors(page.items.map((i) => (i.id === final.id ? final : i)));
    this.h.commit(page.id, d.before, page.items);
    this.select(page.id, final.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------------------------

  createText(r: PageRect, x: number, y: number): void {
    const s = this.h.settings().text;
    const item: TextItem = fitTextBox({
      id: newId('i'),
      type: 'text',
      x: Math.max(0, x - TEXT_PAD),
      y: Math.max(0, y - s.size * 0.75 - TEXT_PAD),
      w: s.size * 2,
      h: s.size * LINE_HEIGHT + TEXT_PAD * 2,
      created: Date.now(),
      text: '',
      size: s.size,
      color: s.color,
      font: s.font,
      bold: s.bold,
      italic: s.italic,
      align: s.align,
      autoWidth: true,
    });
    const before = r.page.items;
    r.page.items = [...before, item];
    this.sel = { pageId: r.page.id, id: item.id };
    this.startEdit(r.page.id, item.id, true, before);
  }

  startEdit(pageId: string, id: string, isNew: boolean, before?: Item[], kind: 'text' | 'label' | 'topic' = 'text', topic?: string, newTopic = false): void {
    const page = this.pageOf(pageId);
    const item = page?.items.find((i) => i.id === id);
    if (!page || !item || this.h.readOnly()) return;
    if (kind === 'text' && item.type !== 'text') return;
    if (kind === 'label' && (item.type !== 'shape' || isLine(item))) return;
    if (kind === 'topic' && (item.type !== 'mindmap' || !topic || !findNode(item.root, topic))) return;
    this.finishEdit();
    const ta = el('textarea', `hn-text-editor hn-ov-int${kind !== 'text' ? ` is-${kind}` : ''}`, this.overlay);
    ta.value = item.type === 'text' ? item.text : item.type === 'shape' ? (item.label?.text ?? '') : item.type === 'mindmap' ? (findNode(item.root, topic as string)?.text ?? '') : '';
    if (newTopic) ta.select();
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('inputmode', 'text');
    ta.setAttribute('enterkeyhint', 'enter');
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('input', () => this.onEditInput());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.finishEdit();
        this.sync();
      }
      // mind map topics: Enter = new sibling, Tab = new subtopic (Xmind), Shift+Enter = line break
      if (kind === 'topic' && !e.isComposing && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
        e.preventDefault();
        this.finishEdit();
        this.mapAction(e.key === 'Tab' ? 'child' : 'sibling');
      }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => {
      // a tap on the floating bar must not end editing before its click runs
      window.setTimeout(() => {
        if (this.editor?.ta === ta && document.activeElement !== ta) {
          this.finishEdit();
          this.sync();
        }
      }, 120);
    });
    this.editor = { pageId, id, ta, before: before ?? page.items, isNew: isNew || newTopic, kind, ...(topic ? { topic } : {}) };
    this.sel = { pageId, id };
    if (kind === 'topic') this.topic = topic ?? null;
    if (kind === 'text') this.h.setSkip(new Set([id]));
    this.h.requestScene();
    this.sync();
    this.pendingFocus = ta;
    this.focusEditor();
    this.h.onEditStart(ta);
  }

  /** Focus the text editor (also called from a touchend handler so iOS opens the keyboard). */
  focusEditor(): void {
    const ta = this.editor?.ta ?? null;
    if (!ta || !ta.isConnected) {
      this.pendingFocus = null;
      return;
    }
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    try {
      ta.setSelectionRange(n, n);
    } catch {
      /* ignore */
    }
  }

  private onEditInput(): void {
    const e = this.editor;
    if (!e) return;
    const page = this.pageOf(e.pageId);
    const item = page?.items.find((i) => i.id === e.id);
    if (!page || !item) return;
    if (e.kind === 'text' && item.type === 'text') page.items = page.items.map((i) => (i.id === e.id ? fitTextBox({ ...item, text: e.ta.value }) : i));
    else if (e.kind === 'label' && item.type === 'shape') {
      const lb = item.label ?? { text: '', size: 14, color: item.stroke };
      this.replace(page, { ...item, label: { ...lb, text: e.ta.value.slice(0, 2000) } });
    } else if (e.kind === 'topic' && item.type === 'mindmap' && e.topic) {
      this.replace(page, fitMindMap({ ...item, root: setText(item.root, e.topic, e.ta.value) }, item, e.topic));
    }
    this.h.requestScene();
    this.sync();
  }

  /**
   * Open a text box for typing. A text that is part of a group of text pieces (a converted sentence
   * with a word lassoed out and put back, then grouped) is edited as ONE text: the pieces are shown
   * joined while typing; the page keeps the pieces unless the text was changed (then one box,
   * one undo step).
   */
  editTextUnit(pageId: string, id: string): void {
    const page = this.pageOf(pageId);
    if (!page || this.h.readOnly()) return;
    if (this.editor && (this.editor.id === id || this.editor.unit?.ids.includes(id))) return;
    this.finishEdit();
    const members = textUnit(page.items, id);
    if (!members) {
      this.select(pageId, id);
      this.startEdit(pageId, id, false);
      return;
    }
    const before = page.items;
    const merged = mergeTextPieces(members);
    const ids = new Set(members.map((m) => m.id));
    let placed = false;
    page.items = page.items.flatMap((i) => {
      if (!ids.has(i.id)) return [i];
      if (placed) return [];
      placed = true;
      return [merged];
    });
    this.select(pageId, merged.id);
    this.startEdit(pageId, merged.id, false, before);
    if (this.editor?.id === merged.id) this.editor.unit = { ids: [...ids], text: merged.text };
  }

  /** Commit the text being edited (an empty new box disappears without an undo step). */
  finishEdit(): void {
    const e = this.editor;
    if (!e) return;
    this.editor = null;
    this.pendingFocus = null;
    e.ta.remove();
    this.h.setSkip(new Set());
    const page = this.pageOf(e.pageId);
    if (!page) return;
    if (e.kind !== 'text') {
      this.finishContentEdit(page, e);
      return;
    }
    const item = page.items.find((i) => i.id === e.id) as TextItem | undefined;
    const old = e.before.find((i) => i.id === e.id) as TextItem | undefined;
    if (e.unit) {
      // grouped pieces edited as one: unchanged → the pieces come back as they were
      if (item && item.text === e.unit.text) {
        page.items = e.before;
        if (this.sel?.id === e.id) this.sel = null;
      } else {
        if (!item || !item.text.trim()) {
          page.items = detachMissing(page.items.filter((i) => i.id !== e.id));
          if (this.sel?.id === e.id) this.sel = null;
        }
        this.h.commit(page.id, e.before, page.items);
      }
      this.h.requestScene();
      this.h.onSelection(this.selected);
      return;
    }
    if (!item || item.text.trim() === '') {
      page.items = detachMissing(page.items.filter((i) => i.id !== e.id));
      if (this.sel?.id === e.id) this.sel = null;
      if (!e.isNew && old) this.h.commit(page.id, e.before, page.items);
    } else if (e.isNew || !old || old.text !== item.text) {
      this.h.commit(page.id, e.before, page.items);
    }
    this.h.requestScene();
    this.h.onSelection(this.selected);
  }

  /** End editing a shape label or a mind map topic (one undo step when something changed). */
  private finishContentEdit(page: Page, e: NonNullable<ObjectController['editor']>): void {
    const item = page.items.find((i) => i.id === e.id);
    const old = e.before.find((i) => i.id === e.id);
    if (item && old && e.kind === 'label' && item.type === 'shape') {
      const text = item.label?.text.trim() ?? '';
      if (!text) {
        const n: ShapeItem = { ...item };
        delete n.label;
        this.replace(page, n);
      }
      const before = old.type === 'shape' ? (old.label?.text ?? '') : '';
      if (before !== (item.label?.text ?? '')) this.h.commit(page.id, e.before, page.items);
      else page.items = e.before;
    } else if (item && old && e.kind === 'topic' && item.type === 'mindmap' && old.type === 'mindmap' && e.topic) {
      const now = findNode(item.root, e.topic);
      const was = findNode(old.root, e.topic);
      if (now && !now.text.trim()) {
        // an emptied topic: a new one disappears, an existing one keeps its text
        const root = e.isNew && now.children.length === 0 ? removeNode(item.root, e.topic) : setText(item.root, e.topic, was?.text ?? '');
        this.replace(page, fitMindMap({ ...item, root }, item, findParent(item.root, e.topic)?.id));
        if (e.isNew) this.topic = findParent(item.root, e.topic)?.id ?? null;
      }
      const after = page.items.find((i) => i.id === e.id);
      if (after !== old) this.h.commit(page.id, e.before, page.items);
    }
    this.updateMapUi();
    this.h.requestScene();
    this.h.onSelection(this.selected);
  }

  private styleContentEditor(r: PageRect, it: Item): void {
    const e = this.editor;
    if (!e) return;
    const z = this.h.camera().zoom;
    const ta = e.ta;
    let box = { x: it.x, y: it.y, w: it.w, h: it.h };
    let font = '';
    let color = '#1a1a1a';
    if (e.kind === 'label' && it.type === 'shape') {
      const size = it.label?.size ?? 14;
      font = `400 ${size * z}px/${LINE_HEIGHT} ${fontFamily(it.label?.font ?? 'sans')}`;
      color = it.label?.color ?? it.stroke;
      const h = Math.min(it.h, Math.max(size * LINE_HEIGHT * 2, it.h * 0.6));
      box = { x: it.x + it.w * 0.08, y: it.y + (it.h - h) / 2, w: it.w * 0.84, h };
    } else if (e.kind === 'topic' && it.type === 'mindmap' && e.topic) {
      const l = mapLayout(it);
      const n = l.byId.get(e.topic);
      if (n) {
        const [px, py] = mapToPage(it, l, n.x, n.y);
        box = { x: px, y: py, w: Math.max(n.w, n.style.size * 6) * it.scale, h: n.h * it.scale };
        font = topicFont(n.style.size * it.scale * z, n.style.weight, l.theme.font) + '';
        color = n.textColor === '#ffffff' ? '#1f2933' : n.textColor;
      }
    }
    const p = this.toScreen(r, box.x, box.y);
    ta.style.left = `${p.x}px`;
    ta.style.top = `${p.y}px`;
    ta.style.width = `${box.w * z + 2}px`;
    ta.style.height = `${box.h * z + 2}px`;
    ta.style.padding = `${2 * z}px`;
    ta.style.font = font;
    ta.style.lineHeight = String(LINE_HEIGHT);
    ta.style.color = color;
    // centred, wrapping: .hn-text-editor.is-label / .is-topic in styles.css
  }

  private styleEditor(r: PageRect, it: TextItem): void {
    const e = this.editor;
    if (!e) return;
    const z = this.h.camera().zoom;
    const p = this.toScreen(r, it.x, it.y);
    const ta = e.ta;
    ta.style.left = `${p.x}px`;
    ta.style.top = `${p.y}px`;
    ta.style.width = `${Math.max(it.w, it.size * 2) * z + 2}px`;
    ta.style.height = `${it.h * z + 2}px`;
    ta.style.padding = `${TEXT_PAD * z}px`;
    ta.style.font = `${it.italic ? 'italic ' : ''}${it.bold ? '700' : '400'} ${it.size * z}px/${LINE_HEIGHT} ${fontFamily(it.font)}`;
    ta.style.color = it.color;
    ta.style.textAlign = it.align;
    ta.style.whiteSpace = it.autoWidth ? 'pre' : 'pre-wrap';
  }

  // ---------------------------------------------------------------------------------------------
  // Item actions (floating bar)
  // ---------------------------------------------------------------------------------------------

  deleteSelected(): void {
    const f = this.find();
    if (!f) return;
    if (this.editor) {
      this.editor.ta.remove();
      this.editor = null;
      this.h.setSkip(new Set());
    }
    const before = f.page.items;
    f.page.items = detachMissing(before.filter((i) => i.id !== f.item.id));
    this.h.commit(f.page.id, before, f.page.items);
    this.select('', null);
  }

  copySelected(): void {
    const f = this.find();
    if (!f) return;
    this.clipboard = [f.item];
    this.h.copied?.(f.page, f.item);
  }

  cutSelected(): void {
    this.copySelected();
    this.deleteSelected();
    this.h.notify(t('copied'));
  }

  duplicateSelected(): void {
    const f = this.find();
    if (!f) return;
    const dup = this.cloneItem(f.item, 16, 16);
    const before = f.page.items;
    f.page.items = [...before, dup];
    this.h.commit(f.page.id, before, f.page.items);
    this.select(f.page.id, dup.id);
  }

  private cloneItem(it: Item, dx: number, dy: number): Item {
    const moved = moveItem({ ...it, id: newId('i'), created: Date.now() }, dx, dy);
    return moved;
  }

  paste(r: PageRect, x: number, y: number): void {
    this.hidePaste();
    const src = this.clipboard[0];
    if (!src) return;
    const it = this.cloneItem(src, x - src.x, y - src.y);
    const before = r.page.items;
    r.page.items = [...before, it];
    this.h.commit(r.page.id, before, r.page.items);
    this.select(r.page.id, it.id);
  }

  async shareSelected(): Promise<void> {
    const f = this.find();
    if (!f || f.item.type !== 'image') return;
    const blob = await this.h.imageBlob(f.item.src);
    if (!blob) {
      this.h.notify(t('imageFailed'));
      return;
    }
    const ext = blob.type.split('/')[1] || 'png';
    const file = new File([blob], `handnote-image.${ext}`, { type: blob.type || 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    try {
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file] });
        return;
      }
    } catch {
      return; // user cancelled
    }
    try {
      const CI = (window as unknown as { ClipboardItem?: new (d: Record<string, Blob>) => ClipboardItem }).ClipboardItem;
      if (CI && navigator.clipboard?.write) {
        await navigator.clipboard.write([new CI({ [blob.type || 'image/png']: blob })]);
        this.h.notify(t('shareUnavailable'));
        return;
      }
    } catch {
      /* fall through */
    }
    this.h.notify(t('clipboardUnavailable'));
  }

  toggleCrop(): void {
    const f = this.find();
    if (!f || f.item.type !== 'image') return;
    this.cropMode = !this.cropMode;
    this.sync();
  }

  /** Apply a style patch to the selected shape / text (sub-toolbar edits). */
  applyStyle(patch: Partial<ShapeItem> | Partial<TextItem>): void {
    const f = this.find();
    if (!f) return;
    const before = f.page.items;
    let next = { ...f.item, ...patch } as Item;
    if (next.type === 'text') next = fitTextBox(next);
    this.replace(f.page, next);
    this.h.commit(f.page.id, before, f.page.items);
    this.h.requestScene();
    this.sync();
  }

  // ---------------------------------------------------------------------------------------------
  // Selection overlay: box, handles, floating bar; dragging
  // ---------------------------------------------------------------------------------------------

  private bindSelection(): void {
    const start = (e: PointerEvent, kind: Drag['kind'], handle?: Handle) => {
      const f = this.find();
      if (!f || this.h.readOnly()) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const p = this.clientToPage(f.rect, e.clientX, e.clientY);
      this.drag = { pointerId: e.pointerId, kind, handle, pageId: f.page.id, id: f.item.id, startX: p.x, startY: p.y, before: f.page.items, orig: f.item, moved: false };
      // mind map: pressing a topic drags that topic (re-parent); the centre topic / empty area moves the map
      if (kind === 'move' && f.item.type === 'mindmap') {
        const tol = 6 / this.h.camera().zoom;
        const n = mapNodeAt(f.item, p.x, p.y, tol);
        this.drag.badge = mapBadgeAt(f.item, p.x, p.y, tol);
        if (n && n.depth > 0 && !this.drag.badge) {
          this.drag.kind = 'topic';
          this.drag.topic = n.id;
        }
      }
    };
    this.selBox.addEventListener('pointerdown', (e) => {
      const hd = (e.target as HTMLElement).dataset?.h as Handle | undefined;
      if (this.editor && !hd) return; // clicks inside the text editor
      start(e, hd ? (this.cropMode ? 'crop' : 'resize') : 'move', hd);
    });
    const move = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.pointerId !== e.pointerId || d.kind === 'create') return;
      const r = this.rectOf(d.pageId);
      if (!r) return;
      e.preventDefault();
      const p = this.clientToPage(r, e.clientX, e.clientY);
      const dx = p.x - d.startX;
      const dy = p.y - d.startY;
      if (!d.moved && Math.hypot(dx, dy) * this.h.camera().zoom < (d.kind === 'topic' ? TAP_SLOP_PX : 3)) return;
      d.moved = true;
      if (d.kind === 'topic' && d.orig.type === 'mindmap' && d.topic) {
        const n = mapNodeAt(d.orig, p.x, p.y, 4 / this.h.camera().zoom);
        const ok = n && n.id !== d.topic && !isDescendant(d.orig.root, d.topic, n.id) && findParent(d.orig.root, d.topic)?.id !== n.id;
        d.drop = ok && n ? n.id : null;
        this.topic = d.topic;
        this.updateMapUi({ dragging: d.topic, dropTarget: d.drop });
        return;
      }
      let next: Item;
      if (d.kind === 'move') next = moveItem(d.orig, dx, dy);
      else if (d.kind === 'crop') next = cropItem(d.orig as ImageItem, d.handle as Handle, dx, dy);
      else next = this.resized(d.orig, d.handle as Handle, dx, dy, p);
      this.replace(r.page, next);
      this.h.requestScene();
      this.sync();
    };
    const up = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.pointerId !== e.pointerId || d.kind === 'create') return;
      this.drag = null;
      const page = this.pageOf(d.pageId);
      if (!page) return;
      if (!d.moved) {
        // tap on the selected box: edit its content (text, label, formula, topic)
        const it = page.items.find((i) => i.id === d.id);
        if (it && !this.editor && e.type === 'pointerup') this.tapSelected(page.id, it, d.startX, d.startY);
        return;
      }
      if (d.kind === 'topic') {
        const it = page.items.find((i) => i.id === d.id);
        if (it?.type === 'mindmap' && d.topic && d.drop && e.type === 'pointerup') this.updateMap(moveNode(it.root, d.topic, d.drop), d.drop);
        this.updateMapUi();
        this.sync();
        return;
      }
      if (d.kind === 'resize' && (d.handle === 'a' || d.handle === 'b')) this.reattach(page, d.id, d.handle);
      this.h.commit(page.id, d.before, page.items);
      this.sync();
    };
    const bindHandle = (eh: HTMLElement) => {
      eh.addEventListener('pointerdown', (e) => start(e, 'resize', eh.dataset.h as Handle));
      eh.addEventListener('pointermove', move);
      eh.addEventListener('pointerup', up);
      eh.addEventListener('pointercancel', up);
    };
    this.selBox.addEventListener('pointermove', move);
    this.selBox.addEventListener('pointerup', up);
    this.selBox.addEventListener('pointercancel', up);
    for (const eh of this.endHandles) bindHandle(eh);
    this.handleBinder = bindHandle;
  }

  private resized(orig: Item, hd: Handle, dx: number, dy: number, p: { x: number; y: number }): Item {
    if (isLine(orig) && (hd === 'a' || hd === 'b')) {
      const a: Pt = hd === 'a' ? [p.x, p.y] : orig.a;
      const b: Pt = hd === 'b' ? [p.x, p.y] : orig.b;
      let c = orig.c;
      if (c) {
        // keep the bulge relative to the chord
        const m = curveMid(orig.a, c, orig.b);
        const off: Pt = [m[0] - (orig.a[0] + orig.b[0]) / 2, m[1] - (orig.a[1] + orig.b[1]) / 2];
        c = controlFromMid(a, [(a[0] + b[0]) / 2 + off[0], (a[1] + b[1]) / 2 + off[1]], b);
      }
      const n: ShapeItem = fitConnector({ ...orig, a, b, ...(c ? { c } : {}) });
      if (hd === 'a') delete n.from;
      else delete n.to;
      return n;
    }
    if (isLine(orig) && hd === 'c' && orig.c) return fitConnector({ ...orig, c: controlFromMid(orig.a, [p.x, p.y], orig.b) });
    if (isLine(orig) && hd.startsWith('p') && orig.pts) {
      const i = Number(hd.slice(1));
      const pts = orig.pts.slice();
      pts[i * 2] = p.x;
      pts[i * 2 + 1] = p.y;
      return fitConnector({ ...orig, pts });
    }
    if (orig.rot) {
      // resize in the item's own frame, then keep the opposite side fixed on the page
      const cs = Math.cos(-orig.rot);
      const sn = Math.sin(-orig.rot);
      const ldx = dx * cs - dy * sn;
      const ldy = dx * sn + dy * cs;
      const local = this.resizedBox({ ...orig, rot: undefined }, hd, ldx, ldy);
      const fixedHd = ({ nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' } as Record<string, string>)[hd] ?? 'se';
      const ax = fixedHd.includes('w') ? 0 : fixedHd.includes('e') ? 1 : 0.5;
      const ay = fixedHd.includes('n') ? 0 : fixedHd.includes('s') ? 1 : 0.5;
      const before = anchorPoint(orig, ax, ay);
      const cand = { ...local, rot: orig.rot } as Item;
      const after = anchorPoint(cand, ax, ay);
      return { ...cand, x: cand.x + before[0] - after[0], y: cand.y + before[1] - after[1] };
    }
    return this.resizedBox(orig, hd, dx, dy);
  }

  private resizedBox(orig: Item, hd: Handle, dx: number, dy: number): Item {
    let { x, y, w, h } = orig;
    if (hd.includes('w')) {
      x += dx;
      w -= dx;
    }
    if (hd.includes('e')) w += dx;
    if (hd.includes('n')) {
      y += dy;
      h -= dy;
    }
    if (hd.includes('s')) h += dy;
    const min = 6;
    if (w < min) {
      if (hd.includes('w')) x -= min - w;
      w = min;
    }
    if (h < min) {
      if (hd.includes('n')) y -= min - h;
      h = min;
    }
    if (orig.type === 'image' && hd.length === 2) {
      // corners keep the aspect ratio
      const ar = orig.w / Math.max(orig.h, 1e-3);
      if (w / h > ar) w = h * ar;
      else h = w / ar;
      if (hd.includes('w')) x = orig.x + orig.w - w;
      if (hd.includes('n')) y = orig.y + orig.h - h;
    }
    if (orig.type === 'text') return fitTextBox({ ...orig, x, w: Math.max(orig.size * 2, w), autoWidth: false });
    return resizeItem(orig, { x, y, w, h });
  }

  private reattach(page: Page, id: string, hd: 'a' | 'b'): void {
    const it = page.items.find((i) => i.id === id);
    if (!it || !isLine(it)) return;
    const pt = hd === 'a' ? it.a : it.b;
    const target = this.attachTarget(page, pt[0], pt[1], id);
    if (!target) return;
    const an = nearestAnchor(target, pt[0], pt[1]);
    const att = { id: target.id, ax: an.ax, ay: an.ay };
    const next: ShapeItem = hd === 'a' ? { ...it, from: att } : { ...it, to: att };
    page.items = resolveConnectors(page.items.map((i) => (i.id === id ? next : i)));
    this.h.requestScene();
  }

  /** Re-position the overlay after camera / item changes. */
  sync(): void {
    const f = this.find();
    if (!f) {
      hide(this.selBox);
      hide(this.bar);
      this.exportMenu?.remove();
      this.exportMenu = null;
      for (const eh of this.endHandles) hide(eh);
      if (this.editor) this.finishEdit();
      return;
    }
    const { rect, item } = f;
    const z = this.h.camera().zoom;
    const line = isLine(item);
    const pad = line ? 10 : 2;
    const p0 = this.toScreen(rect, item.x, item.y);
    const box = this.selBox;
    show(box);
    box.classList.toggle('is-line', line);
    box.classList.toggle('is-text', item.type === 'text');
    box.classList.toggle('is-crop', this.cropMode);
    box.classList.toggle('is-editing', !!this.editor);
    box.style.left = `${p0.x - pad}px`;
    box.style.top = `${p0.y - pad}px`;
    box.style.width = `${Math.max(item.w * z, line ? 0 : 8) + pad * 2}px`;
    box.style.height = `${Math.max(item.h * z, line ? 0 : 8) + pad * 2}px`;
    box.classList.toggle('hn-rot-center', !!item.rot && !line);
    if (item.rot && !line) box.style.transform = `rotate(${item.rot}rad)`;
    else box.style.removeProperty('transform');
    const vertexCount = line && item.kind === 'polyline' ? Math.floor((item.pts?.length ?? 0) / 2) : 0;
    while (this.endHandles.length < 3 + vertexCount) this.addEndHandle(`p${this.endHandles.length - 3}`);
    for (const eh of this.endHandles) {
      const hd = eh.dataset.h as Handle;
      let pt: Pt | null = null;
      if (line) {
        if (hd === 'a') pt = item.a;
        else if (hd === 'b') pt = item.b;
        else if (hd === 'c' && item.kind === 'curve' && item.c) pt = curveMid(item.a, item.c, item.b);
        else if (hd.startsWith('p') && item.pts) {
          const i = Number(hd.slice(1));
          if (i < vertexCount) pt = [item.pts[i * 2], item.pts[i * 2 + 1]];
        }
      }
      if (!pt) {
        hide(eh);
        continue;
      }
      const s = this.toScreen(rect, pt[0], pt[1]);
      show(eh);
      eh.style.left = `${s.x}px`;
      eh.style.top = `${s.y}px`;
    }
    if (this.editor && item.type === 'text') this.styleEditor(rect, item);
    else if (this.editor) this.styleContentEditor(rect, item);
    box.classList.toggle('is-map', item.type === 'mindmap');
    this.renderBar(item, p0, item.w * z, item.h * z);
  }

  private renderBar(item: Item, p0: { x: number; y: number }, w: number, h: number): void {
    const bar = this.bar;
    bar.textContent = '';
    this.exportMenu?.remove();
    this.exportMenu = null;
    show(bar);
    const add = (icon: string, label: string, run: () => void, cls = '') => {
      const b = el('button', `hn-btn ${cls}`.trim(), bar);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.dataset.action = icon;
      setHnIcon(b, icon);
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault(); // keep the text editor focused
      });
      onTap(b, () => run());
    };
    if (this.cropMode) {
      add('check', t('done'), () => {
        this.cropMode = false;
        this.sync();
      }, 'is-primary');
    } else {
      if (item.type === 'text' && !this.editor) add('edit', t('edit'), () => this.sel && this.startEdit(this.sel.pageId, this.sel.id, false));
      if (item.type === 'text' && this.editor) add('check', t('done'), () => {
        this.finishEdit();
        this.sync();
      }, 'is-primary');
      if (item.type === 'image') add('crop', t('crop'), () => this.toggleCrop());
      if (item.type === 'formula') {
        add('edit', t('formulaEdit'), () => this.sel && this.h.editFormula(this.sel.pageId, this.sel.id));
        add('markdown', t('latexCopy'), () => void this.h.copyText(formulaMarkdown(item.latex)).then((ok) => ok && this.h.notify(t('latexCopied'))));
      }
      if (item.type === 'shape' && !isLine(item) && !this.editor) add('edit', t('labelEdit'), () => this.sel && this.startEdit(this.sel.pageId, this.sel.id, false, undefined, 'label'));
      if (item.type === 'shape' && this.editor) add('check', t('done'), () => {
        this.finishEdit();
        this.sync();
      }, 'is-primary');
      if (item.type === 'mindmap') {
        const topic = this.topic ? findNode(item.root, this.topic) : null;
        if (this.editor) add('check', t('done'), () => {
          this.finishEdit();
          this.sync();
        }, 'is-primary');
        else if (topic) add('edit', t('topicEdit'), () => this.sel && this.startEdit(this.sel.pageId, this.sel.id, false, undefined, 'topic', topic.id));
        add('add-child', t('topicAddChild'), () => this.mapAction('child'));
        if (topic && topic.id !== item.root.id) add('add-sibling', t('topicAddSibling'), () => this.mapAction('sibling'));
        if (topic && topic.children.length) add(topic.collapsed ? 'expand' : 'collapse', topic.collapsed ? t('topicExpand') : t('topicCollapse'), () => this.mapAction('collapse'));
        if (topic && topic.id !== item.root.id) add('trash', t('topicDelete'), () => this.mapAction('delete'), 'is-danger hn-topic-delete');
        add('palette', t('mapTheme'), () => this.mapAction('theme'));
        add(item.layout === 'balanced' ? 'layout-right' : 'layout-balanced', t('mapLayout'), () => this.mapAction('layout'));
        // one export button with a labelled choice (two look-alike copy icons confused users)
        add('export', t('mapExport'), () => this.toggleExportMenu([
          ['markdown', t('mapCopyMarkdown'), () => this.mapAction('md')],
          ['flowchart', t('mapCopyMermaid'), () => this.mapAction('mermaid')],
        ]));
        if (topic) {
          // topic tools only; whole-map actions after deselecting the topic
          this.placeBar(item, p0, w, h);
          return;
        }
      }
      add('cut', t('cutItem'), () => this.cutSelected());
      add('copy', t('duplicate'), () => this.duplicateSelected());
      if (item.type === 'image') add('share', t('share'), () => void this.shareSelected());
      add('trash', t('delete'), () => this.deleteSelected(), 'is-danger');
    }
    this.placeBar(item, p0, w, h);
  }

  private exportMenu: HTMLElement | null = null;

  /** Small labelled menu under the floating bar (export choices). */
  private toggleExportMenu(rows: [string, string, () => void][]): void {
    if (this.exportMenu) {
      this.exportMenu.remove();
      this.exportMenu = null;
      return;
    }
    const menu = el('div', 'hn-objbar-menu hn-ov-int', this.overlay);
    for (const [icon, label, run] of rows) {
      const b = el('button', 'hn-objbar-menu-row', menu);
      b.type = 'button';
      b.dataset.action = icon;
      setHnIcon(el('span', 'hn-ic', b), icon);
      el('span', 'hn-btn-label', b, label);
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      onTap(b, () => {
        run();
        menu.remove();
        this.exportMenu = null;
      });
    }
    const r = this.bar.getBoundingClientRect();
    const vr = this.h.viewport.getBoundingClientRect();
    menu.style.left = `${r.right - vr.left - 220}px`;
    menu.style.top = `${r.bottom - vr.top + 6}px`;
    this.exportMenu = menu;
  }

  private placeBar(_item: Item, p0: { x: number; y: number }, w: number, h: number): void {
    const bar = this.bar;
    const vw = this.h.viewport.clientWidth;
    const bw = bar.offsetWidth || 200;
    const above = p0.y - 52;
    const top = above > 8 ? above : p0.y + h + 14;
    bar.style.top = `${top}px`;
    bar.style.left = `${Math.max(8, Math.min(vw - bw - 8, p0.x + w / 2 - bw / 2))}px`;
  }

  destroy(): void {
    window.clearTimeout(this.longPress);
    this.overlay.remove();
  }
}

/** Crop by dragging an edge: the image keeps its scale, the visible window changes. */
export function cropItem(orig: ImageItem, hd: Handle, dx: number, dy: number): ImageItem {
  const c = orig.crop ?? [0, 0, 1, 1];
  const sx = orig.w / (c[2] * orig.natW); // page units per source pixel
  const sy = orig.h / (c[3] * orig.natH);
  let [cx, cy, cw, ch] = c;
  let { x, y, w, h } = orig;
  const min = 0.02;
  if (hd.includes('w')) {
    const du = Math.max(-cx, Math.min(cw - min, dx / sx / orig.natW));
    cx += du;
    cw -= du;
    x += du * orig.natW * sx;
    w -= du * orig.natW * sx;
  }
  if (hd.includes('e')) {
    const du = Math.max(-(cw - min), Math.min(1 - cx - cw, dx / sx / orig.natW));
    cw += du;
    w += du * orig.natW * sx;
  }
  if (hd.includes('n')) {
    const dv = Math.max(-cy, Math.min(ch - min, dy / sy / orig.natH));
    cy += dv;
    ch -= dv;
    y += dv * orig.natH * sy;
    h -= dv * orig.natH * sy;
  }
  if (hd.includes('s')) {
    const dv = Math.max(-(ch - min), Math.min(1 - cy - ch, dy / sy / orig.natH));
    ch += dv;
    h += dv * orig.natH * sy;
  }
  return { ...orig, x, y, w, h, crop: [cx, cy, cw, ch] };
}
