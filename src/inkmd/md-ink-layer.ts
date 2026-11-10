import { Prec, type Compartment } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { Notice, Platform, type MarkdownView, type TFile } from 'obsidian';
import { ENGINE_EXPERIMENTAL, ENGINE_VERSION, newId, type HandNoteDocument, type Page, type Stroke } from '../document/model';
import { quantizeSample } from '../document/codec';
import { GeometryCache, hitStrokeSegment } from '../document/geometry-cache';
import { cutStroke } from '../ink/erase';
import { CanvasPathSink, emitStroke } from '../ink/outline';
import { INK_PIPELINE, StrokeBuilder, geometryFromStored, quantizeGeometry, type StrokeGeometry } from '../ink/stroke-builder';
import { sanitizeExperimental, sanitizeParams } from '../ink/presets';
import { isInkTool, isObjectTool, type InkTool, type InputSample, type Tool } from '../ink/types';
import { recognizeInk, recognizeInkArrowHead, type RecognizedShape } from '../ink/shape-recognition';
import { paintInkStroke } from '../rendering/paint';
import { onImageLoaded, paintItemsAbove, paintItemsBelow, pencilFill, registerAssets, assetDataUrl } from '../rendering/items-paint';
import type { PageRect } from '../rendering/paint';
import { arrowTangents, detachMissing, isLine, moveItem, shapeTouchesCircle, type Item, type ShapeItem } from '../document/items';
import type { Op } from '../document/history';
import { LassoController } from '../editor/lasso';
import { ObjectController } from '../editor/objects';
import { makeAsset } from '../editor/handnote-editor';
import { Popover, renderColorPanel, renderLassoFilterPanel, renderLineStylePanel, renderListPicker } from '../ui/panels';
import { ERASER_SIZES, addPaletteColor, type EditorSettings } from '../editor/settings';
import { Toolbar, groupOf, type PenKind, type ToolGroup } from '../ui/toolbar';
import { t } from '../ui/i18n';
import { onTap } from '../ui/tap';
import { setHnIcon } from '../ui/icons';
import { InputRouter, type PointerKind, type RouterHost, type RouterPointer } from '../input/input-router';
import type { Camera } from '../editor/camera';
import { LaserPointer } from '../editor/laser';
import { anchorText, pickAnchorLine, relocateLine, sampleBounds } from './anchor';
import type { InkFileStore, InkStatus } from './ink-file';

/**
 * Ink on Markdown (0.12, step 1): HandNote ink on top of Obsidian's own Markdown editor.
 *
 * The note stays a normal, editable Markdown note in its normal view. This layer adds:
 * - the HandNote toolbar above the editor (lasso, pen / pencil / highlighter / shape pen, eraser,
 *   text, laser, hand); its menus are own popovers (Obsidian's Menu closes at once on iPad);
 * - two canvases inside the editor's scroll container, so the ink scrolls natively with the text
 *   (no drift during momentum scrolling); only the visible part (+ overscan) is drawn;
 * - input: with an ink tool every pointer goes through HandNote's InputRouter, the same rules as in
 *   a note (pen writes, finger pans with momentum, two fingers zoom, palm rejection, two / three
 *   finger tap undo / redo). A finger tap goes to the editor (cursor, links, checkboxes). With the
 *   text tool (or while typing) everything goes to the editor;
 * - with an ink tool the editor is made non-editable: iPadOS Scribble works on every editable
 *   text under the Pencil — it turned strokes into typed text (drawn as a second line next to the
 *   ink), deleted words crossed out and selected text, and JavaScript cannot stop it otherwise.
 *   Three layers: the CodeMirror `editable` facet + content attribute; every other editable
 *   element of the note (table cells, title, properties) forced read-only while locked, kept so by
 *   a MutationObserver (Obsidian may set them again); and a "shield" — the ink's clip element takes
 *   the pointer, so a hit test under the Pencil finds no text at all. A finger tap is passed on:
 *   links, checkboxes… are clicked; on text the editor becomes editable and the caret goes there
 *   (keyboard), until the Pencil comes back;
 * - zoom: the editor's `.cm-sizer` is scaled (CodeMirror supports transformed editors and maps
 *   taps correctly), so text and ink grow together and the text stays editable and sharp. During
 *   a pinch only a cheap preview transform of the editor box is applied (one composited layer);
 *   the real zoom is set once when the fingers lift (no re-layout per frame);
 * - anchors: each stroke belongs to a line (see anchor.ts) and moves with it when text is added
 *   or removed above.
 *
 * Coordinates: x from the left edge of `.cm-content`, y from CodeMirror's document top, in CSS px
 * of the unzoomed editor ("document px").
 */

/** Ink is a little wider than on paper pages at 100 %: a note at 100 % shows text about as large as a page fitted to an iPad. */
export const MD_INK_WIDTH_SCALE = 1.6;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
/** Largest backing store of the ink canvas (px): memory on the iPad, far below its per-canvas limit. */
const MAX_CANVAS_PX = 8_000_000;
/** Overscan of the ink canvas above and below the view (screens). */
const OVERSCAN = 0.5;
/** Elements a finger tap opens / toggles itself (no caret is placed for them). */
const TAPPABLE = 'a, button, input, select, textarea, label, img, .cm-hmd-internal-link, .cm-link, .cm-url, .internal-link, .external-link, .task-list-item-checkbox, .callout-fold, .cm-fold-indicator, .collapse-indicator, .internal-embed, .multi-select-pill';
/** Input types that take typed (and Scribble) text. */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'number', 'password']);
/** Fastest fling (px / ms): about two screens of momentum. */
const MAX_FLING = 4;
/** After a stroke, a click on a link under it is not followed (ms). */
const CLICK_GUARD_MS = 450;
/** Re-check anchor lines this long after the last edit (ms). */
const ANCHOR_CHECK_MS = 2500;

const MD_GROUPS: ToolGroup[] = ['lasso', 'pen', 'eraser', 'text', 'image', 'shape', 'laser', 'hand'];
const MD_PEN_KINDS: PenKind[] = ['fountain', 'pencil', 'highlighter', 'shapepen'];

export interface MdInkHost {
  /** plugin version (diagnostics) */
  version: string;
  settings(): EditorSettings;
  settingsChanged(s: EditorSettings): void;
  /** leave the annotation mode for this note */
  exit(): void;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Geo {
  /** client position of document (0, 0) */
  cx: number;
  cy: number;
  /** screen px per document px */
  sx: number;
  sy: number;
  /** scale of the editor box (the zoom): screen px per scroll px */
  bs: number;
}

interface ActiveInk {
  id: number;
  tool: InkTool;
  color: string;
  builder: StrokeBuilder;
  geo: Geo;
  origin: { ox: number; oy: number };
  t0: number;
  created: number;
  /** shape pen: the stroke becomes the recognised shape */
  shape: boolean;
}

interface ActiveErase {
  id: number;
  geo: Geo;
  origin: { ox: number; oy: number };
  lastX: number;
  lastY: number;
  before: Stroke[];
  beforeItems: Item[];
  changed: boolean;
}

type Cam = Camera;

/** A pan / pinch by the router: the camera it started from (pinch preview) and the preview. */
interface Nav {
  base: Cam | null;
  preview: Cam | null;
  /** scroll container's top-left in the editor box (transform origin) */
  offX: number;
  offY: number;
}

/** One undo step: the ink and / or the text boxes, images and shapes. */
interface UndoOp {
  strokes?: { before: Stroke[]; after: Stroke[] };
  items?: { before: Item[]; after: Item[] };
}

/** Points per text row of a highlighter laid on text (samples and stored ink). */
const SPAN_PTS = 6;

/** Largest image accepted (bytes). */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface MenuRow {
  label: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** the menu stays open (toggles) */
  keep?: boolean;
  run(): void;
}

interface Pinch {
  ids: [number, number];
  edRect: DOMRect;
  d0: number;
  f0x: number;
  f0y: number;
  fx: number;
  fy: number;
  k: number;
  rect: DOMRect;
  /** camera when the fingers landed */
  cam: Cam;
}

export class MdInkLayer {
  readonly file: TFile;
  private strokes: Stroke[] = [];
  /** stroke id → position of the start of its anchor line (mapped through edits) */
  private pos = new Map<string, number>();
  private readonly cache = new GeometryCache();
  private readonly boxes = new WeakMap<Stroke, Box>();
  private undoStack: UndoOp[] = [];
  private redoStack: UndoOp[] = [];
  /** text boxes, images and shapes (as in a note) */
  private readonly objects: ObjectController;
  private readonly objHost: HTMLElement;
  /** where popovers (colours, sizes) open */
  private readonly popRoot: HTMLElement;
  private popover: Popover | null = null;
  private popKind: string | null = null;
  private readonly fileInput: HTMLInputElement;
  private skipItems: ReadonlySet<string> = new Set();
  private skipObj: ReadonlySet<string> = new Set();
  private skipLasso: ReadonlySet<string> = new Set();
  private objPointer: number | null = null;
  /** the annotation page as the object controller sees it (no page edge: items may go in the margins) */
  private pageView: Page | null = null;
  private readonly bar: HTMLElement;
  private readonly toolbar: Toolbar;
  private readonly clip: HTMLElement;
  private readonly inkCanvas: HTMLCanvasElement;
  private readonly liveCanvas: HTMLCanvasElement;
  private readonly inkCtx: CanvasRenderingContext2D;
  private readonly liveCtx: CanvasRenderingContext2D;
  private readonly sizer: HTMLElement | null;
  /** canvas rectangle in scroll-content px (visual) */
  private cv = { left: 0, top: 0, w: 0, vw: 0, h: 0, dpr: 1, zoom: 0 };
  private zoom = 1;
  private baseWidth = 0;
  private active: ActiveInk | null = null;
  private erase: ActiveErase | null = null;
  private pinch: Pinch | null = null;
  private lastInkEnd = 0;
  private raf = 0;
  private needsInk = true;
  private readOnly = false;
  private anchorTimer = 0;
  private disposers: (() => void)[] = [];
  private closed = false;
  /** the editor accepts typing (text tool, or after a finger tap) */
  private editable = true;
  /** a finger tap made the text editable while an ink tool is selected */
  private typing = false;
  /** live canvas rectangle (the visible part when the stroke started), scroll-content px */
  private lv = { left: 0, top: 0, w: 0, h: 0, dpr: 1 };
  /** content size last given to the clip */
  private clipW = 0;
  private clipH = 0;
  /** HandNote's input rules (pen / finger / palm, pan, pinch, taps), as in a note */
  private readonly router: InputRouter;
  private nav: Nav | null = null;
  /** scroll container rectangle when the gesture started (not re-measured during a preview) */
  private vpRect: DOMRect = new DOMRect();
  /** the pointer event being routed */
  private evt: PointerEvent | null = null;
  private inertia: { vx: number; vy: number; last: number } | null = null;
  /** left edge of the note at 100 % (to zoom back exactly) */
  private baseLeft = 0;
  /** sideways offset of the note and the ink (px; see camNow) */
  private panX = 0;
  /** horizontal extent of the ink (cached; undefined = to compute) */
  private inkX: { x0: number; x1: number } | null | undefined = undefined;
  /** scroll position kept while the editor is hidden for a moment (sidebar drawer, tab switch) */
  private lastTop = 0;
  /** scroll events while the Pencil was writing, not caused by HandNote (diagnostics) */
  private penScrolls = 0;
  private layerTimer = 0;
  /** when the zoom was last set (performance.now) */
  private zoomedAt = -1e9;
  /** frames to draw again after the lines moved */
  private settle = 0;
  /** highlighters laid on text: stroke id → the characters (document positions, mapped through edits) */
  private spanPos = new Map<string, { from: number; to: number }>();
  /** highlighters laid on text whose characters were deleted: become ink rows at the next frame */
  private lostSpans = new Set<string>();
  /** a highlighter on text: its ink row by row */
  private readonly spanGeoms = new WeakMap<Stroke, StrokeGeometry[]>();
  /** the editor was hidden (no size) */
  private hidden = false;
  /** a finger tap placed the caret: the keyboard opens from the touchend */
  private focusPending = false;
  private readonly laserHost: HTMLElement;
  private readonly laser: LaserPointer;
  private laserId: number | null = null;
  /** HandNote's lasso (as in a note): ink, text boxes, images and shapes */
  private readonly lasso: LassoController;
  private lassoPointer: number | null = null;
  /** strokes hidden from the ink canvas (the lasso draws them while they move) */
  private skipStrokes: ReadonlySet<string> = new Set();
  private menuEl: HTMLElement | null = null;
  private menuAnchor: HTMLElement | null = null;
  private menuOff: (() => void) | null = null;
  /** editable elements made read-only while locked, with what to restore */
  private forced = new Map<HTMLElement, { ce: string | null; ro: boolean }>();
  private guard: MutationObserver | null = null;
  private guardQueued = false;
  /** what was under the last pen-down (diagnostics) */
  private lastProbe: { x: number; y: number; stack: string[] } | null = null;

  constructor(
    readonly md: MarkdownView,
    readonly view: EditorView,
    private readonly store: InkFileStore,
    private readonly host: MdInkHost,
    private readonly compartment: Compartment,
  ) {
    this.file = md.file as TFile;
    md.contentEl.addClass('hn-ink-active');
    // the HandNote toolbar, above the editor (the sub-bar floats below it, over the text)
    this.bar = createDiv({ cls: 'hn-editor is-markdown hn-inkbar' });
    md.contentEl.prepend(this.bar);
    this.toolbar = new Toolbar(this.bar, this.toolbarActions(), { groups: MD_GROUPS, penKinds: MD_PEN_KINDS, strokeStyle: false });
    this.toolbar.setMarkdown(() => this.host.exit());
    // the ink, inside the scroll container (scrolls with the text); clipped to the content so it
    // never makes the note scroll further
    const sc = view.scrollDOM;
    sc.addClass('hn-ink-scroller');
    this.clip = sc.createDiv({ cls: 'hn-ink-clip' });
    this.inkCanvas = this.clip.createEl('canvas', { cls: 'hn-ink-canvas' });
    this.liveCanvas = this.clip.createEl('canvas', { cls: 'hn-ink-canvas hn-ink-live' });
    this.inkCtx = this.inkCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.liveCtx = this.liveCanvas.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings) as CanvasRenderingContext2D;
    this.sizer = view.contentDOM.closest<HTMLElement>('.cm-sizer');
    const s = host.settings();
    if (!(isInkTool(s.tool) || isObjectTool(s.tool) || s.tool === 'eraser' || s.tool === 'hand' || s.tool === 'lasso' || s.tool === 'laser')) {
      s.tool = s.lastPen;
      s.drawShape = false;
    }
    // the laser: over the visible part of the editor (does not scroll)
    this.laserHost = md.contentEl.createDiv({ cls: 'hn-ink-laserhost' });
    this.laser = new LaserPointer(this.laserHost, () => this.host.settings().laser);
    // text boxes, images and shapes: HandNote's object controller over the visible part of the note
    // (outside the editor box: the box is scaled when zoomed, the overlays work in screen px)
    this.objHost = md.contentEl.createDiv({ cls: 'hn-editor hn-ink-objhost' });
    this.popRoot = md.contentEl.createDiv({ cls: 'hn-editor hn-ink-poproot' });
    this.fileInput = this.popRoot.createEl('input', { cls: 'hn-file-input' });
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.insertImage(f);
    });
    this.objects = new ObjectController({
      root: this.objHost,
      viewport: this.objHost,
      rects: () => {
        const r = this.pageRect();
        return r ? [r] : [];
      },
      camera: () => this.objCamera(),
      settings: () => this.host.settings(),
      readOnly: () => this.readOnly,
      requestScene: () => {
        this.needsInk = true;
        this.schedule();
      },
      setSkip: (ids) => {
        this.skipObj = ids;
        this.updateSkip();
      },
      commit: (_pageId, before, after) => this.commitItems(before, after),
      notify: (m) => new Notice(m, 4000),
      imageBlob: async (src) => {
        const url = assetDataUrl(src);
        if (!url) return null;
        try {
          return await (await fetch(url)).blob();
        } catch {
          return null;
        }
      },
      onSelection: (it) => this.onSelection(it),
      selectGroup: () => undefined,
      onEditStart: () => undefined,
      editFormula: () => undefined,
      copyText: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
    });
    this.lasso = new LassoController(
      {
        viewport: this.objHost,
        cache: this.cache,
        rects: () => {
          const r = this.pageRect(false);
          return r ? [r] : [];
        },
        camera: () => this.objCamera(),
        dpr: () => Math.min(window.devicePixelRatio || 1, 3),
        settings: () => this.host.settings(),
        readOnly: () => this.readOnly,
        setSkip: (ids) => {
          const st = new Set<string>();
          const it = new Set<string>();
          const items = new Set((this.page?.items ?? []).map((i) => i.id));
          for (const id of ids) (items.has(id) ? it : st).add(id);
          this.skipStrokes = st;
          this.skipLasso = it;
          this.updateSkip();
        },
        requestScene: () => {
          this.needsInk = true;
          this.schedule();
        },
        push: (op) => this.applyOp(op),
        notify: (m) => new Notice(m, 4000),
        assets: () => this.store.doc?.assets ?? {},
        addAssets: (a) => {
          const doc = this.store.doc;
          if (!doc) return;
          doc.assets = { ...(doc.assets ?? {}), ...a };
          registerAssets(a);
        },
        action: (name, anchor) => {
          if (name === 'color') this.openLassoColor(anchor);
        },
        selectionChanged: () => undefined,
        loopStart: () => this.objects.deselect(),
        features: { convert: false, ai: false },
      },
      this.objects.overlay,
    );
    this.disposers.push(
      onImageLoaded(() => {
        this.needsInk = true;
        this.schedule();
      }),
    );
    this.router = new InputRouter(this.routerHost(), { fingerDrawing: false, tapGestures: s.tapGestures, hand: s.tool === 'hand' });
    this.placeHosts();
    this.bindInput();
    this.applyLock();
    this.updateToolbar();
  }

  // ---------------------------------------------------------------------------------------------
  // Editable or not (Scribble)
  // ---------------------------------------------------------------------------------------------

  /** Non-editable with an ink tool (no Scribble, no selection by the Pencil), unless typing. */
  private applyLock(): void {
    this.setEditable(this.closed || !this.inkToolSelected() || this.typing);
  }

  private inkToolSelected(): boolean {
    const tl = this.tool;
    return isInkTool(tl) || isObjectTool(tl) || tl === 'eraser' || tl === 'hand' || tl === 'lasso' || tl === 'laser';
  }

  private setEditable(on: boolean, viewGone = false): void {
    if (this.editable === on) return;
    this.editable = on;
    this.md.contentEl.toggleClass('hn-ink-locked', !on);
    // the shield: the clip takes pen and finger, so nothing editable is under the Pencil
    this.clip.toggleClass('hn-ink-shield', !on);
    // no native scrolling of the note while the shield is up (set on the scroll container itself)
    this.view.scrollDOM.toggleClass('hn-ink-noscroll', !on);
    for (const el of Array.from(this.md.contentEl.querySelectorAll<HTMLElement>('.inline-title, .metadata-container'))) {
      if (on) el.removeAttribute('inert');
      else el.setAttribute('inert', '');
    }
    if (on) {
      this.guard?.disconnect();
      this.guard = null;
      this.restoreForced();
    }
    if (!viewGone) {
      // Obsidian sets contenteditable itself (content attributes): the highest-precedence attribute
      // wins, so it is set here too, together with the facet
      const lock = Prec.highest([EditorView.editable.of(false), EditorView.contentAttributes.of({ contenteditable: 'false' })]);
      const effects = this.compartment.reconfigure(on ? [] : lock);
      try {
        this.view.dispatch({ effects });
      } catch {
        // called while the editor updates: right after it
        window.setTimeout(() => {
          if (this.editable === on) this.view.dispatch({ effects });
        }, 0);
      }
      if (!on && this.view.hasFocus) this.view.contentDOM.blur();
    }
    if (!on) {
      this.enforce();
      // whatever becomes editable again (Obsidian, a table being rendered) is made read-only again
      this.guard = new MutationObserver(() => {
        if (this.guardQueued) return;
        this.guardQueued = true;
        queueMicrotask(() => {
          this.guardQueued = false;
          this.enforce();
        });
      });
      this.guard.observe(this.md.contentEl, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable', 'readonly'] });
    }
  }

  /** Every editable element of the note read-only (while locked). */
  private enforce(): void {
    if (this.editable || this.closed) return;
    for (const el of Array.from(this.md.contentEl.querySelectorAll<HTMLElement>('[contenteditable]'))) {
      const v = el.getAttribute('contenteditable');
      if (v === 'false' || this.bar.contains(el) || this.objHost.contains(el) || this.popRoot.contains(el)) continue;
      if (!this.forced.has(el)) this.forced.set(el, { ce: v, ro: false });
      el.setAttribute('contenteditable', 'false');
    }
    for (const el of Array.from(this.md.contentEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))) {
      if ((el instanceof HTMLInputElement && !TEXT_INPUTS.has(el.type)) || el.readOnly || this.bar.contains(el) || this.objHost.contains(el) || this.popRoot.contains(el)) continue;
      if (!this.forced.has(el)) this.forced.set(el, { ce: null, ro: true });
      el.readOnly = true;
    }
  }

  private restoreForced(): void {
    for (const [el, f] of this.forced) {
      if (!el.isConnected) continue;
      if (f.ro) (el as HTMLInputElement).readOnly = false;
      else if (f.ce === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', f.ce);
    }
    this.forced.clear();
  }

  /** The element under (x, y) in the note, below the shield. */
  private under(x: number, y: number): Element | null {
    const shield = this.clip.hasClass('hn-ink-shield');
    if (shield) this.clip.removeClass('hn-ink-shield');
    const el = document.elementFromPoint(x, y);
    if (shield) this.clip.addClass('hn-ink-shield');
    return el;
  }

  /** State for a support report (⋯ → copy diagnostics). */
  diagnostics(): string {
    const v = this.view;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n));
    };
    const editables = Array.from(this.md.contentEl.querySelectorAll<HTMLElement>('[contenteditable], input, textarea'))
      .filter((el) => !this.bar.contains(el))
      .slice(0, 40)
      .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), ce: el.getAttribute('contenteditable'), isCE: el.isContentEditable, ro: (el as HTMLInputElement).readOnly ?? null, inert: el.closest('[inert]') !== null, rect: rect(el) }));
    return JSON.stringify(
      {
        handnote: this.host.version,
        ios: Platform.isIosApp,
        mobile: Platform.isMobile,
        tablet: Platform.isTablet,
        tool: this.tool,
        editable: this.editable,
        typing: this.typing,
        shield: this.clip.hasClass('hn-ink-shield'),
        facetEditable: v.state.facet(EditorView.editable),
        contentCE: v.contentDOM.getAttribute('contenteditable'),
        contentIsCE: v.contentDOM.isContentEditable,
        forced: this.forced.size,
        active: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}.${String(document.activeElement.className).slice(0, 40)}` : null,
        lastPenDown: this.lastProbe,
        router: { state: this.router.state, contacts: this.router.contactCount, penScrolls: this.penScrolls, ...this.router.stats },
        panX: this.panX,
        touchAction: getComputedStyle(this.view.scrollDOM).touchAction,
        zoom: this.zoom,
        editables,
      },
      null,
      1,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Document
  // ---------------------------------------------------------------------------------------------

  /** The annotations were loaded or replaced (sync, journal restore). */
  setDocument(doc: HandNoteDocument, readOnly: boolean): void {
    this.readOnly = readOnly;
    this.bar.toggleClass('is-readonly', readOnly);
    this.strokes = doc.pages[0]?.strokes ?? [];
    this.inkX = undefined;
    this.pos.clear();
    this.objects.deselect();
    this.pageView = null;
    registerAssets(doc.assets);
    const d = this.view.state.doc;
    for (const s of [...this.strokes, ...(doc.pages[0]?.items ?? [])]) {
      if (!s.anchor) continue;
      this.pos.set(s.id, d.line(relocateLine(s.anchor, d)).from);
    }
    this.spanPos.clear();
    this.lostSpans.clear();
    for (const st of this.strokes) this.resolveSpan(st);
    this.undoStack = [];
    this.redoStack = [];
    this.needsInk = true;
    this.schedule();
    this.updateToolbar();
  }

  get storePath(): string {
    return this.store.path;
  }

  externalChange(): Promise<void> {
    return this.store.externalChange();
  }

  /** Commit the stroke in progress and write the annotations now. */
  flush(): Promise<void> {
    if (this.active) this.endStroke();
    this.objects.finishEdit();
    return this.store.flush();
  }

  /** The note was renamed / moved together with its annotation file. */
  moved(mdPath: string, inkPath: string): void {
    this.store.moved(mdPath, inkPath);
  }

  setStatus(s: InkStatus): void {
    this.toolbar.setStatus(s);
  }

  /** Before saving: the anchors' lines as they are now. */
  refreshAnchors(doc: HandNoteDocument): void {
    const d = this.view.state.doc;
    for (const st of doc.pages[0]?.strokes ?? []) {
      const r = this.spanPos.get(st.id);
      if (!st.span || !st.anchor || !r) continue;
      const line = d.lineAt(Math.min(d.length, r.from));
      if (r.to > line.to) continue;
      st.anchor.line = line.number;
      st.anchor.text = anchorText(line.text);
      st.span.s = r.from - line.from;
      st.span.e = r.to - line.from;
      st.span.t = line.text.slice(st.span.s, st.span.e).slice(0, 400);
      this.pos.set(st.id, line.from);
    }
    for (const s of [...(doc.pages[0]?.strokes ?? []), ...(doc.pages[0]?.items ?? [])]) {
      if ('samples' in s && s.span && this.spanPos.has(s.id)) continue;
      const p = this.pos.get(s.id);
      if (!s.anchor || p === undefined) continue;
      const line = d.lineAt(Math.min(d.length, Math.max(0, p)));
      s.anchor.line = line.number;
      s.anchor.text = anchorText(line.text);
    }
    const page = doc.pages[0];
    if (page) {
      page.width = Math.max(100, Math.round(this.view.contentDOM.offsetWidth || 700));
      page.height = Math.min(100000, Math.max(100, Math.round(this.view.contentHeight / this.hUnit())));
    }
  }

  private commit(after: Stroke[]): void {
    const before = this.strokes;
    this.setStrokes(after);
    this.pushUndo({ strokes: { before, after } });
  }

  private pushUndo(op: UndoOp): void {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.updateToolbar();
  }

  private setStrokes(list: Stroke[]): void {
    this.strokes = list;
    this.inkX = undefined;
    // highlighters on text restored by undo find their characters again
    for (const st of list) if (st.span) this.resolveSpan(st);
    const page = this.store.doc?.pages[0];
    if (page) page.strokes = list;
    this.store.markDirty();
    this.needsInk = true;
    this.schedule();
  }

  undo(): void {
    if (this.objects.isEditingText) this.objects.finishEdit();
    const op = this.undoStack.pop();
    if (!op || this.readOnly) return;
    this.redoStack.push(op);
    this.lasso.clear();
    if (op.items) this.setItems(op.items.before);
    if (op.strokes) this.setStrokes(op.strokes.before);
    this.updateToolbar();
  }

  redo(): void {
    if (this.objects.isEditingText) this.objects.finishEdit();
    const op = this.redoStack.pop();
    if (!op || this.readOnly) return;
    this.undoStack.push(op);
    this.lasso.clear();
    if (op.items) this.setItems(op.items.after);
    if (op.strokes) this.setStrokes(op.strokes.after);
    this.updateToolbar();
  }

  // ---------------------------------------------------------------------------------------------
  // Text boxes, images, shapes
  // ---------------------------------------------------------------------------------------------

  private get page(): Page | null {
    return this.store.doc?.pages[0] ?? null;
  }

  /**
   * The note as one page: document px. For the object controller (`objects`) a view of it without
   * an edge (a text box may start in the margin); the lasso gets the page itself.
   */
  private pageRect(objects = true): PageRect | null {
    const page = this.page;
    if (!page) return null;
    if (!objects) return { page, index: 0, x: 0, y: 0, w: Math.max(100, this.view.contentDOM.offsetWidth), h: Math.max(100, this.view.contentHeight / this.hUnit()) };
    if (!this.pageView) {
      this.pageView = new Proxy(page, {
        get: (target, key, recv): unknown => (key === 'board' ? true : (Reflect.get(target, key, recv) as unknown)),
      });
    }
    return { page: this.pageView, index: 0, x: 0, y: 0, w: Math.max(100, this.view.contentDOM.offsetWidth), h: Math.max(100, this.view.contentHeight / this.hUnit()) };
  }

  /** Camera of the object overlay: overlay px = (document px − cam) × zoom. */
  private objCamera(): Cam {
    const g = this.geo();
    const hr = this.objHost.getBoundingClientRect();
    return { x: -(g.cx - hr.left) / g.sx, y: -(g.cy - hr.top) / g.sy, zoom: g.sx };
  }

  /** An item change by the controller (already in page.items): anchored, one undo step. */
  private commitItems(before: Item[], after: Item[]): void {
    const page = this.page;
    if (!page) return;
    const prev = new Map(before.map((i) => [i.id, i]));
    let changed = false;
    const anchored = after.map((it) => {
      const o = prev.get(it.id);
      if (o && o.anchor && o.x === it.x && o.y === it.y && o.w === it.w && o.h === it.h) return it;
      changed = true;
      return this.anchorItem(it);
    });
    const final = changed ? anchored : after;
    page.items = final;
    this.store.markDirty();
    this.inkX = undefined;
    this.pushUndo({ items: { before, after: final } });
    this.needsInk = true;
    this.schedule();
  }

  private setItems(list: Item[]): void {
    const page = this.page;
    if (!page) return;
    this.objects.deselect();
    page.items = list;
    for (const it of list) if (it.anchor && !this.pos.has(it.id)) this.pos.set(it.id, this.view.state.doc.line(relocateLine(it.anchor, this.view.state.doc)).from);
    this.store.markDirty();
    this.inkX = undefined;
    this.needsInk = true;
    this.schedule();
  }

  /** The item belongs to the line at its vertical centre (or the nearest line with text). */
  private anchorItem(it: Item): Item {
    const v = this.view;
    const d = v.state.doc;
    const u = this.hUnit();
    const yc = Math.min(v.contentHeight, Math.max(0, (it.y + it.h / 2) * u));
    const block = v.lineBlockAtHeight(yc);
    const n = pickAnchorLine(d.lineAt(block.from).number, d);
    const line = d.line(n);
    this.pos.set(it.id, line.from);
    return { ...it, anchor: { line: n, text: anchorText(line.text), top: v.lineBlockAt(line.from).top / u } };
  }

  /**
   * Ink and items follow their lines: whatever belongs to a line that moved (text added or
   * removed above) is moved by as much, and its anchor with it — the annotations are always kept
   * at the layout of today (not an undo step; saved). The lasso and the object tools then work on
   * the positions they see. `force`: also while something is being edited (a new loop starts).
   */
  private followLines(force = false): boolean {
    const page = this.page;
    if (!page) return false;
    if (!force && (this.objects.busy || this.objects.isEditingText || this.lasso.busy || this.active || this.erase)) return false;
    const len = this.view.state.doc.length;
    const u = this.hUnit();
    const shiftOf = (id: string, a: { top: number } | undefined): number => {
      const p = this.pos.get(id);
      if (!a || p === undefined) return 0;
      const dy = this.view.lineBlockAt(Math.min(len, Math.max(0, p))).top / u - a.top;
      return Math.abs(dy) < 0.25 ? 0 : dy;
    };
    let movedS = false;
    const strokes = this.strokes.map((st) => {
      const dy = shiftOf(st.id, st.anchor);
      if (!dy || !st.anchor) return st;
      movedS = true;
      const n: Stroke = { ...st, samples: st.samples.map((q) => ({ ...q, y: q.y + dy })), anchor: { ...st.anchor, top: st.anchor.top + dy } };
      if (st.geom) n.geom = quantizeGeometry({ xs: st.geom.xs.slice(), ys: st.geom.ys.map((v) => v + dy), rs: st.geom.rs.slice() });
      return n;
    });
    let movedI = false;
    const items = page.items.map((it) => {
      const dy = shiftOf(it.id, it.anchor);
      if (!dy || !it.anchor) return it;
      movedI = true;
      return { ...moveItem(it, 0, dy, true), anchor: { ...it.anchor, top: it.anchor.top + dy } };
    });
    if (!movedS && !movedI) return false;
    if (movedS) {
      this.strokes = strokes;
      page.strokes = strokes;
    }
    if (movedI) page.items = items;
    this.store.markDirty();
    this.inkX = undefined;
    this.needsInk = true;
    this.objects.sync();
    this.lasso.sync();
    return true;
  }

  private updateSkip(): void {
    this.skipItems = this.skipLasso.size ? new Set([...this.skipObj, ...this.skipLasso]) : this.skipObj;
    this.needsInk = true;
    this.schedule();
  }

  /**
   * An operation of the lasso (move, scale, rotate, recolour, delete, paste, group…): applied and
   * recorded as one undo step; what changed is anchored to the line it is on now.
   */
  private applyOp(op: Op): void {
    const page = this.page;
    if (!page) return;
    const ops = op.kind === 'batch' ? op.ops : [op];
    const undo: UndoOp = {};
    for (const o of ops) {
      if (o.kind === 'set-strokes') {
        const before = new Set(o.before);
        const old = new Map(o.before.map((st) => [st.id, st]));
        const after = o.after.flatMap((st) => {
          if (before.has(st)) return [st];
          // a highlighter on text that was only recoloured / grouped stays on its text; one that was
          // moved, scaled or rotated leaves it (one ordinary stroke per row)
          const prev = old.get(st.id);
          if (st.span) {
            const same = !!prev && prev.samples.length === st.samples.length && prev.samples.every((q, i) => q.x === st.samples[i].x && q.y === st.samples[i].y);
            if (same) return [st];
            return this.splitSpan(st).map((c) => {
              this.anchor(c);
              return c;
            });
          }
          const c: Stroke = { ...st };
          this.anchor(c);
          return [c];
        });
        undo.strokes = { before: undo.strokes?.before ?? this.strokes, after };
        this.setStrokes(after);
      } else if (o.kind === 'set-items') {
        const before = new Set(o.before);
        const after = o.after.map((it) => (before.has(it) ? it : this.anchorItem(it)));
        undo.items = { before: undo.items?.before ?? o.before, after };
        page.items = after;
        this.store.markDirty();
        this.inkX = undefined;
      }
    }
    if (!undo.strokes && !undo.items) return;
    this.pushUndo(undo);
    this.needsInk = true;
    this.schedule();
    this.updateToolbar();
  }

  /** Lasso: colour of the selection. */
  private openLassoColor(anchor: HTMLElement): void {
    const p = this.openPopover('lasso-color', anchor, 'hn-color-panel');
    if (!p) return;
    const s = this.host.settings();
    renderColorPanel(p.el, {
      palette: s.inkPalette,
      current: '',
      onPick: (c) => this.lasso.recolor(c),
      onAdd: (c) => {
        s.inkPalette = addPaletteColor(s.inkPalette, c);
        this.host.settingsChanged(s);
        this.lasso.recolor(c.toLowerCase());
      },
    });
    p.place('center');
  }

  /** The system image picker (inside the tap that asked for it). */
  private pickImage(): void {
    if (this.readOnly) return;
    this.fileInput.click();
  }

  /** An image from the picker: embedded in the annotation file, in the middle of the view. */
  private async insertImage(file: File): Promise<void> {
    const page = this.page;
    const r = this.pageRect();
    if (!page || !r || this.readOnly) return;
    if (file.size > MAX_IMAGE_BYTES) {
      new Notice(t('pasteImageTooLarge'), 5000);
      return;
    }
    try {
      const asset = await makeAsset(file);
      const doc = this.store.doc;
      if (!doc) return;
      doc.assets = { ...(doc.assets ?? {}), [asset.id]: asset };
      registerAssets({ [asset.id]: asset });
      const sc = this.view.scrollDOM;
      const g = this.geo();
      const sr = sc.getBoundingClientRect();
      const viewW = sc.clientWidth / g.sx;
      const k = Math.min(1, (Math.min(r.w, viewW) * 0.6) / asset.w, (sc.clientHeight / g.sy) * 0.5 / asset.h);
      const w = Math.max(20, asset.w * k);
      const h = Math.max(20, asset.h * k);
      const cx = (sr.left + sr.width / 2 - g.cx) / g.sx;
      const cy = (sr.top + sr.height / 2 - g.cy) / g.sy;
      const item: Item = { id: newId('i'), type: 'image', x: cx - w / 2, y: cy - h / 2, w, h, created: Date.now(), src: `asset:${asset.id}`, natW: asset.w, natH: asset.h };
      const before = page.items;
      page.items = [...before, item];
      this.commitItems(before, page.items);
      if (this.tool !== 'image') this.setTool('image');
      this.objects.select(page.id, item.id);
      new Notice(t('imageInserted'), 3000);
    } catch (err) {
      console.error('HandNote: image insert failed', err);
      new Notice(t('imageFailed'), 5000);
    }
  }

  /** The sub-toolbar shows (and edits) the selected item's style (as in a note). */
  private onSelection(it: Item | null): void {
    if (!it) return;
    const s = this.host.settings();
    if (it.type === 'shape') s.shape = { ...s.shape, color: it.stroke, strokeWidth: it.strokeWidth, fill: !!it.fill, fillOpacity: it.fillOpacity, dash: it.dash ?? 'solid' };
    else if (it.type === 'text') s.text = { size: it.size, color: it.color, font: it.font, bold: it.bold, italic: it.italic, align: it.align };
    this.updateToolbar();
  }

  private openPopover(kind: string, anchor: HTMLElement, cls: string): Popover | null {
    const same = this.popKind === kind;
    this.closePopover();
    if (same) return null;
    const p = new Popover(this.popRoot, anchor, cls, () => {
      if (this.popover === p) {
        this.popover = null;
        this.popKind = null;
      }
    });
    this.popover = p;
    this.popKind = kind;
    return p;
  }

  private closePopover(): void {
    this.popover?.close();
    this.popover = null;
    this.popKind = null;
  }

  private setTextStyle(patch: Partial<EditorSettings['text']>): void {
    const s = this.host.settings();
    s.text = { ...s.text, ...patch };
    this.changed();
    if (this.objects.selected?.type === 'text') this.objects.applyStyle(patch);
  }

  /** Every annotation of the note: ink, text boxes, images, shapes (one undo step). */
  clearAll(): void {
    const page = this.page;
    if (this.readOnly || (!this.strokes.length && !page?.items.length)) return;
    this.objects.finishEdit();
    this.objects.deselect();
    this.lasso.clear();
    const op: UndoOp = {};
    if (this.strokes.length) op.strokes = { before: this.strokes, after: [] };
    if (page?.items.length) op.items = { before: page.items, after: [] };
    if (op.strokes) this.setStrokes([]);
    if (op.items) this.setItems([]);
    this.pushUndo(op);
    this.updateToolbar();
  }


  // ---------------------------------------------------------------------------------------------
  // CodeMirror updates
  // ---------------------------------------------------------------------------------------------

  update(u: ViewUpdate): void {
    if (this.closed) return;
    if (u.docChanged && this.spanPos.size) {
      for (const [id, r] of this.spanPos) {
        // typing at either edge does not extend the highlight
        const from = u.changes.mapPos(r.from, 1);
        const to = u.changes.mapPos(r.to, -1);
        if (to > from) this.spanPos.set(id, { from, to });
        else {
          this.spanPos.delete(id);
          this.lostSpans.add(id);
        }
      }
    }
    // a highlighter on text that the editor renders only now (scrolled into view) takes its place
    if (u.viewportChanged && this.spanPos.size) {
      this.needsInk = true;
      this.schedule();
    }
    if (u.docChanged && this.pos.size) {
      for (const [id, p] of this.pos) this.pos.set(id, u.changes.mapPos(p, 1));
      // the lines moved: save their new numbers a moment after the typing stops
      window.clearTimeout(this.anchorTimer);
      this.anchorTimer = window.setTimeout(() => this.checkAnchors(), ANCHOR_CHECK_MS);
    }
    // the ink does not depend on which lines the editor has rendered (viewportChanged): it is
    // drawn again only when lines moved or changed height
    if (u.docChanged || u.geometryChanged || u.heightChanged) {
      this.needsInk = true;
      if (u.docChanged) this.settle = Math.max(this.settle, 2);
      this.schedule();
    }
    if (u.focusChanged && !this.view.hasFocus && this.typing) {
      // typing ended (keyboard closed, tapped elsewhere): back to ink — after this update (a
      // dispatch inside an update throws, and CodeMirror then drops the extension)
      window.setTimeout(() => {
        if (this.closed || this.view.hasFocus) return;
        this.typing = false;
        this.applyLock();
      }, 0);
    }
  }

  private checkAnchors(): void {
    const d = this.view.state.doc;
    for (const s of [...this.strokes, ...(this.page?.items ?? [])]) {
      const p = this.pos.get(s.id);
      if (!s.anchor || p === undefined) continue;
      const line = d.lineAt(Math.min(d.length, Math.max(0, p)));
      if (line.number !== s.anchor.line || anchorText(line.text) !== s.anchor.text) {
        this.store.markDirty();
        return;
      }
    }
  }

  /** Where a stroke is drawn now, relative to where it was written (its line moved). */
  private shift(s: Stroke): number {
    const a = s.anchor;
    if (!a) return 0;
    let p = this.pos.get(s.id);
    if (p === undefined) {
      const d = this.view.state.doc;
      p = d.line(relocateLine(a, d)).from;
      this.pos.set(s.id, p);
    }
    const len = this.view.state.doc.length;
    return this.view.lineBlockAt(Math.min(len, Math.max(0, p))).top / this.hUnit() - a.top;
  }

  /**
   * CodeMirror height units per document px. Obsidian's editor measures line heights in screen px
   * when it is scaled (zoomed): then its heights are the zoom × document px. Detected from the
   * editor itself (its content height against the layout height), so it is right while the
   * editor is still re-measuring after a zoom too.
   */
  private hUnit(): number {
    const v = this.view;
    const sy = v.scaleY || 1;
    const off = v.contentDOM.offsetHeight;
    if (Math.abs(sy - 1) < 1e-3 || off <= 0) return 1;
    const r = v.contentHeight / off;
    return Math.abs(r - sy) < Math.abs(r - 1) ? sy : 1;
  }

  private box(s: Stroke): Box {
    let b = this.boxes.get(s);
    if (!b) {
      b = sampleBounds(s.samples, s.params.width);
      this.boxes.set(s, b);
    }
    return b;
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.raf || this.closed) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.frame();
    });
  }

  private frame(): void {
    if (this.closed) return;
    // lines moved: the editor may still adjust its layout and scroll position (it keeps the view
    // on the same text) after this frame — draw again for a few frames until it has settled
    if (this.needsInk && this.followLines()) this.settle = 3;
    if (this.needsInk) this.reflowSpans();
    if (this.placeCanvases() || this.needsInk) this.renderInk();
    if (this.settle > 0) {
      this.settle--;
      this.needsInk = true;
      this.schedule();
    }
    if (this.active) this.renderLive();
    if (!this.nav?.preview) this.syncOverlays();
  }

  /** Client position of document (0, 0) and the editor's scale. */
  private geo(): Geo {
    const v = this.view;
    const cr = v.contentDOM.getBoundingClientRect();
    return { cx: cr.left, cy: v.documentTop, sx: v.scaleX || 1, sy: v.scaleY || 1, bs: this.boxScale() };
  }

  /** Scale of the editor box: screen px per px inside it (1, or the zoom). */
  private boxScale(): number {
    const ed = this.view.dom;
    const w = ed.offsetWidth;
    return w > 0 ? ed.getBoundingClientRect().width / w || 1 : 1;
  }

  /** Document origin in scroll-content px (one layout read). */
  private origin(g: Geo): { ox: number; oy: number } {
    const sc = this.view.scrollDOM;
    const sr = sc.getBoundingClientRect();
    return { ox: (g.cx - sr.left) / g.bs - sc.clientLeft + sc.scrollLeft - this.panX, oy: (g.cy - sr.top) / g.bs - sc.clientTop + sc.scrollTop };
  }

  /** The visible part is still inside the ink canvas (no layout read: called on every scroll). */
  private covered(): boolean {
    const sc = this.view.scrollDOM;
    const c = this.cv;
    const top = sc.scrollTop;
    const left = sc.scrollLeft - this.panX;
    return c.w > 0 && c.zoom === this.zoom && left >= c.left - 1 && left + sc.clientWidth <= c.left + c.w + 1 && top >= c.top - 1 && top + sc.clientHeight <= c.top + c.h + 1;
  }

  private onScroll(): void {
    const sc = this.view.scrollDOM;
    if (sc.scrollLeft !== 0) {
      // the editor scrolled sideways by itself. Right after a zoom that is a leftover of its own
      // scrolling (it would throw a zoom on the right of the note back to the left): undone.
      // Otherwise (keeping the caret in view while typing) it is kept, as panX.
      const d = sc.scrollLeft;
      sc.scrollLeft = 0;
      if (performance.now() - this.zoomedAt > 1500) this.setPanX(this.panX - d);
    }
    if (sc.clientHeight > 1 && !this.hidden) {
      // the Pencil is writing and the note scrolled: not HandNote (diagnostics)
      if (this.router.state === 'PenDrawing' && Math.abs(sc.scrollTop - this.lastTop) > 2) this.penScrolls++;
      this.lastTop = sc.scrollTop;
    }
    if (!this.covered()) this.schedule();
    else this.syncOverlays();
  }

  /** The object selection / text editor and the lasso selection follow the view. */
  private syncOverlays(): void {
    if (this.objects.selected || this.objects.isEditingText) this.objects.sync();
    if (this.lasso.selection) this.lasso.sync();
  }

  /**
   * Keep the ink canvas over the visible part of the note (+ half a screen above and below),
   * inside the scroll content, so that it scrolls natively; moved only when the view leaves it.
   * Returns true when it was moved or resized (then the ink is drawn again).
   */
  private placeCanvases(): boolean {
    const sc = this.view.scrollDOM;
    const vw = sc.clientWidth;
    const vh = sc.clientHeight;
    if (vw < 2 || vh < 2) return false;
    // canvas pixels per scroll px: sharp at the zoom of the box
    const dpr = Math.min(window.devicePixelRatio || 1, 3) * this.boxScale();
    if (this.covered() && Math.abs(this.cv.dpr - dpr) < 1e-3 && this.cv.vw === vw) return false;
    this.sizeClip();
    // overscan: half a screen above and below; a little to the sides when the view can move sideways
    const cam = this.camNow();
    const wide = this.clampCam({ ...cam, x: -1e9 }).x < cam.x - 1 || this.clampCam({ ...cam, x: 1e9 }).x > cam.x + 1;
    let ov = OVERSCAN;
    let ovx = wide ? 0.25 : 0;
    const px = () => vw * (1 + 2 * ovx) * dpr * vh * (1 + 2 * ov) * dpr;
    while (ov > 0.2 && px() > MAX_CANVAS_PX) ov -= 0.1;
    while (ovx > 0 && px() > MAX_CANVAS_PX) ovx = Math.max(0, ovx - 0.05);
    while (ov > 0.05 && px() > MAX_CANVAS_PX) ov -= 0.05;
    const top = sc.scrollTop;
    const h = Math.round(vh * (1 + 2 * ov));
    const w = Math.round(vw * (1 + 2 * ovx));
    const c = this.cv;
    c.left = Math.round(sc.scrollLeft - this.panX - vw * ovx);
    c.top = Math.max(0, Math.round(top - vh * ov));
    c.w = w;
    c.vw = vw;
    c.h = h;
    c.dpr = dpr;
    c.zoom = this.zoom;
    this.place(this.inkCanvas, c.left, c.top, w, h, dpr);
    return true;
  }

  private place(cv: HTMLCanvasElement, left: number, top: number, w: number, h: number, dpr: number): void {
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    cv.style.left = `${left}px`;
    cv.style.top = `${top}px`;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  }

  /** The clip covers the content exactly (it never makes the note scroll further). */
  private sizeClip(): void {
    const sc = this.view.scrollDOM;
    const sr = sc.getBoundingClientRect();
    const zr = (this.sizer ?? this.view.contentDOM).getBoundingClientRect();
    const bs = this.boxScale();
    const w = Math.round(Math.max(sc.clientWidth, (zr.right - sr.left) / bs - sc.clientLeft + sc.scrollLeft));
    const h = Math.round(Math.max(sc.clientHeight, (zr.bottom - sr.top) / bs - sc.clientTop + sc.scrollTop + 40));
    if (w !== this.clipW) {
      this.clipW = w;
      this.clip.style.width = `${w}px`;
    }
    if (h !== this.clipH) {
      this.clipH = h;
      this.clip.style.height = `${h}px`;
    }
  }

  /** ctx transform: document px (shifted by `dy`) → pixels of a canvas at (left, top). */
  private docTransform(ctx: CanvasRenderingContext2D, g: Geo, o: { ox: number; oy: number }, left: number, top: number, dpr: number, dy: number): void {
    // document px → scroll px (the box carries the zoom) → canvas pixels
    const sx = g.sx / g.bs;
    const sy = g.sy / g.bs;
    ctx.setTransform(dpr * sx, 0, 0, dpr * sy, dpr * (o.ox - left), dpr * (o.oy - top + dy * sy));
  }

  private renderInk(): void {
    this.needsInk = false;
    const ctx = this.inkCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
    const page = this.page;
    if ((!this.strokes.length && !page?.items.length) || this.cv.w === 0) return;
    const g = this.geo();
    const o = this.origin(g);
    const c = this.cv;
    const y0 = ((c.top - o.oy) * g.bs) / g.sy;
    const y1 = ((c.top + c.h - o.oy) * g.bs) / g.sy;
    const skip = this.skipStrokes;
    // text boxes, images and shapes are kept at today's layout (followLines): no shift
    if (page?.items.length) {
      this.docTransform(ctx, g, o, c.left, c.top, c.dpr, 0);
      paintItemsBelow(ctx, page, this.skipItems);
    }
    for (const s of this.strokes) {
      if (skip.has(s.id)) continue;
      const dy = this.shift(s);
      const b = this.box(s);
      if (b.y1 + dy < y0 || b.y0 + dy > y1) continue;
      this.docTransform(ctx, g, o, c.left, c.top, c.dpr, dy);
      const rows = this.spanChunks(s);
      if (rows) for (const gm of rows) paintInkStroke(ctx, s, gm);
      else paintInkStroke(ctx, s, this.cache.get(s));
    }
    ctx.globalAlpha = 1;
    if (page?.items.length) {
      this.docTransform(ctx, g, o, c.left, c.top, c.dpr, 0);
      paintItemsAbove(ctx, page, this.skipItems);
      ctx.globalAlpha = 1;
    }
  }

  /** The live canvas: the visible part of the note when the stroke started (it does not scroll meanwhile). */
  private placeLive(): void {
    const sc = this.view.scrollDOM;
    const dpr = Math.min(window.devicePixelRatio || 1, 3) * this.boxScale();
    const l = this.lv;
    l.left = Math.round(sc.scrollLeft - this.panX);
    l.top = Math.round(sc.scrollTop);
    l.w = sc.clientWidth;
    l.h = sc.clientHeight;
    l.dpr = dpr;
    this.place(this.liveCanvas, l.left, l.top, l.w, l.h, dpr);
    this.liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
  }

  private clearLive(): void {
    const ctx = this.liveCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
  }

  private renderLive(): void {
    const a = this.active;
    this.clearLive();
    if (!a) return;
    const ctx = this.liveCtx;
    const st = a.builder.stable();
    const tl = a.builder.tail(undefined);
    const xs = [...st.xs, ...tl.xs];
    const ys = [...st.ys, ...tl.ys];
    const rs = [...st.rs, ...tl.rs];
    const l = this.lv;
    this.docTransform(ctx, a.geo, a.origin, l.left, l.top, l.dpr, 0);
    ctx.fillStyle = a.tool === 'pencil' ? pencilFill(ctx, a.color) : a.color;
    ctx.beginPath();
    if (xs.length) emitStroke(new CanvasPathSink(ctx), xs, ys, rs, 0, xs.length === 1);
    else if (a.builder.rawCount > 0) {
      const s0 = a.builder.rawSamples[0];
      ctx.arc(s0.x, s0.y, a.builder.params.width / 2, 0, Math.PI * 2);
    }
    ctx.fill('nonzero');
  }

  private drawEraserCursor(x: number, y: number, r: number, er: ActiveErase): void {
    const ctx = this.liveCtx;
    const g = er.geo;
    this.clearLive();
    const l = this.lv;
    this.docTransform(ctx, g, er.origin, l.left, l.top, l.dpr, 0);
    ctx.strokeStyle = 'rgba(120,120,120,0.9)';
    ctx.fillStyle = 'rgba(120,120,120,0.08)';
    ctx.lineWidth = 1 / g.sx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // ---------------------------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------------------------

  private get tool(): Tool {
    return this.host.settings().tool;
  }

  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts: AddEventListenerOptions): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  /** The shield is up: every pointer on the note goes through HandNote's input router. */
  private shielded(): boolean {
    return this.clip.hasClass('hn-ink-shield');
  }

  private bindInput(): void {
    const sc = this.view.scrollDOM;
    const cap = { capture: true, passive: false };
    this.on(sc, 'pointerdown', (e) => this.pointerDown(e), cap);
    this.on(sc, 'pointermove', (e) => this.pointerMove(e), cap);
    this.on(sc, 'pointerup', (e) => this.pointerEnd(e, false), cap);
    this.on(sc, 'pointercancel', (e) => this.pointerEnd(e, true), cap);
    this.on(sc, 'lostpointercapture', (e) => this.router.lostCapture(e.pointerId, e.timeStamp), { capture: true });
    // with the shield up, no touch reaches the browser (no native scrolling, selection, loupe or
    // Scribble): the router pans and zooms, exactly as in a HandNote note. Without it (text tool,
    // typing) touches are native; two fingers still zoom.
    this.on(sc, 'touchstart', (e) => this.touchStart(e), cap);
    this.on(sc, 'touchmove', (e) => this.touchMove(e), cap);
    this.on(sc, 'touchend', (e) => this.touchEnd(e), cap);
    this.on(sc, 'touchcancel', (e) => this.touchEnd(e), cap);
    this.on(sc, 'click', (e) => this.guardClick(e), cap);
    this.on(sc, 'wheel', (e) => this.wheel(e), cap);
    this.on(sc, 'scroll', () => this.onScroll(), { passive: true });
    // self-heal: when the last finger / Pencil leaves the screen, every open contact is over even
    // if its pointerup was lost (as in the note editor)
    const lifted = (e: TouchEvent) => {
      if (e.touches.length) return;
      window.setTimeout(() => {
        if (!this.closed && this.router.contactCount) this.router.liftAll(performance.now());
      }, 300);
    };
    this.on(document.body, 'touchend', lifted, { capture: true, passive: true });
    // a new text box: iPadOS opens the keyboard only for a focus inside the touch gesture
    const flushFocus = () => {
      if (!this.objects.pendingFocus) return;
      this.objects.focusEditor();
      this.objects.pendingFocus = null;
    };
    this.on(document.body, 'touchend', flushFocus, { capture: true });
    this.on(document.body, 'click', flushFocus, { capture: true });
    this.on(document.body, 'touchcancel', lifted, { capture: true, passive: true });
    const ro = new ResizeObserver(() => {
      // the tab switched to the reading view (the editor is hidden; no workspace event for that)
      if (this.md.getMode() !== 'source' || this.md.file !== this.file) {
        this.host.exit();
        return;
      }
      // hidden for a moment (a sidebar drawer, another tab): a box without size has lost its
      // scroll position — put it back when it is shown again
      if (sc.clientHeight < 2) {
        this.hidden = true;
        return;
      }
      if (this.hidden) {
        this.hidden = false;
        if (Math.abs(sc.scrollTop - this.lastTop) > 2) sc.scrollTop = this.lastTop;
      }
      this.layoutZoom();
      if (this.panX) this.panTo(this.camNow());
      this.cv.w = 0;
      this.needsInk = true;
      this.schedule();
    });
    ro.observe(sc);
    // the tab itself (the editor box has a fixed size while zoomed)
    const parent = this.view.dom.parentElement;
    if (parent) ro.observe(parent);
    this.disposers.push(() => ro.disconnect());
  }

  /** Pointer in viewport-local px (the scroll container, measured without a pinch preview). */
  private normalize(e: PointerEvent): RouterPointer {
    const r = this.vpRect;
    const kind: PointerKind = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'mouse' ? 'mouse' : 'touch';
    return { id: e.pointerId, kind, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, button: e.button, buttons: e.buttons, pressure: e.pressure, width: e.width, height: e.height };
  }

  private pointerDown(e: PointerEvent): void {
    // controls on the ink layer (selection bar) handle their own taps
    if ((e.target as Element | null)?.closest?.('.hn-ink-selbar')) return;
    if (!this.shielded()) {
      // text tool / typing: the editor gets everything, except the Pencil with an ink tool
      // (typing ends: the Pencil writes again)
      if (!(e.pointerType === 'pen' && this.inkToolSelected() && !this.readOnly)) return;
      this.typing = false;
      this.applyLock();
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.pointerType === 'pen') this.probe(e);
    if (!this.nav?.base) this.vpRect = this.view.scrollDOM.getBoundingClientRect();
    this.inertia = null;
    this.evt = e;
    const owner = this.router.down(this.normalize(e));
    this.evt = null;
    if (owner === null) return;
    try {
      this.view.scrollDOM.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events cannot be captured */
    }
  }

  private pointerMove(e: PointerEvent): void {
    if (this.router.ownerOf(e.pointerId) === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.evt = e;
    this.router.move(this.normalize(e), e);
    this.evt = null;
  }

  private pointerEnd(e: PointerEvent, cancelled: boolean): void {
    if (this.router.ownerOf(e.pointerId) === undefined) return;
    e.stopPropagation();
    this.evt = e;
    const p = this.normalize(e);
    if (cancelled) this.router.cancel(p);
    else this.router.up(p);
    this.evt = null;
  }

  /** What was under the pen (diagnostics). */
  private probe(e: PointerEvent): void {
    this.lastProbe = {
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      stack: document
        .elementsFromPoint(e.clientX, e.clientY)
        .slice(0, 8)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}${(el as HTMLElement).isContentEditable ? ' [editable]' : ''}`),
    };
  }

  /** A link under a stroke is not opened when the pen lifts. */
  private guardClick(e: MouseEvent): void {
    if (performance.now() - this.lastInkEnd < CLICK_GUARD_MS) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private touchStart(e: TouchEvent): void {
    if ((e.target as Element | null)?.closest?.('.hn-ink-selbar')) return;
    if (this.shielded()) {
      // as in a note: no native scrolling, and Obsidian's own touch gestures (swipe to open a
      // sidebar) do not see the touch either — the router pans sideways instead
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      return;
    }
    // no shield (text tool, typing): native, but two fingers zoom
    const fingers = Array.from(e.touches).filter((tc) => (tc as Touch & { touchType?: string }).touchType !== 'stylus');
    if (Array.from(e.changedTouches).some((tc) => (tc as Touch & { touchType?: string }).touchType === 'stylus')) {
      if (this.inkToolSelected() && e.cancelable) e.preventDefault();
      return;
    }
    if (fingers.length === 2 && !this.pinch) {
      if (e.cancelable) e.preventDefault();
      this.startPinch(fingers[0], fingers[1]);
      // typing ends: iPadOS would scroll the view back to the caret after the zoom (the view
      // jumped away from where the fingers zoomed)
      if (this.typing) {
        this.typing = false;
        this.view.contentDOM.blur();
        this.applyLock();
      }
    }
  }

  private touchMove(e: TouchEvent): void {
    if (this.shielded() && !this.pinch) {
      if ((e.target as Element | null)?.closest?.('.hn-ink-selbar')) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      return;
    }
    const p = this.pinch;
    if (!p) return;
    if (e.cancelable) e.preventDefault();
    const a = Array.from(e.touches).find((tc) => tc.identifier === p.ids[0]);
    const b = Array.from(e.touches).find((tc) => tc.identifier === p.ids[1]);
    if (!a || !b) return;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    p.k = Math.min(MAX_ZOOM / this.zoom, Math.max(MIN_ZOOM / this.zoom, d / p.d0));
    p.fx = (a.clientX + b.clientX) / 2;
    p.fy = (a.clientY + b.clientY) / 2;
    this.preview(p.cam, this.pinchCamera(p));
  }

  /** Camera of a two-finger zoom: the point under the fingers when they landed stays under them. */
  private pinchCamera(p: Pinch): Cam {
    const sc = this.view.scrollDOM;
    const z0 = p.cam.zoom;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z0 * p.k));
    const l = p.rect.left + sc.clientLeft * z0;
    const t = p.rect.top + sc.clientTop * z0;
    const wx = p.cam.x + (p.f0x - l) / z0;
    const wy = p.cam.y + (p.f0y - t) / z0;
    return { x: wx - (p.fx - l) / z, y: wy - (p.fy - t) / z, zoom: z };
  }

  private touchEnd(e: TouchEvent): void {
    const pinching = this.pinch;
    if (pinching) {
      const left = Array.from(e.touches).filter((tc) => tc.identifier === pinching.ids[0] || tc.identifier === pinching.ids[1]);
      if (left.length < 2) this.endPinch();
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (this.shielded() || this.focusPending) {
      // a finger tap asked for the caret: focus inside the touch gesture (iPadOS opens the
      // keyboard only from a touch handler)
      if (this.focusPending) {
        this.focusPending = false;
        this.view.focus();
      }
      if (this.shielded() && !(e.target as Element | null)?.closest?.('.hn-ink-selbar')) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
  }

  /**
   * A finger tap (the router saw one finger go down and up without moving): links, checkboxes,
   * fold arrows… are clicked; on text the editor becomes editable and the caret goes there.
   */
  private fingerTap(x: number, y: number): void {
    if (this.editable || this.readOnly) return;
    const target = this.under(x, y);
    if (!target || !this.view.scrollDOM.contains(target)) return;
    if (this.lasso.selection) {
      // a tap outside the lasso selection drops it
      this.lasso.clear();
      return;
    }
    const control = target.closest<HTMLElement>(TAPPABLE);
    if (control) {
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.click();
      else {
        // to the innermost element, as a real tap would (Obsidian opens a link from its text span)
        const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
        target.dispatchEvent(new MouseEvent('mousedown', o));
        target.dispatchEvent(new MouseEvent('mouseup', o));
        target.dispatchEvent(new MouseEvent('click', o));
      }
      return;
    }
    const pos = this.view.posAtCoords({ x, y });
    if (pos === null) return;
    this.typing = true;
    this.applyLock();
    this.view.dispatch({ selection: { anchor: pos } });
    // the keyboard: focus from the touchend that follows (or now, without touch)
    this.focusPending = true;
    window.setTimeout(() => {
      if (!this.focusPending) return;
      this.focusPending = false;
      this.view.focus();
    }, 120);
  }

  private wheel(e: WheelEvent): void {
    this.inertia = null;
    if (!(e.ctrlKey || e.metaKey)) {
      // sideways (trackpad, Shift + wheel): the view moves beside the note too; up and down stays
      // native scrolling
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (!dx || this.editable) return;
      e.preventDefault();
      const c = this.camNow();
      this.panTo({ ...c, x: c.x + (dx * (e.deltaMode === 1 ? 16 : 1)) / c.zoom });
      return;
    }
    // Ctrl / ⌘ + wheel, trackpad pinch: zoom at the pointer
    e.preventDefault();
    e.stopPropagation();
    const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    this.zoomTo(this.zoom * k, e.clientX, e.clientY);
  }

  // ---------------------------------------------------------------------------------------------
  // Router (the same rules as in a HandNote note: pen / finger / palm, pan, pinch, taps)
  // ---------------------------------------------------------------------------------------------

  private routerHost(): RouterHost {
    return {
      getCamera: () => this.nav?.preview ?? this.camNow(),
      setCamera: (c) => this.setCamera(c),
      minZoom: () => MIN_ZOOM,
      drawKindFor: (p) => (this.tool === 'eraser' || (p.kind === 'pen' && (p.button === 5 || (p.buttons & 32) !== 0)) ? 'erase' : 'ink'),
      canDrawAt: () => this.inkToolSelected() && this.tool !== 'hand' && (!this.readOnly || this.tool === 'laser'),
      inkBegin: () => {
        const e = this.evt;
        if (!e) return;
        const tl = this.tool;
        if (isObjectTool(tl)) {
          const r = this.pageRect();
          if (!r) return;
          const [x, y] = this.docPoint(e, this.geo());
          this.objPointer = e.pointerId;
          this.objects.pointerBegin(r, x, y, e.pointerId);
          return;
        }
        if (tl === 'laser') this.laserBegin(e);
        else if (tl === 'lasso') {
          const r = this.pageRect(false);
          if (!r) return;
          // the ink and the objects at today's layout before the loop is drawn
          this.followLines(true);
          const [x, y] = this.docPoint(e, this.geo());
          this.lassoPointer = e.pointerId;
          this.lasso.pointerBegin(r, x, y, e.pointerId);
        } else if (isInkTool(tl)) this.beginStroke(e, tl);
      },
      inkMove: (_p, raw) => {
        const e = (raw as PointerEvent | null) ?? this.evt;
        if (!e) return;
        if (this.objPointer !== null) {
          const r = this.pageRect();
          const [x, y] = this.docPoint(e, this.geo());
          if (r) this.objects.pointerMove(r, x, y);
          return;
        }
        if (this.laserId !== null) this.laser.move(...this.laserLocal(e));
        else if (this.lassoPointer !== null) {
          const r = this.pageRect(false);
          if (!r) return;
          const g = this.geo();
          const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const ce of list && list.length ? list : [e]) {
            const [x, y] = this.docPoint(ce, g);
            this.lasso.pointerMove(r, x, y);
          }
        } else if (this.active) {
          const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const ce of list && list.length ? list : [e]) this.addSample(ce, this.active);
          this.schedule();
        }
      },
      inkEnd: (_p, commit) => {
        if (this.objPointer !== null) {
          this.objPointer = null;
          const r = this.pageRect();
          const e = this.evt;
          if (commit && r && e) {
            const [x, y] = this.docPoint(e, this.geo());
            this.objects.pointerEnd(r, x, y);
          } else this.objects.cancel();
          return;
        }
        if (this.laserId !== null) {
          this.laserId = null;
          this.laser.end();
          return;
        }
        if (this.lassoPointer !== null) {
          this.lassoPointer = null;
          this.lasso.pointerEnd(this.pageRect(false), commit);
          this.lastInkEnd = performance.now();
          return;
        }
        const a = this.active;
        if (!a) return;
        if (!commit) {
          this.active = null;
          this.blockLive();
          return;
        }
        if (this.evt) this.addSample(this.evt, a, true);
        this.endStroke();
      },
      eraseBegin: () => {
        if (this.evt) this.beginErase(this.evt);
      },
      eraseMove: (_p, raw) => {
        const e = (raw as PointerEvent | null) ?? this.evt;
        const er = this.erase;
        if (!e || !er) return;
        const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        for (const ce of list && list.length ? list : [e]) this.eraseTo(ce, er);
      },
      eraseEnd: () => this.endErase(),
      navStart: () => {
        this.inertia = null;
        const ed = this.view.dom.getBoundingClientRect();
        const sr = this.vpRect;
        this.nav = { base: null, preview: null, offX: sr.left - ed.left, offY: sr.top - ed.top };
        // the editor box becomes its own layer from the first finger on (a pinch preview then
        // starts without repainting it)
        window.clearTimeout(this.layerTimer);
        this.view.dom.addClass('hn-ink-pinching');
      },
      navEnd: (velocity) => {
        const n = this.nav;
        this.nav = null;
        if (n?.preview) this.commitCamera(n.preview);
        // a little later: dropping the layer right at the commit would repaint the same frame
        window.clearTimeout(this.layerTimer);
        this.layerTimer = window.setTimeout(() => {
          if (!this.nav) this.view.dom.removeClass('hn-ink-pinching');
        }, 400);
        if (velocity && Math.hypot(velocity.vx, velocity.vy) >= 0.25) {
          // a glitch in the touch samples must not throw the note to its end
          const v = Math.hypot(velocity.vx, velocity.vy);
          const k = v > MAX_FLING ? MAX_FLING / v : 1;
          this.inertia = { vx: velocity.vx * k, vy: velocity.vy * k, last: performance.now() };
          this.stepInertia();
        }
      },
      undo: () => this.undo(),
      redo: () => this.redo(),
      tap: (p) => {
        if (p.kind !== 'touch') return;
        const cx = p.x + this.vpRect.left;
        const cy = p.y + this.vpRect.top;
        // text / image / shape tool: the tap is the object tool's (a text box where it lands,
        // select an item), as in a note
        const r = isObjectTool(this.tool) ? this.pageRect() : null;
        if (r) {
          const g = this.geo();
          this.objects.tap(r, (cx - g.cx) / g.sx, (cy - g.cy) / g.sy);
          return;
        }
        this.fingerTap(cx, cy);
      },
    };
  }

  /**
   * The visible part as a camera: world = the note at 100 % (sizer px), screen = viewport px.
   * Vertically the note scrolls (native scroll position); horizontally it is moved by `panX` (a
   * transform of the note and the ink), so the view can also go beside the note, to ink written in
   * the margins at a small zoom.
   */
  private camNow(): Cam {
    const sc = this.view.scrollDOM;
    const sz = this.sizer;
    // the box carries the zoom: scroll px are document px
    return { x: sc.scrollLeft - (sz?.offsetLeft ?? 0) - this.panX, y: sc.scrollTop - (sz?.offsetTop ?? 0), zoom: this.zoom };
  }

  /** Size of the scroll area at 100 % (the box is that size divided by the zoom). */
  private baseView(): { w: number; h: number } {
    const sc = this.view.scrollDOM;
    return { w: sc.clientWidth * this.zoom, h: sc.clientHeight * this.zoom };
  }

  /** Left edge of the note at zoom z (scroll px inside the box): centred while narrower than the view. */
  private leftAt(z: number): number {
    const sz = this.sizer;
    if (!sz) return 0;
    if (z === this.zoom) return sz.offsetLeft;
    if (z === 1 && this.baseLeft) return this.baseLeft;
    const sc = this.view.scrollDOM;
    const w = this.zoom === 1 ? sz.offsetWidth : this.baseWidth;
    const cs = getComputedStyle(sc);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return padL + Math.max(0, (this.baseView().w / z - padL - padR - w) / 2);
  }

  /** Horizontal extent of the ink (world px, relative to the note's left edge), or null. */
  private inkSpan(): { x0: number; x1: number } | null {
    if (this.inkX === undefined) {
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const s of this.strokes) {
        const b = this.box(s);
        x0 = Math.min(x0, b.x0);
        x1 = Math.max(x1, b.x1);
      }
      for (const it of this.page?.items ?? []) {
        x0 = Math.min(x0, it.x);
        x1 = Math.max(x1, it.x + it.w);
      }
      this.inkX = x0 <= x1 ? { x0, x1 } : null;
    }
    const span = this.inkX;
    if (!span) return null;
    // ink x is measured from the text's left edge; the note's left edge is a little further left
    const sz = this.sizer;
    const off = sz ? this.view.contentDOM.offsetLeft - (this.view.contentDOM.offsetParent === sz ? 0 : sz.offsetLeft) : 0;
    return { x0: span.x0 + off, x1: span.x1 + off };
  }

  /** Keep the camera on the note and its ink (vertically as far as scrolling goes). */
  private clampCam(c: Cam): Cam {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom));
    const sz = this.sizer;
    const w = this.zoom === 1 ? (sz?.offsetWidth ?? 0) : this.baseWidth;
    const h = sz?.offsetHeight ?? 0;
    const top = sz?.offsetTop ?? 0;
    const base = this.baseView();
    const viewW = base.w / z;
    const viewH = base.h / z;
    // where the camera stands without moving sideways (note centred, or at its left edge)
    const nat = -this.leftAt(z);
    const ink = this.inkSpan();
    // as in a note, the view may go beside the note — up to half a screen of empty margin on each
    // side, and further when there is ink out there
    const margin = Math.max(32 / z, viewW * 0.5);
    const lo = Math.min(0, ink ? ink.x0 : 0) - margin;
    const hi = Math.max(w, ink ? ink.x1 : w) + margin;
    const xmin = Math.min(lo, nat);
    const xmax = Math.max(hi - viewW, nat);
    const x = Math.min(xmax, Math.max(xmin, c.x));
    const maxY = Math.max(0, top + h + 40 / z - viewH);
    const sy = Math.min(maxY, Math.max(0, top + c.y));
    return { x: Number.isFinite(x) ? x : nat, y: sy - top, zoom: z };
  }

  /** Move the view at the current zoom (scroll position + sideways offset). */
  private panTo(want: Cam): Cam {
    const c = this.clampCam({ ...want, zoom: this.zoom });
    const sc = this.view.scrollDOM;
    const z = this.zoom;
    const top = Math.round(((this.sizer?.offsetTop ?? 0) + c.y) * 4) / 4;
    if (Math.abs(sc.scrollTop - top) >= 0.25) sc.scrollTop = top;
    if (sc.scrollLeft !== 0) sc.scrollLeft = 0;
    this.setPanX(-c.x - this.leftAt(z));
    // the ink is redrawn in this same frame when the view leaves the drawn part (no blank strip)
    if (!this.covered()) this.frame();
    else this.syncOverlays();
    return this.camNow();
  }

  /** Sideways offset of the note and its ink (px). */
  private setPanX(x: number): void {
    const v = Math.round(x * 4) / 4;
    if (v === this.panX) return;
    this.panX = v;
    this.applyPan();
  }

  /** The note (its sizer) and the ink layers follow `panX` (transforms: no layout). */
  private applyPan(): void {
    this.layoutZoom();
    const tr = this.panX ? `translate3d(${this.panX}px, 0, 0)` : '';
    for (const e of [this.inkCanvas, this.liveCanvas]) {
      if (tr) e.style.transform = tr;
      else e.style.removeProperty('transform');
    }
  }

  /**
   * The router moves the camera. Same zoom: the note is scrolled. Another zoom (pinch): only a
   * preview — the editor box is transformed as one layer from the camera the pinch started with;
   * the real zoom is set once when the fingers lift.
   */
  private setCamera(want: Cam): Cam {
    const n = this.nav;
    if ((!n || !n.preview) && Math.abs(want.zoom - this.zoom) < 1e-6) return this.panTo(want);
    if (!n) return this.camNow();
    if (!n.base) {
      n.base = this.camNow();
      this.rememberBase();
    }
    const c = this.clampCam(want);
    this.preview(n.base, c);
    n.preview = c;
    return c;
  }

  /** The note at 100 % (width, left edge) before it is zoomed. */
  private rememberBase(): void {
    const sz = this.sizer;
    // (panX is a transform: it changes neither the width nor the layout position)
    if (sz && this.zoom === 1) {
      this.baseWidth = sz.offsetWidth;
      this.baseLeft = sz.offsetLeft;
    }
  }

  /**
   * Pinch preview: the editor box (already scaled by the current zoom) as it would look at camera
   * c — one transform, nothing is laid out again. The overlays (selection, text editor, laser) are
   * hidden meanwhile.
   */
  private preview(b: Cam, c: Cam): void {
    const ed = this.view.dom;
    const sc = this.view.scrollDOM;
    const z0 = this.zoom;
    const zc = c.zoom;
    const tx = (z0 - zc) * sc.offsetLeft + zc * (b.x - c.x);
    const ty = (z0 - zc) * sc.offsetTop + zc * (b.y - c.y);
    ed.addClass('hn-ink-previewbox');
    ed.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zc})`;
    this.md.contentEl.addClass('hn-ink-previewing');
  }

  /**
   * End of a pinch (or a zoom by wheel / button): the real zoom and position of the preview, in
   * the same frame.
   *
   * The editor measures its lines in screen px: at a new scale it estimates the heights of the
   * lines it does not show again and corrects its scroll position to keep the text in view. A
   * scroll position computed before that is wrong afterwards (maintainer: "after zooming in the
   * page jumps up"). So the view is set by a line of the text: the line in the middle of the view
   * is put where the pinch showed it, after the editor has measured at the new scale.
   */
  private commitCamera(c: Cam): void {
    const sc = this.view.scrollDOM;
    const ref = this.refLine(c);
    this.rememberBase();
    this.zoom = Math.abs(c.zoom - 1) < 0.02 ? 1 : c.zoom;
    // the editor box gets its new size and scale (this also replaces the preview transform)
    this.layoutZoom();
    this.md.contentEl.removeClass('hn-ink-previewing');
    this.syncMeasure();
    const sz = this.sizer;
    const cc = this.clampCam({ ...c, zoom: this.zoom });
    sc.scrollTop = (sz?.offsetTop ?? 0) + cc.y;
    if (ref) {
      // the editor scrolls the reference text to about where the pinch showed it, measuring the
      // lines around it first (its own scrolling: its scroll correction does not fight it). The
      // character under the middle of the view is in view sideways, so it never scrolls sideways
      // (zooming in on the right of the note stays on the right).
      try {
        this.view.dispatch({ effects: EditorView.scrollIntoView(ref.caret, { y: 'start', yMargin: ref.top - sc.getBoundingClientRect().top, x: 'nearest' }) });
      } catch {
        /* the editor is updating */
      }
    }
    // then the line is put exactly there; again if measuring moved it
    for (let i = 0; i < 3; i++) {
      this.syncMeasure();
      const el = ref ? this.lineEl(ref.pos) : null;
      if (!el || !ref) break;
      const d = (el.getBoundingClientRect().top - ref.top) / this.boxScale();
      if (Math.abs(d) < 0.5) break;
      sc.scrollTop += d;
    }
    sc.scrollLeft = 0;
    this.panX = Math.round((-cc.x - (sz?.offsetLeft ?? 0)) * 4) / 4;
    this.applyPan();
    this.view.requestMeasure();
    this.zoomedAt = performance.now();
    // the ink at the new zoom now, not a frame later (no flash of the old ink)
    this.cv.w = 0;
    this.frame();
    this.updateToolbar();
    this.lasso.sync();
  }

  /**
   * The line in the middle of the view and where (client y of its top) it must be at camera c:
   * where the preview shows it, or computed from the camera without a preview.
   */
  private refLine(c: Cam): { pos: number; caret: number; top: number } | null {
    const v = this.view;
    const sr = v.scrollDOM.getBoundingClientRect();
    const cr = v.contentDOM.getBoundingClientRect();
    // the editor's place on screen (the box itself may be transformed by a preview)
    const vr = (v.dom.parentElement ?? v.dom).getBoundingClientRect();
    if (vr.height < 2 || cr.width < 2) return null;
    const x = Math.min(cr.right - 2, Math.max(cr.left + 2, vr.left + vr.width / 2));
    const y = vr.top + vr.height / 2;
    const stack = this.withoutShield(() => document.elementsFromPoint(x, y));
    const line = stack.map((e) => e.closest<HTMLElement>('.cm-line')).find((e): e is HTMLElement => !!e && v.contentDOM.contains(e));
    if (!line) return null;
    let pos: number;
    try {
      pos = v.posAtDOM(line, 0);
    } catch {
      return null;
    }
    // the character under the middle of the view (for the editor's scrollIntoView: being in view
    // sideways, it never makes the editor scroll sideways — zooming in on the right of the note
    // must stay on the right)
    let caret = pos;
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const cr0 = this.withoutShield(() => doc.caretRangeFromPoint?.(x, y) ?? null);
    if (cr0 && line.contains(cr0.startContainer)) {
      try {
        caret = v.posAtDOM(cr0.startContainer, cr0.startOffset);
      } catch {
        /* keep the line start */
      }
    }
    const top = line.getBoundingClientRect().top;
    if (v.dom.hasClass('hn-ink-previewbox')) return { pos, caret, top };
    // no preview: from the camera now (b) to c
    const b = this.camNow();
    const base = sr.top + v.scrollDOM.clientTop * b.zoom;
    return { pos, caret, top: base + ((top - base) / b.zoom + b.y - c.y) * c.zoom };
  }

  /** The rendered line element of a document position, or null (no measuring). */
  private lineEl(pos: number): HTMLElement | null {
    try {
      const at = this.view.domAtPos(pos);
      const node = at.node instanceof HTMLElement ? at.node : at.node.parentElement;
      const el = node?.closest<HTMLElement>('.cm-line') ?? (node?.childNodes[at.offset] as HTMLElement | undefined)?.closest?.('.cm-line') ?? null;
      return el && this.view.contentDOM.contains(el) ? el : null;
    } catch {
      return null;
    }
  }

  /** Let the editor measure now (its public lookups measure first when a measure is due). */
  private syncMeasure(): void {
    try {
      this.view.requestMeasure();
      this.view.lineBlockAtHeight(0);
    } catch {
      /* the editor is updating: it measures in its next frame */
    }
  }

  /** Momentum after a fling (as in a note). */
  private stepInertia(): void {
    const it = this.inertia;
    if (!it || this.closed) return;
    window.requestAnimationFrame((now) => {
      if (this.inertia !== it) return;
      const dt = Math.min(40, now - it.last);
      it.last = now;
      const c = this.camNow();
      this.panTo({ x: c.x - (it.vx * dt) / c.zoom, y: c.y - (it.vy * dt) / c.zoom, zoom: c.zoom });
      const decay = Math.exp(-dt / 325);
      it.vx *= decay;
      it.vy *= decay;
      if (Math.hypot(it.vx, it.vy) < 0.02) this.inertia = null;
      else this.stepInertia();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Laser
  // ---------------------------------------------------------------------------------------------

  private laserLocal(e: PointerEvent): [number, number] {
    const r = this.laserHost.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private laserBegin(e: PointerEvent): void {
    this.laserId = e.pointerId;
    this.laser.begin(...this.laserLocal(e));
  }

  // ---------------------------------------------------------------------------------------------
  // Strokes
  // ---------------------------------------------------------------------------------------------

  private beginStroke(e: PointerEvent, tool: InkTool): void {
    const s = this.host.settings();
    const experimental = tool === 'fountain' && s.fountainVariant === 'experimental';
    const base = experimental ? sanitizeExperimental(s.experimental) : sanitizeParams(tool, s.pens[tool].params);
    const params = { ...base, width: base.width * MD_INK_WIDTH_SCALE };
    const geo = this.geo();
    const builder = new StrokeBuilder(tool, params, {
      zoom: geo.sx,
      hasPressure: e.pointerType === 'pen',
      engine: tool === 'pencil' || experimental ? ENGINE_EXPERIMENTAL : ENGINE_VERSION,
      ink: INK_PIPELINE,
    });
    this.active = { id: e.pointerId, tool, color: s.pens[tool].color, builder, geo, origin: this.origin(geo), t0: e.timeStamp, created: Date.now(), shape: s.drawShape && tool !== 'highlighter' };
    this.liveCanvas.style.opacity = tool === 'highlighter' || tool === 'pencil' ? String(params.opacity) : '';
    this.placeLive();
    this.addSample(e, this.active);
    this.schedule();
  }

  /** Discard the live layer (stroke aborted). */
  private blockLive(): void {
    this.clearLive();
  }

  private toSample(e: PointerEvent, a: { geo: Geo; t0: number }): InputSample {
    const g = a.geo;
    const s: InputSample = {
      x: (e.clientX - g.cx) / g.sx,
      y: (e.clientY - g.cy) / g.sy,
      p: e.pointerType === 'pen' ? e.pressure : 0.5,
      t: Math.max(0, e.timeStamp - a.t0),
    };
    if (e.pointerType === 'pen' && (e.tiltX || e.tiltY)) {
      s.tx = e.tiltX;
      s.ty = e.tiltY;
    }
    return s;
  }

  private addSample(e: PointerEvent, a: ActiveInk, lift = false): void {
    const s = this.toSample(e, a);
    const raw = a.builder.rawSamples;
    const last = raw[raw.length - 1];
    if (last && last.x === s.x && last.y === s.y && last.p === s.p) return;
    if (lift && last) {
      // the pointerup reports pressure 0 and usually no new position (see the editor)
      if (Math.hypot(s.x - last.x, s.y - last.y) * a.geo.sx < 0.5) return;
      if (!(s.p > 0)) s.p = last.p;
    }
    a.builder.add(s);
  }

  private endStroke(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.lastInkEnd = performance.now();
    const samples = a.builder.rawSamples.map(quantizeSample);
    if (!samples.length) {
      this.clearLive();
      return;
    }
    const stroke: Stroke = {
      id: newId('s'),
      tool: a.tool,
      color: a.color,
      params: { ...a.builder.params },
      zoom: Math.round(a.builder.ctx.zoom * 1000) / 1000,
      hasPressure: a.builder.ctx.hasPressure,
      engine: a.builder.ctx.engine ?? ENGINE_VERSION,
      created: a.created,
      samples,
    };
    stroke.geom = a.builder.commitGeometry();
    // shape pen: a shape / connector item, or an arrow head for a line nearby (as in a note)
    if (!(a.shape && this.commitShape(stroke))) {
      if (a.tool === 'highlighter' && this.host.settings().highlighterStraight) this.straighten(stroke);
      this.cache.set(stroke, geometryFromStored(stroke.geom));
      this.commit([...this.strokes, this.layOnText(stroke)]);
    }
    // the committed ink is drawn before the live layer is cleared: nothing blinks
    this.placeCanvases();
    this.renderInk();
    this.clearLive();
  }

  /**
   * Shape pen (as in a note): a "V" next to the end of a line / curve gives it an arrow head;
   * otherwise a recognised stroke becomes a shape item. Returns false when it stays ink.
   */
  private commitShape(st: Stroke): boolean {
    const page = this.page;
    if (!page || this.readOnly) return false;
    const head = recognizeInkArrowHead(st.samples, st.geom, st.zoom);
    if (head && this.attachArrowHead(head)) return true;
    const rec = recognizeInk(st.samples, st.geom, st.zoom);
    if (!rec) return false;
    const before = page.items;
    page.items = [...before, this.shapeItemFrom(st, rec)];
    this.commitItems(before, page.items);
    return true;
  }

  private shapeItemFrom(st: Stroke, rec: RecognizedShape): ShapeItem {
    const item: ShapeItem = {
      id: newId('i'),
      type: 'shape',
      kind: rec.kind,
      x: rec.x,
      y: rec.y,
      w: rec.w,
      h: rec.h,
      created: st.created,
      stroke: st.color,
      strokeWidth: Math.max(0.6, Math.min(8, st.params.width * 0.8)),
      fill: null,
      fillOpacity: 1,
    };
    if (rec.points) item.points = rec.points;
    if (rec.rot) item.rot = rec.rot;
    if (rec.a && rec.b) {
      item.a = rec.a;
      item.b = rec.b;
      if (rec.c) item.c = rec.c;
      if (rec.c2) item.c2 = rec.c2;
      if (rec.pts) item.pts = rec.pts;
      item.arrowEnd = !!rec.arrowEnd;
      if (rec.arrowEnd) item.head = 'open';
    }
    return item;
  }

  /** Shape pen: add an arrow head to the connector end the "V" stroke points at. */
  private attachArrowHead(head: { tip: [number, number]; dir: [number, number]; size: number }): boolean {
    const page = this.page;
    if (!page) return false;
    const tol = Math.max(14, head.size * 1.4);
    let best: { it: ShapeItem; end: 'start' | 'end'; d: number } | null = null;
    for (const it of page.items) {
      if (!isLine(it)) continue;
      const tan = arrowTangents(it);
      for (const end of ['start', 'end'] as const) {
        const [from, tip] = tan[end];
        const d = Math.hypot(tip[0] - head.tip[0], tip[1] - head.tip[1]);
        if (d > tol) continue;
        // the V must point the same way as the line arrives at that end
        const lx = tip[0] - from[0];
        const ly = tip[1] - from[1];
        const ll = Math.hypot(lx, ly) || 1;
        if ((lx * head.dir[0] + ly * head.dir[1]) / ll < 0.5) continue;
        if (!best || d < best.d) best = { it, end, d };
      }
    }
    if (!best) return false;
    const next: ShapeItem = best.end === 'end' ? { ...best.it, arrowEnd: true } : { ...best.it, arrowStart: true };
    if (!next.head) next.head = 'open';
    const before = page.items;
    page.items = before.map((i) => (i.id === next.id ? next : i));
    this.commitItems(before, page.items);
    return true;
  }

  /**
   * Anchor strokes to the line at their vertical centre (or the nearest line with text); `group`
   * (shape pen, lasso) shares one anchor, computed from all of them.
   */
  private anchor(s: Stroke, group: Stroke[] = [s]): void {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const g of group) {
      const b = this.box(g);
      y0 = Math.min(y0, b.y0);
      y1 = Math.max(y1, b.y1);
    }
    const v = this.view;
    const d = v.state.doc;
    const u = this.hUnit();
    const yc = Math.min(v.contentHeight, Math.max(0, ((y0 + y1) / 2) * u));
    const block = v.lineBlockAtHeight(yc);
    const n = pickAnchorLine(d.lineAt(block.from).number, d);
    const line = d.line(n);
    const anchor = { line: n, text: anchorText(line.text), top: v.lineBlockAt(line.from).top / u };
    for (const g of group) {
      g.anchor = { ...anchor };
      this.pos.set(g.id, line.from);
    }
  }

  /** Highlighter: a nearly straight stroke becomes straight (setting, as in notes). */
  private straighten(stroke: Stroke): void {
    const rec = recognizeInk(stroke.samples, stroke.geom, stroke.zoom);
    if (!rec || rec.kind !== 'line' || rec.arrowEnd || !rec.a || !rec.b) return;
    const [ax, ay] = rec.a;
    const [bx, by] = rec.b;
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) return;
    const n = Math.max(2, Math.min(200, Math.ceil(len / 2) + 1));
    const t1 = stroke.samples[stroke.samples.length - 1].t;
    stroke.samples = Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1);
      return quantizeSample({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u, p: 0.5, t: t1 * u });
    });
    const r = Math.max(0.05, stroke.params.width / 2);
    stroke.geom = quantizeGeometry({ xs: [ax, bx], ys: [ay, by], rs: [r, r] });
  }

  private beginErase(e: PointerEvent): void {
    const geo = this.geo();
    const x = (e.clientX - geo.cx) / geo.sx;
    const y = (e.clientY - geo.cy) / geo.sy;
    this.placeCanvases();
    this.placeLive();
    this.liveCanvas.style.removeProperty('opacity');
    this.erase = { id: e.pointerId, geo, origin: this.origin(geo), lastX: x, lastY: y, before: this.strokes, beforeItems: this.page?.items ?? [], changed: false };
    this.eraseTo(e, this.erase);
  }

  private eraseTo(e: PointerEvent, er: ActiveErase): void {
    const g = er.geo;
    const x = (e.clientX - g.cx) / g.sx;
    const y = (e.clientY - g.cy) / g.sy;
    const s = this.host.settings();
    const mode = s.eraserMode;
    const base = ERASER_SIZES[s.eraserSize] ?? ERASER_SIZES[1];
    const radius = (mode === 'precise' ? base * 0.6 : base) / g.sx;
    const next: Stroke[] = [];
    let changed = false;
    for (const st of this.strokes) {
      if (s.eraserHighlighterOnly && st.tool !== 'highlighter') {
        next.push(st);
        continue;
      }
      const dy = this.shift(st);
      // a highlighter on text is erased whole (its rows belong together)
      const rows = this.spanChunks(st);
      if (rows) {
        if (rows.some((gm) => hitStrokeSegment(gm, er.lastX, er.lastY - dy, x, y - dy, radius))) {
          changed = true;
          this.spanPos.delete(st.id);
        } else next.push(st);
        continue;
      }
      if (!hitStrokeSegment(this.cache.get(st), er.lastX, er.lastY - dy, x, y - dy, radius)) {
        next.push(st);
        continue;
      }
      changed = true;
      if (mode === 'stroke') continue;
      const parts = cutStroke(st, er.lastX, er.lastY - dy, x, y - dy, radius, mode === 'precise');
      if (!parts) {
        next.push(st);
        continue;
      }
      // the pieces stay on the line of the stroke they come from
      const p = this.pos.get(st.id);
      for (const q of parts) {
        if (st.anchor) q.anchor = { ...st.anchor };
        if (p !== undefined) this.pos.set(q.id, p);
      }
      next.push(...parts);
    }
    // shapes are erased whole (as in a note); text boxes and images are not
    const page = this.page;
    if (page && !s.eraserHighlighterOnly) {
      const keep = page.items.filter((it) => !(it.type === 'shape' && (shapeTouchesCircle(it, x, y, radius) || shapeTouchesCircle(it, (x + er.lastX) / 2, (y + er.lastY) / 2, radius))));
      if (keep.length !== page.items.length) {
        page.items = detachMissing(keep);
        changed = true;
      }
    }
    er.lastX = x;
    er.lastY = y;
    if (changed) {
      er.changed = true;
      this.strokes = next;
      this.renderInk();
    }
    this.drawEraserCursor(x, y, radius, er);
  }

  private endErase(): void {
    const er = this.erase;
    if (!er) return;
    this.erase = null;
    this.lastInkEnd = performance.now();
    this.clearLive();
    if (!er.changed) return;
    const op: UndoOp = {};
    if (this.strokes !== er.before) {
      op.strokes = { before: er.before, after: this.strokes };
      this.setStrokes(this.strokes);
    }
    const items = this.page?.items ?? [];
    if (items !== er.beforeItems) {
      op.items = { before: er.beforeItems, after: items };
      this.store.markDirty();
      this.inkX = undefined;
    }
    this.pushUndo(op);
    this.updateToolbar();
  }

  private docPoint(e: PointerEvent, g: Geo): [number, number] {
    return [(e.clientX - g.cx) / g.sx, (e.clientY - g.cy) / g.sy];
  }

  // ---------------------------------------------------------------------------------------------
  // Highlighter laid on text: it follows its characters wherever they wrap
  // ---------------------------------------------------------------------------------------------

  /** Run with the shield down (CodeMirror's hit tests look at the element under the point). */
  private withoutShield<T>(fn: () => T): T {
    const shield = this.clip.hasClass('hn-ink-shield');
    if (shield) this.clip.removeClass('hn-ink-shield');
    try {
      return fn();
    } finally {
      if (shield) this.clip.addClass('hn-ink-shield');
    }
  }

  /** The characters of a stored highlighter in today's text (after edits made elsewhere). */
  private resolveSpan(st: Stroke): void {
    const sp = st.span;
    if (!sp || !st.anchor || this.spanPos.has(st.id)) return;
    const d = this.view.state.doc;
    const line = d.line(relocateLine(st.anchor, d));
    let at = line.text.slice(sp.s, sp.e) === sp.t ? sp.s : -1;
    if (at < 0 && sp.t) {
      // the nearest copy of the text in its line
      let best = -1;
      for (let i = line.text.indexOf(sp.t); i >= 0; i = line.text.indexOf(sp.t, i + 1)) if (best < 0 || Math.abs(i - sp.s) < Math.abs(best - sp.s)) best = i;
      at = best;
    }
    if (at < 0) return; // not found: it stays where it was drawn (never deleted)
    this.spanPos.set(st.id, { from: line.from + at, to: line.from + at + (sp.t ? sp.t.length : sp.e - sp.s) });
  }

  /** Text rows of document range [from, to] (client rects, one per row), or null when not rendered. */
  private textRows(from: number, to: number): { x0: number; x1: number; y0: number; y1: number }[] | null {
    const v = this.view;
    if (from < v.viewport.from || to > v.viewport.to || to <= from) return null;
    let rects: DOMRect[];
    try {
      const a = v.domAtPos(from);
      const b = v.domAtPos(to);
      const rg = document.createRange();
      rg.setStart(a.node, a.offset);
      rg.setEnd(b.node, b.offset);
      rects = Array.from(rg.getClientRects()).filter((r) => r.width > 0.5 && r.height > 2);
    } catch {
      return null;
    }
    if (!rects.length) return null;
    rects.sort((a, b) => a.top - b.top || a.left - b.left);
    const rows: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const r of rects) {
      const row = rows.find((w) => Math.min(w.y1, r.bottom) - Math.max(w.y0, r.top) > 0.5 * Math.min(w.y1 - w.y0, r.height));
      if (row) {
        row.x0 = Math.min(row.x0, r.left);
        row.x1 = Math.max(row.x1, r.right);
        row.y0 = Math.min(row.y0, r.top);
        row.y1 = Math.max(row.y1, r.bottom);
      } else rows.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom });
    }
    return rows;
  }

  /** The highlighter's band on each text row (document px): x0..x1 at centre y, height h. */
  private spanBands(st: Stroke): { x0: number; x1: number; y: number }[] | null {
    const r = this.spanPos.get(st.id);
    const sp = st.span;
    if (!r || !sp) return null;
    const rows = this.textRows(r.from, r.to);
    if (!rows) return null;
    const g = this.geo();
    return rows.map((w) => ({ x0: (w.x0 - g.cx) / g.sx, x1: (w.x1 - g.cx) / g.sx, y: ((w.y0 + w.y1) / 2 - g.cy) / g.sy + sp.oy }));
  }

  /**
   * A new highlighter stroke over text: the characters it covers (one line of the note), its band
   * relative to the text row, or null (not on text: stays ordinary ink).
   */
  private spanFor(st: Stroke): { from: number; to: number; oy: number; h: number } | null {
    if (st.tool !== 'highlighter' || this.readOnly) return null;
    const b = this.box(st);
    const rad = st.params.width / 2;
    if (b.x1 - b.x0 < 2 * rad + 4) return null;
    const v = this.view;
    const g = this.geo();
    const d = v.state.doc;
    const lh = v.defaultLineHeight / g.sy;
    const cy = (b.y0 + b.y1) / 2;
    // the pen's path (the box minus the ink's radius); a highlight drawn a little past a word ends on
    // that word: the ends count from a third of a character inside
    const p0 = b.x0 + rad;
    const p1 = b.x1 - rad;
    const inset = Math.min((p1 - p0) / 3, lh * 0.35);
    const xa = p0 + inset;
    const xb = p1 - inset;
    // on the text, or just under it (an underline), or just over it
    for (const dy of [0, -0.5 * lh, -0.9 * lh, 0.5 * lh]) {
      const y = cy + dy;
      const hit = this.withoutShield(() => [v.posAtCoords({ x: g.cx + xa * g.sx, y: g.cy + y * g.sy }), v.posAtCoords({ x: g.cx + xb * g.sx, y: g.cy + y * g.sy })]);
      const pa = hit[0];
      const pb = hit[1];
      if (pa === null || pb === null) continue;
      const from = Math.min(pa, pb);
      const to = Math.max(pa, pb);
      if (to - from < 1 || d.lineAt(from).number !== d.lineAt(to).number) continue;
      const rows = this.textRows(from, to);
      if (!rows || rows.length !== 1) continue;
      const mid = ((rows[0].y0 + rows[0].y1) / 2 - g.cy) / g.sy;
      const oy = cy - mid;
      if (Math.abs(oy) > lh * 1.1) continue;
      return { from, to, oy, h: Math.max(4, Math.min(b.y1 - b.y0, lh * 1.5)) };
    }
    return null;
  }

  /** A new stroke: anchored to its line; a highlighter over text also to its characters. */
  private layOnText(st: Stroke): Stroke {
    const hit = this.spanFor(st);
    if (!hit) {
      this.anchor(st);
      return st;
    }
    const d = this.view.state.doc;
    const line = d.lineAt(hit.from);
    st.anchor = { line: line.number, text: anchorText(line.text), top: this.view.lineBlockAt(line.from).top / this.hUnit() };
    st.span = { s: hit.from - line.from, e: hit.to - line.from, t: d.sliceString(hit.from, hit.to).slice(0, 400), oy: hit.oy, h: hit.h };
    this.pos.set(st.id, line.from);
    this.spanPos.set(st.id, { from: hit.from, to: hit.to });
    const bands = this.spanBands(st);
    return bands ? this.materialize(st, bands) : st;
  }

  /** The stroke drawn on these bands (SPAN_PTS points per row; the stroke keeps its id). */
  private materialize(st: Stroke, bands: { x0: number; x1: number; y: number }[]): Stroke {
    const sp = st.span as NonNullable<Stroke['span']>;
    const r = sp.h / 2;
    const xs: number[] = [];
    const ys: number[] = [];
    const rs: number[] = [];
    const samples: Stroke['samples'] = [];
    let t = 0;
    for (const bd of bands) {
      // the band's round ends stay over the characters
      const a = bd.x0 + Math.min(r * 0.9, (bd.x1 - bd.x0) / 2);
      const z = Math.max(a, bd.x1 - Math.min(r * 0.9, (bd.x1 - bd.x0) / 2));
      for (let i = 0; i < SPAN_PTS; i++) {
        const x = a + ((z - a) * i) / (SPAN_PTS - 1);
        xs.push(x);
        ys.push(bd.y);
        rs.push(r);
        samples.push(quantizeSample({ x, y: bd.y, p: 0.5, t }));
        t += 8;
      }
    }
    const n: Stroke = { ...st, samples, geom: quantizeGeometry({ xs, ys, rs }) };
    if (n.anchor) {
      const rr = this.spanPos.get(st.id);
      if (rr) {
        const line = this.view.state.doc.lineAt(rr.from);
        n.anchor = { line: line.number, text: anchorText(line.text), top: this.view.lineBlockAt(line.from).top / this.hUnit() };
        this.pos.set(st.id, line.from);
      }
    }
    return n;
  }

  /** Same bands as the stroke's ink (no rebuild needed). */
  private sameBands(st: Stroke, bands: { x0: number; x1: number; y: number }[]): boolean {
    const gm = st.geom;
    if (!gm || gm.xs.length !== bands.length * SPAN_PTS) return false;
    const r = (st.span?.h ?? 0) / 2;
    return bands.every((bd, i) => {
      const a = bd.x0 + Math.min(r * 0.9, (bd.x1 - bd.x0) / 2);
      return Math.abs(gm.ys[i * SPAN_PTS] - bd.y) < 0.3 && Math.abs(gm.xs[i * SPAN_PTS] - a) < 0.3 && Math.abs(gm.xs[i * SPAN_PTS + SPAN_PTS - 1] - Math.max(a, bd.x1 - Math.min(r * 0.9, (bd.x1 - bd.x0) / 2))) < 0.3;
    });
  }

  /**
   * Highlighters on text follow their characters: when the text rows changed (typing before them,
   * another window width, live preview showing markup…), their ink is rebuilt on the new rows. One
   * whose characters were deleted becomes ordinary ink where it was (never deleted).
   */
  private reflowSpans(): void {
    if (!this.spanPos.size && !this.lostSpans.size) return;
    if (this.active || this.erase || this.lasso.busy) return;
    let changed = false;
    const next = this.strokes.flatMap((st) => {
      if (!st.span) return [st];
      if (this.lostSpans.has(st.id)) {
        this.lostSpans.delete(st.id);
        changed = true;
        return this.splitSpan(st);
      }
      const bands = this.spanBands(st);
      if (!bands || this.sameBands(st, bands)) return [st];
      changed = true;
      return [this.materialize(st, bands)];
    });
    if (!changed) return;
    this.strokes = next;
    const page = this.page;
    if (page) page.strokes = next;
    this.store.markDirty();
    this.inkX = undefined;
    this.syncOverlays();
  }

  /** A highlighter's ink, row by row (each row its own band). */
  private spanChunks(st: Stroke): StrokeGeometry[] | null {
    const gm = st.geom;
    if (!st.span || !gm || gm.xs.length % SPAN_PTS !== 0 || gm.xs.length === 0) return null;
    let list = this.spanGeoms.get(st);
    if (!list) {
      list = [];
      for (let i = 0; i < gm.xs.length; i += SPAN_PTS) list.push(geometryFromStored(quantizeGeometry({ xs: gm.xs.slice(i, i + SPAN_PTS), ys: gm.ys.slice(i, i + SPAN_PTS), rs: gm.rs.slice(i, i + SPAN_PTS) })));
      this.spanGeoms.set(st, list);
    }
    return list;
  }

  /** A highlighter that left its text (moved with the lasso, text deleted): one ordinary stroke per row. */
  private splitSpan(st: Stroke): Stroke[] {
    const gm = st.geom;
    const base: Stroke = { ...st };
    delete base.span;
    this.spanPos.delete(st.id);
    if (!gm || gm.xs.length % SPAN_PTS !== 0 || gm.xs.length <= SPAN_PTS || st.samples.length !== gm.xs.length) return [base];
    const out: Stroke[] = [];
    for (let i = 0; i < gm.xs.length; i += SPAN_PTS) {
      const part: Stroke = { ...base, id: i === 0 ? st.id : newId('s'), samples: st.samples.slice(i, i + SPAN_PTS), geom: quantizeGeometry({ xs: gm.xs.slice(i, i + SPAN_PTS), ys: gm.ys.slice(i, i + SPAN_PTS), rs: gm.rs.slice(i, i + SPAN_PTS) }) };
      const p = this.pos.get(st.id);
      if (p !== undefined) this.pos.set(part.id, p);
      out.push(part);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Zoom
  // ---------------------------------------------------------------------------------------------

  /** Two fingers while the text is editable (text tool / typing): zoom without the router. */
  private startPinch(a: Touch, b: Touch): void {
    if (!this.sizer) return;
    const sc = this.view.scrollDOM;
    const fx = (a.clientX + b.clientX) / 2;
    const fy = (a.clientY + b.clientY) / 2;
    this.rememberBase();
    this.pinch = {
      ids: [a.identifier, b.identifier],
      d0: Math.max(10, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      f0x: fx,
      f0y: fy,
      fx,
      fy,
      k: 1,
      rect: sc.getBoundingClientRect(),
      edRect: this.view.dom.getBoundingClientRect(),
      cam: this.camNow(),
    };
  }

  /** Fingers lifted: the preview becomes the real zoom, with the same point under the fingers. */
  private endPinch(): void {
    const p = this.pinch;
    if (!p) return;
    this.pinch = null;
    this.commitCamera(this.pinchCamera(p));
  }

  /** Zoom keeping the content under the client point (x, y) in place. */
  zoomTo(z: number, x: number, y: number): void {
    if (!this.sizer) return;
    const sc = this.view.scrollDOM;
    const r = sc.getBoundingClientRect();
    const c = this.camNow();
    const vx = x - r.left - sc.clientLeft * c.zoom;
    const vy = y - r.top - sc.clientTop * c.zoom;
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    this.rememberBase();
    this.commitCamera({ x: c.x + vx / c.zoom - vx / nz, y: c.y + vy / c.zoom - vy / nz, zoom: nz });
  }

  /**
   * Zoom = the whole editor box is scaled (as CodeMirror expects of a scaled editor: its scroll
   * position and its measurements stay in one unit). The box is laid out at its size divided by
   * the zoom and scaled back to fill the tab; the note inside keeps its width at 100 % (no new
   * line breaks) and is moved sideways by `panX`.
   */
  private layoutZoom(): void {
    const sizer = this.sizer;
    const ed = this.view.dom;
    const parent = ed.parentElement;
    const pan = this.panX ? `translate3d(${this.panX}px, 0, 0)` : '';
    this.placeHosts();
    ed.removeClass('hn-ink-previewbox');
    if (this.zoom === 1 || !sizer || !parent) {
      for (const k of ['width', 'height', 'min-width', 'max-width', 'transform', 'transform-origin']) ed.style.removeProperty(k);
      ed.removeClass('hn-ink-zoombox');
      if (sizer) {
        sizer.removeClass('hn-ink-zoomed');
        for (const k of ['width', 'min-width', 'max-width', 'margin-left']) sizer.style.removeProperty(k);
        if (pan) sizer.style.transform = pan;
        else sizer.style.removeProperty('transform');
      }
      return;
    }
    const z = this.zoom;
    // the note's width at 100 % — read before the box gets narrower (the note would follow it)
    if (!this.baseWidth) this.rememberBase();
    const w = this.baseWidth || sizer.offsetWidth;
    ed.addClass('hn-ink-zoombox');
    ed.style.setProperty('width', `${parent.clientWidth / z}px`, 'important');
    ed.style.setProperty('min-width', `${parent.clientWidth / z}px`, 'important');
    ed.style.setProperty('max-width', `${parent.clientWidth / z}px`, 'important');
    ed.style.setProperty('height', `${parent.clientHeight / z}px`, 'important');
    ed.style.transform = `scale(${z})`;
    const sc = this.view.scrollDOM;
    const cs = getComputedStyle(sc);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    sizer.addClass('hn-ink-zoomed');
    sizer.style.setProperty('width', `${w}px`, 'important');
    sizer.style.setProperty('min-width', `${w}px`, 'important');
    sizer.style.setProperty('max-width', `${w}px`, 'important');
    // centred while narrower than the view; from the left edge when wider (moved by panX)
    sizer.style.setProperty('margin-left', `${Math.max(0, (sc.clientWidth - padL - padR - w) / 2)}px`, 'important');
    if (pan) sizer.style.transform = pan;
    else sizer.style.removeProperty('transform');
  }

  /** The overlays (objects, lasso, laser) cover the editor's place in the tab, unscaled. */
  private placeHosts(): void {
    const parent = this.view.dom.parentElement;
    if (!parent) return;
    const cr = this.md.contentEl.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    for (const el of [this.objHost, this.laserHost]) {
      el.style.left = `${pr.left - cr.left}px`;
      el.style.top = `${pr.top - cr.top}px`;
      el.style.width = `${pr.width}px`;
      el.style.height = `${pr.height}px`;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------------------------

  private updateToolbar(): void {
    const s = this.host.settings();
    const ink: InkTool = isInkTool(s.tool) ? s.tool : s.lastPen;
    const params = ink === 'fountain' && s.fountainVariant === 'experimental' ? s.experimental : s.pens[ink].params;
    this.toolbar.update({
      tool: s.tool,
      drawShape: s.drawShape && isInkTool(s.tool) && s.tool !== 'highlighter',
      subbarOpen: s.subbarOpen,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      page: 0,
      pageCount: 1,
      markdown: { zoom: this.zoom },
      readOnly: this.readOnly,
      penColor: s.pens[ink].color,
      palette: ink === 'highlighter' ? s.highlighterPalette : s.inkPalette,
      widthPresets: s.widthPresets[ink],
      width: params.width,
      penDash: 'solid',
      eraserMode: s.eraserMode,
      eraserSize: s.eraserSize,
      highlighterOnly: s.eraserHighlighterOnly,
      shape: s.shape,
      text: s.text,
      lasso: s.lasso,
      laser: s.laser,
    });
  }

  private changed(): void {
    this.host.settingsChanged(this.host.settings());
    this.syncRouter();
    this.updateToolbar();
  }

  /** Settings changed in another view (tool, colour…). */
  settingsUpdated(): void {
    this.applyLock();
    this.syncRouter();
    this.updateToolbar();
  }

  /** The router follows the tool (hand: the pen pans too) and the tap-gesture setting. */
  private syncRouter(): void {
    const s = this.host.settings();
    this.router.setOptions({ tapGestures: s.tapGestures, hand: s.tool === 'hand' });
  }

  private setTool(tool: Tool, shape = false): void {
    const s = this.host.settings();
    if (tool === 'ballpoint') tool = 'fountain';
    if (groupOf(tool) !== groupOf(s.tool)) s.subbarOpen = true;
    s.tool = tool;
    // the shape pen is the pen tool with shape recognition (as in a note); other tools keep the
    // choice for when the pen group is chosen again
    if (isInkTool(tool)) s.drawShape = shape && tool !== 'highlighter';
    if (isInkTool(tool) && !shape) s.lastPen = tool;
    if (tool !== 'lasso') this.lasso.clear();
    if (tool !== 'laser') this.laser.clear();
    if (!isObjectTool(tool)) this.objects.deselect();
    this.closePopover();
    this.typing = false;
    this.closeMenu();
    this.applyLock();
    this.changed();
  }

  // ---------------------------------------------------------------------------------------------
  // Menus: own popovers in the toolbar. Obsidian's Menu closes itself on iPad right away (iOS sends
  // a mouse event after the tap that opened it, which counts as a click outside).
  // ---------------------------------------------------------------------------------------------

  private openMenu(anchor: HTMLElement, rows: MenuRow[]): void {
    const same = this.menuAnchor === anchor && this.menuEl;
    this.closeMenu();
    if (same) return;
    const menu = this.bar.createDiv({ cls: 'hn-ps-menu hn-ink-menu' });
    menu.setAttribute('role', 'menu');
    const render = () => {
      menu.empty();
      for (const r of rows) {
        const b = menu.createEl('button', { cls: 'hn-ps-menu-row' + (r.danger ? ' is-danger' : '') + (r.checked ? ' is-checked' : '') });
        b.type = 'button';
        b.disabled = !!r.disabled;
        b.setAttribute('role', r.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        if (r.checked !== undefined) b.setAttribute('aria-checked', String(r.checked));
        const ic = b.createSpan({ cls: 'hn-row-icon' });
        const icon = r.checked !== undefined ? (r.checked ? 'check' : '') : r.icon;
        if (icon) setHnIcon(ic, icon);
        b.createSpan({ cls: 'hn-row-label', text: r.label });
        onTap(b, () => {
          if (b.disabled) return;
          if (r.keep) {
            r.run();
            r.checked = !r.checked;
            render();
            return;
          }
          this.closeMenu();
          r.run();
        });
      }
    };
    render();
    // below the button, inside the window
    const ar = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(ar.bottom + 6)}px`;
    const w = Math.max(menu.offsetWidth, 210);
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, ar.right - w)))}px`;
    this.menuEl = menu;
    this.menuAnchor = anchor;
    const opened = performance.now();
    // closes on a press outside (a pointerdown, not the mouse events iOS sends after the tap) or Esc
    const outside = (e: PointerEvent) => {
      if (performance.now() - opened < 250) return;
      const tg = e.target as Node | null;
      if (tg && (menu.contains(tg) || anchor.contains(tg))) return;
      this.closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    this.menuOff = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }

  private closeMenu(): void {
    this.menuOff?.();
    this.menuOff = null;
    this.menuEl?.remove();
    this.menuEl = null;
    this.menuAnchor = null;
  }

  private toolbarActions() {
    const s = () => this.host.settings();
    const inkTool = (): InkTool | null => (isInkTool(s().tool) ? (s().tool as InkTool) : null);
    const noop = () => undefined;
    return {
      onGroup: (g: ToolGroup) => {
        if (groupOf(s().tool) === g && g !== 'hand' && g !== 'image') {
          s().subbarOpen = !s().subbarOpen;
          this.changed();
          return;
        }
        if (g === 'pen') this.setTool(s().drawShape ? 'fountain' : s().lastPen, s().drawShape);
        else if (g === 'image') {
          if (s().tool !== 'image') this.setTool('image');
          this.pickImage();
        } else this.setTool(g === 'eraser' ? 'eraser' : g === 'text' ? 'text' : g === 'shape' ? 'shape' : g === 'lasso' ? 'lasso' : g === 'laser' ? 'laser' : 'hand');
      },
      onPages: noop,
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onPrev: noop,
      onNext: noop,
      // the zoom label: back to 100 %
      onPageLabel: () => {
        const r = (this.view.dom.parentElement ?? this.view.dom).getBoundingClientRect();
        this.zoomTo(1, r.left + r.width / 2, r.top + r.height / 2);
        // and the note centred again
        this.panTo({ ...this.camNow(), x: -this.leftAt(1) });
      },
      onMore: (anchor: HTMLElement) =>
        this.openMenu(anchor, [
          { label: t('mdSaveNow'), icon: 'check', run: () => void this.store.flush() },
          { label: t('mdClear'), icon: 'trash', danger: true, disabled: this.readOnly || !this.strokes.length, run: () => this.clearAll() },
          { label: t('mdExit'), icon: 'close', run: () => this.host.exit() },
          {
            label: t('mdDiagnostics'),
            icon: 'info',
            run: () => {
              const text = '```json\n' + this.diagnostics() + '\n```\n';
              void navigator.clipboard
                .writeText(text)
                .then(() => new Notice(t('mdDiagnosticsCopied'), 5000))
                .catch(() => new Notice('HandNote: clipboard not available', 5000));
            },
          },
        ]),
      onPenKind: (k: PenKind) => this.setTool(k === 'shapepen' ? 'fountain' : k, k === 'shapepen'),
      onStrokeStyle: noop,
      onWidthPreset: (i: number) => {
        const tool = inkTool();
        if (!tool) return;
        const w = s().widthPresets[tool][i];
        if (w === undefined) return;
        if (tool === 'fountain' && s().fountainVariant === 'experimental') s().experimental = { ...s().experimental, width: w };
        else s().pens[tool].params = { ...s().pens[tool].params, width: w };
        this.changed();
      },
      onColor: (c: string) => {
        const tool = inkTool();
        if (!tool) return;
        s().pens[tool].color = c;
        this.changed();
      },
      onAddColor: (c: string) => {
        const tool = inkTool();
        if (!tool) return;
        if (tool === 'highlighter') s().highlighterPalette = addPaletteColor(s().highlighterPalette, c);
        else s().inkPalette = addPaletteColor(s().inkPalette, c);
        s().pens[tool].color = c.toLowerCase();
        this.changed();
      },
      onRemoveColor: (c: string, anchor: HTMLElement) => {
        const tool = inkTool();
        if (!tool) return;
        this.openMenu(anchor, [
          {
            label: t('removeColor'),
            icon: 'trash',
            danger: true,
            run: () => {
              if (tool === 'highlighter') s().highlighterPalette = s().highlighterPalette.filter((x) => x !== c);
              else s().inkPalette = s().inkPalette.filter((x) => x !== c);
              this.changed();
            },
          },
        ]);
      },
      onEraserType: (anchor: HTMLElement) => {
        const rows: MenuRow[] = (
          [
            ['standard', 'eraserStandard'],
            ['precise', 'eraserPrecise'],
            ['stroke', 'eraserStroke'],
          ] as const
        ).map(([mode, label]) => ({
          label: t(label),
          checked: s().eraserMode === mode,
          run: () => {
            s().eraserMode = mode;
            this.changed();
          },
        }));
        this.openMenu(anchor, rows);
      },
      onEraserSize: (i: number) => {
        s().eraserSize = i;
        this.changed();
      },
      onHighlighterOnly: (v: boolean) => {
        s().eraserHighlighterOnly = v;
        this.changed();
      },
      onLassoMode: (m: 'free' | 'rect') => {
        s().lasso = { ...s().lasso, mode: m };
        this.changed();
      },
      onLassoFilter: (anchor: HTMLElement) => {
        const p = this.openPopover('lasso-filter', anchor, 'hn-list-panel hn-lasso-filter');
        if (!p) return;
        renderLassoFilterPanel(p.el, {
          filter: s().lasso.filter,
          onChange: (f) => {
            s().lasso = { ...s().lasso, filter: f };
            this.host.settingsChanged(s());
          },
        });
        p.place('center');
      },
      onLaserMode: (m: 'dot' | 'trail') => {
        s().laser = { ...s().laser, mode: m };
        this.changed();
      },
      onLaserColor: (c: string) => {
        s().laser = { ...s().laser, color: c };
        this.changed();
      },
      onLaserHold: (ms: number) => {
        s().laser = { ...s().laser, holdMs: ms };
        this.changed();
      },
      onInsertImage: () => this.pickImage(),
      onShapeKind: (k: ShapeItem['kind']) => {
        s().shape = { ...s().shape, kind: k };
        this.changed();
      },
      onShapeStyle: (anchor: HTMLElement) => {
        const p = this.openPopover('shape-style', anchor, 'hn-width-panel');
        if (!p) return;
        const sh = s().shape;
        const sel = this.objects.selected;
        const lineKind = sel?.type === 'shape' ? isLine(sel) && sel.kind !== 'line' : ['arrow', 'curve', 'elbow'].includes(sh.kind);
        const apply = (patch: Partial<EditorSettings['shape']>, itemPatch: Partial<ShapeItem>) => {
          s().shape = { ...s().shape, ...patch };
          this.changed();
          if (this.objects.selected?.type === 'shape') this.objects.applyStyle(itemPatch);
        };
        renderLineStylePanel(p.el, {
          dash: sh.dash,
          width: sh.strokeWidth,
          arrows: lineKind ? sh.arrows : null,
          head: lineKind ? sh.head : null,
          onDash: (d) => apply({ dash: d }, { dash: d === 'solid' ? undefined : d }),
          onWidth: (w) => apply({ strokeWidth: w }, { strokeWidth: w }),
          onArrows: (a) => apply({ arrows: a }, { arrowEnd: a !== 'none', arrowStart: a === 'both' }),
          onHead: (h) => apply({ head: h }, { head: h }),
        });
        p.place('center');
      },
      onShapeColor: (anchor: HTMLElement) => {
        const p = this.openPopover('shape-color', anchor, 'hn-color-panel');
        if (!p) return;
        const sh = s().shape;
        const apply = (patch: Partial<EditorSettings['shape']>) => {
          s().shape = { ...s().shape, ...patch };
          this.changed();
          const sel = this.objects.selected;
          if (sel?.type === 'shape') {
            const n = s().shape;
            this.objects.applyStyle({ stroke: n.color, fill: n.fill && sel.kind !== 'line' ? n.color : null, fillOpacity: n.fillOpacity });
          }
        };
        renderColorPanel(p.el, {
          palette: s().inkPalette,
          current: sh.color,
          onPick: (c) => apply({ color: c }),
          onAdd: (c) => {
            s().inkPalette = addPaletteColor(s().inkPalette, c);
            apply({ color: c.toLowerCase() });
          },
          fill: { on: sh.fill, opacity: sh.fillOpacity, onToggle: (v) => apply({ fill: v }), onOpacity: (v) => apply({ fillOpacity: v }) },
        });
        p.place('center');
      },
      onTextColor: (anchor: HTMLElement) => {
        const p = this.openPopover('text-color', anchor, 'hn-color-panel');
        if (!p) return;
        renderColorPanel(p.el, {
          palette: s().inkPalette,
          current: s().text.color,
          onPick: (c) => this.setTextStyle({ color: c }),
          onAdd: (c) => {
            s().inkPalette = addPaletteColor(s().inkPalette, c);
            this.setTextStyle({ color: c.toLowerCase() });
          },
        });
        p.place('center');
      },
      onTextSize: (anchor: HTMLElement) => {
        const p = this.openPopover('text-size', anchor, 'hn-list-panel');
        if (!p) return;
        const sizes = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];
        renderListPicker(
          p.el,
          t('textSize'),
          sizes.map((v) => ({ label: String(v), value: v, active: v === s().text.size })),
          (v) => {
            this.setTextStyle({ size: v });
            this.closePopover();
          },
        );
        p.place('center');
      },
      onTextFont: (anchor: HTMLElement) => {
        const p = this.openPopover('text-font', anchor, 'hn-list-panel');
        if (!p) return;
        const fonts: ['sans' | 'serif' | 'mono' | 'hand', string][] = [
          ['sans', t('fontSans')],
          ['serif', t('fontSerif')],
          ['hand', t('fontHand')],
          ['mono', t('fontMono')],
        ];
        renderListPicker(
          p.el,
          t('font'),
          fonts.map(([v, label]) => ({ label, value: v, active: v === s().text.font })),
          (v) => {
            this.setTextStyle({ font: v });
            this.closePopover();
          },
        );
        p.place('center');
      },
      onTextToggle: (key: 'bold' | 'italic') => this.setTextStyle({ [key]: !s().text[key] }),
      onTextAlign: () => {
        const order = ['left', 'center', 'right'] as const;
        const next = order[(order.indexOf(s().text.align) + 1) % 3];
        this.setTextStyle({ align: next });
      },
    };
  }

  // ---------------------------------------------------------------------------------------------

  /** Leave: write what is pending, remove everything that was added to the editor. */
  /** `viewGone`: the editor itself is being destroyed (nothing may be dispatched to it). */
  async close(viewGone = false): Promise<void> {
    if (this.closed) return;
    if (this.active) this.endStroke();
    if (this.erase) this.endErase();
    this.router.reset();
    this.closeMenu();
    this.closePopover();
    this.objects.finishEdit();
    this.objects.destroy();
    this.objHost.remove();
    this.popRoot.remove();
    this.lasso.destroy();
    this.inertia = null;
    this.laser.destroy();
    this.laserHost.remove();
    this.closed = true;
    window.cancelAnimationFrame(this.raf);
    window.clearTimeout(this.anchorTimer);
    for (const d of this.disposers) d();
    this.disposers = [];
    this.pinch = null;
    const ed = this.view.dom;
    ed.style.removeProperty('transform');
    ed.style.removeProperty('transform-origin');
    ed.removeClass('hn-ink-pinching');
    this.view.scrollDOM.removeClass('hn-ink-scroller');
    this.view.scrollDOM.removeClass('hn-ink-noscroll');
    // the editor is editable again, the title and properties too
    this.typing = false;
    this.setEditable(true, viewGone);
    window.clearTimeout(this.layerTimer);
    if (this.zoom !== 1 || this.panX) {
      this.zoom = 1;
      this.panX = 0;
      this.layoutZoom();
      this.view.requestMeasure();
    }
    for (const c of [this.inkCanvas, this.liveCanvas]) {
      c.width = 0;
      c.height = 0;
    }
    this.clip.remove();
    this.toolbar.destroy();
    this.bar.remove();
    this.md.contentEl.removeClass('hn-ink-active');
    await this.store.dispose();
  }
}
