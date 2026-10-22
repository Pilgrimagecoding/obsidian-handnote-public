import { calibration } from '../input/diagnostics';
export { calibration };
import type { InkTool, PenParams } from '../ink/types';
import type { BackgroundKind } from '../document/model';
import { PAGE_SIZES, PAPER_TONES } from '../document/model';
import type { EraserMode, FountainVariant, LassoFilter, PaperTone, StrokeDash } from '../editor/settings';
import type { ArrowHead } from '../document/items';
import { stepSlider } from './slider';
import { onTap } from './tap';
import { colorSwatch } from './toolbar';
import type { InputMode, InputModeSetting } from '../input/input-mode';
import { StrokeBuilder } from '../ink/stroke-builder';
import { CanvasPathSink, emitStroke } from '../ink/outline';
import { pencilFill } from '../rendering/items-paint';
import { el } from './dom';
import { setHnIcon } from './icons';
import { t } from './i18n';

const MM = 72 / 25.4;

/**
 * Compact anchored popover. Closes on outside pointerdown or Escape. Width ≤ 320 px, height limited
 * to the space below the anchor (scrollable inside).
 */
export class Popover {
  readonly el: HTMLElement;
  private onDoc = (e: Event) => {
    if (!this.el.contains(e.target as Node) && !this.anchor.contains(e.target as Node)) this.close();
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };
  private closed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly anchor: HTMLElement,
    cls: string,
    private readonly onClose: () => void,
  ) {
    this.el = el('div', `hn-popover ${cls}`, root);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', this.onDoc, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  /** Position below the anchor ('center' = centred on it), kept inside the root. */
  place(align: 'left' | 'right' | 'center' = 'center'): void {
    const r = this.anchor.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    const top = r.bottom - rr.top + 8;
    this.el.style.top = `${top}px`;
    this.el.style.maxHeight = `${Math.max(180, rr.height - top - 12)}px`;
    const w = Math.min(this.el.offsetWidth || 300, rr.width - 16);
    let left = align === 'left' ? r.left - rr.left : align === 'right' ? r.right - rr.left - w : r.left - rr.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, rr.width - w - 8));
    this.el.style.left = `${left}px`;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener('pointerdown', this.onDoc, true);
    document.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.onClose();
  }
}

// ------------------------------------------------------------------------------------------------
// Small building blocks
// ------------------------------------------------------------------------------------------------

function title(parent: HTMLElement, text: string): void {
  el('div', 'hn-pop-title', parent, text);
}

function section(parent: HTMLElement, text?: string): HTMLElement {
  const s = el('div', 'hn-section', parent);
  if (text) el('div', 'hn-section-title', s, text);
  return s;
}

function chips<T extends string>(parent: HTMLElement, items: [T, string][], active: T, onPick: (v: T) => void, disabled = false): HTMLElement {
  const row = el('div', 'hn-chips', parent);
  for (const [v, label] of items) {
    const b = el('button', 'hn-chip', row, label);
    b.type = 'button';
    b.dataset.value = v;
    b.disabled = disabled;
    b.classList.toggle('is-active', v === active);
    onTap(b, () => {
      onPick(v);
      for (const c of Array.from(row.children)) c.classList.remove('is-active');
      b.classList.add('is-active');
    });
  }
  return row;
}

function toggleRow(parent: HTMLElement, icon: string | null, label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el('label', 'hn-row hn-toggle-row', parent);
  if (icon) setHnIcon(el('span', 'hn-row-icon', row), icon);
  el('span', 'hn-row-label', row, label);
  const cb = el('input', 'hn-switch', row);
  cb.type = 'checkbox';
  cb.checked = value;
  cb.addEventListener('change', () => onChange(cb.checked));
  return row;
}

/** Compact step slider row (0 / 25 / 50 / 75 / 100 % stops, value at the right). */
function slider(parent: HTMLElement, label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void, fmt = (v: number) => String(v)): HTMLElement {
  const row = el('div', 'hn-row hn-slider-row', parent);
  return stepSlider(row, { label, value, min, max, step, format: fmt, onInput }).el;
}

function actionButton(parent: HTMLElement, label: string, run: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', `hn-action ${cls}`.trim(), parent, label);
  b.type = 'button';
  onTap(b, () => run());
  return b;
}

/** A menu row with an icon (GoodNotes "More" style). */
function listRow(parent: HTMLElement, icon: string, label: string, run: () => void, opts: { danger?: boolean; disabled?: boolean; chevron?: boolean } = {}): HTMLButtonElement {
  const b = el('button', 'hn-list-row' + (opts.danger ? ' is-danger' : ''), parent);
  b.type = 'button';
  b.disabled = !!opts.disabled;
  setHnIcon(el('span', 'hn-row-icon', b), icon);
  el('span', 'hn-row-label', b, label);
  if (opts.chevron) setHnIcon(el('span', 'hn-row-chev', b), 'chevron-right');
  onTap(b, () => run());
  return b;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fmt2 = (v: number) => v.toFixed(2);

// ------------------------------------------------------------------------------------------------
// Pen settings (GoodNotes style): preview + three sliders; technical settings under "Advanced".
// ------------------------------------------------------------------------------------------------

export interface PenPanelModel {
  tool: InkTool;
  title: string;
  color: string;
  params: PenParams;
  /** Engine used for new strokes of this tool (2 = standard, 1 = v0.1 original). */
  engine: number;
  /** Fountain only: A/B engine switch. */
  variant: FountainVariant | null;
  /** Pencil pressure range measured by the diagnostics: median and p99 (null = no data). */
  measured: { typical: number; heavy: number } | null;
  onParams(p: PenParams): void;
  onVariant(v: FountainVariant): void;
  onReset(): void;
}

/** Draw a sample S-stroke with a light → heavy → light pressure sweep using the real pen. */
export function drawPenPreview(canvas: HTMLCanvasElement, tool: InkTool, params: PenParams, color: string, engine: number): void {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 260;
  const H = canvas.clientHeight || 64;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const zoom = 2;
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
  const b = new StrokeBuilder(tool, params, { zoom, hasPressure: true, engine });
  const typ = params.typicalPressure ?? 0.3;
  const heavy = params.heavyPressure ?? 0.6;
  const w = W / zoom;
  const h = H / zoom;
  const n = 90;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const x = w * (0.08 + 0.84 * u);
    const y = h * 0.5 + Math.sin(u * Math.PI * 2) * h * 0.24;
    const p = u < 0.5 ? 0.01 + (heavy - 0.01) * (u / 0.5) : heavy - (heavy - typ * 0.4) * ((u - 0.5) / 0.5);
    b.add({ x, y, p, t: i * 6 });
  }
  const g = b.finalize();
  ctx.fillStyle = tool === 'pencil' ? pencilFill(ctx, color) : color;
  ctx.globalAlpha = params.opacity;
  ctx.beginPath();
  emitStroke(new CanvasPathSink(ctx), g.xs, g.ys, g.rs, 0, g.dot);
  ctx.fill('nonzero');
}

export function renderPenPanel(host: HTMLElement, m: PenPanelModel): void {
  host.textContent = '';
  title(host, m.title);
  const pv = el('canvas', 'hn-pen-preview', host);
  let p = { ...m.params };
  const redraw = () => drawPenPreview(pv, m.tool, p, m.color, m.engine);
  window.requestAnimationFrame(redraw);
  const set = (k: keyof PenParams, v: number) => {
    p = { ...p, [k]: v };
    m.onParams(p);
    redraw();
  };
  const hl = m.tool === 'highlighter';
  const main = section(host);
  main.classList.add('hn-card');
  if (!hl) {
    slider(main, t('tipSharpness'), p.tapering, 0, 1, 0.05, (v) => set('tapering', v), pct);
    slider(main, t('pressureSensitivity'), p.pressureSensitivity, 0, 1, 0.05, (v) => set('pressureSensitivity', v), pct);
  } else {
    slider(main, t('opacity'), p.opacity, 0.1, 0.8, 0.05, (v) => set('opacity', v), pct);
  }
  slider(main, t('stabilization'), p.smoothing, 0, 1, 0.05, (v) => set('smoothing', v), pct);

  if (hl) return;
  const adv = el('details', 'hn-advanced', host);
  el('summary', 'hn-section-title', adv, t('advanced'));
  if (m.variant) {
    const s = section(adv, t('engine'));
    chips<FountainVariant>(
      s,
      [
        ['experimental', t('engineB')],
        ['baseline', t('engineA')],
      ],
      m.variant,
      (v) => m.onVariant(v),
    );
  }
  if (m.engine === 2) {
    const cal = el('div', 'hn-row hn-cal-row', adv);
    const ms = m.measured;
    const btn = actionButton(cal, ms ? `${t('calibrate')} (${ms.typical.toFixed(2)} / ${ms.heavy.toFixed(2)})` : t('calibrate'), () => {
      if (!ms) return;
      const c = calibration(ms.typical, ms.heavy);
      p = { ...p, typicalPressure: c.typical, heavyPressure: c.heavy };
      m.onParams(p);
      renderPenPanel(host, { ...m, params: p });
    });
    btn.classList.add('hn-calibrate');
    btn.disabled = !ms;
    if (!ms) el('div', 'hn-row-hint', cal, t('calibrateHint'));
    const cr = el('div', 'hn-row hn-select-row', adv);
    el('span', 'hn-row-label', cr, t('pressureCurve'));
    const sel = el('select', 'hn-select dropdown', cr);
    ['Gamma', 'Linear', 'Smoothstep', 'Soft knee', 'Natural'].forEach((name, i) => {
      const o = el('option', '', sel, name);
      o.value = String(i);
    });
    sel.value = String(p.pressureCurve ?? 4);
    sel.addEventListener('change', () => set('pressureCurve', Number(sel.value)));
    slider(adv, t('minWidth'), p.minWidthRatio ?? 0.15, 0.05, 1, 0.05, (v) => set('minWidthRatio', v), pct);
    slider(adv, t('maxWidth'), p.maxWidthRatio ?? 2, 1, 4, 0.1, (v) => set('maxWidthRatio', v), pct);
    slider(adv, t('typicalPressure'), p.typicalPressure ?? 0.1, 0.03, 0.8, 0.01, (v) => set('typicalPressure', v), fmt2);
    slider(adv, t('heavyPressure'), p.heavyPressure ?? 0.85, 0.15, 1, 0.01, (v) => set('heavyPressure', v), fmt2);
    slider(adv, t('pressureSmoothing'), p.pressureSmoothing ?? 0.85, 0, 1, 0.05, (v) => set('pressureSmoothing', v), pct);
  }
  if (m.tool === 'fountain') {
    slider(adv, t('inkFlow'), p.velocityThinning, 0, 1, 0.05, (v) => set('velocityThinning', v), pct);
    slider(adv, t('nibFlatness'), p.nibFlatness, 0, 0.6, 0.02, (v) => set('nibFlatness', v), pct);
  }
  slider(adv, t('opacity'), p.opacity, 0.1, 1, 0.05, (v) => set('opacity', v), pct);
  const foot = el('div', 'hn-row', adv);
  actionButton(foot, t('resetPen'), () => m.onReset(), 'is-danger');
}

// ------------------------------------------------------------------------------------------------
// Width slider (GoodNotes "stroke settings"): tapered track, value in mm
// ------------------------------------------------------------------------------------------------

/** Slider position (0..1) ↔ width in mm; more resolution at the thin end. */
export function sliderToMm(s: number, range: [number, number]): number {
  return range[0] + (range[1] - range[0]) * Math.pow(Math.min(1, Math.max(0, s)), 1.5);
}

export function mmToSlider(mm: number, range: [number, number]): number {
  const u = (mm - range[0]) / (range[1] - range[0]);
  return Math.pow(Math.min(1, Math.max(0, u)), 1 / 1.5);
}

export interface StrokePanelModel {
  /** Current line style (null = hide the style row, e.g. highlighter). */
  dash: StrokeDash | null;
  width: number;
  range: [number, number];
  color: string;
  onDash(d: StrokeDash): void;
  onChange: (width: number) => void;
}

/** Line-style tiles: solid / dashed / dotted, each drawn as a sample line. */
function dashTiles(host: HTMLElement, current: StrokeDash, onPick: (d: StrokeDash) => void): void {
  const row = el('div', 'hn-dash-tiles', host);
  const items: [StrokeDash, string][] = [
    ['solid', 'lineSolid'],
    ['dash', 'lineDash'],
    ['dot', 'lineDot'],
  ];
  for (const [d, label] of items) {
    const b = el('button', 'hn-dash-tile', row);
    b.type = 'button';
    b.dataset.dash = d;
    b.setAttribute('aria-label', t(label));
    el('span', `hn-dash-sample is-${d}`, b);
    el('span', 'hn-tile-label', b, t(label));
    b.classList.toggle('is-active', d === current);
    b.setAttribute('aria-pressed', String(d === current));
    onTap(b, () => {
      for (const c of Array.from(row.children)) {
        c.classList.remove('is-active');
        c.setAttribute('aria-pressed', 'false');
      }
      b.classList.add('is-active');
      b.setAttribute('aria-pressed', 'true');
      onPick(d);
    });
  }
}

/** GoodNotes "stroke settings": solid / dashed / dotted + a tapered width slider in mm. */
export function renderStrokePanel(host: HTMLElement, m: StrokePanelModel): void {
  host.textContent = '';
  title(host, t('strokeSettings'));
  if (m.dash) dashTiles(host, m.dash, (d) => m.onDash(d));
  const box = el('div', 'hn-card hn-width-card', host);
  const mmFmt = (mm: number) => `${mm.toFixed(1)} mm`;
  const lo = m.range[0];
  const hi = m.range[1];
  const stops = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(sliderToMm(p, m.range) * 10) / 10);
  stepSlider(box, {
    label: t('width'),
    value: Math.round((m.width / MM) * 10) / 10,
    min: lo,
    max: hi,
    step: 0.1,
    stops,
    toPos: (mm) => mmToSlider(mm, m.range),
    fromPos: (p) => sliderToMm(p, m.range),
    format: mmFmt,
    taper: true,
    onInput: (mm) => m.onChange((Math.round(mm * 10) / 10) * MM),
  });
}

/** Back-compat name used by older call sites/tests. */
export function renderWidthPanel(host: HTMLElement, m: { width: number; range: [number, number]; onChange(width: number): void }): void {
  renderStrokePanel(host, { dash: null, width: m.width, range: m.range, color: '#000', onDash: () => undefined, onChange: (w) => m.onChange(w) });
}

// ------------------------------------------------------------------------------------------------
// Shape / connector line style: dash, width, arrow heads
// ------------------------------------------------------------------------------------------------

export interface LineStyleModel {
  dash: StrokeDash;
  width: number;
  arrows: 'none' | 'end' | 'both' | null;
  head: ArrowHead | null;
  onDash(d: StrokeDash): void;
  onWidth(w: number): void;
  onArrows(a: 'none' | 'end' | 'both'): void;
  onHead(h: ArrowHead): void;
}

export function renderLineStylePanel(host: HTMLElement, m: LineStyleModel): void {
  host.textContent = '';
  title(host, t('lineStyle'));
  dashTiles(host, m.dash, (d) => m.onDash(d));
  const box = el('div', 'hn-card', host);
  stepSlider(box, {
    label: t('width'),
    value: m.width,
    min: 0.5,
    max: 8,
    step: 0.25,
    stops: [0.5, 1, 1.5, 2.5, 4, 8],
    toPos: (v) => Math.log(v / 0.5) / Math.log(16),
    fromPos: (p) => 0.5 * Math.pow(16, p),
    format: (v) => `${v.toFixed(v < 2 ? 2 : 1)} pt`,
    onInput: (v) => m.onWidth(v),
  });
  if (m.arrows) {
    const s = section(host, t('arrowHeads'));
    chips<'none' | 'end' | 'both'>(
      s,
      [
        ['none', t('arrowNone')],
        ['end', t('arrowEnd')],
        ['both', t('arrowBoth')],
      ],
      m.arrows,
      (v) => m.onArrows(v),
    );
  }
  if (m.head) {
    const s = section(host, t('arrowStyle'));
    chips<ArrowHead>(
      s,
      [
        ['open', t('headOpen')],
        ['filled', t('headFilled')],
      ],
      m.head,
      (v) => m.onHead(v),
    );
  }
}

// ------------------------------------------------------------------------------------------------
// Lasso: which content it selects
// ------------------------------------------------------------------------------------------------

export function renderLassoFilterPanel(host: HTMLElement, m: { filter: LassoFilter; onChange(f: LassoFilter): void }): void {
  host.textContent = '';
  title(host, t('lassoContent'));
  const card = el('div', 'hn-list hn-card', host);
  const f = { ...m.filter };
  const rows: [keyof LassoFilter, string, string][] = [
    ['ink', 'pen', 'lassoInk'],
    ['highlighter', 'highlighter', 'lassoHighlighter'],
    ['shapes', 'shapes', 'lassoShapes'],
    ['connectors', 'arrow', 'lassoConnectors'],
    ['text', 'text', 'lassoText'],
    ['images', 'image', 'lassoImages'],
  ];
  for (const [k, icon, label] of rows) {
    toggleRow(card, icon, t(label), f[k], (v) => {
      f[k] = v;
      m.onChange({ ...f });
    });
  }
}

// ------------------------------------------------------------------------------------------------
// Eraser type
// ------------------------------------------------------------------------------------------------

export function renderEraserPanel(host: HTMLElement, m: { mode: EraserMode; onPick(mode: EraserMode): void }): void {
  host.textContent = '';
  title(host, t('eraserType'));
  const tiles = el('div', 'hn-tiles', host);
  const hint = el('div', 'hn-row-hint hn-center', host);
  const items: [EraserMode, string, string][] = [
    ['precise', 'eraserPrecise', 'eraserPreciseHint'],
    ['standard', 'eraserStandard', 'eraserStandardHint'],
    ['stroke', 'eraserStroke', 'eraserStrokeHint'],
  ];
  for (const [mode, label, h] of items) {
    const b = el('button', 'hn-tile', tiles);
    b.type = 'button';
    b.dataset.mode = mode;
    setHnIcon(el('span', 'hn-tile-icon', b), 'eraser');
    el('span', 'hn-tile-label', b, t(label));
    b.classList.toggle('is-active', mode === m.mode);
    if (mode === m.mode) hint.textContent = t(h);
    onTap(b, () => {
      for (const c of Array.from(tiles.children)) c.classList.remove('is-active');
      b.classList.add('is-active');
      hint.textContent = t(h);
      m.onPick(mode);
    });
  }
}

// ------------------------------------------------------------------------------------------------
// Colour picker for shapes / text (palette + system picker; optional fill)
// ------------------------------------------------------------------------------------------------

export interface ColorPanelModel {
  palette: string[];
  current: string;
  onPick(c: string): void;
  onAdd(c: string): void;
  fill?: { on: boolean; opacity: number; onToggle(v: boolean): void; onOpacity(v: number): void };
}

export function renderColorPanel(host: HTMLElement, m: ColorPanelModel): void {
  host.textContent = '';
  title(host, t('color'));
  const grid = el('div', 'hn-color-grid', host);
  const paint = (current: string) => {
    grid.textContent = '';
    for (const c of m.palette) {
      colorSwatch(grid, c, c.toLowerCase() === current.toLowerCase(), () => {
        m.onPick(c);
        paint(c);
      });
    }
    const add = el('label', 'hn-swatch hn-swatch-add', grid);
    add.title = t('addColor');
    setHnIcon(add, 'plus');
    const input = el('input', 'hn-color-input', add);
    input.type = 'color';
    input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#1a1a1a';
    input.addEventListener('change', () => {
      m.onAdd(input.value);
      paint(input.value);
    });
  };
  paint(m.current);
  if (m.fill) {
    const f = m.fill;
    const s = section(host);
    s.classList.add('hn-card');
    toggleRow(s, 'fill', t('fill'), f.on, (v) => f.onToggle(v));
    slider(s, t('fillOpacity'), f.opacity, 0.05, 1, 0.05, (v) => f.onOpacity(v), pct);
  }
}

/** Simple vertical list picker (text size, font). */
export function renderListPicker<T>(host: HTMLElement, heading: string, items: { label: string; value: T; active: boolean }[], onPick: (v: T) => void): void {
  host.textContent = '';
  title(host, heading);
  const list = el('div', 'hn-list', host);
  for (const it of items) {
    const b = el('button', 'hn-list-row' + (it.active ? ' is-active' : ''), list);
    b.type = 'button';
    el('span', 'hn-row-label', b, it.label);
    if (it.active) setHnIcon(el('span', 'hn-row-chev', b), 'check');
    onTap(b, () => onPick(it.value));
  }
}

// ------------------------------------------------------------------------------------------------
// ⋯ menu (icons + short labels, settings below)
// ------------------------------------------------------------------------------------------------

export interface MoreMenuModel {
  inputMode: InputModeSetting;
  resolvedMode: InputMode;
  fingerDrawing: boolean;
  tapGestures: boolean;
  fingerDoubleTapEraser: boolean;
  usePrediction: boolean;
  diagnostics: boolean;
  hud: boolean;
  texture: boolean;
  canDeletePage: boolean;
  readOnly: boolean;
  actions: { label: string; run: () => void }[];
  onAddPage: () => void;
  onDeletePage: () => void;
  onClearPage(): void;
  pageEmpty: boolean;
  onTemplate(): void;
  onFitWidth: () => void;
  onFitPage: () => void;
  onTexture(v: boolean): void;
  onInputMode(m: InputModeSetting): void;
  onToggle(key: 'fingerDrawing' | 'tapGestures' | 'fingerDoubleTapEraser' | 'usePrediction' | 'diagnostics' | 'showHud', v: boolean): void;
  onCopyDiagnostics: () => void;
  onClearDiagnostics: () => void;
  close(): void;
}

export function renderMoreMenu(host: HTMLElement, m: MoreMenuModel): void {
  host.textContent = '';
  title(host, t('more'));
  const card = el('div', 'hn-list hn-card', host);
  const run = (fn: () => void) => () => {
    fn();
    m.close();
  };
  listRow(card, 'page-add', t('addPage'), run(m.onAddPage), { disabled: m.readOnly });
  listRow(card, 'template', t('changeTemplate'), () => m.onTemplate(), { disabled: m.readOnly, chevron: true });
  listRow(card, 'fit-width', t('fitWidth'), run(m.onFitWidth));
  listRow(card, 'fit-page', t('fitPage'), run(m.onFitPage));
  if (m.actions.length) {
    const ex = el('div', 'hn-list hn-card', host);
    for (const a of m.actions) listRow(ex, 'export', a.label, run(a.run));
  }
  const del = el('div', 'hn-list hn-card', host);
  // clear: two taps (the first one arms it for 3 s), undoable
  let armed = 0;
  const clearRow = listRow(
    del,
    'trash',
    t('clearPage'),
    () => {
      if (!armed) {
        clearRow.classList.add('is-armed');
        (clearRow.querySelector('.hn-row-label') as HTMLElement).textContent = t('clearPageConfirm');
        armed = window.setTimeout(() => {
          armed = 0;
          clearRow.classList.remove('is-armed');
          (clearRow.querySelector('.hn-row-label') as HTMLElement).textContent = t('clearPage');
        }, 3000);
        return;
      }
      window.clearTimeout(armed);
      m.onClearPage();
      m.close();
    },
    { danger: true, disabled: m.pageEmpty || m.readOnly },
  );
  clearRow.classList.add('hn-clear-page');
  listRow(del, 'page-remove', t('deletePage'), run(m.onDeletePage), { danger: true, disabled: !m.canDeletePage || m.readOnly });

  el('div', 'hn-section-title', host, t('settingsSection'));
  const st = el('div', 'hn-list hn-card', host);
  const im = el('div', 'hn-row hn-input-row', st);
  setHnIcon(el('span', 'hn-row-icon', im), 'tablet');
  el('span', 'hn-row-label', im, t('inputMode'));
  chips<InputModeSetting>(
    im,
    [
      ['auto', `${t('inputAuto')} (${m.resolvedMode === 'pen' ? t('inputPen') : t('inputMouse')})`],
      ['pen', t('inputPen')],
      ['mouse', t('inputMouse')],
    ],
    m.inputMode,
    (v) => m.onInputMode(v),
  );
  toggleRow(st, 'finger', t('fingerDrawing'), m.fingerDrawing, (v) => m.onToggle('fingerDrawing', v));
  toggleRow(st, 'tap', t('tapGestures'), m.tapGestures, (v) => m.onToggle('tapGestures', v));
  toggleRow(st, 'eraser', t('fingerDoubleTap'), m.fingerDoubleTapEraser, (v) => m.onToggle('fingerDoubleTapEraser', v));
  toggleRow(st, 'spark', t('predictedInk'), m.usePrediction, (v) => m.onToggle('usePrediction', v));
  toggleRow(st, 'grain', t('paperGrain'), m.texture, (v) => m.onTexture(v));
  const dg = el('div', 'hn-list hn-card', host);
  toggleRow(dg, 'pulse', t('diagnostics'), m.diagnostics, (v) => m.onToggle('diagnostics', v));
  listRow(dg, 'copy', t('copyDiagnostics'), run(m.onCopyDiagnostics));
  listRow(dg, 'trash', t('clearDiagnostics'), run(m.onClearDiagnostics));
  toggleRow(dg, 'info', t('perfOverlay'), m.hud, (v) => m.onToggle('showHud', v));
}

// ------------------------------------------------------------------------------------------------
// Change template: size + orientation, paper colour, pattern; this page / all pages
// ------------------------------------------------------------------------------------------------

export interface TemplateChoice {
  sizeId: string;
  landscape: boolean;
  tone: PaperTone;
  kind: BackgroundKind;
  scope: 'page' | 'all';
}

export function renderTemplatePanel(host: HTMLElement, m: { initial: TemplateChoice; onApply(c: TemplateChoice): void; onCancel(): void }): void {
  host.textContent = '';
  const c: TemplateChoice = { ...m.initial };
  title(host, t('changeTemplate'));
  const thumbs: { canvas: HTMLCanvasElement; kind: BackgroundKind; btn: HTMLButtonElement }[] = [];
  const drawThumbs = () => {
    const tone = PAPER_TONES[c.tone];
    for (const th of thumbs) {
      const cv = th.canvas;
      const w = c.landscape ? 72 : 52;
      const h = c.landscape ? 52 : 72;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) continue;
      const pw = c.landscape ? 842 : 595;
      const k = (w * dpr) / pw;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.fillStyle = tone.paper;
      ctx.fillRect(0, 0, pw, c.landscape ? 595 : 842);
      drawThumbPattern(ctx, th.kind, pw, c.landscape ? 595 : 842, darken(tone.line), k);
      th.btn.classList.toggle('is-active', th.kind === c.kind);
    }
  };
  const s1 = section(host, t('pageSize'));
  chips(s1, PAGE_SIZES.map((p) => [p.id, p.label] as [string, string]), c.sizeId, (v) => (c.sizeId = v));
  chips<'p' | 'l'>(
    s1,
    [
      ['p', t('portrait')],
      ['l', t('landscape')],
    ],
    c.landscape ? 'l' : 'p',
    (v) => {
      c.landscape = v === 'l';
      drawThumbs();
    },
  );
  const s2 = section(host, t('paperColor'));
  chips<PaperTone>(
    s2,
    [
      ['white', t('white')],
      ['cream', t('cream')],
      ['yellow', t('yellow')],
    ],
    c.tone,
    (v) => {
      c.tone = v;
      drawThumbs();
    },
  );
  const s3 = section(host, t('template'));
  const row = el('div', 'hn-thumbs', s3);
  for (const kind of ['blank', 'ruled', 'grid', 'dots'] as BackgroundKind[]) {
    const b = el('button', 'hn-thumb', row);
    b.type = 'button';
    b.dataset.kind = kind;
    const cv = el('canvas', 'hn-thumb-canvas', b);
    el('span', 'hn-thumb-label', b, t(kind));
    onTap(b, () => {
      c.kind = kind;
      drawThumbs();
    });
    thumbs.push({ canvas: cv, kind, btn: b });
  }
  const s4 = section(host, t('applyTo'));
  chips<'page' | 'all'>(
    s4,
    [
      ['page', t('thisPage')],
      ['all', t('allPages')],
    ],
    c.scope,
    (v) => (c.scope = v),
  );
  const foot = el('div', 'hn-row hn-foot', host);
  actionButton(foot, t('cancel'), () => m.onCancel());
  actionButton(foot, t('apply'), () => m.onApply(c), 'is-primary hn-apply');
  window.requestAnimationFrame(drawThumbs);
}

/** Template preview: the real spacing, but lines drawn ~1 device px so they stay visible. */
function drawThumbPattern(ctx: CanvasRenderingContext2D, kind: BackgroundKind, w: number, h: number, color: string, k: number): void {
  if (kind === 'blank') return;
  const sp = kind === 'ruled' ? 24 : 14.17 * 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1 / k;
  ctx.beginPath();
  if (kind === 'ruled') {
    for (let y = sp * 3; y < h - sp * 0.5; y += sp) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  } else if (kind === 'grid') {
    for (let y = sp; y < h; y += sp) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    for (let x = sp; x < w; x += sp) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
  } else {
    const r = 1.1 / k;
    for (let y = sp; y < h; y += sp)
      for (let x = sp; x < w; x += sp) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    ctx.fill();
  }
  ctx.restore();
}

function darken(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const f = (v: string) => Math.max(0, Math.round(parseInt(v, 16) * 0.8)).toString(16).padStart(2, '0');
  return `#${f(m[1])}${f(m[2])}${f(m[3])}`;
}

/** Small confirm bubble (e.g. remove a palette colour). */
export function renderConfirm(host: HTMLElement, label: string, run: () => void): void {
  host.textContent = '';
  actionButton(host, label, run, 'is-danger');
}
