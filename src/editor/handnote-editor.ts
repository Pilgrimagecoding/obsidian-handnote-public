import { GeometryCache, hitStrokeSegment } from '../document/geometry-cache';
import { History, type Op } from '../document/history';
import {
  ENGINE_EXPERIMENTAL,
  ENGINE_VERSION,
  PAGE_SIZES,
  createPage,
  defaultBackground,
  PAPER_TONES,
  sizeOf,
  toneOf,
  newId,
  type Asset,
  type BackgroundKind,
  type DocSource,
  type HandNoteDocument,
  type Page,
  type Stroke,
} from '../document/model';
import { arrowTangents, detachMissing, isLine, resolveConnectors, shapeTouchesCircle, transformItem, type ImageItem, type Item, type ShapeItem, type TextItem } from '../document/items';
import { quantizeSample } from '../document/codec';
import { CanvasPathSink, emitStroke } from '../ink/outline';
import { StrokeBuilder, buildStrokeGeometry } from '../ink/stroke-builder';
import { isInkTool, isObjectTool, type InkTool, type InputSample, type PenParams, type Tool } from '../ink/types';
import { sanitizeExperimental, sanitizeParams, WIDTH_RANGE_MM } from '../ink/presets';
import { cutStroke } from '../ink/erase';
import { recognizeArrowHead, recognizeShape } from '../ink/shape-recognition';
import { PerfMonitor } from '../utils/perf';
import { InputRouter, LONG_PRESS_MS, type RouterHost, type RouterPointer, type PointerKind } from '../input/input-router';
import { InputDiagnostics } from '../input/diagnostics';
import { constrainCamera, previewTransform, screenToWorld, zoomAt, type Camera } from './camera';
import { documentBounds, layoutPages, paintInkStroke, paintPageContent, paintPaper, renderPageToCanvas, type PageRect } from '../rendering/paint';
import { LINE_HEIGHT, TEXT_PAD, assetDataUrl, fitTextBox, onImageLoaded, pencilFill, primeImage, registerAssets } from '../rendering/items-paint';
import { emitDashedGeometry } from '../rendering/dash';
import { docPageReady, onDocLayerReady, registerSources, setDocPaintText } from '../rendering/doc-layer';
import { documentPages } from '../import/pages';
import { ERASER_SIZES, addPaletteColor, type EditorSettings, type PaperTone, type StrokeDash } from './settings';
import { Toolbar, groupOf, type PenKind, type ToolGroup } from '../ui/toolbar';
import { LassoController, clipPlainText, lassoClipboard, setLassoClipboard, transformStroke } from './lasso';
import { ContextMenu, type MenuEntry } from '../ui/context-menu';
import { MAX_PASTE_IMAGE, cleanPastedText, fromDataTransfer, readSystemClipboard, samePlain, type ClipboardContent } from './system-clipboard';
import { PagesSidebar } from '../ui/pages-sidebar';
import { LaserPointer } from './laser';
import { layoutSelection, type LayoutOp } from './layout';
import type { AIStatus, AIRunResult } from '../ai/service';
import type { AIImage, AITask } from '../ai/types';
import { renderAIToolsMenu, renderConvertMenu, mathPreview } from '../ui/convert-panels';
import type { EngineInfo } from '../recognition/service';
import { ConvertFlow, type RecognitionBridge } from './convert-flow';
import type { RecTask } from '../recognition/types';
import { formulaBoxSize, formulaMarkdown, onFormulaReady, renderFormula } from '../rendering/formula';
import { el, type IconSetter, hide, show } from '../ui/dom';
import {
  Popover,
  renderColorPanel,
  renderConfirm,
  renderEraserPanel,
  renderListPicker,
  renderLassoFilterPanel,
  renderLineStylePanel,
  renderMoreMenu,
  renderPenPanel,
  renderStrokePanel,
  renderTemplatePanel,
  type TemplateChoice,
} from '../ui/panels';
import { t } from '../ui/i18n';
import { detectEnvironment, resolveInputMode, type InputMode } from '../input/input-mode';
import { pressureVerdict, quantile } from '../input/diagnostics';
import { DEFAULT_PEN_PARAMS, EXPERIMENTAL_FOUNTAIN } from '../ink/presets';
import { ObjectController } from './objects';

export interface EditorHost {
  /** Obsidian Platform.isMobileApp (input-mode Auto detection). */
  isMobileApp?: boolean;
  /** Show a short message (Obsidian Notice); the editor falls back to its own toast. */
  notify?(msg: string): void;
  /** Called after every document change (stroke added/erased, page added...). */
  onChange(): void;
  /** Called when the user changes a pen/tool setting (host persists it). */
  onSettingsChange(settings: EditorSettings): void;
  /** Kept for API compatibility; HandNote draws its own icons. */
  setIcon?: IconSetter;
  /** Extra menu actions provided by the host (export, etc.). */
  menuActions?: { label: string; run: () => void }[];
  /**
   * Store an inserted image (Obsidian: vault attachment) and return the src to keep in the note.
   * Without it, images are embedded as data URLs.
   */
  saveImage?(data: ArrayBuffer, mime: string, name: string): Promise<string>;
  /** Bytes of an image src (share). Defaults to fetching data URLs. */
  imageBlob?(src: string): Promise<Blob | null>;
  /** AI conversion (0.4 bridge, kept for API compatibility; the 0.5 editor uses `recognizer`). */
  ai?: AIBridge;
  /** Handwriting recognition / convert (0.5: HandwritingRecognitionService). */
  recognizer?: RecognitionBridge;
  /** Open the plugin's AI settings (shown when AI is not configured). */
  openAISettings?(): void;
  /** Export one page (page navigator menu). */
  exportPage?(index: number, kind: 'png' | 'svg'): void;
}

const NO_ENGINE: EngineInfo = { engine: 'vision', ready: false, reason: 'no-ai', model: '', label: '', sends: 'image', maxImageSide: 1280, kind: 'vision-llm' };

const DOUBLE_TAP_MS = 380;
const DOUBLE_TAP_PX = 60;

/** Page copied from the navigator ("Copy" → "Paste after"); shared by all open notes. */
let pageClipboard: Page | null = null;
/** The imported document a copied page shows (pasting into another note brings the reference along). */
let pageClipboardSource: DocSource | null = null;

/** The part of the AI service the editor uses. */
export interface AIBridge {
  status(): AIStatus;
  model(task: AITask): string;
  label(): string;
  textFont(): 'hand' | 'sans';
  run(task: AITask, image: AIImage, meta: { selectionId: string; bounds: { x: number; y: number; w: number; h: number }; language: 'zh' | 'en' }, signal?: AbortSignal): Promise<AIRunResult>;
}

interface ActiveStroke {
  pointerId: number;
  builder: StrokeBuilder;
  page: PageRect;
  tool: InkTool;
  color: string;
  t0: number; // event timestamp of first sample
  created: number;
  drawnStable: number; // stable samples already painted
  predicted: InputSample[];
  drawShape: boolean;
  dash: StrokeDash;
}

interface ActiveErase {
  pointerId: number;
  page: PageRect;
  lastX: number;
  lastY: number;
  beforeStrokes: Stroke[];
  beforeItems: Item[];
  changed: boolean;
}

const SCENE_OVERSCAN = 0.2;

/**
 * The handwriting editor: DOM, input routing, camera, rendering and undo history.
 * It has no dependency on Obsidian so it can be exercised in a plain browser (experiments/ink-lab)
 * and in automated browser tests.
 */
export class HandNoteEditor {
  readonly root: HTMLElement;
  readonly viewport: HTMLElement;
  readonly perf = new PerfMonitor();
  readonly cache = new GeometryCache();
  readonly history = new History();
  readonly objects: ObjectController;
  readonly lasso: LassoController;
  readonly laser: LaserPointer;

  private doc: HandNoteDocument;
  private rects: PageRect[] = [];
  private bounds = { minX: 0, maxX: 0, height: 0 };
  private cam: Camera = { x: 0, y: 0, zoom: 1 };
  private renderedCam: Camera = { x: 0, y: 0, zoom: 1 };
  private viewW = 0;
  private viewH = 0;
  private dpr = 1;
  private readOnly = false;
  private skipItems: ReadonlySet<string> = new Set();
  private skipObj: ReadonlySet<string> = new Set();
  private skipLasso: ReadonlySet<string> = new Set();
  private lassoPointer: { id: number; page: PageRect } | null = null;
  private laserPointer: number | null = null;
  private sidebar: PagesSidebar | null = null;
  private lastFingerTap: { x: number; y: number; t: number } | null = null;
  private sidebarRaf = 0;
  private sidebarCurrent = -1;
  private thumbCache = new WeakMap<Page, { key: string; strokes: Stroke[]; items: Item[]; canvas: HTMLCanvasElement }>();
  private kbHintShown = false;

  private scene: HTMLCanvasElement;
  private sceneCtx: CanvasRenderingContext2D;
  private activeStable: HTMLCanvasElement;
  private activeStableCtx: CanvasRenderingContext2D;
  private activeTail: HTMLCanvasElement;
  private activeTailCtx: CanvasRenderingContext2D;
  private hud: HTMLElement;
  private toolbar: Toolbar;
  private fileInput: HTMLInputElement;
  private popover: Popover | null = null;
  private popoverKind: string | null = null;
  /** Long-press / right-click context menu (0.9). */
  private ctxMenu: ContextMenu | null = null;
  /** Plain text HandNote wrote to the system clipboard for its last copy (see samePlain). */
  private clipStamp: string | null = null;
  /** Where the next picked image goes (context menu "Insert image here"). */
  private imageTarget: { pageId: string; x: number; y: number } | null = null;
  /** Last pointer position over the viewport (keyboard paste goes there). */
  private lastLocal: { x: number; y: number } | null = null;
  /** A keyboard paste is expected (Ctrl/Cmd+V); the paste event handles it, else a fallback. */
  private pasteFallback = 0;
  private hintShown = new Set<string>();
  mode: InputMode = 'pen';

  private active: ActiveStroke | null = null;
  private erase: ActiveErase | null = null;
  readonly router: InputRouter;
  readonly diagnostics = new InputDiagnostics();
  /** The DOM event currently being routed (gives host callbacks access to coalesced samples). */
  private evt: PointerEvent | null = null;
  private objPointer: { id: number; page: PageRect } | null = null;
  private navigating = false;
  private spaceHeld = false;
  private pointerInside = false;
  private hiddenCam: Camera | null = null;

  private rafId = 0;
  /** when the last ink stroke ended (a hand touch right after writing is not a tap on text) */
  private lastInkAt = -Infinity;
  /** fallback timer when requestAnimationFrame does not fire (iPad WebView stalls) */
  private rafGuard = 0;
  /** frames that had to be run by the fallback timer (diagnostics) */
  rafStalls = 0;
  private frameLoop = false;
  private sceneDirty = false;
  private lastSceneRenderMs = 0;
  private inertia: { vx: number; vy: number; last: number } | null = null;
  private resizeObs: ResizeObserver | null = null;
  private disposers: (() => void)[] = [];
  private destroyed = false;
  /** Set during destroy() after the last pending stroke / edit was committed. */
  private closed = false;
  private convertFlow: ConvertFlow;

  constructor(
    container: HTMLElement,
    doc: HandNoteDocument,
    private settings: EditorSettings,
    private readonly host: EditorHost,
  ) {
    this.doc = doc;
    this.root = el('div', 'hn-editor', container);
    this.toolbar = new Toolbar(this.root, this.toolbarActions());
    this.viewport = el('div', 'hn-viewport', this.root);
    this.viewport.tabIndex = 0;
    this.scene = el('canvas', 'hn-scene', this.viewport);
    this.activeStable = el('canvas', 'hn-active', this.viewport);
    this.activeTail = el('canvas', 'hn-active', this.viewport);
    this.hud = el('pre', 'hn-hud', this.viewport);
    this.fileInput = el('input', 'hn-file-input', this.root);
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      const at = this.imageTarget;
      this.imageTarget = null;
      if (f) void this.insertImageFile(f, at ?? undefined);
    });
    const ctxOpts = { desynchronized: true, alpha: true } as CanvasRenderingContext2DSettings;
    this.sceneCtx = this.scene.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    this.activeStableCtx = this.activeStable.getContext('2d', ctxOpts) as CanvasRenderingContext2D;
    this.activeTailCtx = this.activeTail.getContext('2d', ctxOpts) as CanvasRenderingContext2D;

    this.objects = new ObjectController({
      root: this.root,
      viewport: this.viewport,
      rects: () => this.rects,
      camera: () => this.cam,
      settings: () => this.settings,
      readOnly: () => this.readOnly,
      requestScene: () => this.requestScene(true),
      setSkip: (ids) => {
        this.skipObj = ids;
        this.updateSkip();
      },
      commit: (pageId, before, after) => {
        this.history.record({ kind: 'set-items', pageId, before, after });
        this.afterOp(false);
      },
      notify: (m) => this.notify(m),
      imageBlob: (src) => this.imageBlob(src),
      onSelection: (it) => this.onSelection(it),
      selectGroup: (pageId, g) => this.selectGroup(pageId, g),
      onEditStart: (ta) => this.onEditStart(ta),
      editFormula: (pageId, id) => this.editFormula(pageId, id),
      copyText: (text) => this.copyText(text),
      copied: (page, item) => {
        const assets: Record<string, Asset> = {};
        const all = this.doc.assets ?? {};
        if (item.type === 'image' && item.src.startsWith('asset:') && all[item.src.slice(6)]) assets[item.src.slice(6)] = all[item.src.slice(6)];
        setLassoClipboard({ strokes: [], items: [item], assets, box: { x: item.x, y: item.y, w: item.w, h: item.h } });
        void page;
        this.writeClipStamp(clipPlainText([item]));
      },
      contextMenu: (r, x, y) => this.openContextMenu(r, x, y),
    });
    this.convertFlow = new ConvertFlow(
      {
        root: this.root,
        cache: this.cache,
        readOnly: () => this.readOnly,
        pages: () => this.doc.pages,
        selection: () => {
          const f = this.lasso.selected();
          const b = this.lasso.bounds();
          return f && b ? { page: f.rect.page, strokes: f.strokes, items: f.items, bounds: b, outline: this.lasso.outlinePoints } : null;
        },
        push: (op) => this.pushOp(op),
        select: (pageId, ids) => this.lasso.setSelection({ pageId, strokeIds: new Set(), itemIds: new Set(ids) }),
        notify: (m) => this.notify(m),
        openSettings: () => {
          if (this.host.openAISettings) this.host.openAISettings();
        },
        enableOffline: () => {
          this.host.recognizer?.enableOffline?.();
          this.notify(t('engineOfflineEnabled'));
        },
        copy: (text) => this.copyText(text),
        language: () => (t('pen') === '笔' ? 'zh' : 'en'),
        defaultInkColor: () => this.settings.pens[this.settings.lastPen].color,
        overlay: this.objects.overlay,
        screenRect: (pageId, box) => {
          const r = this.rects.find((x) => x.page.id === pageId);
          if (!r) return null;
          const z = this.cam.zoom;
          return { x: (r.x + box.x - this.cam.x) * z, y: (r.y + box.y - this.cam.y) * z, w: box.w * z, h: box.h * z };
        },
        clearSelection: () => this.lasso.clear(),
        selectResult: (pageId, ids, outline) => this.lasso.setSelection({ pageId, strokeIds: new Set(), itemIds: new Set(ids) }, outline),
        editItem: (pageId, id) => {
          const it = this.doc.pages.find((p) => p.id === pageId)?.items.find((i) => i.id === id);
          if (!it || this.readOnly) return;
          if (it.type === 'formula') this.editFormula(pageId, id);
          else if (it.type === 'text') {
            this.lasso.clear();
            this.objects.select(pageId, id);
            this.objects.startEdit(pageId, id, false);
          }
        },
      },
      () => this.host.recognizer,
    );
    this.lasso = new LassoController(
      {
        viewport: this.viewport,
        cache: this.cache,
        rects: () => this.rects,
        camera: () => this.cam,
        dpr: () => this.dpr,
        settings: () => this.settings,
        readOnly: () => this.readOnly,
        setSkip: (ids) => {
          this.skipLasso = ids;
          this.updateSkip();
        },
        requestScene: () => this.requestScene(true),
        push: (op) => this.pushOp(op),
        notify: (m) => this.notify(m),
        assets: () => this.doc.assets ?? {},
        addAssets: (a) => this.addAssets(a),
        action: (name, anchor) => (name === 'ai' ? this.openAIMenu(anchor) : name === 'convert' ? this.openConvertMenu(anchor) : this.openLassoColor(anchor)),
        selectionChanged: (sel) => {
          if (sel) this.convertFlow.selectionReady();
        },
        tapItem: (r, x, y) => this.tapObjectWithLasso(r, x, y),
        loopStart: () => this.objects.deselect(),
        copied: (plain) => this.writeClipStamp(plain),
        contextMenu: (r, x, y) => this.openContextMenu(r, x, y),
      },
      this.objects.overlay,
    );
    this.laser = new LaserPointer(this.viewport, () => this.settings.laser);
    registerAssets(doc.assets);
    registerSources(doc.sources);
    setDocPaintText({ loading: t('docLoading'), missing: t('docMissing'), failed: t('docFailed') });

    this.perf.capabilities = probeCapabilities();
    this.diagnostics.setEnabled(settings.diagnostics);
    this.applyMode();
    this.router = new InputRouter(this.routerHost(), {
      fingerDrawing: settings.fingerDrawing,
      tapGestures: settings.tapGestures,
    });
    this.bindInput();
    this.disposers.push(onImageLoaded(() => this.requestScene(true)));
    this.disposers.push(onFormulaReady(() => this.requestScene(true)));
    this.disposers.push(
      onDocLayerReady(() => {
        this.requestScene(true);
        this.sidebar?.refreshThumbs();
      }),
    );
    this.relayout();
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.viewport);
    this.onResize();
    this.fitWidth(0);
    this.updateToolbar();
    this.updateHud();
  }

  // ===============================================================================================
  // Public API
  // ===============================================================================================

  getDocument(): HandNoteDocument {
    return this.doc;
  }

  /** Replace the document (e.g. reload after an external change). Keeps camera when possible. */
  setDocument(doc: HandNoteDocument, opts: { keepCamera?: boolean; resetHistory?: boolean } = {}): void {
    this.cancelActive();
    this.convertFlow.closeResult();
    this.objects.deselect();
    this.lasso.clear();
    this.doc = doc;
    registerAssets(doc.assets);
    registerSources(doc.sources);
    if (opts.resetHistory !== false) this.history.clear();
    this.relayout();
    if (!opts.keepCamera) this.fitWidth(0);
    else this.setCamera(this.cam);
    this.requestScene(true);
    this.updateToolbar();
  }

  /** Repaint everything (a document page's source changed). */
  requestRedraw(): void {
    this.requestScene(true);
  }

  setReadOnly(ro: boolean): void {
    this.readOnly = ro;
    this.root.classList.toggle('is-readonly', ro);
    if (ro) this.objects.deselect();
    this.lasso.sync();
    this.updateToolbar();
  }

  setStatus(status: 'saved' | 'dirty' | 'saving' | 'error' | 'readonly'): void {
    this.toolbar.setStatus(status);
  }

  getSettings(): EditorSettings {
    return this.settings;
  }

  updateSettings(s: EditorSettings): void {
    this.settings = s;
    this.router.setOptions({ fingerDrawing: s.fingerDrawing, tapGestures: s.tapGestures });
    this.diagnostics.setEnabled(s.diagnostics);
    this.applyMode();
    this.updateToolbar();
    this.updateHud();
  }

  get camera(): Camera {
    return { ...this.cam };
  }

  /** Move the camera (clamped to the document) and re-render. */
  setView(c: Camera): void {
    this.setCamera(c);
    this.renderScene();
    this.updateToolbar();
  }

  /** Page-local coordinates -> client (CSS) coordinates. Used by tests and overlays. */
  pageToClient(pageIndex: number, x: number, y: number): { x: number; y: number } {
    const r = this.rects[pageIndex];
    const vr = this.viewport.getBoundingClientRect();
    if (!r) return { x: vr.left, y: vr.top };
    return { x: vr.left + (r.x + x - this.cam.x) * this.cam.zoom, y: vr.top + (r.y + y - this.cam.y) * this.cam.zoom };
  }

  /** Commit any in-progress stroke (call before saving / when the app goes to background). */
  commitPending(): void {
    // Router reset commits the stroke owned by the router and forgets every contact (a contact
    // whose pointerup is lost while the app is suspended must not block navigation later).
    this.router.reset();
    if (this.active) this.endStroke(true);
    if (this.erase) this.endErase();
    this.objects.cancel();
    this.objects.finishEdit();
    this.setSpace(false);
  }

  undo(): void {
    if (this.active || this.erase || this.objects.busy || this.lasso.busy) return;
    this.objects.finishEdit();
    this.lasso.clear();
    const r = this.history.undo(this.doc);
    if (r) this.afterOp(r.structural);
    this.objects.sync();
  }

  redo(): void {
    if (this.active || this.erase || this.objects.busy || this.lasso.busy) return;
    this.objects.finishEdit();
    this.lasso.clear();
    const r = this.history.redo(this.doc);
    if (r) this.afterOp(r.structural);
    this.objects.sync();
  }

  setTool(tool: Tool): void {
    const prevGroup = groupOf(this.settings.tool);
    if (tool === 'ballpoint') tool = 'fountain';
    if (tool !== this.settings.tool || !isObjectTool(tool)) this.objects.deselect();
    if (tool !== 'lasso') this.lasso.clear();
    if (tool !== 'laser') this.laser.clear();
    this.settings.tool = tool;
    if (isInkTool(tool)) this.settings.lastPen = tool;
    if (groupOf(tool) !== prevGroup) this.settings.subbarOpen = true;
    this.host.onSettingsChange(this.settings);
    this.closePopover();
    this.updateToolbar();
    if (tool === 'text') this.hint('text', t('tapToAddText'));
    if (tool === 'shape') this.hint('shape', t('dragToDrawShape'));
    this.viewport.classList.toggle('is-laser', tool === 'laser');
  }

  setColor(c: string): void {
    const tool = this.settings.tool;
    if (!isInkTool(tool)) return;
    this.settings.pens[tool].color = c;
    this.host.onSettingsChange(this.settings);
    this.updateToolbar();
  }

  setWidth(w: number): void {
    const tool = this.settings.tool;
    if (!isInkTool(tool)) return;
    this.setActiveParams(tool, { ...this.activeParams(tool), width: w });
    this.host.onSettingsChange(this.settings);
    this.updateToolbar();
  }

  currentPageIndex(): number {
    const centerY = this.cam.y + this.viewH / this.cam.zoom / 2;
    let best = 0;
    for (const r of this.rects) {
      if (r.y <= centerY) best = r.index;
    }
    return best;
  }

  gotoPage(index: number): void {
    const r = this.rects[Math.max(0, Math.min(this.rects.length - 1, index))];
    if (!r) return;
    this.setCamera({ ...this.cam, y: r.y - 12 / this.cam.zoom });
    this.requestScene(true);
    this.updateToolbar();
  }

  addPageAfterCurrent(): void {
    if (this.readOnly) return;
    const idx = this.currentPageIndex();
    const cur = this.doc.pages[idx];
    const page = createPage(cur?.width ?? 595, cur?.height ?? 842, cur?.background ?? defaultBackground(this.settings.newPageBackground, this.settings.newPaperTone));
    this.pushOp({ kind: 'add-page', index: idx + 1, page });
    this.gotoPage(idx + 1);
  }

  /** Remove all ink, text boxes, images and shapes from the current page (one undo step). */
  clearCurrentPage(): void {
    if (this.readOnly) return;
    const page = this.doc.pages[this.currentPageIndex()];
    if (!page || (page.strokes.length === 0 && page.items.length === 0)) return;
    this.objects.deselect();
    const ops: Op[] = [];
    if (page.strokes.length) ops.push({ kind: 'set-strokes', pageId: page.id, before: page.strokes, after: [] });
    if (page.items.length) ops.push({ kind: 'set-items', pageId: page.id, before: page.items, after: [] });
    this.pushOp(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    this.notify(t('pageCleared'));
  }

  deleteCurrentPage(): void {
    if (this.readOnly || this.doc.pages.length <= 1) return;
    const idx = this.currentPageIndex();
    const page = this.doc.pages[idx];
    this.objects.deselect();
    this.pushOp({ kind: 'remove-page', index: idx, page });
    this.gotoPage(Math.min(idx, this.doc.pages.length - 1));
  }

  setPageBackground(kind: BackgroundKind): void {
    const page = this.doc.pages[this.currentPageIndex()];
    if (!page) return;
    this.applyTemplate({ ...this.templateOf(page), kind, scope: 'page' });
  }

  setPaperTone(tone: PaperTone): void {
    const page = this.doc.pages[this.currentPageIndex()];
    if (!page) return;
    this.applyTemplate({ ...this.templateOf(page), tone, scope: 'all' });
  }

  private templateOf(page: Page): TemplateChoice {
    const s = sizeOf(page);
    return { sizeId: s.id === 'custom' ? 'a4' : s.id, landscape: s.landscape, tone: toneOf(page.background), kind: page.background.kind, scope: 'page' };
  }

  /** Change page size / orientation / paper colour / pattern (undoable). */
  applyTemplate(c: TemplateChoice): void {
    if (this.readOnly) return;
    const size = PAGE_SIZES.find((p) => p.id === c.sizeId) ?? PAGE_SIZES[1];
    const width = c.landscape ? size.height : size.width;
    const height = c.landscape ? size.width : size.height;
    const tone = PAPER_TONES[c.tone];
    const idx = this.currentPageIndex();
    const targets = c.scope === 'all' ? this.doc.pages : [this.doc.pages[idx]].filter(Boolean);
    const ops: Op[] = targets.map((p) => {
      const before = { width: p.width, height: p.height, background: { ...p.background } };
      const kindChanged = p.background.kind !== c.kind;
      const background = {
        ...p.background,
        kind: c.kind,
        spacing: kindChanged ? defaultBackground(c.kind).spacing : p.background.spacing,
        paper: tone.paper,
        line: tone.line,
      };
      return { kind: 'set-page', pageId: p.id, before, after: { width, height, background } };
    });
    if (!ops.length) return;
    this.settings.newPaperTone = c.tone;
    this.settings.newPageBackground = c.kind;
    this.host.onSettingsChange(this.settings);
    this.pushOp(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    this.fitWidth(idx);
    this.updateToolbar();
  }

  private fitWidthZoom(viewW = this.viewW): number {
    const maxW = Math.max(...this.doc.pages.map((p) => p.width), 100);
    return Math.min(3, Math.max(0.3, (viewW - 24) / maxW));
  }

  /**
   * The page sidebar changes the viewport width: keep the paper fitted to the width if it was,
   * otherwise keep the same point in the centre.
   */
  private keepViewAcrossResize(change: () => void): void {
    const z = this.cam.zoom;
    const wasFit = this.viewW > 0 && Math.abs(z - this.fitWidthZoom()) / z < 0.03;
    const cx = this.cam.x + this.viewW / 2 / z;
    const cy = this.cam.y + this.viewH / 2 / z;
    change();
    this.onResize();
    if (this.viewW <= 0) return;
    const nz = wasFit ? this.fitWidthZoom() : z;
    this.setCamera({ x: wasFit ? 0 : cx - this.viewW / 2 / nz, y: cy - this.viewH / 2 / nz, zoom: nz });
    this.requestScene(true);
  }

  fitWidth(pageIndex = this.currentPageIndex()): void {
    if (this.viewW <= 0) return;
    const zoom = this.fitWidthZoom();
    const r = this.rects[pageIndex] ?? this.rects[0];
    this.setCamera({ x: 0, y: (r ? r.y : 0) - 12 / zoom, zoom });
    this.requestScene(true);
  }

  /** Zoom so the whole current page is visible. */
  fitPage(pageIndex = this.currentPageIndex()): void {
    const r = this.rects[pageIndex] ?? this.rects[0];
    if (!r || this.viewW <= 0) return;
    const zoom = Math.min((this.viewW - 24) / r.w, (this.viewH - 24) / r.h);
    this.setCamera({ x: r.x + r.w / 2 - this.viewW / 2 / zoom, y: r.y + r.h / 2 - this.viewH / 2 / zoom, zoom });
    this.requestScene(true);
    this.updateToolbar();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closePopover();
    this.closeContextMenu();
    window.clearTimeout(this.pasteFallback);
    this.commitPending();
    // from here on no operation reaches the document (the stroke in progress was committed above)
    this.closed = true;
    this.closePagesSidebar();
    this.toolbar.destroy();
    this.convertFlow.dispose();
    this.objects.destroy();
    this.lasso.destroy();
    this.laser.destroy();
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.rafGuard);
    this.resizeObs?.disconnect();
    for (const d of this.disposers) d();
    // release canvas memory immediately (iOS keeps it until GC otherwise)
    for (const c of [this.scene, this.activeStable, this.activeTail]) {
      c.width = 0;
      c.height = 0;
    }
    this.root.remove();
  }

  // ===============================================================================================
  // Layout, camera, rendering
  // ===============================================================================================

  private relayout(): void {
    this.rects = layoutPages(this.doc);
    this.bounds = documentBounds(this.rects);
  }

  private onResize(): void {
    const r = this.viewport.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) {
      // Hidden (background tab, collapsed pane): release canvas memory. iPadOS limits the total
      // canvas memory of a web view, and Obsidian keeps background tabs alive.
      this.commitPending();
      for (const c of [this.scene, this.activeStable, this.activeTail]) {
        c.width = 0;
        c.height = 0;
      }
      if (this.viewW > 0) this.hiddenCam = { ...this.cam };
      this.viewW = 0;
      this.viewH = 0;
      return;
    }
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.viewW && h === this.viewH && dpr === this.dpr) return;
    const first = this.viewW === 0 && !this.hiddenCam;
    if (this.hiddenCam) {
      this.cam = this.hiddenCam;
      this.hiddenCam = null;
    }
    this.viewW = w;
    this.viewH = h;
    this.dpr = dpr;
    const ov = Math.round(Math.max(w, h) * SCENE_OVERSCAN);
    this.sizeCanvas(this.scene, w + 2 * ov, h + 2 * ov, -ov, -ov);
    this.sizeCanvas(this.activeStable, w, h, 0, 0);
    this.sizeCanvas(this.activeTail, w, h, 0, 0);
    this.scene.style.transformOrigin = `${ov}px ${ov}px`;
    if (first) this.fitWidth(0);
    else this.setCamera(this.cam);
    this.renderScene();
  }

  private sizeCanvas(c: HTMLCanvasElement, w: number, h: number, left: number, top: number): void {
    c.width = Math.round(w * this.dpr);
    c.height = Math.round(h * this.dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.style.left = `${left}px`;
    c.style.top = `${top}px`;
  }

  private get overscan(): number {
    return Math.round(Math.max(this.viewW, this.viewH) * SCENE_OVERSCAN);
  }

  private setCamera(c: Camera): void {
    this.cam = constrainCamera(c, { w: this.viewW, h: this.viewH }, this.bounds);
    // keep the scene bitmap aligned until the next re-render
    const tr = previewTransform(this.renderedCam, this.cam);
    this.scene.style.transform = `translate(${tr.tx}px, ${tr.ty}px) scale(${tr.k})`;
    this.objects?.sync();
    this.lasso?.sync();
    this.convertFlow?.sync();
  }

  /** Schedule a scene re-render on the next frame. */
  requestScene(full = true): void {
    this.sceneDirty = true;
    void full;
    this.schedule();
  }

  private schedule(): void {
    if (this.rafId || this.destroyed) return;
    this.rafId = window.requestAnimationFrame((now) => this.onFrame(now));
    // iPad (WKWebView): requestAnimationFrame sometimes stops firing until the page is scrolled —
    // the editor then looked frozen. A frame that is late by far is run from a timer instead.
    window.clearTimeout(this.rafGuard);
    this.rafGuard = window.setTimeout(() => {
      if (!this.rafId || this.destroyed || document.visibilityState === 'hidden') return;
      cancelAnimationFrame(this.rafId);
      this.rafStalls++;
      this.onFrame(performance.now());
    }, 150);
  }

  private onFrame(now: number): void {
    window.clearTimeout(this.rafGuard);
    this.rafId = 0;
    if (this.destroyed) return;
    if (this.active) this.perf.frame(now);
    if (this.inertia) this.stepInertia(now);
    if (this.active) this.renderActive();
    if (this.sceneDirty) {
      const gestureActive = this.navigating || this.inertia !== null;
      // During navigation, re-render only if it is cheap; otherwise rely on the CSS preview transform
      if (!gestureActive || this.lastSceneRenderMs < 7) {
        this.renderScene();
      } else {
        this.schedule();
      }
    }
    if (this.active || this.frameLoop) this.schedule();
  }

  private sceneCtxTransform(ctx: CanvasRenderingContext2D, cam: Camera, ov: number): void {
    const k = this.dpr * cam.zoom;
    ctx.setTransform(k, 0, 0, k, this.dpr * (ov - cam.x * cam.zoom), this.dpr * (ov - cam.y * cam.zoom));
  }

  renderScene(): void {
    const t0 = performance.now();
    this.sceneDirty = false;
    const ctx = this.sceneCtx;
    const ov = this.overscan;
    const cam = this.cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar(this.viewport, '--hn-desk', '#e9e9ec');
    ctx.fillRect(0, 0, this.scene.width, this.scene.height);
    this.sceneCtxTransform(ctx, cam, ov);
    const vx0 = cam.x - ov / cam.zoom;
    const vy0 = cam.y - ov / cam.zoom;
    const vx1 = cam.x + (this.viewW + ov) / cam.zoom;
    const vy1 = cam.y + (this.viewH + ov) / cam.zoom;
    const shadow = cssVar(this.viewport, '--hn-page-shadow', 'rgba(0,0,0,0.12)');
    for (const r of this.rects) {
      if (r.x > vx1 || r.x + r.w < vx0 || r.y > vy1 || r.y + r.h < vy0) continue;
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.fillStyle = shadow;
      ctx.fillRect(1.5 / cam.zoom, 2 / cam.zoom, r.w, r.h);
      paintPaper(ctx, r.page, this.dpr * cam.zoom, this.settings.paperTexture);
      ctx.beginPath();
      ctx.rect(0, 0, r.w, r.h);
      ctx.clip();
      paintPageContent(ctx, r.page, this.cache, { clip: [vx0 - r.x, vy0 - r.y, vx1 - r.x, vy1 - r.y] }, this.skipItems);
      ctx.restore();
    }
    this.renderedCam = { ...cam };
    this.scene.style.removeProperty('transform');
    this.lastSceneRenderMs = performance.now() - t0;
    this.perf.sceneRender.push(this.lastSceneRenderMs);
  }

  /** Paint one committed ink stroke onto the scene bitmap without a full re-render. */
  private paintCommitted(stroke: Stroke, r: PageRect): void {
    const ctx = this.sceneCtx;
    this.sceneCtxTransform(ctx, this.renderedCam, this.overscan);
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.beginPath();
    ctx.rect(0, 0, r.w, r.h);
    ctx.clip();
    paintInkStroke(ctx, stroke, this.cache.get(stroke));
    ctx.restore();
  }

  private activeTransform(ctx: CanvasRenderingContext2D, r: PageRect): void {
    const k = this.dpr * this.cam.zoom;
    ctx.setTransform(k, 0, 0, k, k * (r.x - this.cam.x), k * (r.y - this.cam.y));
  }

  private inkFill(ctx: CanvasRenderingContext2D, a: ActiveStroke): string | CanvasPattern {
    return a.tool === 'pencil' ? pencilFill(ctx, a.color) : a.color;
  }

  private renderActive(): void {
    const a = this.active;
    if (!a) return;
    const t0 = performance.now();
    if (a.dash !== 'solid') {
      this.renderActiveDashed(a);
      this.perf.render.push(performance.now() - t0);
      return;
    }
    const st = a.builder.stable();
    const n = st.xs.length;
    // 1) append newly stable capsules to the stable layer (never cleared during the stroke)
    if (n > a.drawnStable) {
      const ctx = this.activeStableCtx;
      this.activeTransform(ctx, a.page);
      ctx.fillStyle = this.inkFill(ctx, a);
      ctx.beginPath();
      emitStroke(new CanvasPathSink(ctx), st.xs, st.ys, st.rs, Math.max(0, a.drawnStable - 1));
      ctx.fill('nonzero');
      a.drawnStable = n;
    }
    // 2) redraw the tail (from the last stable sample to the pen tip)
    const tctx = this.activeTailCtx;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, this.activeTail.width, this.activeTail.height);
    const tl = a.builder.tail(this.settings.usePrediction ? a.predicted : undefined);
    if (tl.xs.length) {
      const xs = n ? [st.xs[n - 1], ...tl.xs] : tl.xs;
      const ys = n ? [st.ys[n - 1], ...tl.ys] : tl.ys;
      const rs = n ? [st.rs[n - 1], ...tl.rs] : tl.rs;
      this.activeTransform(tctx, a.page);
      tctx.fillStyle = this.inkFill(tctx, a);
      tctx.beginPath();
      emitStroke(new CanvasPathSink(tctx), xs, ys, rs, 0, xs.length === 1);
      tctx.fill('nonzero');
    } else if (n === 0 && a.builder.rawCount > 0) {
      const s = a.builder.rawSamples[0];
      this.activeTransform(tctx, a.page);
      tctx.fillStyle = this.inkFill(tctx, a);
      tctx.beginPath();
      tctx.arc(s.x, s.y, a.builder.params.width / 2, 0, Math.PI * 2);
      tctx.fill();
    }
    this.perf.render.push(performance.now() - t0);
  }

  /** Dashed / dotted strokes: the pattern depends on the whole length, so redraw it each frame. */
  private renderActiveDashed(a: ActiveStroke): void {
    const st = a.builder.stable();
    const tl = a.builder.tail(undefined);
    const n = st.xs.length;
    const xs = [...st.xs, ...tl.xs];
    const ys = [...st.ys, ...tl.ys];
    const rs = [...st.rs, ...tl.rs];
    const ctx = this.activeTailCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.activeTail.width, this.activeTail.height);
    if (!xs.length) return;
    void n;
    this.activeTransform(ctx, a.page);
    ctx.fillStyle = this.inkFill(ctx, a);
    ctx.beginPath();
    emitDashedGeometry(new CanvasPathSink(ctx), { xs, ys, rs, dot: xs.length === 1, bbox: [0, 0, 0, 0] }, a.dash as 'dash' | 'dot', a.builder.params.width);
    ctx.fill('nonzero');
  }

  private clearActive(): void {
    for (const [c, ctx] of [
      [this.activeStable, this.activeStableCtx],
      [this.activeTail, this.activeTailCtx],
    ] as const) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
    }
    this.activeStable.style.removeProperty('opacity');
    this.activeTail.style.removeProperty('opacity');
  }

  // ===============================================================================================
  // Document operations
  // ===============================================================================================

  private pushOp(op: Op): void {
    // a late async result (conversion, image, AI) must not change a note whose editor is gone
    if (this.closed) return;
    const r = this.history.push(this.doc, op);
    this.afterOp(r.structural);
  }

  private afterOp(structural: boolean): void {
    if (structural) this.relayout();
    this.setCamera(this.cam);
    this.lasso.sync();
    this.convertFlow.sync();
    this.requestScene(true);
    this.updateToolbar();
    this.host.onChange();
    this.refreshSidebar();
  }

  /** Re-render the page navigator after a document change (once per frame). */
  private refreshSidebar(): void {
    if (!this.sidebar || this.sidebarRaf) return;
    this.sidebarRaf = window.requestAnimationFrame(() => {
      this.sidebarRaf = 0;
      this.sidebar?.render();
    });
  }

  private pageAt(wx: number, wy: number): PageRect | null {
    for (const r of this.rects) {
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return r;
    }
    return null;
  }

  // ===============================================================================================
  // Input — DOM events are normalized and handed to the InputRouter, which owns every pointer.
  // ===============================================================================================

  private bindInput(): void {
    const v = this.viewport;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(v, 'pointerdown', (e) => this.guard(() => this.onPointerDown(e)));
    on(v, 'pointermove', (e) => this.guard(() => this.onPointerMove(e)));
    on(v, 'pointerup', (e) => this.guard(() => this.onPointerEnd(e, false)));
    on(v, 'pointercancel', (e) => this.guard(() => this.onPointerEnd(e, true)));
    on(v, 'lostpointercapture', (e) => this.guard(() => this.router.lostCapture(e.pointerId, e.timeStamp)));
    // Backup: a pointer that ends outside the viewport without capture (capture failed or was
    // released) must still end, otherwise the router keeps it as an active pen.
    const endOutside = (e: PointerEvent, cancelled: boolean) => {
      if (this.router.ownerOf(e.pointerId) === undefined) return;
      if (e.target instanceof Node && v.contains(e.target)) return; // the viewport handler has it
      this.guard(() => this.onPointerEnd(e, cancelled));
    };
    on(window, 'pointerup', (e) => endOutside(e, false));
    on(window, 'pointercancel', (e) => endOutside(e, true));
    on(v, 'pointerenter', () => (this.pointerInside = true));
    on(v, 'pointerleave', () => (this.pointerInside = false));
    on(v, 'wheel', (e) => this.onWheel(e), { passive: false });
    // Stop iOS / Obsidian mobile from turning touches on the page into native scrolling, sidebar
    // swipes, text selection, the loupe, or Scribble. Pointer events are still delivered, and the
    // router implements panning and zooming itself (touch-action: none on the viewport).
    // Overlay controls (text editor, object buttons) keep their native touch behaviour.
    const stop = (e: TouchEvent) => {
      if (isOverlayTarget(e.target)) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };
    on(v, 'touchstart', stop, { passive: false });
    on(v, 'touchmove', stop, { passive: false });
    on(v, 'touchend', stop, { passive: false });
    // self-heal: when the last finger / Pencil leaves the screen, every open contact is over even
    // if its pointerup was lost (checked a moment later, after the pointer events of that touch)
    const lifted = (e: Event) => {
      if ((e as TouchEvent).touches?.length) return;
      window.setTimeout(() => {
        if (this.destroyed || !this.router.contactCount) return;
        this.guard(() => {
          if (this.router.liftAll(performance.now())) this.requestScene(true);
        });
      }, 300);
    };
    on(document, 'touchend', lifted, { capture: true, passive: true });
    on(document, 'touchcancel', lifted, { capture: true, passive: true });
    // iOS keyboard: run the pending text-box focus inside the touch gesture (capture phase, before
    // the viewport handler cancels the touch)
    const flushFocus = () => {
      if (!this.objects.pendingFocus) return;
      this.objects.focusEditor();
      this.objects.pendingFocus = null;
    };
    on(document, 'touchend', flushFocus as (e: Event) => void, { capture: true });
    on(document, 'click', flushFocus as (e: Event) => void, { capture: true });
    // iOS scrolls overflow:hidden containers to reveal a focused element (text box, colour input).
    // A scrolled viewport would move the canvases away from the pen, so scrolling is pinned to 0.
    const pin = () => this.pinScroll();
    for (const elx of [v, this.root, this.root.parentElement].filter(Boolean) as HTMLElement[]) on(elx, 'scroll', pin, { passive: true });
    on(v, 'contextmenu', (e) => {
      if (isOverlayTarget(e.target)) return;
      e.preventDefault();
      // desktop right click: the same menu as a finger long press (touch long presses are handled
      // by the router; a contextmenu event from a touch is ignored here)
      if (e.pointerType === 'touch' || this.router.contactCount) return;
      const l = this.localPoint(e);
      const page = this.pageForPoint(l);
      if (page) {
        const w = screenToWorld(this.cam, l.x, l.y);
        this.openContextMenu(page, w.x - page.x, w.y - page.y);
      }
    });
    on(document, 'paste', (e) => this.guard(() => this.onPasteEvent(e)));
    on(v, 'dblclick', (e) => e.preventDefault());
    on(document, 'keydown', (e) => this.onKey(e, true));
    on(document, 'keyup', (e) => this.onKey(e, false));
    on(window, 'blur', () => this.setSpace(false));
    on(document, 'visibilitychange' as keyof HTMLElementEventMap, () => {
      if (document.visibilityState === 'hidden') this.commitPending();
    });
    on(window, 'orientationchange' as keyof HTMLElementEventMap, () => this.commitPending());
  }

  /**
   * Run an input handler; an unexpected exception must not leave a half-finished gesture behind
   * (a stuck "pen is drawing" state ignores every later touch and stroke).
   */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('HandNote: input handler failed; input state reset', err);
      this.evt = null;
      try {
        this.router.reset();
      } catch {
        /* ignore */
      }
      this.active = null;
      this.frameLoop = false;
      this.erase = null;
      this.laserPointer = null;
      this.lassoPointer = null;
      this.objPointer = null;
      this.clearActive();
      this.requestScene(true);
    }
  }

  private normalize(e: PointerEvent): RouterPointer {
    const local = this.localPoint(e);
    const kind: PointerKind = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
    return {
      id: e.pointerId,
      kind,
      x: local.x,
      y: local.y,
      t: e.timeStamp,
      button: e.button,
      buttons: e.buttons,
      pressure: e.pressure,
      width: e.width || 0,
      height: e.height || 0,
    };
  }

  private onPointerDown(e: PointerEvent): void {
    if (isOverlayTarget(e.target)) return;
    this.pinScroll();
    this.closePopover();
    this.closeContextMenu();
    const p = this.normalize(e);
    this.lastLocal = { x: p.x, y: p.y };
    this.diagnostics.pointerDown(p);
    this.evt = e;
    const owner = this.router.down(p);
    this.evt = null;
    if (owner === null) return;
    e.preventDefault();
    if (owner === 'nav' && p.kind === 'touch') {
      // finger long press → context menu (the router decides whether the finger is still eligible)
      const id = p.id;
      window.setTimeout(() => {
        if (this.destroyed) return;
        this.guard(() => {
          this.router.longPressCheck(id, performance.now());
        });
      }, LONG_PRESS_MS + 20);
    }
    if (owner === 'ink' || owner === 'erase') this.blurEditors();
    try {
      this.viewport.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events cannot be captured */
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const owner = this.router.ownerOf(e.pointerId);
    if (owner === undefined && e.pointerType === 'mouse' && this.settings.tool === 'laser' && e.buttons === 0) {
      const l = this.localPoint(e);
      this.laser.hover(l.x, l.y);
      return;
    }
    if (e.pointerType === 'mouse') this.lastLocal = this.localPoint(e);
    if (owner === undefined && !(this.navigating && e.pointerType === 'mouse')) return;
    if (owner !== undefined) e.preventDefault();
    this.evt = e;
    this.router.move(this.normalize(e), e);
    this.evt = null;
  }

  private onPointerEnd(e: PointerEvent, cancelled: boolean): void {
    this.evt = e;
    if (cancelled) this.router.cancel(this.normalize(e));
    else this.router.up(this.normalize(e));
    this.evt = null;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const tg = e.target as HTMLElement | null;
    const editable = !!tg && (tg.isContentEditable || tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || !!tg.closest?.('.cm-editor'));
    if (editable) return;
    const focused = this.viewport.contains(document.activeElement) || this.root.contains(document.activeElement);
    if (!focused && !this.pointerInside) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      this.setSpace(down);
      return;
    }
    if (!down) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && (k === '=' || k === '+')) {
      e.preventDefault();
      this.zoomBy(1.25);
    } else if (mod && k === '-') {
      e.preventDefault();
      this.zoomBy(0.8);
    } else if (mod && k === '0') {
      e.preventDefault();
      this.fitWidth();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.lasso.selection) {
      e.preventDefault();
      this.lasso.deleteSelection();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.objects.selected) {
      e.preventDefault();
      this.objects.deleteSelected();
    } else if (mod && k === 'c' && this.lasso.selection) {
      e.preventDefault();
      this.lasso.copy();
    } else if (mod && k === 'c' && this.objects.selected) {
      e.preventDefault();
      this.objects.copySelected();
      this.notify(t('copied'));
    } else if (mod && k === 'x' && this.lasso.selection) {
      e.preventDefault();
      this.lasso.cut();
    } else if (mod && k === 'v' && !this.readOnly) {
      // Let the browser fire the paste event (it carries the system clipboard: text, images).
      // If no paste event arrives (some hosts swallow it), paste HandNote's own copy instead.
      window.clearTimeout(this.pasteFallback);
      this.pasteFallback = window.setTimeout(() => {
        if (this.destroyed || !lassoClipboard()) return;
        const at = this.pastePoint();
        if (at) this.pasteHandNote(at.r, at.x, at.y);
      }, 250);
    } else if (e.key === 'Escape' && this.lasso.selection) {
      this.lasso.clear();
    } else if (!mod && !e.altKey && focused) {
      const tools: Record<string, Tool> = { '1': 'fountain', '2': 'pencil', '3': 'highlighter', '4': 'eraser', e: 'eraser', t: 'text', l: 'lasso' };
      if (tools[k]) {
        e.preventDefault();
        this.settings.drawShape = false;
        this.setTool(tools[k]);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        this.gotoPage(this.currentPageIndex() + 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        this.gotoPage(this.currentPageIndex() - 1);
      }
    }
  }

  private setSpace(down: boolean): void {
    if (this.spaceHeld === down) return;
    this.spaceHeld = down;
    this.router.setSpace(down);
    this.viewport.classList.toggle('is-space-pan', down);
  }

  /** Zoom around the viewport centre (keyboard / buttons). */
  zoomBy(factor: number): void {
    this.setCamera(zoomAt(this.cam, this.cam.zoom * factor, this.viewW / 2, this.viewH / 2));
    this.requestScene(true);
    this.updateToolbar();
  }

  /** Page-local point of a router pointer. */
  private localOn(page: PageRect, p: { x: number; y: number }): { x: number; y: number } {
    const w = screenToWorld(this.cam, p.x, p.y);
    return { x: w.x - page.x, y: w.y - page.y };
  }

  /** The editor side of the InputRouter contract. */
  private routerHost(): RouterHost {
    return {
      getCamera: () => ({ ...this.cam }),
      setCamera: (c) => {
        this.setCamera(c);
        this.requestScene(true);
        return { ...this.cam };
      },
      drawKindFor: (p) => {
        const tool = this.settings.tool;
        if (tool !== 'laser' && tool !== 'lasso' && p.kind === 'pen' && (p.button === 5 || (p.buttons & 32) !== 0)) return 'erase';
        return tool === 'eraser' ? 'erase' : 'ink';
      },
      canDrawAt: () => this.rects.length > 0 && (!this.readOnly || isObjectTool(this.settings.tool) || this.settings.tool === 'laser' || this.settings.tool === 'lasso'),
      inkBegin: (p) => {
        if (this.settings.tool === 'laser') {
          this.laserPointer = p.id;
          this.laser.begin(p.x, p.y);
          return;
        }
        const page = this.pageForPoint(p);
        if (!page) return;
        if (this.settings.tool === 'lasso') {
          const l = this.localOn(page, p);
          this.lassoPointer = { id: p.id, page };
          this.lasso.pointerBegin(page, l.x, l.y, p.id);
          return;
        }
        if (isObjectTool(this.settings.tool)) {
          const l = this.localOn(page, p);
          this.objPointer = { id: p.id, page };
          this.objects.pointerBegin(page, l.x, l.y, p.id);
          return;
        }
        if (this.readOnly) return;
        const e = this.evt;
        const tool = isInkTool(this.settings.tool) ? this.settings.tool : 'fountain';
        if (e) this.beginStroke(e, page, tool);
      },
      inkMove: (p, raw) => {
        if (this.laserPointer === p.id) {
          this.laser.move(p.x, p.y);
          return;
        }
        if (this.lassoPointer) {
          const page = this.lassoPointer.page;
          // every coalesced sample: the loop follows the pen as closely as the ink does
          const e = raw as PointerEvent | null;
          const list = e && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          if (list && list.length > 1) {
            for (const ce of list) {
              const l = this.localOn(page, this.localPoint(ce));
              this.lasso.pointerMove(page, l.x, l.y);
            }
          } else {
            const l = this.localOn(page, p);
            this.lasso.pointerMove(page, l.x, l.y);
          }
          return;
        }
        if (this.objPointer) {
          const page = this.objPointer.page;
          const l = this.localOn(page, p);
          this.objects.pointerMove(page, l.x, l.y);
          return;
        }
        const e = (raw as PointerEvent | null) ?? this.evt;
        if (e) this.extendStroke(e);
      },
      inkEnd: (p, commit) => {
        if (this.laserPointer !== null) {
          this.laserPointer = null;
          this.laser.end();
          return;
        }
        if (this.lassoPointer) {
          const page = this.lassoPointer.page;
          this.lassoPointer = null;
          this.lasso.pointerEnd(page, commit && !!p);
          return;
        }
        if (this.objPointer) {
          const page = this.objPointer.page;
          this.objPointer = null;
          const l = p ? this.localOn(page, p) : { x: NaN, y: NaN };
          if (commit && p) this.objects.pointerEnd(page, l.x, l.y);
          else this.objects.cancel();
          return;
        }
        if (!this.active) return;
        if (!commit) {
          this.abortStroke();
          return;
        }
        if (p && this.evt) this.addSample(this.evt);
        this.endStroke(false);
      },
      eraseBegin: (p) => {
        if (this.readOnly) return;
        const page = this.pageForPoint(p);
        if (!page) return;
        const l = this.localOn(page, p);
        this.erase = { pointerId: p.id, page, lastX: l.x, lastY: l.y, beforeStrokes: page.page.strokes, beforeItems: page.page.items, changed: false };
        if (this.evt) this.eraseTo(this.evt);
      },
      eraseMove: (_p, raw) => {
        const e = (raw as PointerEvent | null) ?? this.evt;
        if (!e) return;
        const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        for (const ce of list && list.length ? list : [e]) this.eraseTo(ce);
      },
      eraseEnd: () => this.endErase(),
      navStart: () => {
        this.navigating = true;
        this.inertia = null;
      },
      navEnd: (velocity) => {
        this.navigating = false;
        if (velocity && Math.hypot(velocity.vx, velocity.vy) >= 0.25) {
          this.inertia = { vx: velocity.vx, vy: velocity.vy, last: performance.now() };
          this.schedule();
        }
        this.requestScene(true);
        this.updateToolbar();
      },
      undo: () => this.undo(),
      redo: () => this.redo(),
      classified: (p, owner, reason) => this.diagnostics.classified(p, owner, reason),
      longPress: (p) => {
        if (this.readOnly) return;
        const page = this.pageForPoint(p);
        if (!page) return;
        const l = this.localOn(page, p);
        this.openContextMenu(page, l.x, l.y);
      },
      tap: (p) => {
        // a finger tap on text (converted handwriting or a text box) types in it, whatever the tool
        if (this.tapToEdit(p)) return;
        if (this.doubleTapSwitch(p)) return;
        if (this.settings.tool === 'lasso') {
          this.lasso.clear();
          const page = this.pageForPoint(p);
          if (page) {
            const l = this.localOn(page, p);
            this.tapObjectWithLasso(page, l.x, l.y);
          }
          return;
        }
        if (!isObjectTool(this.settings.tool)) return;
        const page = this.pageForPoint(p);
        if (!page) return;
        const l = this.localOn(page, p);
        this.objects.tap(page, l.x, l.y);
      },
    };
  }

  /**
   * Finger double tap: pen ⇄ eraser (GoodNotes' Pencil double tap; iPadOS gives web content no
   * access to the Pencil's own double tap). Only while writing or erasing, so object tools keep
   * their taps.
   */
  private doubleTapSwitch(p: { x: number; y: number; t: number }): boolean {
    const tool = this.settings.tool;
    if (!this.settings.fingerDoubleTapEraser || this.readOnly || !(isInkTool(tool) || tool === 'eraser')) {
      this.lastFingerTap = null;
      return false;
    }
    const prev = this.lastFingerTap;
    this.lastFingerTap = { x: p.x, y: p.y, t: p.t };
    if (!prev || p.t - prev.t > DOUBLE_TAP_MS || Math.hypot(p.x - prev.x, p.y - prev.y) > DOUBLE_TAP_PX) return false;
    this.lastFingerTap = null;
    if (tool === 'eraser') {
      this.setTool(this.settings.lastPen);
      this.notify(t('switchedToPen'));
    } else {
      this.setTool('eraser');
      this.notify(t('switchedToEraser'));
    }
    return true;
  }

  private pageForPoint(p: { x: number; y: number }): PageRect | null {
    const w = screenToWorld(this.cam, p.x, p.y);
    return this.pageAt(w.x, w.y) ?? this.nearestPage(w.y);
  }

  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const v = this.viewport;
    const r = v.getBoundingClientRect();
    // the canvases sit inside the viewport: if it was scrolled they moved by -scroll
    return { x: e.clientX - r.left + v.scrollLeft, y: e.clientY - r.top + v.scrollTop };
  }

  /** Undo any native scrolling of the editor's containers (see bindInput). */
  pinScroll(): void {
    for (const elx of [this.viewport, this.root, this.root.parentElement]) {
      if (!elx) continue;
      if (elx.scrollTop !== 0) elx.scrollTop = 0;
      if (elx.scrollLeft !== 0) elx.scrollLeft = 0;
    }
  }

  private nearestPage(wy: number): PageRect | null {
    let best: PageRect | null = null;
    let bd = Infinity;
    for (const r of this.rects) {
      const d = wy < r.y ? r.y - wy : wy > r.y + r.h ? wy - r.y - r.h : 0;
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  }

  /** iPadOS Scribble converts Pencil input to text when an editable element has focus. */
  private blurEditors(): void {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== this.viewport && (ae.isContentEditable || ae.closest?.('.cm-editor') || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      ae.blur();
    }
    this.viewport.focus?.({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------------------------
  // Strokes
  // ---------------------------------------------------------------------------------------------

  /** Engine for new strokes of a tool: pencil and the default fountain pen use engine 2. */
  private engineFor(tool: InkTool): number {
    if (tool === 'pencil') return ENGINE_EXPERIMENTAL;
    if (tool === 'fountain' && this.settings.fountainVariant === 'experimental') return ENGINE_EXPERIMENTAL;
    return ENGINE_VERSION;
  }

  /** Is the fountain pen currently the engine-2 variant? */
  private isExperimental(tool: InkTool): boolean {
    return tool === 'fountain' && this.settings.fountainVariant === 'experimental';
  }

  /** The parameter object the toolbar / pen panel edits for a tool. */
  activeParams(tool: InkTool): PenParams {
    return this.isExperimental(tool) ? this.settings.experimental : this.settings.pens[tool].params;
  }

  private setActiveParams(tool: InkTool, params: PenParams): void {
    if (this.isExperimental(tool)) this.settings.experimental = params;
    else this.settings.pens[tool].params = params;
  }

  private beginStroke(e: PointerEvent, page: PageRect, tool: InkTool): void {
    const pen = this.settings.pens[tool];
    const experimental = this.isExperimental(tool);
    const params = experimental ? sanitizeExperimental(this.settings.experimental) : sanitizeParams(tool, pen.params);
    const builder = new StrokeBuilder(tool, params, {
      zoom: this.cam.zoom,
      hasPressure: e.pointerType === 'pen',
      engine: this.engineFor(tool),
    });
    this.active = {
      pointerId: e.pointerId,
      builder,
      page,
      tool,
      color: pen.color,
      t0: e.timeStamp,
      created: Date.now(),
      drawnStable: 0,
      predicted: [],
      drawShape: this.settings.drawShape && tool !== 'highlighter',
      dash: this.settings.penDash[tool] ?? 'solid',
    };
    this.clearActive();
    // highlighter: draw opaque on the active layers, apply opacity to the layer as a whole
    if (tool === 'highlighter' || tool === 'pencil') {
      this.activeStable.style.opacity = String(params.opacity);
      this.activeTail.style.opacity = String(params.opacity);
    }
    this.perf.strokeStart();
    this.diagnostics.strokeBegin(e.pointerType, e.timeStamp, e.pressure);
    this.addSample(e);
    this.frameLoop = true;
    this.schedule();
  }

  private toSample(e: PointerEvent, a: ActiveStroke): InputSample {
    const local = this.localPoint(e);
    const w = screenToWorld(this.cam, local.x, local.y);
    const s: InputSample = {
      x: w.x - a.page.x,
      y: w.y - a.page.y,
      p: e.pointerType === 'pen' ? e.pressure : 0.5,
      t: Math.max(0, e.timeStamp - a.t0),
    };
    if (e.pointerType === 'pen' && (e.tiltX || e.tiltY)) {
      s.tx = e.tiltX;
      s.ty = e.tiltY;
    }
    return s;
  }

  private addSample(e: PointerEvent): void {
    const a = this.active;
    if (!a) return;
    const s = this.toSample(e, a);
    const raw = a.builder.rawSamples;
    const last = raw[raw.length - 1];
    if (last && last.x === s.x && last.y === s.y && last.p === s.p) return; // exact duplicate
    this.perf.sample(e.timeStamp);
    if (e.pointerType === 'pen') this.perf.pressure.push(e.pressure);
    this.diagnostics.sample(e.timeStamp, e.pressure, e.pointerType);
    a.builder.add(s);
  }

  /** Append the samples of one pointermove (all coalesced samples) to the active stroke. */
  private extendStroke(e: PointerEvent): void {
    const a = this.active;
    if (!a) return;
    const t0 = performance.now();
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const evs = list && list.length ? list : [e];
    this.perf.samplesPerEvent.push(evs.length);
    this.diagnostics.event(evs.length);
    for (const ce of evs) this.addSample(ce);
    // Predicted points only extend the live preview; they are replaced on every real event and
    // never reach the stored stroke.
    a.predicted = this.settings.usePrediction && typeof e.getPredictedEvents === 'function' ? this.limitPrediction(e.getPredictedEvents().map((pe) => this.toSample(pe, a)), a) : [];
    this.perf.processing.push(performance.now() - t0);
    this.schedule();
  }

  /**
   * Keep at most 2 predicted points within 12 screen px of the last real sample, so a wrong
   * prediction (sharp turn, lift) can only ever draw a tiny, short-lived tail.
   */
  private limitPrediction(pred: InputSample[], a: ActiveStroke): InputSample[] {
    const raw = a.builder.rawSamples;
    const last = raw[raw.length - 1];
    if (!last) return [];
    const maxD = 12 / this.cam.zoom;
    const out: InputSample[] = [];
    for (const q of pred.slice(0, 2)) {
      const d = Math.hypot(q.x - last.x, q.y - last.y);
      if (!Number.isFinite(d)) break;
      if (d > maxD) {
        const k = maxD / d;
        out.push({ ...q, x: last.x + (q.x - last.x) * k, y: last.y + (q.y - last.y) * k });
        break;
      }
      out.push(q);
    }
    return out;
  }

  /** Discard the active stroke without saving it (tentative finger stroke turned into a pinch). */
  private abortStroke(): void {
    if (!this.active) return;
    this.diagnostics.strokeEnd(performance.now(), null);
    this.active = null;
    this.frameLoop = false;
    this.clearActive();
  }

  private endStroke(_cancelled: boolean): void {
    this.lastInkAt = performance.now();
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.frameLoop = false;
    a.predicted = [];
    const samples = a.builder.rawSamples.map(quantizeSample);
    if (samples.length === 0) {
      this.clearActive();
      return;
    }
    if (a.drawShape && this.commitRecognizedShape(a, samples)) return;
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
    if (a.dash !== 'solid') stroke.dash = a.dash;
    // Geometry from the stored (quantized) samples: exactly what a reload will show.
    const g = buildStrokeGeometry(samples, stroke.tool, stroke.params, { zoom: stroke.zoom, hasPressure: stroke.hasPressure, engine: stroke.engine });
    this.cache.set(stroke, g);
    this.diagnostics.strokeEnd(a.t0 + (samples[samples.length - 1]?.t ?? 0), g.rs);
    this.history.push(this.doc, { kind: 'add-strokes', pageId: a.page.page.id, strokes: [stroke] });
    const hasTextAbove = a.page.page.items.some((i) => i.type === 'text');
    if (stroke.tool === 'highlighter' || hasTextAbove) {
      // highlighters are composited under ink, text boxes above it: needs a full scene render
      this.renderScene();
    } else {
      this.paintCommitted(stroke, a.page);
    }
    this.clearActive();
    this.updateToolbar();
    this.updateHud();
    this.host.onChange();
  }

  /** Shape pen: replace a stroke that looks like a shape with a clean shape item. */
  private commitRecognizedShape(a: ActiveStroke, samples: InputSample[]): boolean {
    const page = a.page.page;
    // a separate "V" next to the end of an existing line / curve turns it into an arrow
    const head = recognizeArrowHead(samples);
    if (head && this.attachArrowHead(a, head)) return true;
    const rec = recognizeShape(samples);
    if (!rec) return false;
    const strokeWidth = Math.max(0.6, Math.min(8, a.builder.params.width * 0.8));
    const item: ShapeItem = {
      id: newId('i'),
      type: 'shape',
      kind: rec.kind,
      x: rec.x,
      y: rec.y,
      w: rec.w,
      h: rec.h,
      created: a.created,
      stroke: a.color,
      strokeWidth,
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
    if (a.dash !== 'solid') item.dash = a.dash;
    const before = page.items;
    this.diagnostics.strokeEnd(a.t0 + (samples[samples.length - 1]?.t ?? 0), null);
    this.pushOp({ kind: 'set-items', pageId: page.id, before, after: [...before, item] });
    this.clearActive();
    return true;
  }

  /** Shape pen: add an arrow head to the connector end the "V" stroke points at. */
  private attachArrowHead(a: ActiveStroke, head: { tip: [number, number]; dir: [number, number]; size: number }): boolean {
    const page = a.page.page;
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
    this.diagnostics.strokeEnd(performance.now(), null);
    this.pushOp({ kind: 'set-items', pageId: page.id, before: page.items, after: page.items.map((i) => (i.id === next.id ? next : i)) });
    this.clearActive();
    return true;
  }

  private cancelActive(): void {
    if (this.active) {
      this.active = null;
      this.frameLoop = false;
      this.clearActive();
    }
    if (this.erase) this.endErase();
  }

  // ---------------------------------------------------------------------------------------------
  // Eraser: precise / standard (partial) or whole strokes; shapes are erased whole
  // ---------------------------------------------------------------------------------------------

  private eraseTo(e: PointerEvent): void {
    const er = this.erase;
    if (!er) return;
    const local = this.localPoint(e);
    const w = screenToWorld(this.cam, local.x, local.y);
    const x = w.x - er.page.x;
    const y = w.y - er.page.y;
    const mode = this.settings.eraserMode;
    const base = ERASER_SIZES[this.settings.eraserSize] ?? ERASER_SIZES[1];
    const radius = (mode === 'precise' ? base * 0.6 : base) / this.cam.zoom;
    const page = er.page.page;
    const hlOnly = this.settings.eraserHighlighterOnly;
    let changed = false;
    const next: Stroke[] = [];
    for (const s of page.strokes) {
      if (hlOnly && s.tool !== 'highlighter') {
        next.push(s);
        continue;
      }
      if (!hitStrokeSegment(this.cache.get(s), er.lastX, er.lastY, x, y, radius)) {
        next.push(s);
        continue;
      }
      if (mode === 'stroke') {
        changed = true;
        continue;
      }
      const parts = cutStroke(s, er.lastX, er.lastY, x, y, radius, mode === 'precise');
      if (!parts) {
        next.push(s);
        continue;
      }
      changed = true;
      next.push(...parts);
    }
    if (changed) page.strokes = next;
    if (!hlOnly) {
      const keep = page.items.filter((it) => !(it.type === 'shape' && (shapeTouchesCircle(it, x, y, radius) || shapeTouchesCircle(it, (x + er.lastX) / 2, (y + er.lastY) / 2, radius))));
      if (keep.length !== page.items.length) {
        page.items = detachMissing(keep);
        changed = true;
      }
    }
    er.lastX = x;
    er.lastY = y;
    if (changed) er.changed = true;
    // eraser cursor
    const ctx = this.activeTailCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.activeTail.width, this.activeTail.height);
    this.activeTransform(ctx, er.page);
    ctx.strokeStyle = 'rgba(120,120,120,0.9)';
    ctx.fillStyle = 'rgba(120,120,120,0.08)';
    ctx.lineWidth = 1 / this.cam.zoom;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (changed) this.requestScene(true);
  }

  private endErase(): void {
    const er = this.erase;
    if (!er) return;
    this.erase = null;
    this.clearActive();
    if (!er.changed) return;
    const page = er.page.page;
    const ops: Op[] = [];
    if (page.strokes !== er.beforeStrokes) ops.push({ kind: 'set-strokes', pageId: page.id, before: er.beforeStrokes, after: page.strokes });
    if (page.items !== er.beforeItems) ops.push({ kind: 'set-items', pageId: page.id, before: er.beforeItems, after: page.items });
    if (!ops.length) return;
    this.history.record(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    this.afterOp(false);
  }

  // ---------------------------------------------------------------------------------------------
  // Images
  // ---------------------------------------------------------------------------------------------

  /** Open the system image picker (must run inside a user gesture). */
  pickImage(): void {
    if (this.readOnly) return;
    this.fileInput.click();
  }

  /** Insert an image file at the centre of the visible part of the current page. */
  async insertImageFile(file: Blob & { name?: string }, at?: { pageId: string; x: number; y: number }): Promise<void> {
    if (this.readOnly) return;
    if (file.size > MAX_PASTE_IMAGE) {
      this.notify(t('pasteImageTooLarge'));
      return;
    }
    try {
      const mime = file.type || 'image/png';
      const dataUrl = await blobToDataUrl(file);
      const img = await loadImage(dataUrl);
      let src = dataUrl;
      if (this.settings.imageStorage === 'embed' || !this.host.saveImage) {
        // stored inside the .handnote file (format v4); large images are downscaled first
        const asset = await makeAsset(file, img);
        this.addAssets({ [asset.id]: asset });
        src = `asset:${asset.id}`;
        if (asset.w < img.naturalWidth) this.notify(t('imageTooLarge'));
      } else {
        src = await this.host.saveImage(await file.arrayBuffer(), mime, file.name || 'image.png');
        primeImage(src, img);
      }
      const target = at ? this.rects.find((x) => x.page.id === at.pageId) : undefined;
      const r = target ?? this.rects[this.currentPageIndex()];
      if (!r) return;
      const maxW = r.w * 0.6;
      const scale = Math.min(1, maxW / img.naturalWidth, (r.h * 0.5) / img.naturalHeight);
      const w = Math.max(20, img.naturalWidth * scale);
      const h = Math.max(20, img.naturalHeight * scale);
      const view = target && at ? { cx: at.x, cy: at.y } : this.visibleRegion(r);
      const cx = Math.min(r.w - w / 2, Math.max(w / 2, view.cx));
      const cy = Math.min(r.h - h / 2, Math.max(h / 2, view.cy));
      const item: ImageItem = { id: newId('i'), type: 'image', x: cx - w / 2, y: cy - h / 2, w, h, created: Date.now(), src, natW: img.naturalWidth, natH: img.naturalHeight };
      const before = r.page.items;
      this.pushOp({ kind: 'set-items', pageId: r.page.id, before, after: [...before, item] });
      if (this.settings.tool !== 'image') this.setTool('image');
      this.objects.select(r.page.id, item.id);
      this.notify(t('imageInserted'));
    } catch (err) {
      console.error('HandNote: image insert failed', err);
      this.notify(t('imageFailed'));
    }
  }

  private visibleRegion(r: PageRect): { cx: number; cy: number } {
    const x0 = Math.max(r.x, this.cam.x);
    const x1 = Math.min(r.x + r.w, this.cam.x + this.viewW / this.cam.zoom);
    const y0 = Math.max(r.y, this.cam.y);
    const y1 = Math.min(r.y + r.h, this.cam.y + this.viewH / this.cam.zoom);
    return { cx: (x0 + x1) / 2 - r.x, cy: (y0 + y1) / 2 - r.y };
  }

  private async imageBlob(src: string): Promise<Blob | null> {
    const embedded = assetDataUrl(src);
    if (embedded) {
      try {
        return await (await fetch(embedded)).blob();
      } catch {
        return null;
      }
    }
    if (this.host.imageBlob) return this.host.imageBlob(src);
    if (!src.startsWith('data:')) return null;
    try {
      return await (await fetch(src)).blob();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Navigation inertia (started by the router after a one-finger fling)
  // ---------------------------------------------------------------------------------------------

  private stepInertia(now: number): void {
    const it = this.inertia;
    if (!it) return;
    const dt = Math.min(40, now - it.last);
    it.last = now;
    this.setCamera({ ...this.cam, x: this.cam.x - (it.vx * dt) / this.cam.zoom, y: this.cam.y - (it.vy * dt) / this.cam.zoom });
    const decay = Math.exp(-dt / 325);
    it.vx *= decay;
    it.vy *= decay;
    this.sceneDirty = true;
    if (Math.hypot(it.vx, it.vy) < 0.02) {
      this.inertia = null;
      this.requestScene(true);
      this.updateToolbar();
    } else this.schedule();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.inertia = null;
    const local = this.localPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewH : 1;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp((-e.deltaY * unit) / 300);
      this.setCamera(zoomAt(this.cam, this.cam.zoom * factor, local.x, local.y));
    } else {
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
      this.setCamera({ ...this.cam, x: this.cam.x + dx / this.cam.zoom, y: this.cam.y + dy / this.cam.zoom });
    }
    this.requestScene(true);
    this.updateToolbar();
  }

  // ===============================================================================================
  // UI
  // ===============================================================================================

  private updateToolbar(): void {
    if (this.sidebar) {
      const cur = this.currentPageIndex();
      if (cur !== this.sidebarCurrent) {
        this.sidebarCurrent = cur;
        this.sidebar.setCurrent(cur, true);
      }
    }
    const s = this.settings;
    const ink: InkTool = isInkTool(s.tool) ? s.tool : s.lastPen;
    const palette = ink === 'highlighter' ? s.highlighterPalette : s.inkPalette;
    this.toolbar.update({
      tool: s.tool,
      drawShape: s.drawShape,
      subbarOpen: s.subbarOpen,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      page: this.currentPageIndex(),
      pageCount: this.doc.pages.length,
      readOnly: this.readOnly,
      penColor: s.pens[ink].color,
      palette,
      widthPresets: s.widthPresets[ink],
      width: this.activeParams(ink).width,
      penDash: s.penDash[ink] ?? 'solid',
      eraserMode: s.eraserMode,
      eraserSize: s.eraserSize,
      highlighterOnly: s.eraserHighlighterOnly,
      shape: s.shape,
      text: s.text,
      lasso: s.lasso,
      laser: s.laser,
    });
  }

  private updateHud(): void {
    if (this.settings.showHud) show(this.hud);
    else hide(this.hud);
    if (this.settings.showHud) this.hud.textContent = this.perf.format();
  }

  /** Resolve Auto / Pen-first / Mouse-first for this device and apply layout conventions. */
  private applyMode(): void {
    this.mode = resolveInputMode(this.settings.inputMode, detectEnvironment(!!this.host.isMobileApp));
    this.root.classList.toggle('hn-mode-pen', this.mode === 'pen');
    this.root.classList.toggle('hn-mode-mouse', this.mode === 'mouse');
    this.toolbar?.setMode(this.mode);
  }

  private notify(msg: string): void {
    if (this.host.notify) {
      this.host.notify(msg);
      return;
    }
    this.root.querySelectorAll('.hn-toast, .hn-hint').forEach((n) => n.remove());
    const toast = el('div', 'hn-toast', this.root, msg);
    window.setTimeout(() => toast.remove(), 2500);
  }

  /** A one-time hint per session (like GoodNotes' tips at the bottom of the page). */
  private hint(key: string, msg: string): void {
    if (this.hintShown.has(key)) return;
    this.hintShown.add(key);
    this.root.querySelectorAll('.hn-toast, .hn-hint').forEach((n) => n.remove());
    const h = el('div', 'hn-hint', this.root, msg);
    window.setTimeout(() => h.classList.add('is-out'), 3600);
    window.setTimeout(() => h.remove(), 4200);
  }

  private closePopover(): void {
    this.popover?.close();
    this.popover = null;
    this.popoverKind = null;
  }

  /** Open a popover; a second tap on the same control closes it. */
  private openPopover(kind: string, anchor: HTMLElement, cls: string): Popover | null {
    const same = this.popoverKind === kind;
    this.closePopover();
    if (same) return null;
    const p = new Popover(this.root, anchor, cls, () => {
      if (this.popover === p) {
        this.popover = null;
        this.popoverKind = null;
      }
    });
    this.popover = p;
    this.popoverKind = kind;
    return p;
  }

  private settingsChanged(): void {
    this.host.onSettingsChange(this.settings);
    this.updateToolbar();
  }

  private onSelection(it: Item | null): void {
    if (!it) return;
    // the sub-toolbar shows (and edits) the selected item's style
    if (it.type === 'shape') {
      this.settings.shape = { ...this.settings.shape, color: it.stroke, strokeWidth: it.strokeWidth, fill: !!it.fill, fillOpacity: it.fillOpacity, kind: this.settings.shape.kind, dash: it.dash ?? 'solid' };
    } else if (it.type === 'text') {
      this.settings.text = { size: it.size, color: it.color, font: it.font, bold: it.bold, italic: it.italic, align: it.align };
    }
    this.updateToolbar();
  }

  private toolbarActions() {
    return {
      onGroup: (g: ToolGroup) => {
        const cur = groupOf(this.settings.tool);
        if (g === cur && g !== 'image') {
          this.settings.subbarOpen = !this.settings.subbarOpen;
          this.closePopover();
          this.settingsChanged();
          return;
        }
        if (g === 'pen') this.setTool(this.settings.drawShape ? 'fountain' : this.settings.lastPen);
        else if (g === 'eraser') this.setTool('eraser');
        else if (g === 'text') this.setTool('text');
        else if (g === 'shape') this.setTool('shape');
        else if (g === 'lasso') this.setTool('lasso');
        else if (g === 'laser') this.setTool('laser');
        else if (g === 'image') {
          if (cur !== 'image') this.setTool('image');
          this.pickImage();
        }
      },
      onPages: (anchor: HTMLElement) => this.openPagesPanel(anchor),
      onStrokeStyle: (anchor: HTMLElement) => {
        const tool = isInkTool(this.settings.tool) ? this.settings.tool : this.settings.lastPen;
        const presets = this.settings.widthPresets[tool];
        const w = this.activeParams(tool).width;
        let i = presets.findIndex((p) => Math.abs(p - w) < 0.01);
        if (i < 0) i = 1;
        this.openWidthPanel(tool, i, anchor);
      },
      onLassoMode: (m: 'free' | 'rect') => {
        this.settings.lasso = { ...this.settings.lasso, mode: m };
        this.settingsChanged();
      },
      onLassoFilter: (anchor: HTMLElement) => {
        const p = this.openPopover('lasso-filter', anchor, 'hn-list-panel hn-lasso-filter');
        if (!p) return;
        renderLassoFilterPanel(p.el, {
          filter: this.settings.lasso.filter,
          onChange: (f) => {
            this.settings.lasso = { ...this.settings.lasso, filter: f };
            this.host.onSettingsChange(this.settings);
          },
        });
        p.place('center');
      },
      onLaserMode: (m: 'dot' | 'trail') => {
        this.settings.laser = { ...this.settings.laser, mode: m };
        this.settingsChanged();
      },
      onLaserColor: (c: string) => {
        this.settings.laser = { ...this.settings.laser, color: c };
        this.settingsChanged();
      },
      onLaserHold: (ms: number) => {
        this.settings.laser = { ...this.settings.laser, holdMs: ms };
        this.settingsChanged();
      },
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onPrev: () => this.gotoPage(this.currentPageIndex() - 1),
      onNext: () => this.gotoPage(this.currentPageIndex() + 1),
      onMore: (anchor: HTMLElement) => this.openMoreMenu(anchor),
      onPenKind: (k: PenKind, anchor: HTMLElement) => {
        const tool: InkTool = k === 'shapepen' ? 'fountain' : k;
        const active = k === 'shapepen' ? this.settings.drawShape : !this.settings.drawShape && this.settings.tool === k;
        if (active) {
          this.openPenPanel(tool, anchor);
          return;
        }
        this.settings.drawShape = k === 'shapepen';
        this.setTool(tool);
      },
      onWidthPreset: (i: number, anchor: HTMLElement) => {
        const tool = this.settings.tool;
        if (!isInkTool(tool)) return;
        const presets = this.settings.widthPresets[tool];
        const w = presets[i];
        if (Math.abs(this.activeParams(tool).width - w) < 0.01) {
          this.openWidthPanel(tool, i, anchor);
          return;
        }
        this.setWidth(w);
      },
      onColor: (c: string) => this.setColor(c),
      onAddColor: (c: string) => {
        const tool = this.settings.tool;
        const hl = tool === 'highlighter';
        if (hl) this.settings.highlighterPalette = addPaletteColor(this.settings.highlighterPalette, c);
        else this.settings.inkPalette = addPaletteColor(this.settings.inkPalette, c);
        this.setColor(c.toLowerCase());
      },
      onRemoveColor: (c: string, anchor: HTMLElement) => {
        const p = this.openPopover('remove-color', anchor, 'hn-confirm');
        if (!p) return;
        renderConfirm(p.el, t('removeColor'), () => {
          const hl = this.settings.tool === 'highlighter';
          const list = hl ? this.settings.highlighterPalette : this.settings.inkPalette;
          if (list.length > 1) {
            const next = list.filter((x) => x.toLowerCase() !== c.toLowerCase());
            if (hl) this.settings.highlighterPalette = next;
            else this.settings.inkPalette = next;
          }
          this.closePopover();
          this.settingsChanged();
        });
        p.place('center');
      },
      onEraserType: (anchor: HTMLElement) => {
        const p = this.openPopover('eraser-type', anchor, 'hn-eraser-panel');
        if (!p) return;
        renderEraserPanel(p.el, {
          mode: this.settings.eraserMode,
          onPick: (m) => {
            this.settings.eraserMode = m;
            this.settingsChanged();
          },
        });
        p.place('center');
      },
      onEraserSize: (i: number) => {
        this.settings.eraserSize = i;
        this.settingsChanged();
      },
      onHighlighterOnly: (v: boolean) => {
        this.settings.eraserHighlighterOnly = v;
        this.settingsChanged();
      },
      onInsertImage: () => this.pickImage(),
      onShapeKind: (k: ShapeItem['kind']) => {
        this.settings.shape = { ...this.settings.shape, kind: k };
        this.settingsChanged();
      },
      onShapeStyle: (anchor: HTMLElement) => this.openShapeStyle(anchor),
      onShapeColor: (anchor: HTMLElement) => this.openShapeColor(anchor),
      onTextColor: (anchor: HTMLElement) => this.openTextColor(anchor),
      onTextSize: (anchor: HTMLElement) => {
        const p = this.openPopover('text-size', anchor, 'hn-list-panel');
        if (!p) return;
        const sizes = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];
        renderListPicker(
          p.el,
          t('textSize'),
          sizes.map((v) => ({ label: String(v), value: v, active: v === this.settings.text.size })),
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
          fonts.map(([v, label]) => ({ label, value: v, active: v === this.settings.text.font })),
          (v) => {
            this.setTextStyle({ font: v });
            this.closePopover();
          },
        );
        p.place('center');
      },
      onTextToggle: (key: 'bold' | 'italic') => this.setTextStyle({ [key]: !this.settings.text[key] }),
      onTextAlign: () => {
        const order = ['left', 'center', 'right'] as const;
        const next = order[(order.indexOf(this.settings.text.align) + 1) % 3];
        this.setTextStyle({ align: next });
      },
    };
  }

  private setTextStyle(patch: Partial<EditorSettings['text']>): void {
    this.settings.text = { ...this.settings.text, ...patch };
    this.settingsChanged();
    if (this.objects.selected?.type === 'text') this.objects.applyStyle(patch);
  }

  private openShapeColor(anchor: HTMLElement): void {
    const p = this.openPopover('shape-color', anchor, 'hn-color-panel');
    if (!p) return;
    const s = this.settings.shape;
    const apply = (patch: Partial<EditorSettings['shape']>) => {
      this.settings.shape = { ...this.settings.shape, ...patch };
      this.settingsChanged();
      const sel = this.objects.selected;
      if (sel?.type === 'shape') {
        const sh = this.settings.shape;
        this.objects.applyStyle({ stroke: sh.color, fill: sh.fill && sel.kind !== 'line' ? sh.color : null, fillOpacity: sh.fillOpacity });
      }
    };
    renderColorPanel(p.el, {
      palette: this.settings.inkPalette,
      current: s.color,
      onPick: (c) => apply({ color: c }),
      onAdd: (c) => {
        this.settings.inkPalette = addPaletteColor(this.settings.inkPalette, c);
        apply({ color: c.toLowerCase() });
      },
      fill: { on: s.fill, opacity: s.fillOpacity, onToggle: (v) => apply({ fill: v }), onOpacity: (v) => apply({ fillOpacity: v }) },
    });
    p.place('center');
  }

  private openTextColor(anchor: HTMLElement): void {
    const p = this.openPopover('text-color', anchor, 'hn-color-panel');
    if (!p) return;
    renderColorPanel(p.el, {
      palette: this.settings.inkPalette,
      current: this.settings.text.color,
      onPick: (c) => this.setTextStyle({ color: c }),
      onAdd: (c) => {
        this.settings.inkPalette = addPaletteColor(this.settings.inkPalette, c);
        this.setTextStyle({ color: c.toLowerCase() });
      },
    });
    p.place('center');
  }

  /** Measured Pencil pressure range: median and p99 (only with enough real pressure data). */
  private measuredPressure(): { typical: number; heavy: number } | null {
    const p = this.diagnostics.pressure;
    if (p.length < 200 || pressureVerdict(p).verdict !== 'real') return null;
    const s = [...p].sort((a, b) => a - b);
    return { typical: quantile(s, 0.5), heavy: quantile(s, 0.99) };
  }

  openPenPanel(tool: InkTool, anchor: HTMLElement): void {
    const p = this.openPopover('pen', anchor, 'hn-pen-panel');
    if (!p) return;
    const render = () =>
      renderPenPanel(p.el, {
        tool,
        title: t(this.settings.drawShape ? 'shapepen' : tool),
        color: this.settings.pens[tool].color,
        params: this.activeParams(tool),
        engine: this.engineFor(tool),
        variant: tool === 'fountain' ? this.settings.fountainVariant : null,
        measured: this.measuredPressure(),
        onParams: (prm) => {
          const prev = this.activeParams(tool);
          this.setActiveParams(tool, prm);
          // a calibration applies to every engine-2 pen
          if (prm.typicalPressure !== prev.typicalPressure || prm.heavyPressure !== prev.heavyPressure) {
            const other: InkTool = tool === 'pencil' ? 'fountain' : 'pencil';
            if (this.engineFor(other) === ENGINE_EXPERIMENTAL) {
              this.setActiveParams(other, { ...this.activeParams(other), typicalPressure: prm.typicalPressure, heavyPressure: prm.heavyPressure });
            }
          }
          this.settingsChanged();
        },
        onVariant: (v) => {
          this.settings.fountainVariant = v;
          this.settingsChanged();
          render();
        },
        onReset: () => {
          this.setActiveParams(tool, this.isExperimental(tool) ? { ...EXPERIMENTAL_FOUNTAIN } : { ...DEFAULT_PEN_PARAMS[tool] });
          this.settingsChanged();
          render();
        },
      });
    render();
    p.place('center');
  }

  private openWidthPanel(tool: InkTool, index: number, anchor: HTMLElement): void {
    const p = this.openPopover('width', anchor, 'hn-width-panel');
    if (!p) return;
    renderStrokePanel(p.el, {
      dash: this.settings.penDash[tool] ?? 'solid',
      color: this.settings.pens[tool].color,
      width: this.activeParams(tool).width,
      range: WIDTH_RANGE_MM[tool],
      onDash: (d) => {
        this.settings.penDash = { ...this.settings.penDash, [tool]: d };
        this.settingsChanged();
      },
      onChange: (w) => {
        const presets = [...this.settings.widthPresets[tool]];
        presets[index] = w;
        this.settings.widthPresets[tool] = presets;
        this.setActiveParams(tool, { ...this.activeParams(tool), width: w });
        this.settingsChanged();
      },
    });
    p.place('center');
  }

  private openShapeStyle(anchor: HTMLElement): void {
    const p = this.openPopover('shape-style', anchor, 'hn-width-panel');
    if (!p) return;
    const sh = this.settings.shape;
    const sel = this.objects.selected;
    const lineKind = sel?.type === 'shape' ? isLine(sel) && sel.kind !== 'line' : ['arrow', 'curve', 'elbow'].includes(sh.kind);
    const apply = (patch: Partial<EditorSettings['shape']>, itemPatch: Partial<ShapeItem>) => {
      this.settings.shape = { ...this.settings.shape, ...patch };
      this.settingsChanged();
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
  }

  private updateSkip(): void {
    this.skipItems = this.skipLasso.size ? new Set([...this.skipObj, ...this.skipLasso]) : this.skipObj;
    this.requestScene(true);
  }

  private addAssets(a: Record<string, Asset>): void {
    this.doc.assets = { ...(this.doc.assets ?? {}), ...a };
    registerAssets(a);
  }

  /** Make imported documents known to this note (pages refer to them by id). */
  addSources(a: Record<string, DocSource>): void {
    this.doc.sources = { ...(this.doc.sources ?? {}), ...a };
    registerSources(a);
  }

  /**
   * Insert the pages of an imported document after the current page (one undo step). Each page
   * shows the document page under the ink; its size is the document page's size in points.
   */
  insertDocumentPages(source: DocSource, sizes: { width: number; height: number }[], at?: number): number {
    if (this.readOnly || !sizes.length) return -1;
    this.addSources({ [source.id]: source });
    const index = at ?? (this.isBlankDocument() ? 0 : this.currentPageIndex() + 1);
    const pages = documentPages(source, sizes);
    const ops: Op[] = pages.map((page, i) => ({ kind: 'add-page', index: index + i, page }));
    // an untouched single blank page (new note) is replaced by the document
    if (this.isBlankDocument()) ops.push({ kind: 'remove-page', index: pages.length, page: this.doc.pages[0] });
    this.pushOp(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    this.gotoPage(index);
    return index;
  }

  /** One empty page, no ink, no objects, no document. */
  private isBlankDocument(): boolean {
    return this.doc.pages.length === 1 && !this.doc.pages[0].strokes.length && !this.doc.pages[0].items.length && !this.doc.pages[0].doc;
  }

  private selectGroup(pageId: string, g: string): void {
    const r = this.rects.find((x) => x.page.id === pageId);
    if (!r) return;
    if (this.settings.tool !== 'lasso') {
      this.settings.tool = 'lasso';
      this.settings.subbarOpen = true;
      this.host.onSettingsChange(this.settings);
      this.updateToolbar();
    }
    this.lasso.setSelection({
      pageId,
      strokeIds: new Set(r.page.strokes.filter((s) => s.g === g).map((s) => s.id)),
      itemIds: new Set(r.page.items.filter((i) => i.g === g).map((i) => i.id)),
    });
  }

  /** The one colour of the lasso selection (ink, text, formula, shape outline); null when mixed. */
  private selectionColor(): string | null {
    const f = this.lasso.selected();
    if (!f) return null;
    const colors = new Set<string>();
    for (const s of f.strokes) colors.add(s.color.toLowerCase());
    for (const it of f.items) {
      const c = it.type === 'text' || it.type === 'formula' ? it.color : it.type === 'shape' ? it.stroke : null;
      if (c) colors.add(c.toLowerCase());
    }
    return colors.size === 1 ? [...colors][0] : null;
  }

  private openLassoColor(anchor: HTMLElement): void {
    const p = this.openPopover('lasso-color', anchor, 'hn-color-panel');
    if (!p) return;
    renderColorPanel(p.el, {
      palette: this.settings.inkPalette,
      // the selection's own colour (all the same) — not the pen's
      current: this.selectionColor() ?? '',
      onPick: (c) => this.lasso.recolor(c),
      onAdd: (c) => {
        this.settings.inkPalette = addPaletteColor(this.settings.inkPalette, c);
        this.host.onSettingsChange(this.settings);
        this.lasso.recolor(c.toLowerCase());
      },
    });
    p.place('center');
  }

  // ---------------------------------------------------------------------------------------------
  // Page navigator
  // ---------------------------------------------------------------------------------------------

  private pageKey(page: Page): string {
    const last = page.strokes[page.strokes.length - 1];
    // a document page's thumbnail is redrawn once the page has been rendered (it starts as a placeholder)
    const doc = page.doc ? `|d${docPageReady(page.doc.src, page.doc.n) ? 1 : 0}` : '';
    return `${page.strokes.length}|${last?.id ?? ''}|${page.items.length}|${page.width}x${page.height}|${page.background.kind}|${page.background.paper}${doc}`;
  }

  /**
   * Page preview fitted into a box (CSS px), cached per page until its content changes. The cached
   * canvas itself is returned and shown (no second bitmap per thumbnail).
   */
  pageThumb(page: Page, boxW: number, boxH: number): HTMLCanvasElement {
    const dpr = Math.min(2, this.dpr || 1);
    const fit = Math.min(boxW / page.width, boxH / page.height);
    const scale = fit * dpr;
    const key = this.pageKey(page) + '|' + scale.toFixed(4);
    let c = this.thumbCache.get(page);
    if (!c || c.key !== key || c.items !== page.items || c.strokes !== page.strokes) {
      if (c) {
        c.canvas.width = 0;
        c.canvas.height = 0;
        c.canvas.remove();
      }
      const off = document.createElement('canvas');
      renderPageToCanvas(off, page, this.cache, scale);
      off.style.width = `${Math.round(page.width * fit)}px`;
      off.style.height = `${Math.round(page.height * fit)}px`;
      c = { key, strokes: page.strokes, items: page.items, canvas: off };
      this.thumbCache.set(page, c);
    }
    return c.canvas;
  }

  get pagesSidebarOpen(): boolean {
    return this.sidebar !== null;
  }

  /** Toolbar "pages" button: show / hide the page navigator on the left. */
  openPagesPanel(_anchor?: HTMLElement): void {
    if (this.sidebar) {
      this.closePagesSidebar();
      return;
    }
    this.closePopover();
    this.sidebar = new PagesSidebar(this.root, {
      count: () => this.doc.pages.length,
      current: () => this.currentPageIndex(),
      readOnly: () => this.readOnly,
      thumb: (i, w, h) => {
        const pg = this.doc.pages[i];
        return pg ? this.pageThumb(pg, w, h) : null;
      },
      hasPageClipboard: () => pageClipboard !== null,
      onGo: (i) => this.gotoPage(i),
      onInsert: (at) => {
        this.addPageAt(at);
        this.gotoPage(at);
      },
      onCopy: (i) => {
        const pg = this.doc.pages[i];
        if (!pg) return;
        pageClipboard = clonePage(pg);
        pageClipboardSource = pg.doc ? (this.doc.sources?.[pg.doc.src] ?? null) : null;
        this.notify(t('pageCopied'));
      },
      onPaste: (at) => {
        if (!pageClipboard || this.readOnly) return;
        if (pageClipboard.doc && pageClipboardSource && !this.doc.sources?.[pageClipboard.doc.src]) this.addSources({ [pageClipboardSource.id]: pageClipboardSource });
        this.pushOp({ kind: 'add-page', index: at, page: clonePage(pageClipboard) });
        this.gotoPage(at);
      },
      onDuplicate: (i) => this.duplicatePage(i),
      onRotate: (i) => this.rotatePage(i),
      onMove: (from, to) => this.movePage(from, to),
      onExport: (i, kind) => this.host.exportPage?.(i, kind),
      onClear: (i) => this.clearPageAt(i),
      onDelete: (i) => this.deletePageAt(i),
      onClose: () => this.closePagesSidebar(),
    });
    this.sidebarCurrent = this.currentPageIndex();
    this.keepViewAcrossResize(() => {
      this.root.classList.add('has-pages-sidebar');
      this.root.classList.toggle('is-sidebar-overlay', this.root.clientWidth < 700);
    });
    this.toolbar.setPagesOpen(true);
    window.requestAnimationFrame(() => this.sidebar?.revealCurrent());
  }

  closePagesSidebar(): void {
    if (!this.sidebar) return;
    cancelAnimationFrame(this.sidebarRaf);
    this.sidebarRaf = 0;
    this.sidebar.destroy();
    this.sidebar = null;
    if (this.destroyed) return;
    this.keepViewAcrossResize(() => this.root.classList.remove('has-pages-sidebar', 'is-sidebar-overlay'));
    this.toolbar.setPagesOpen(false);
  }

  /** Rotate a page 90° clockwise with its content (one undo step). */
  rotatePage(index: number): void {
    const page = this.doc.pages[index];
    if (!page || this.readOnly) return;
    const H = page.height;
    const ang = Math.PI / 2;
    // (x, y) → (H − y, x): rotate about the origin, then shift into the new page
    const strokes = page.strokes.map((s) => transformStroke(s, [0, 0], 1, ang, H, 0));
    const items = resolveConnectors(page.items.map((it) => transformItem(it, [0, 0], 1, ang, H, 0)));
    const ops: Op[] = [{ kind: 'set-page', pageId: page.id, before: { width: page.width, height: page.height, background: page.background }, after: { width: page.height, height: page.width, background: page.background } }];
    if (page.strokes.length) ops.push({ kind: 'set-strokes', pageId: page.id, before: page.strokes, after: strokes });
    if (page.items.length) ops.push({ kind: 'set-items', pageId: page.id, before: page.items, after: items });
    this.objects.deselect();
    this.lasso.clear();
    this.pushOp(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
  }

  /** Clear the content of any page (navigator menu). */
  clearPageAt(index: number): void {
    const page = this.doc.pages[index];
    if (this.readOnly || !page || (page.strokes.length === 0 && page.items.length === 0)) return;
    this.objects.deselect();
    this.lasso.clear();
    const ops: Op[] = [];
    if (page.strokes.length) ops.push({ kind: 'set-strokes', pageId: page.id, before: page.strokes, after: [] });
    if (page.items.length) ops.push({ kind: 'set-items', pageId: page.id, before: page.items, after: [] });
    this.pushOp(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    this.notify(t('pageCleared'));
  }

  /** Insert a page (same size and paper as the current one) at an index. */
  addPageAt(index: number): void {
    if (this.readOnly) return;
    const cur = this.doc.pages[this.currentPageIndex()];
    const page = createPage(cur?.width ?? 595, cur?.height ?? 842, cur?.background ?? defaultBackground(this.settings.newPageBackground, this.settings.newPaperTone));
    this.pushOp({ kind: 'add-page', index, page });
  }

  duplicatePage(index: number): void {
    const src = this.doc.pages[index];
    if (!src || this.readOnly) return;
    this.pushOp({ kind: 'add-page', index: index + 1, page: clonePage(src) });
  }

  movePage(from: number, to: number): void {
    const page = this.doc.pages[from];
    if (!page || this.readOnly || to < 0 || to >= this.doc.pages.length || to === from) return;
    this.pushOp({ kind: 'move-page', pageId: page.id, from, to });
  }

  deletePageAt(index: number): void {
    if (this.readOnly || this.doc.pages.length <= 1) return;
    const page = this.doc.pages[index];
    if (!page) return;
    this.objects.deselect();
    this.lasso.clear();
    this.pushOp({ kind: 'remove-page', index, page });
  }

  // ---------------------------------------------------------------------------------------------
  // AI conversion and local tidy (lasso selection)
  // ---------------------------------------------------------------------------------------------

  private openAIMenu(anchor: HTMLElement): void {
    const p = this.openPopover('ai', anchor, 'hn-ai-menu');
    if (!p) return;
    const rec = this.host.recognizer;
    const f = this.lasso.selected();
    renderAIToolsMenu(p.el, {
      engine: (task) => rec?.engineFor(task) ?? NO_ENGINE,
      hasInk: !!f?.strokes.some((s) => s.tool !== 'highlighter'),
      hasImages: !!f?.items.some((i) => i.type === 'image'),
      onTask: (task) => {
        this.closePopover();
        void this.convert(task);
      },
      onLocal: (op) => {
        this.closePopover();
        this.tidySelection(op);
      },
      onSetup: () => {
        this.closePopover();
        if (this.host.openAISettings) this.host.openAISettings();
        else this.notify(t('errNotConfigured'));
      },
    });
    p.place('center');
  }

  /** Convert menu: Text / Math (digital-ink recognition) and Shape (local). */
  private openConvertMenu(anchor: HTMLElement): void {
    const p = this.openPopover('convert', anchor, 'hn-ai-menu hn-convert-menu');
    if (!p) return;
    this.convertFlow.menuOpened();
    const rec = this.host.recognizer;
    const f = this.lasso.selected();
    renderConvertMenu(p.el, {
      engine: (task) => rec?.engineFor(task) ?? NO_ENGINE,
      hasInk: !!f?.strokes.some((s) => s.tool !== 'highlighter'),
      hasImages: !!f?.items.some((i) => i.type === 'image'),
      onTask: (task) => {
        this.closePopover();
        void this.convert(task);
      },
      onShape: () => {
        this.closePopover();
        const n = this.lasso.convertToShapes();
        if (!n) this.notify(t('convertShapeNone'));
      },
    });
    p.place('center');
  }

  /** Lasso tap on an editable object: select it in the object controller (topics, labels, LaTeX). */
  /** Finger tap on a text box or formula: edit it right away (keyboard / formula editor). */
  private tapToEdit(p: { x: number; y: number }): boolean {
    if (this.readOnly || !this.rects.length) return false;
    // while writing, a short touch of the hand on a text must not open the keyboard
    if (this.active || performance.now() - this.lastInkAt < 1200) return false;
    const page = this.pageForPoint(p);
    if (!page) return false;
    const l = this.localOn(page, p);
    const hit = this.objects.hit(page.page, l.x, l.y);
    if (!hit || (hit.type !== 'text' && hit.type !== 'formula')) return false;
    this.editObject(page.page.id, hit.id);
    return true;
  }

  /** Open a text box (keyboard) or formula for editing. */
  private editObject(pageId: string, id: string): void {
    const it = this.doc.pages.find((x) => x.id === pageId)?.items.find((i) => i.id === id);
    if (!it || this.readOnly) return;
    this.lasso.clear();
    this.convertFlow.closeResult();
    if (it.type === 'formula') {
      this.editFormula(pageId, id);
      return;
    }
    if (it.type !== 'text') return;
    this.objects.editTextUnit(pageId, id);
  }

  private tapObjectWithLasso(r: PageRect, x: number, y: number): boolean {
    if (this.readOnly) return false;
    const hit = this.objects.hit(r.page, x, y);
    if (!hit || hit.type === 'image' || isLine(hit)) {
      this.objects.deselect();
      return false;
    }
    if (hit.type === 'text' || hit.type === 'formula') {
      // a tap on text with the lasso: type in it (converted handwriting is one text)
      this.editObject(r.page.id, hit.id);
      return true;
    }
    if (this.objects.selected?.id === hit.id) this.objects.tap(r, x, y);
    else {
      this.objects.select(r.page.id, hit.id);
      if (hit.type === 'mindmap') this.objects.tap(r, x, y);
    }
    return true;
  }

  /** Convert the lasso selection (text / math / mind map / flowchart / image text). */
  convert(task: RecTask): Promise<boolean> {
    return this.convertFlow.run(task);
  }

  /** 0.4 API: AI task names map onto the 0.5 convert tasks. */
  runAI(task: AITask): Promise<boolean> {
    const map: Record<AITask, RecTask> = { handwriting: 'text', diagram: 'diagram', mindmap: 'mindmap', 'image-text': 'image-text' };
    return this.convert(map[task]);
  }

  /** LaTeX editor of a formula item (one undo step on Done). */
  editFormula(pageId: string, id: string): void {
    const page = this.doc.pages.find((p) => p.id === pageId);
    const it = page?.items.find((i) => i.id === id);
    if (!page || !it || it.type !== 'formula' || this.readOnly) return;
    mathPreview(
      this.root,
      {
        latex: it.latex,
        alternatives: [],
        source: document.createElement('canvas'),
        color: it.color,
        canReplace: false,
        info: '',
        onCopy: (latex) => void this.copyText(formulaMarkdown(latex)).then((ok) => ok && this.notify(t('latexCopied'))),
        onApply: (latex) => {
          void renderFormula(latex).then((d) => {
            const cur = page.items.find((i) => i.id === id);
            if (!cur || cur.type !== 'formula' || latex === cur.latex) return;
            const box = formulaBoxSize(d, cur.size);
            const next = { ...cur, latex, w: box.w, h: box.h, y: cur.y + cur.h / 2 - box.h / 2 };
            this.pushOp({ kind: 'set-items', pageId, before: page.items, after: page.items.map((i) => (i.id === id ? next : i)) });
            this.objects.select(pageId, id);
          });
        },
      },
      true,
    );
  }

  /** Copy text to the clipboard (false when the platform refuses). */
  async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      this.notify(t('clipboardUnavailable'));
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Context menu and paste (0.9)
  // ---------------------------------------------------------------------------------------------

  private closeContextMenu(): void {
    this.ctxMenu?.close();
    this.ctxMenu = null;
  }

  /** Context menu at a page-local point (finger long press, pen long press, right click). */
  openContextMenu(r: PageRect, x: number, y: number): void {
    if (this.readOnly || this.destroyed) return;
    this.closePopover();
    this.closeContextMenu();
    const clip = lassoClipboard();
    const nav = navigator as Navigator & { clipboard?: { read?: unknown; readText?: unknown } };
    const canRead = !!(nav.clipboard && (nav.clipboard.read || nav.clipboard.readText));
    const entries: MenuEntry[] = [];
    if (clip) {
      const n = clip.strokes.length + clip.items.length;
      entries.push({ icon: 'paste', label: t('ctxPasteHandNote'), hint: `${t('ctxPasteHandNoteHint')} · ${n}`, run: () => this.pasteHandNote(r, x, y) });
    }
    entries.push({
      icon: 'paste',
      label: t('ctxPasteSystem'),
      hint: canRead ? t('ctxPasteSystemHint') : t('ctxPasteSystemUnsupported'),
      disabled: !canRead,
      // must start inside the tap: iPadOS only lets a user gesture read the clipboard
      run: () => void this.pasteSystemAt(r, x, y),
    });
    entries.push({
      icon: 'text',
      label: t('ctxTextHere'),
      hint: t('ctxTextHereHint'),
      run: () => {
        if (this.settings.tool !== 'text') this.setTool('text');
        this.objects.createText(r, x, y);
      },
    });
    entries.push({
      icon: 'image',
      label: t('ctxImageHere'),
      run: () => {
        this.imageTarget = { pageId: r.page.id, x, y };
        this.pickImage();
      },
    });
    const w = { x: r.x + x, y: r.y + y };
    const sx = (w.x - this.cam.x) * this.cam.zoom;
    const sy = (w.y - this.cam.y) * this.cam.zoom;
    const vr = this.viewport.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    this.ctxMenu = new ContextMenu(this.root, sx + vr.left - rr.left, sy + vr.top - rr.top, entries, () => {
      this.ctxMenu = null;
    });
  }

  /** Remember (and write) the plain text of a HandNote copy. */
  private writeClipStamp(plain: string): void {
    this.clipStamp = plain;
    try {
      const c = navigator.clipboard;
      if (c?.writeText) void c.writeText(plain).catch(() => undefined);
    } catch {
      /* no system clipboard: the in-memory copy still works */
    }
  }

  /** Where a keyboard paste goes: the pointer over a page, else the middle of the visible page. */
  private pastePoint(): { r: PageRect; x: number; y: number } | null {
    if (this.lastLocal && this.pointerInside) {
      const page = this.pageForPoint(this.lastLocal);
      if (page) {
        const l = this.localOn(page, this.lastLocal);
        if (l.x >= 0 && l.y >= 0 && l.x <= page.w && l.y <= page.h) return { r: page, x: l.x, y: l.y };
      }
    }
    const r = this.rects[this.currentPageIndex()];
    if (!r) return null;
    const v = this.visibleRegion(r);
    return { r, x: v.cx, y: v.cy };
  }

  private pasteHandNote(r: PageRect, x: number, y: number): void {
    if (!lassoClipboard() || this.readOnly) return;
    if (this.settings.tool !== 'lasso') this.setTool('lasso');
    this.lasso.paste(r, [x, y]);
  }

  /** Context menu "Paste from clipboard": read the system clipboard (inside the tap). */
  private async pasteSystemAt(r: PageRect, x: number, y: number): Promise<void> {
    const content = await readSystemClipboard();
    if (this.destroyed) return;
    await this.pasteContent(content, r, x, y);
  }

  /** Ctrl/Cmd+V or Edit → Paste while HandNote has the focus (or the pointer). */
  private onPasteEvent(e: ClipboardEvent): void {
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.isContentEditable || tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.closest?.('.cm-editor'))) return;
    const focused = this.viewport.contains(document.activeElement) || this.root.contains(document.activeElement);
    if (!focused && !this.pointerInside) return;
    window.clearTimeout(this.pasteFallback);
    if (this.readOnly) return;
    const at = this.pastePoint();
    if (!at) return;
    e.preventDefault();
    void this.pasteContent(fromDataTransfer(e.clipboardData), at.r, at.x, at.y);
  }

  private async pasteContent(c: ClipboardContent, r: PageRect, x: number, y: number): Promise<void> {
    if (this.readOnly) return;
    const own = lassoClipboard();
    switch (c.kind) {
      case 'image': {
        let k = 0;
        for (const img of c.images.slice(0, 10)) {
          await this.insertImageFile(img, { pageId: r.page.id, x: x + k * 24, y: y + k * 24 });
          k++;
        }
        return;
      }
      case 'text':
        // the text HandNote itself put there for its last copy: paste the full objects instead
        if (own && samePlain(c.text, this.clipStamp)) this.pasteHandNote(r, x, y);
        else this.insertTextAt(r, x, y, c.text);
        return;
      case 'empty':
        if (own && this.clipStamp !== null) this.pasteHandNote(r, x, y);
        else this.notify(t('clipboardEmpty'));
        return;
      case 'denied':
        this.notify(t('clipboardDenied'));
        return;
      default:
        this.notify(t('clipboardUnsupported'));
    }
  }

  /** A pasted text becomes a text box at the point (wrapped to the page when long). One undo step. */
  insertTextAt(r: PageRect, x: number, y: number, raw: string): TextItem | null {
    if (this.readOnly) return null;
    const { text, truncated } = cleanPastedText(raw);
    if (!text.trim()) {
      this.notify(t('clipboardEmpty'));
      return null;
    }
    const s = this.settings.text;
    const margin = 24;
    const left = Math.max(margin / 2, Math.min(x, r.w - margin - s.size * 4));
    const room = Math.max(s.size * 4, r.w - left - margin);
    let item: TextItem = fitTextBox({
      id: newId('i'),
      type: 'text',
      x: left,
      y: Math.max(0, y - s.size * 0.75 - TEXT_PAD),
      w: s.size * 2,
      h: s.size * LINE_HEIGHT + TEXT_PAD * 2,
      created: Date.now(),
      text,
      size: s.size,
      color: s.color,
      font: s.font,
      bold: s.bold,
      italic: s.italic,
      align: s.align,
      autoWidth: true,
    });
    if (item.w > room) item = fitTextBox({ ...item, autoWidth: false, w: room });
    const before = r.page.items;
    this.pushOp({ kind: 'set-items', pageId: r.page.id, before, after: [...before, item] });
    if (this.settings.tool !== 'lasso') this.setTool('lasso');
    this.lasso.setSelection({ pageId: r.page.id, strokeIds: new Set(), itemIds: new Set([item.id]) });
    this.notify(truncated ? t('pastedTextTruncated') : t('pastedText'));
    return item;
  }

  /** Align / distribute the lasso selection locally (one undo step). */
  tidySelection(op: LayoutOp): boolean {
    this.lasso.realize();
    const f = this.lasso.selected();
    const sel = this.lasso.selection;
    if (!f || !sel || this.readOnly) return false;
    const res = layoutSelection(op, f.rect.page, f.strokes, f.items, this.cache);
    if (!res) {
      this.notify(t('tidyDone'));
      return false;
    }
    const page = f.rect.page;
    this.pushOp({
      kind: 'batch',
      ops: [
        { kind: 'set-strokes', pageId: page.id, before: page.strokes, after: res.strokes },
        { kind: 'set-items', pageId: page.id, before: page.items, after: res.items },
      ],
    });
    this.lasso.setSelection(sel);
    this.notify(t('tidyDone'));
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // iPad keyboard
  // ---------------------------------------------------------------------------------------------

  /**
   * After a text box gets focus: if the docked keyboard covers it, scroll the page (camera) up; if
   * no keyboard took space on a touch device, iPadOS is probably showing its floating keyboard —
   * that is a system setting HandNote cannot change, so we explain how to switch back once.
   */
  private onEditStart(ta: HTMLTextAreaElement): void {
    const vv = typeof visualViewport !== 'undefined' ? visualViewport : null;
    if (!vv) return;
    const h0 = vv.height;
    const check = () => {
      if (!ta.isConnected || document.activeElement !== ta) return;
      const r = ta.getBoundingClientRect();
      const bottom = vv.offsetTop + vv.height;
      if (r.bottom > bottom - 12) {
        const dy = r.bottom - bottom + 48;
        this.setCamera({ ...this.cam, y: this.cam.y + dy / this.cam.zoom });
        this.requestScene(true);
      }
      const shrunk = h0 - vv.height > 120 || window.innerHeight - vv.height > 120;
      const touch = this.mode === 'pen' && (navigator.maxTouchPoints ?? 0) > 1;
      if (!shrunk && touch && !this.kbHintShown) {
        this.kbHintShown = true;
        this.hint('keyboard', t('keyboardFloatingHint'));
      }
    };
    window.setTimeout(check, 700);
    const onResize = () => check();
    vv.addEventListener('resize', onResize);
    const off = () => {
      vv.removeEventListener('resize', onResize);
      ta.removeEventListener('blur', off);
    };
    ta.addEventListener('blur', off);
  }

  // ---------------------------------------------------------------------------------------------
  // Embedded images
  // ---------------------------------------------------------------------------------------------

  /** Convert attachment images of this note into embedded assets (explicit command, one undo step). */
  async embedAttachmentImages(): Promise<number> {
    if (this.readOnly) return 0;
    const ops: Op[] = [];
    let n = 0;
    const newAssets: Record<string, Asset> = {};
    for (const page of this.doc.pages) {
      let changed = false;
      const after: Item[] = [];
      for (const it of page.items) {
        if (it.type !== 'image' || it.src.startsWith('asset:')) {
          after.push(it);
          continue;
        }
        const blob = await this.imageBlob(it.src);
        if (!blob) {
          after.push(it);
          continue;
        }
        const asset = await makeAsset(blob);
        newAssets[asset.id] = asset;
        after.push({ ...it, src: `asset:${asset.id}` });
        changed = true;
        n++;
      }
      if (changed) ops.push({ kind: 'set-items', pageId: page.id, before: page.items, after });
    }
    if (!ops.length) return 0;
    this.addAssets(newAssets);
    this.pushOp(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    return n;
  }

  openMoreMenu(anchor: HTMLElement): void {
    const p = this.openPopover('more', anchor, 'hn-more-menu');
    if (!p) return;
    const render = () =>
      renderMoreMenu(p.el, {
        texture: this.settings.paperTexture,
        inputMode: this.settings.inputMode,
        resolvedMode: this.mode,
        fingerDrawing: this.settings.fingerDrawing,
        tapGestures: this.settings.tapGestures,
        fingerDoubleTapEraser: this.settings.fingerDoubleTapEraser,
        usePrediction: this.settings.usePrediction,
        diagnostics: this.settings.diagnostics,
        hud: this.settings.showHud,
        canDeletePage: this.doc.pages.length > 1,
        readOnly: this.readOnly,
        actions: this.host.menuActions ?? [],
        onAddPage: () => this.addPageAfterCurrent(),
        onDeletePage: () => this.deleteCurrentPage(),
        onClearPage: () => this.clearCurrentPage(),
        pageEmpty: (() => {
          const pg = this.doc.pages[this.currentPageIndex()];
          return !pg || (pg.strokes.length === 0 && pg.items.length === 0);
        })(),
        onTemplate: () => this.openTemplate(anchor),
        onTexture: (v) => {
          this.settings.paperTexture = v;
          this.host.onSettingsChange(this.settings);
          this.requestScene(true);
        },
        onFitWidth: () => this.fitWidth(),
        onFitPage: () => this.fitPage(),
        onInputMode: (m) => {
          this.settings.inputMode = m;
          this.host.onSettingsChange(this.settings);
          this.applyMode();
          render();
        },
        onToggle: (key, v) => {
          this.settings[key] = v;
          this.router.setOptions({ fingerDrawing: this.settings.fingerDrawing, tapGestures: this.settings.tapGestures });
          this.diagnostics.setEnabled(this.settings.diagnostics);
          this.host.onSettingsChange(this.settings);
          this.updateHud();
        },
        onCopyDiagnostics: () => void this.copyDiagnostics(),
        onClearDiagnostics: () => {
          this.diagnostics.clear();
          this.notify(t('diagnosticsCleared'));
        },
        close: () => this.closePopover(),
      });
    render();
    p.place('right');
  }

  openTemplate(anchor: HTMLElement): void {
    this.closePopover();
    const p = this.openPopover('template', anchor, 'hn-template-panel');
    if (!p) return;
    const page = this.doc.pages[this.currentPageIndex()];
    if (!page) return;
    renderTemplatePanel(p.el, {
      initial: this.templateOf(page),
      onApply: (c) => {
        this.closePopover();
        this.applyTemplate(c);
      },
      onCancel: () => this.closePopover(),
    });
    p.place('right');
  }

  /** Full diagnostics report (input + performance + environment) as Markdown text. */
  diagnosticsReport(): string {
    const snap = this.perf.snapshot();
    const r = this.viewport.getBoundingClientRect();
    return this.diagnostics.report({
      'plugin input mode': `${this.settings.inputMode} → ${this.mode}`,
      'fountain variant': this.settings.fountainVariant,
      'experimental params': this.settings.experimental,
      'pencil params': this.settings.pens.pencil.params,
      'finger drawing': this.settings.fingerDrawing,
      'predicted ink': this.settings.usePrediction,
      'router stats': this.router.stats,
      'frames run by the fallback timer (rAF stalls)': this.rafStalls,
      'frame interval ms': `p50 ${snap.frameInterval.p50.toFixed(2)} · p95 ${snap.frameInterval.p95.toFixed(2)} (n=${snap.frameInterval.n})`,
      'stroke render ms': `p50 ${snap.render.p50.toFixed(3)} · p95 ${snap.render.p95.toFixed(3)}`,
      'processing ms/event': `p50 ${snap.processing.p50.toFixed(3)} · p95 ${snap.processing.p95.toFixed(3)}`,
      'scene render ms': `avg ${snap.sceneRender.avg.toFixed(2)} · p95 ${snap.sceneRender.p95.toFixed(2)}`,
      'dropped frames': `${snap.droppedFrames} / ${snap.framesObserved}`,
      viewport: `${Math.round(r.width)}×${Math.round(r.height)} @${window.devicePixelRatio}x`,
      'scroll offsets (should be 0)': `viewport ${this.viewport.scrollLeft},${this.viewport.scrollTop} · editor ${this.root.scrollLeft},${this.root.scrollTop} · view ${this.root.parentElement?.scrollLeft ?? 0},${this.root.parentElement?.scrollTop ?? 0} · window ${Math.round(window.scrollX)},${Math.round(window.scrollY)}`,
      'visual viewport': typeof visualViewport !== 'undefined' && visualViewport ? `${Math.round(visualViewport.width)}×${Math.round(visualViewport.height)} offset ${Math.round(visualViewport.offsetLeft)},${Math.round(visualViewport.offsetTop)} scale ${visualViewport.scale.toFixed(2)}` : 'n/a',
      capabilities: snap.capabilities,
    });
  }

  private async copyDiagnostics(): Promise<void> {
    const text = this.diagnosticsReport();
    try {
      await navigator.clipboard.writeText(text);
      this.notify(t('diagnosticsCopied'));
    } catch {
      this.notify(t('clipboardUnavailable'));
    }
  }
}

export function toolLabel(tool: Tool): string {
  return t(tool === 'shape' ? 'shapes' : tool === 'ballpoint' ? 'fountain' : tool);
}

function isOverlayTarget(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('.hn-ov-int');
}

function cssVar(elm: HTMLElement, name: string, fb: string): string {
  const v = getComputedStyle(elm).getPropertyValue(name).trim();
  return v || fb;
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(typeof fr.result === 'string' ? fr.result : '');
    fr.onerror = () => rej(fr.error ?? new Error('could not read the image'));
    fr.readAsDataURL(b);
  });
}

/** Longest side of embedded images; larger pictures are downscaled before they are stored. */
export const MAX_EMBED_SIDE = 2048;
const MAX_EMBED_BYTES = 3 * 1024 * 1024;

/** Build an embedded asset from an image blob (downscaled / re-encoded when too large). */
export async function makeAsset(blob: Blob, decoded?: HTMLImageElement): Promise<Asset> {
  const img = decoded ?? (await loadImage(await blobToDataUrl(blob)));
  const w0 = img.naturalWidth || 1;
  const h0 = img.naturalHeight || 1;
  let mime = blob.type && /^image\/(png|jpeg|webp|gif)$/.test(blob.type) ? blob.type : 'image/png';
  let data: string;
  let w = w0;
  let h = h0;
  if (Math.max(w0, h0) > MAX_EMBED_SIDE || blob.size > MAX_EMBED_BYTES || mime === 'image/gif' || mime === 'image/webp') {
    const k = Math.min(1, MAX_EMBED_SIDE / Math.max(w0, h0));
    w = Math.max(1, Math.round(w0 * k));
    h = Math.max(1, Math.round(h0 * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d')?.drawImage(img, 0, 0, w, h);
    let url = cv.toDataURL(mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
    mime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    if (url.length * 0.75 > MAX_EMBED_BYTES) {
      url = cv.toDataURL('image/jpeg', 0.86);
      mime = 'image/jpeg';
    }
    data = url.slice(url.indexOf(',') + 1);
  } else {
    const url = await blobToDataUrl(blob);
    data = url.slice(url.indexOf(',') + 1);
  }
  return { id: newId('a'), mime, w, h, data };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image decode failed'));
    img.src = src;
  });
}

/** Feature detection reported in the performance overlay / test report. */
export function probeCapabilities(): Record<string, boolean | number | string> {
  const pe = typeof PointerEvent !== 'undefined' ? PointerEvent.prototype : null;
  return {
    pointerEvents: typeof PointerEvent !== 'undefined',
    getCoalescedEvents: !!pe && typeof pe.getCoalescedEvents === 'function',
    getPredictedEvents: !!pe && typeof pe.getPredictedEvents === 'function',
    pointerRawUpdate: typeof window !== 'undefined' && 'onpointerrawupdate' in window,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    path2dAddPath: typeof Path2D !== 'undefined' && typeof Path2D.prototype.addPath === 'function',
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    webgl2: typeof WebGL2RenderingContext !== 'undefined',
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
  };
}

export type { Page };

/** Deep-enough copy of a page with fresh ids (strokes, items, groups, connector links). */
export function clonePage(src: Page): Page {
  const idMap = new Map<string, string>();
  for (const it of src.items) idMap.set(it.id, newId('i'));
  const gMap = new Map<string, string>();
  const g = (x?: string) => (x ? (gMap.get(x) ?? (gMap.set(x, newId('g')), gMap.get(x))) : undefined);
  return {
    ...createPage(src.width, src.height, { ...src.background }),
    ...(src.doc ? { doc: { ...src.doc } } : {}),
    strokes: src.strokes.map((s) => ({ ...s, id: newId('s'), ...(s.g ? { g: g(s.g) } : {}) })),
    items: src.items.map((it) => {
      const n = { ...it, id: idMap.get(it.id) as string, ...(it.g ? { g: g(it.g) } : {}) };
      if (n.type === 'shape') {
        if (n.from) n.from = { ...n.from, id: idMap.get(n.from.id) ?? n.from.id };
        if (n.to) n.to = { ...n.to, id: idMap.get(n.to.id) ?? n.to.id };
      }
      return n;
    }),
  };
}
