import { newId, type Page, type Stroke } from '../document/model';
import type { GeometryCache } from '../document/geometry-cache';
import type { Op } from '../document/history';
import { moveItem, type Item, type MindMapItem, type TextItem } from '../document/items';
import { fitTextBox } from '../rendering/items-paint';
import { InlineProgress, ResultBar, type ResultBarModel, type ResultLine } from '../ui/convert-inline';
import { AIError } from '../ai/types';
import type { EngineInfo, RecInput } from '../recognition/service';
import type { DiagramResult, RecRun, RecStage, RecTask } from '../recognition/types';
import { toInkStrokes } from '../recognition/ink-analysis';
import { rasterForRecognition, type Box } from '../recognition/raster';
import { freeSpotOffset, buildFormulaItem, buildMindMapItem, buildTextBlock, inkColor, inkLines } from '../convert/build';
import { layoutDiagram, itemsToMermaid } from '../diagram/layout';
import { canvasMeasure } from '../mindmap/paint';
import { renderFormula, formulaMarkdown } from '../rendering/formula';
import { fromTree, type MapThemeId } from '../mindmap/model';
import { convertConsent, convertError, convertProgress, engineMissing, diagramPreview, mathPreview, mindmapPreview, textPreview, type ApplyMode } from '../ui/convert-panels';
import { t } from '../ui/i18n';
import { toError } from '../utils/errors';

/** What the editor exposes to the convert flow. */
export interface RecognitionBridge {
  engineFor(task: RecTask): EngineInfo;
  recognize(task: RecTask, input: RecInput, signal?: AbortSignal, onStage?: (s: RecStage['name']) => void): Promise<RecRun>;
  /** Default font of converted text. */
  textFont(): 'hand' | 'sans';
  /** Default theme of maps / flowcharts. */
  mapTheme?(): MapThemeId;
  /** Turn on the offline Chinese engine (settings). */
  enableOffline?(): void;
  /** Record a finished conversion's timings (stats in settings). */
  record?(run: RecRun, totalMs: number, task: RecTask): void;
  /** Conversion preferences (settings). */
  prefs?(): ConvertPrefs;
  /** The user ticked "don't ask again" for MyScript (saved in settings). */
  setAlwaysSend?(on: boolean): void;
  /** Open the connection to the recognition server early (sends nothing of the user's). */
  warmUp?(): void;
  /** Measured network round trip to the recognition server (ms), if known. */
  rtt?(): number | undefined;
  /** Load the on-device models ahead of use (no inference). */
  warmLocal?(task: 'text' | 'math'): void;
  /** On-device model pack for a task: bytes still to download (0 = installed); undefined = unavailable here. */
  localMissingBytes?(task: 'text' | 'math'): number | undefined;
  /** Load the glyphs of the hand font for these characters before text boxes are measured. */
  prepareText?(text: string): Promise<void>;
  /** Bytes of the Excalidraw hand-font pack still to download (0 = installed; undefined = not offered). */
  fontMissingBytes?(): number | undefined;
  /** Download + verify the font pack. */
  installFont?(onProgress: (text: string) => void): Promise<void>;
  /** English model pack: bytes still to download (0 = installed; undefined = not offered). */
  englishMissingBytes?(): number | undefined;
  /** Download the English model and read the selection again (returns the new lines). */
  installEnglish?(onProgress: (text: string) => void): Promise<void>;
  /** Download + verify the on-device pack for a task (the user confirmed the size). */
  installLocal?(task: 'text' | 'math', onProgress: (text: string) => void): Promise<void>;
}

export interface ConvertPrefs {
  mode: 'instant' | 'preview';
  keepInk: boolean;
  alwaysSend: boolean;
  prefetch: 'off' | 'menu' | 'lasso';
}

const DEFAULT_PREFS: ConvertPrefs = { mode: 'preview', keepInk: false, alwaysSend: false, prefetch: 'off' };

export interface ConvertHost {
  root: HTMLElement;
  cache: GeometryCache;
  readOnly(): boolean;
  pages(): Page[];
  selection(): { page: Page; strokes: Stroke[]; items: Item[]; bounds: Box; outline?: [number, number][] | null } | null;
  push(op: Op): void;
  select(pageId: string, itemIds: string[]): void;
  notify(msg: string): void;
  openSettings(): void;
  /** Turn the offline Chinese engine on (settings). */
  enableOffline?(): void;
  copy(text: string): Promise<boolean>;
  language(): 'zh' | 'en';
  defaultInkColor(): string;
  /** In-place conversion UI (absent: the preview dialogs are used). */
  overlay?: HTMLElement;
  /** Page box → viewport CSS px. */
  screenRect?(pageId: string, box: Box): Box | null;
  /** Drop the lasso selection (the converted result is shown with its own bar). */
  clearSelection?(): void;
  /** Select the converted result, keeping the lasso loop as its outline. */
  selectResult?(pageId: string, ids: string[], outline: [number, number][] | null): void;
  /** Edit a converted item (text box editor / LaTeX editor). */
  editItem?(pageId: string, id: string): void;
}

interface ResultState {
  bar: ResultBar;
  pageId: string;
  ids: string[];
  detach: () => void;
}

/**
 * Lasso → Convert → (consent) → recognizer → validated result → editable preview → apply.
 *
 * - The original ink is never touched before the user applies; "replace" removes it in the same
 *   undo step that adds the result, "insert beside" keeps it.
 * - Every stage is visible (progress with elapsed time and Cancel); errors are typed and offer a
 *   retry that the user triggers (a request that may have been billed is never repeated silently).
 * - Results are laid out locally (lines, formula box, mind map tree layout, flowchart layers).
 */
export class ConvertFlow {
  /** Consent remembered for this editor session, per engine label. */
  private trusted = new Set<string>();
  private running = false;
  private result: ResultState | null = null;
  private pill: { pill: InlineProgress; pageId: string; box: Box } | null = null;
  /** The running request (aborted when the editor goes away). */
  private ctrl: AbortController | null = null;
  /** The editor was destroyed (note closed, plugin disabled): late results are discarded. */
  private disposed = false;

  constructor(
    private readonly h: ConvertHost,
    private readonly rec: () => RecognitionBridge | undefined,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  async run(task: RecTask): Promise<boolean> {
    const rec = this.rec();
    const sel = this.h.selection();
    if (!sel) {
      this.h.notify(t('selectionEmpty'));
      return false;
    }
    if (this.running || this.h.readOnly()) return false;
    const engine = rec?.engineFor(task);
    if (!rec || !engine?.ready) {
      // never guess: explain which engine is missing and how to get one
      const local = (task === 'text' || task === 'math') && engine?.engine === 'local' && rec?.installLocal ? rec.localMissingBytes?.(task) : undefined;
      return new Promise<boolean>((resolve) => {
        const m = engineMissing(this.h.root, task, engine?.reason ?? 'no-ai', {
          onSettings: () => this.h.openSettings(),
          onEnableOffline: task === 'text' && this.h.enableOffline ? () => this.h.enableOffline?.() : undefined,
          installBytes: local,
          onTypeLatex: task === 'math' ? () => void this.typeLatex() : undefined,
          onInstall:
            local !== undefined && rec?.installLocal
              ? async (progress) => {
                  await rec.installLocal?.(task as 'text' | 'math', progress);
                  // the user asked to convert: do it now that the model is here (local, free)
                  resolve(await this.run(task));
                }
              : undefined,
        });
        onDismiss(m, () => resolve(false));
      });
    }
    const t0 = performance.now();
    // ---- prepare: only the selection, only what the task needs
    const items = task === 'image-text' ? sel.items.filter((i) => i.type === 'image') : sel.items.filter((i) => i.type === 'image' || i.type === 'shape' || i.type === 'text');
    const strokes = task === 'image-text' ? [] : sel.strokes;
    const ink = engine.sends !== 'image' ? toInkStrokes(strokes.filter((s) => s.tool !== 'highlighter')) : undefined;
    if (ink && !ink.length) {
      this.h.notify(t('convertNeedsInk'));
      return false;
    }
    const lines = task === 'text' ? inkLines(strokes) : [];
    const textLike = task === 'text' || task === 'math' || task === 'image-text';
    let raster: ReturnType<typeof rasterForRecognition> | null = null;
    const getRaster = () =>
      (raster ??= rasterForRecognition(strokes, items, sel.bounds, this.h.cache, {
        maxSide: engine.maxImageSide || 1280,
        blackInk: textLike,
        skipHighlighter: textLike,
      }));
    const prefs = rec.prefs?.() ?? DEFAULT_PREFS;
    // MyScript Notes style: digital-ink results go straight onto the page (a vision model's guess
    // is always previewed first)
    const instant = prefs.mode === 'instant' && (engine.kind === 'digital-ink' || engine.kind === 'local') && (task === 'text' || task === 'math') && !!this.h.overlay && !!this.h.screenRect;
    // ---- consent (what leaves the device). Offline sends nothing; MyScript can be set to "don't
    // ask again" by the user (saved); otherwise remembered per service for this session if asked
    const askConsent = engine.sends !== 'nothing' && !this.trusted.has(engine.label) && !(engine.engine === 'myscript' && prefs.alwaysSend);
    if (askConsent) {
      const r = getRaster();
      const bytes = engine.sends === 'ink' ? JSON.stringify(ink).length : Math.round((r.image.base64.length * 3) / 4);
      const c = await convertConsent(this.h.root, { engine, preview: cloneCanvas(r.canvas), strokes: strokes.length, bytes, offerAlways: engine.engine === 'myscript' && !!rec.setAlwaysSend });
      if (!c.ok) return false;
      if (c.always) rec.setAlwaysSend?.(true);
      else if (c.remember) this.trusted.add(engine.label);
    }
    const input: RecInput = {
      selectionId: newId('sel'),
      language: this.h.language(),
      ...(ink ? { ink } : {}),
      ...(engine.sends === 'image' ? { image: getRaster().image } : {}),
      ...(task === 'text' ? { lineCount: lines.length } : {}),
    };
    if (instant) return this.request(task, input, sel, null, lines, t0, sel.bounds, prefs);
    const r = getRaster();
    return this.request(task, input, sel, r.canvas, lines, t0, r.bounds, prefs);
  }

  /**
   * Type the formula for the lasso selection as LaTeX (no recognition, nothing leaves the device):
   * the same preview as a recognised formula, then in place of the ink or beside it (one undo step).
   */
  async typeLatex(): Promise<boolean> {
    const sel = this.h.selection();
    if (!sel || this.h.readOnly()) return false;
    const page = sel.page;
    const color = inkColor(sel.strokes, this.h.defaultInkColor());
    const replaceIds = new Set(sel.strokes.map((s) => s.id));
    const r = rasterForRecognition(sel.strokes, sel.items, sel.bounds, this.h.cache, { maxSide: 1280, blackInk: true, skipHighlighter: true });
    return new Promise<boolean>((resolve) => {
      const m = mathPreview(this.h.root, {
        latex: '',
        alternatives: [],
        source: cloneCanvas(r.canvas),
        color,
        canReplace: sel.strokes.length > 0,
        info: '',
        onCopy: (latex) => void this.h.copy(formulaMarkdown(latex)).then((ok) => ok && this.h.notify(t('latexCopied'))),
        onApply: (latex, mode) => {
          if (!latex.trim()) return resolve(false);
          void renderFormula(latex).then((d) => {
            const it = buildFormulaItem(latex, d, sel.bounds, color, 0, 0);
            const made = mode === 'keep' ? offsetBeside([it], sel.bounds, page) : [it];
            resolve(this.apply(page, made, mode, replaceIds));
          });
        },
      });
      onDismiss(m, () => resolve(false));
    });
  }

  /** Recognition input of a selection, built exactly like `run` (same cache key → prefetch reuse). */
  private inputFor(task: RecTask, strokes: Stroke[]): RecInput {
    const ink = toInkStrokes(strokes.filter((s) => s.tool !== 'highlighter'));
    return { selectionId: newId('sel'), language: this.h.language(), ink, ...(task === 'text' ? { lineCount: inkLines(strokes).length } : {}) };
  }

  /**
   * A lasso selection was made. With MyScript as the text engine: open the connection early (a
   * GET of the server version — nothing of the user's is sent). If the user turned on
   * "recognise in advance" (and "don't ask"), the text is recognised in the background so that
   * Convert → Text is instant (the request joins / hits the cache).
   */
  selectionReady(): void {
    this.early('lasso');
  }

  /**
   * The Convert menu opened: the user is converting this selection. With "don't ask again" on,
   * MyScript starts reading it as text right away (prefetch "menu", the default), so the answer is
   * usually back by the time Text is tapped — the menu tap overlaps the network round trip.
   */
  menuOpened(): void {
    this.early('menu');
  }

  private early(when: 'lasso' | 'menu'): void {
    const rec = this.rec();
    const sel = this.h.selection();
    if (!rec || !sel || this.running || this.h.readOnly()) return;
    const strokes = sel.strokes.filter((s) => s.tool !== 'highlighter');
    if (!strokes.length) return;
    // on-device models: load them on lasso; once the Convert menu is open, read the selection
    // as text and as math in the background (the worker keeps drawing smooth; nothing is sent)
    const local = (['text', 'math'] as const).filter((tk) => {
      const x = rec.engineFor(tk);
      return x.ready && x.engine === 'local';
    });
    if (local.length) {
      if (when === 'lasso') for (const tk of local) rec.warmLocal?.(tk);
      // read ahead as text only: a math read ahead as well kept the iPad's worker (and CPU) busy
      // with a result that is rarely wanted, and a Text tap had to wait behind it
      else if (local.includes('text')) void rec.recognize('text', this.inputFor('text', sel.strokes)).catch(() => undefined);
    }
    const e = rec.engineFor('text');
    if (!e.ready || e.engine !== 'myscript') return;
    rec.warmUp?.();
    const p = rec.prefs?.() ?? DEFAULT_PREFS;
    if (!p.alwaysSend || p.prefetch === 'off' || (when === 'lasso' && p.prefetch !== 'lasso')) return;
    void rec.recognize('text', this.inputFor('text', sel.strokes)).catch(() => undefined);
  }

  private async request(task: RecTask, input: RecInput, sel: NonNullable<ReturnType<ConvertHost['selection']>>, source: HTMLCanvasElement | null, lines: ReturnType<typeof inkLines>, t0: number, bounds: Box, prefs: ConvertPrefs): Promise<boolean> {
    const rec = this.rec() as RecognitionBridge;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.running = true;
    this.closeResult();
    const engine = rec.engineFor(task);
    let prog: { stage(n: RecStage['name']): void; detail(text: string): void; close(): void };
    if (!source && this.h.overlay) {
      // in place: a small pill under the selection, nothing modal
      const pill = new InlineProgress(this.h.overlay, this.h.screenRect?.(sel.page.id, sel.bounds) ?? null, engineShort(engine.engine), () => ctrl.abort());
      this.pill = { pill, pageId: sel.page.id, box: sel.bounds };
      prog = {
        stage: () => undefined,
        detail: (d) => pill.detail(d),
        close: () => {
          pill.close();
          this.pill = null;
        },
      };
    } else {
      const m = convertProgress(this.h.root, () => ctrl.abort());
      prog = m;
      prog.stage('request');
    }
    let run: RecRun;
    try {
      run = await abortable(rec.recognize(task, { ...input, onProgress: (d, n) => prog.detail(n > 1 ? `${t('convertLine')} ${Math.min(d + 1, n)} / ${n}` : '') }, ctrl.signal, (s) => prog.stage(s)), ctrl.signal);
    } catch (e) {
      prog.close();
      this.running = false;
      this.ctrl = null;
      if (this.disposed) return false;
      const err = e instanceof AIError ? e : new AIError('provider', String((e as Error)?.message ?? e));
      if (err.code === 'cancelled') {
        this.h.notify(t('convertCancelled'));
        return false;
      }
      return new Promise<boolean>((resolve) => {
        const m = convertError(this.h.root, err.code, err.message, {
          onRetry: err.code === 'not-configured' || err.code === 'auth' || err.code === 'too-large' ? undefined : () => void this.request(task, input, sel, source, lines, performance.now(), bounds, prefs).then(resolve),
          onSettings: () => this.h.openSettings(),
        });
        const close = m.close.bind(m);
        m.close = () => {
          close();
          resolve(false);
        };
      });
    }
    prog.stage('build');
    prog.close();
    this.running = false;
    this.ctrl = null;
    if (this.disposed) return false;
    const total = performance.now() - t0;
    rec.record?.(run, total, task);
    const info = factsLine(run, total);
    if (run.result.task === 'text' || run.result.task === 'image-text') void rec.prepareText?.((run.result).lines.map((l) => l.text + (l.tokens ?? []).flatMap((x) => x.candidates).join('')).join(''));
    if (!source && run.confident !== false) return this.applyInstant(run, sel, lines, prefs, total);
    if (!source) {
      // an uncertain on-device result is shown with its candidates; the ink stays until the user picks
      const items = sel.items.filter((i) => i.type === 'image' || i.type === 'shape' || i.type === 'text');
      source = rasterForRecognition(sel.strokes, items, sel.bounds, this.h.cache, { maxSide: 1280, blackInk: true, skipHighlighter: true }).canvas;
    }
    const page = sel.page;
    const canReplace = sel.strokes.length > 0 && !this.h.readOnly();
    const color = inkColor(sel.strokes, this.h.defaultInkColor());
    const replaceIds = new Set(sel.strokes.map((s) => s.id));
    const pageBox = { width: page.width, height: page.height };
    const srcCanvas = cloneCanvas(source);
    const r = run.result;
    if (r.task === 'text' || r.task === 'image-text') {
      const tr = r;
      if (!tr.lines.some((l) => l.text.trim())) {
        this.h.notify(t('aiNoResult'));
        return false;
      }
      return new Promise<boolean>((resolve) => {
        const m = textPreview(this.h.root, {
          lines: tr.lines.map((l) => ({ text: l.text, alternatives: l.alternatives, tokens: l.tokens })),
          warnings: tr.warnings,
          source: srcCanvas,
          font: rec.textFont(),
          canReplace: canReplace && r.task === 'text',
          info,
          onApply: (texts, font, mode) => {
            void (async () => {
            if (font === 'hand') await rec.prepareText?.(texts.join(''));
            const res = texts.map((text, i) => ({ text, alternatives: tr.lines[i]?.alternatives ?? [] }));
            const inkForPlacement = r.task === 'text' ? lines : [];
            const area = r.task === 'text' ? sel.bounds : bounds;
            const block = buildTextBlock(res, inkForPlacement, area, { font, color: r.task === 'text' ? color : this.h.defaultInkColor(), dx: 0, dy: 0 });
            let made: Item[] = block ? [block] : [];
            if (mode === 'keep') made = offsetBeside(made, area, page);
            resolve(this.apply(page, made, mode, replaceIds));
            })();
          },
        });
        onDismiss(m, () => resolve(false));
      });
    }
    if (r.task === 'math') {
      const mr = r;
      return new Promise<boolean>((resolve) => {
        const m = mathPreview(this.h.root, {
          latex: mr.latex,
          alternatives: mr.alternatives,
          source: srcCanvas,
          color,
          canReplace,
          info,
          onCopy: (latex) => void this.h.copy(formulaMarkdown(latex)).then((ok) => ok && this.h.notify(t('latexCopied'))),
          onApply: (latex, mode) => {
            void renderFormula(latex).then((d) => {
              const it = buildFormulaItem(latex, d, sel.bounds, color, 0, 0);
              const made = mode === 'keep' ? offsetBeside([it], sel.bounds, page) : [it];
              resolve(this.apply(page, made, mode, replaceIds));
            });
          },
        });
        onDismiss(m, () => resolve(false));
      });
    }
    if (r.task === 'mindmap') {
      const mm = r;
      const theme = rec.mapTheme?.() ?? 'academic';
      return new Promise<boolean>((resolve) => {
        const m = mindmapPreview(this.h.root, {
          root: fromTree(mm.root),
          theme,
          layout: 'balanced',
          source: srcCanvas,
          canReplace,
          info,
          onApply: (root, th, lay, mode) => {
            let it = buildMindMapItem(root, sel.bounds, th, lay, 0, 0, pageBox);
            if (mode === 'keep') {
              const off = freeSpotOffset(sel.bounds, it, pageBox, occupiedBoxes(page));
              it = clampToPage(moveItem(it, off.dx, off.dy) as MindMapItem, pageBox);
            }
            resolve(this.apply(page, [it], mode, replaceIds));
          },
        });
        onDismiss(m, () => resolve(false));
      });
    }
    const dr = r as DiagramResult;
    if (!dr.nodes.length) {
      this.h.notify(t('aiNoResult'));
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const build = (theme: MapThemeId) => layoutDiagram(dr, { x: sel.bounds.x, y: sel.bounds.y }, theme, canvasMeasure).items;
      const m = diagramPreview(this.h.root, {
        build,
        source: srcCanvas,
        theme: rec.mapTheme?.() ?? 'academic',
        canReplace,
        info,
        warnings: dr.warnings,
        mermaid: (items) => itemsToMermaid(items, dr.direction === 'LR' ? 'LR' : 'TD'),
        onCopy: (text) => void this.h.copy(text).then((ok) => ok && this.h.notify(t('mapCopied'))),
        onApply: (items, mode) => {
          const made = mode === 'keep' ? offsetBeside(items, sel.bounds, page) : items;
          resolve(this.apply(page, made, mode, replaceIds));
        },
      });
      onDismiss(m, () => resolve(false));
    });
  }

  /** One undo step: add the result; with "replace", remove the converted ink in the same step. */
  private apply(page: Page, made: Item[], mode: ApplyMode, replaceIds: Set<string>, instant = false, outline: [number, number][] | null = null): boolean {
    if (this.disposed || this.h.readOnly() || !this.h.pages().includes(page) || !made.length) return false;
    const ops: Op[] = [{ kind: 'set-items', pageId: page.id, before: page.items, after: [...page.items, ...made] }];
    if (mode === 'replace' && replaceIds.size) ops.unshift({ kind: 'set-strokes', pageId: page.id, before: page.strokes, after: page.strokes.filter((s) => !replaceIds.has(s.id)) });
    this.h.push(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    if (instant) {
      // the result stays selected (the loop around it): it can be dragged right away; a tap on
      // it types in it
      if (this.h.selectResult) this.h.selectResult(page.id, made.map((i) => i.id), mode === 'replace' ? outline : null);
      else this.h.clearSelection?.();
      return true;
    }
    this.h.select(page.id, made.map((i) => i.id));
    this.h.notify(t('convertApplied'));
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // In-place conversion (MyScript Notes style)
  // ---------------------------------------------------------------------------------------------

  /**
   * The result replaces the ink where it was written, in one undo step (or goes beside it when the
   * user keeps the ink, or when the ink was changed while it was being recognised). A bar under
   * the result offers the candidates, editing and "Restore ink".
   */
  private async applyInstant(run: RecRun, sel: NonNullable<ReturnType<ConvertHost['selection']>>, lines: ReturnType<typeof inkLines>, prefs: ConvertPrefs, total: number): Promise<boolean> {
    const rec = this.rec() as RecognitionBridge;
    const page = sel.page;
    if (!this.h.pages().includes(page) || this.h.readOnly()) return false;
    // the very strokes that were recognised must still be on the page to be replaced
    const unchanged = sel.strokes.every((s) => page.strokes.find((x) => x.id === s.id) === s);
    const keep = prefs.keepInk || !unchanged;
    const mode: ApplyMode = keep ? 'keep' : 'replace';
    const replaceIds = new Set(sel.strokes.map((s) => s.id));
    const color = inkColor(sel.strokes, this.h.defaultInkColor());
    const info = shortFacts(run, total, rec.rtt?.());
    const r = run.result;
    if (r.task === 'text') {
      const tl = (r).lines.filter((l) => l.text.trim());
      if (!tl.length) {
        this.h.notify(t('aiNoResult'));
        return false;
      }
      const font = rec.textFont();
      if (font === 'hand') await rec.prepareText?.(tl.map((l) => l.text).join(''));
      // one text box for what was converted (a tap edits all of it; lines keep their order)
      const block = buildTextBlock(tl.map((l) => ({ text: l.text, alternatives: l.alternatives })), lines, sel.bounds, { font, color, dx: 0, dy: 0 });
      let made: Item[] = block ? [block] : [];
      if (keep) made = offsetBeside(made, sel.bounds, page);
      if (!this.apply(page, made, mode, replaceIds, true, sel.outline ?? null)) return false;
      if (!unchanged && !prefs.keepInk) this.h.notify(t('convertInkChanged'));
      const ids = made.map((i) => i.id);
      const missing = font === 'hand' ? rec.fontMissingBytes?.() : undefined;
      const latinLine = run.engine === 'local' && tl.some((l) => {
        const cs = l.text.replace(/\s/g, '');
        return cs.length > 0 && cs.replace(/[^A-Za-z]/g, '').length / cs.length >= 0.5;
      });
      const enMissing = latinLine ? rec.englishMissingBytes?.() : undefined;
      this.showResult(page, ids, keep ? [] : sel.strokes, {
        kind: 'text',
        lines: tl.map((l) => ({ text: l.text, tokens: l.tokens, alternatives: l.alternatives })),
        info,
        hand: font === 'hand',
        english:
          enMissing && rec.installEnglish
            ? {
                label: t('englishOffer').replace('{mb}', (enMissing / 1048576).toFixed(1)),
                run: async (progress) => {
                  await rec.installEnglish?.(progress);
                  // read the same ink again (on the device) and update the converted lines in place
                  const again = await rec.recognize('text', this.inputFor('text', sel.strokes));
                  if (again.result.task !== 'text') return;
                  const nl = (again.result).lines.filter((l) => l.text.trim());
                  if (nl.length !== tl.length) {
                    progress(t('englishInstalled'));
                    return;
                  }
                  this.setLines(page, ids[0], nl.map((l) => l.text));
                  this.showResult(page, ids, keep ? [] : sel.strokes, {
                    kind: 'text',
                    lines: nl.map((l) => ({ text: l.text, tokens: l.tokens, alternatives: l.alternatives })),
                    info: shortFacts(again, again.stages.reduce((a, x) => a + x.ms, 0), rec.rtt?.()),
                    hand: font === 'hand',
                  });
                },
              }
            : undefined,
        font:
          missing && rec.installFont
            ? {
                label: t('fontOffer').replace('{mb}', (missing / 1048576).toFixed(1)),
                run: async (progress) => {
                  await rec.installFont?.(progress);
                  await rec.prepareText?.(tl.map((l) => l.text).join(''));
                  // the converted boxes take the new font's measurements (one undo step)
                  const cur = page.items;
                  const after = cur.map((i) => (ids.includes(i.id) && i.type === 'text' ? fitTextBox(i) : i));
                  if (after.some((x, k) => x !== cur[k])) this.h.push({ kind: 'set-items', pageId: page.id, before: cur, after });
                },
              }
            : undefined,
      });
      return true;
    }
    if (r.task === 'math') {
      const latex = (r).latex;
      const d = await renderFormula(latex);
      const it = buildFormulaItem(latex, d, sel.bounds, color, 0, 0);
      const made = keep ? offsetBeside([it], sel.bounds, page) : [it];
      if (!this.apply(page, made, mode, replaceIds, true, sel.outline ?? null)) return false;
      if (!unchanged && !prefs.keepInk) this.h.notify(t('convertInkChanged'));
      this.showResult(page, made.map((i) => i.id), keep ? [] : sel.strokes, { kind: 'math', lines: [], latex, info, hand: false });
      return true;
    }
    return false;
  }

  private showResult(page: Page, ids: string[], removed: Stroke[], m: { kind: 'text' | 'math'; lines: ResultLine[]; latex?: string; info: string; hand: boolean; font?: ResultBarModel['font']; english?: ResultBarModel['english'] }): void {
    this.closeResult();
    const overlay = this.h.overlay;
    if (!overlay) return;
    const bar = new ResultBar(overlay, {
      ...m,
      onLine: (i, text) => (m.kind === 'text' && ids.length === 1 ? this.setLineOf(page, ids[0], i, text) : this.setLine(page, ids[i], text)),
      onEdit: () => {
        const id = ids.find((x) => page.items.some((i) => i.id === x));
        this.closeResult();
        if (id) this.h.editItem?.(page.id, id);
      },
      onRestore: removed.length ? () => this.restore(page, ids, removed) : null,
      onClose: () => this.closeResult(),
    });
    // writing, selecting or tapping anywhere else on the page dismisses the bar
    const host = overlay.parentElement ?? overlay;
    const onDown = (e: Event) => {
      if (!bar.el.contains(e.target as Node)) this.closeResult();
    };
    host.addEventListener('pointerdown', onDown, true);
    this.result = { bar, pageId: page.id, ids, detach: () => host.removeEventListener('pointerdown', onDown, true) };
    this.sync();
  }

  /** A candidate was picked: the text box of that line gets the new text (one undo step). */
  private setLine(page: Page, id: string | undefined, text: string): void {
    const cur = page.items.find((i) => i.id === id);
    if (!cur || cur.type !== 'text' || this.h.readOnly() || cur.text === text) return;
    const next: TextItem = fitTextBox({ ...cur, text });
    this.h.push({ kind: 'set-items', pageId: page.id, before: page.items, after: page.items.map((i) => (i.id === cur.id ? next : i)) });
  }

  /** Line `i` of a converted text box now reads `text` (a candidate was picked; one undo step). */
  private setLineOf(page: Page, id: string | undefined, i: number, text: string): void {
    const cur = page.items.find((x) => x.id === id);
    if (!cur || cur.type !== 'text') return;
    const lines = cur.text.split('\n');
    if (i < 0 || i >= lines.length) return;
    lines[i] = text;
    this.setLine(page, id, lines.join('\n'));
  }

  /** Every line of a converted text box at once (English model read the ink again). */
  private setLines(page: Page, id: string | undefined, texts: string[]): void {
    this.setLine(page, id, texts.map((x) => x.trim()).filter(Boolean).join('\n'));
  }

  /** Bring the handwriting back and remove the result (one undo step). */
  private restore(page: Page, ids: string[], removed: Stroke[]): void {
    if (this.h.readOnly() || !this.h.pages().includes(page)) return;
    const drop = new Set(ids);
    const have = new Set(page.strokes.map((s) => s.id));
    const back = removed.filter((s) => !have.has(s.id));
    const ops: Op[] = [{ kind: 'set-items', pageId: page.id, before: page.items, after: page.items.filter((i) => !drop.has(i.id)) }];
    if (back.length) ops.push({ kind: 'set-strokes', pageId: page.id, before: page.strokes, after: [...page.strokes, ...back] });
    this.closeResult();
    this.h.push(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
    this.h.notify(t('convertRestored'));
  }

  /**
   * The editor is going away (note closed, plugin disabled): stop waiting for a running
   * recognition and never apply its result — the note was already saved with its ink, and a change
   * made now could not be seen, undone or restored by the user.
   */
  dispose(): void {
    this.disposed = true;
    this.ctrl?.abort();
    this.ctrl = null;
    this.closeResult();
  }

  closeResult(): void {
    if (!this.result) return;
    this.result.detach();
    this.result.bar.close();
    this.result = null;
  }

  /** The bar follows its result (camera / document changed); it goes away with the result. */
  sync(): void {
    if (this.pill) this.pill.pill.move(this.h.screenRect?.(this.pill.pageId, this.pill.box) ?? null);
    const r = this.result;
    if (!r) return;
    const page = this.h.pages().find((p) => p.id === r.pageId);
    const items = page?.items.filter((i) => r.ids.includes(i.id)) ?? [];
    if (!items.length) {
      this.closeResult();
      return;
    }
    r.bar.move(this.h.screenRect?.(r.pageId, boundsOf(items)) ?? null);
  }

  /** Is a result bar shown (tests). */
  get resultOpen(): boolean {
    return !!this.result;
  }
}

function engineShort(e: RecRun['engine']): string {
  return e === 'local' ? t('engineLocal') : e === 'offline' ? t('engineOffline') : e === 'myscript' ? 'MyScript' : e === 'mock' ? t('engineMock') : t('engineVision');
}

/** "MyScript · 1.4 s · network 1.1 s · round trip 0.3 s · 6 KB" — where the time went. */
function shortFacts(run: RecRun, total: number, rtt?: number): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const parts = [engineShort(run.engine)];
  if (run.cached) parts.push(t('convertCachedShort'));
  else {
    parts.push(s(total));
    const req = run.stages.find((x) => x.name === 'request');
    if (run.engine === 'myscript' && req) {
      parts.push(`${t('convertNet')} ${s(req.ms)}`);
      if (rtt !== undefined) parts.push(`${t('convertRtt')} ${s(rtt)}`);
      if (run.bytes) parts.push(`${Math.max(1, Math.round(run.bytes / 1024))} KB`);
    }
  }
  return parts.join(' · ');
}

/** Stop waiting when the user cancels (a request shared with a background prefetch keeps running). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AIError('cancelled', 'cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AIError('cancelled', 'cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(e));
      },
    );
  });
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}

function onDismiss(m: { close(): void }, fn: () => void): void {
  const close = m.close.bind(m);
  m.close = () => {
    close();
    fn();
  };
}

function boundsOf(items: Item[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w);
    y1 = Math.max(y1, it.y + it.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Boxes of everything already on the page (items and ink), for placing a result beside the selection. */
function occupiedBoxes(page: Page): Box[] {
  const out: Box[] = page.items.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  for (const s of page.strokes) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of s.samples) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    if (Number.isFinite(x0)) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

function offsetBeside(items: Item[], src: Box, page: Page): Item[] {
  const b = boundsOf(items);
  const off = freeSpotOffset(src, b, page, occupiedBoxes(page));
  // keep connectors attached: move everything together (attachments are kept)
  return items.map((it) => moveItem(it, off.dx, off.dy, true));
}

function clampToPage(it: MindMapItem, page: { width: number; height: number }): MindMapItem {
  return { ...it, x: Math.min(Math.max(8, it.x), Math.max(8, page.width - it.w - 8)), y: Math.min(Math.max(8, it.y), Math.max(8, page.height - it.h - 8)) };
}

function factsLine(run: RecRun, total: number): string {
  const req = run.stages.find((s) => s.name === 'request');
  const name = run.engine === 'local' ? `${t('engineLocal')} · ${run.model} · ${t('engineNoUpload')}` : run.engine === 'offline' ? `${t('engineOffline')} · ${t('engineNoUpload')}` : run.engine === 'myscript' ? `MyScript · ${run.model}` : run.engine === 'mock' ? t('engineMock') : `${t('engineVision')} · ${run.model}`;
  const parts = [`${t('convertFacts')}: ${name}`];
  if (run.cached) parts.push(t('convertCached'));
  else if (req) parts.push(`${t('convertTimeRequest')} ${(req.ms / 1000).toFixed(1)} s`);
  parts.push(`${t('convertTimeTotal')} ${(total / 1000).toFixed(1)} s`);
  if (run.usage.inputTokens || run.usage.outputTokens) parts.push(`tokens ${run.usage.inputTokens ?? '?'}/${run.usage.outputTokens ?? '?'}`);
  return parts.join(' · ');
}
