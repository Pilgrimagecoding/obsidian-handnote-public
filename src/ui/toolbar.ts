import type { InkTool, Tool } from '../ink/types';
import { isInkTool } from '../ink/types';
import type { InputMode } from '../input/input-mode';
import { LASER_HOLD_CHOICES, type EraserMode, type LassoSettings, type LaserSettings, type ShapeSettings, type StrokeDash, type TextSettings } from '../editor/settings';
import type { ShapeKind } from '../document/items';
import { el } from './dom';
import { setHnIcon } from './icons';
import { t } from './i18n';
import { onTap } from './tap';

/** Top-level tool groups of the main toolbar. */
export type ToolGroup = 'lasso' | 'pen' | 'eraser' | 'text' | 'image' | 'shape' | 'laser';

export function groupOf(tool: Tool): ToolGroup {
  if (isInkTool(tool)) return 'pen';
  return tool;
}

export type PenKind = 'fountain' | 'pencil' | 'highlighter' | 'shapepen';

export interface ToolbarActions {
  onGroup(g: ToolGroup, anchor: HTMLElement): void;
  onPages(anchor: HTMLElement): void;
  onUndo(): void;
  onRedo(): void;
  onPrev(): void;
  onNext(): void;
  onMore(anchor: HTMLElement): void;
  // pen sub-bar
  onPenKind(k: PenKind, anchor: HTMLElement): void;
  onStrokeStyle(anchor: HTMLElement): void;
  onWidthPreset(i: number, anchor: HTMLElement): void;
  onColor(c: string): void;
  onAddColor(c: string): void;
  onRemoveColor(c: string, anchor: HTMLElement): void;
  // eraser sub-bar
  onEraserType(anchor: HTMLElement): void;
  onEraserSize(i: number): void;
  onHighlighterOnly(v: boolean): void;
  // lasso / laser sub-bars
  onLassoMode(m: LassoSettings['mode']): void;
  onLassoFilter(anchor: HTMLElement): void;
  onLaserMode(m: LaserSettings['mode']): void;
  onLaserColor(c: string): void;
  onLaserHold(ms: number): void;
  // image sub-bar
  onInsertImage(): void;
  // shape sub-bar
  onShapeKind(k: ShapeKind): void;
  onShapeStyle(anchor: HTMLElement): void;
  onShapeColor(anchor: HTMLElement): void;
  // text sub-bar
  onTextColor(anchor: HTMLElement): void;
  onTextSize(anchor: HTMLElement): void;
  onTextFont(anchor: HTMLElement): void;
  onTextToggle(key: 'bold' | 'italic'): void;
  onTextAlign(): void;
}

export interface ToolbarState {
  tool: Tool;
  drawShape: boolean;
  subbarOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  page: number;
  pageCount: number;
  readOnly: boolean;
  penColor: string;
  palette: string[];
  widthPresets: number[];
  width: number;
  penDash: StrokeDash;
  eraserMode: EraserMode;
  eraserSize: number;
  highlighterOnly: boolean;
  shape: ShapeSettings;
  text: TextSettings;
  lasso: LassoSettings;
  laser: LaserSettings;
}

const GROUPS: { g: ToolGroup; icon: string; label: string }[] = [
  { g: 'lasso', icon: 'lasso', label: 'lasso' },
  { g: 'pen', icon: 'pen', label: 'pen' },
  { g: 'eraser', icon: 'eraser', label: 'eraser' },
  { g: 'text', icon: 'text', label: 'text' },
  { g: 'image', icon: 'image', label: 'image' },
  { g: 'shape', icon: 'shapes', label: 'shapes' },
  { g: 'laser', icon: 'laser', label: 'laser' },
];

const MM = 72 / 25.4;
export const LASER_COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00'];

/** A toolbar button (shared look and states: selected, hover, pressed, disabled). */
export function toolButton(parent: HTMLElement, icon: string, label: string, cls: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el('button', `hn-btn ${cls}`.trim(), parent);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  setHnIcon(b, icon);
  onTap(b, () => onClick(b));
  return b;
}

/** A plain control (label / custom content) with the same tap handling. */
function control(parent: HTMLElement, cls: string, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el('button', `hn-btn ${cls}`.trim(), parent);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  onTap(b, () => onClick(b));
  return b;
}

function setSelected(b: HTMLElement, on: boolean): void {
  b.classList.toggle('is-active', on);
  b.setAttribute('aria-pressed', String(on));
}

/** A colour circle; the selected one gets a ring and a check mark (not only a colour change). */
export function colorSwatch(parent: HTMLElement, color: string, selected: boolean, onPick: () => void, onLong?: (b: HTMLElement) => void): HTMLButtonElement {
  const b = el('button', 'hn-swatch', parent);
  b.type = 'button';
  b.style.setProperty('--sw', color);
  b.dataset.color = color;
  b.title = color;
  b.setAttribute('aria-label', `${t('color')} ${color}`);
  setSelected(b, selected);
  const mark = el('span', 'hn-swatch-mark', b);
  mark.classList.toggle('is-dark', luminance(color) > 0.6);
  onTap(b, () => onPick(), onLong ? { onLongPress: () => onLong(b) } : {});
  return b;
}

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * GoodNotes-style two-tier toolbar.
 *  - Top bar: undo/redo · pages | lasso / pen / eraser / text / image / shapes / laser · page nav, ⋯
 *  - Sub-bar: options of the selected tool in a floating pill below the top bar. Tapping the
 *    selected tool again hides / shows it.
 */
export class Toolbar {
  readonly el: HTMLElement;
  readonly sub: HTMLElement;
  private groupBtns = new Map<ToolGroup, HTMLButtonElement>();
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private pagesBtn: HTMLButtonElement;
  private pageLabel: HTMLElement;
  private statusEl: HTMLElement;
  private subKey = '';
  private mode: InputMode = 'pen';

  constructor(parent: HTMLElement, private readonly a: ToolbarActions) {
    this.el = el('div', 'hn-toolbar', parent);
    this.el.setAttribute('role', 'toolbar');
    const left = el('div', 'hn-group hn-left', this.el);
    this.undoBtn = toolButton(left, 'undo', t('undo'), 'hn-undo', () => a.onUndo());
    this.redoBtn = toolButton(left, 'redo', t('redo'), 'hn-redo', () => a.onRedo());
    const center = el('div', 'hn-group hn-tools', this.el);
    this.pagesBtn = toolButton(center, 'pages', t('pages'), 'hn-pages-btn', (b) => a.onPages(b));
    el('span', 'hn-tools-sep', center);
    for (const { g, icon, label } of GROUPS) {
      const b = toolButton(center, icon, t(label), 'hn-tool', (btn) => a.onGroup(g, btn));
      b.dataset.group = g;
      this.groupBtns.set(g, b);
    }
    const right = el('div', 'hn-group hn-right', this.el);
    this.prevBtn = toolButton(right, 'chevron-up', t('prevPage'), 'hn-prev', () => a.onPrev());
    this.pageLabel = el('span', 'hn-page-label', right, '1/1');
    this.nextBtn = toolButton(right, 'chevron-down', t('nextPage'), 'hn-next', () => a.onNext());
    this.statusEl = el('span', 'hn-status', right);
    this.statusEl.dataset.status = 'saved';
    toolButton(right, 'more', t('more'), 'hn-more-btn', (b) => a.onMore(b));
    this.sub = el('div', 'hn-subbar', parent);
    this.sub.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  setMode(mode: InputMode): void {
    this.mode = mode;
    this.el.classList.toggle('is-mouse', mode === 'mouse');
    this.sub.classList.toggle('is-mouse', mode === 'mouse');
    const keys: Partial<Record<ToolGroup, string>> = { lasso: 'L', pen: '1', eraser: 'E', text: 'T' };
    for (const [g, b] of this.groupBtns) {
      const base = t(GROUPS.find((x) => x.g === g)?.label ?? g);
      b.title = mode === 'mouse' && keys[g] ? `${base} (${keys[g]})` : base;
    }
  }

  /** The pages button shows the navigator's open state. */
  setPagesOpen(open: boolean): void {
    setSelected(this.pagesBtn, open);
  }

  setStatus(status: 'saved' | 'dirty' | 'saving' | 'error' | 'readonly'): void {
    this.statusEl.dataset.status = status;
    this.statusEl.title = status;
  }

  update(s: ToolbarState): void {
    const g = groupOf(s.tool);
    for (const [k, b] of this.groupBtns) {
      setSelected(b, k === g);
      b.disabled = s.readOnly && k !== 'pen' && k !== 'laser' && k !== 'lasso';
    }
    this.undoBtn.disabled = !s.canUndo || s.readOnly;
    this.redoBtn.disabled = !s.canRedo || s.readOnly;
    this.prevBtn.disabled = s.page <= 0;
    this.nextBtn.disabled = s.page >= s.pageCount - 1;
    this.pageLabel.textContent = `${s.page + 1}/${s.pageCount}`;
    void this.pagesBtn;
    const show = s.subbarOpen && !s.readOnly;
    this.sub.classList.toggle('is-hidden', !show);
    const key = JSON.stringify([g, s.tool, s.drawShape, s.penColor, s.palette, s.widthPresets, s.width, s.penDash, s.eraserMode, s.eraserSize, s.highlighterOnly, s.shape, s.text, s.lasso, s.laser, show, this.mode]);
    if (key !== this.subKey) {
      this.subKey = key;
      this.renderSub(s, g);
    }
  }

  // ---------------------------------------------------------------------------------------------

  private renderSub(s: ToolbarState, g: ToolGroup): void {
    const sub = this.sub;
    sub.textContent = '';
    sub.dataset.group = g;
    if (g === 'pen') this.penSub(s);
    else if (g === 'eraser') this.eraserSub(s);
    else if (g === 'text') this.textSub(s);
    else if (g === 'image') this.imageSub();
    else if (g === 'lasso') this.lassoSub(s);
    else if (g === 'laser') this.laserSub(s);
    else this.shapeSub(s);
  }

  private sep(): void {
    el('span', 'hn-sep', this.sub);
  }

  private penSub(s: ToolbarState): void {
    const a = this.a;
    const kinds = el('div', 'hn-sub-group', this.sub);
    const current: PenKind = s.drawShape ? 'shapepen' : ((s.tool === 'ballpoint' ? 'fountain' : s.tool) as PenKind);
    for (const k of ['fountain', 'pencil', 'highlighter', 'shapepen'] as PenKind[]) {
      const b = toolButton(kinds, k, t(k), 'hn-pen-kind', (btn) => a.onPenKind(k, btn));
      b.dataset.kind = k;
      setSelected(b, k === current);
    }
    this.sep();
    // line-style chip: a sample of the current style + chevron (opens "stroke settings")
    const style = control(this.sub, 'hn-stroke-style', t('strokeSettings'), (b) => a.onStrokeStyle(b));
    style.dataset.dash = s.penDash;
    el('span', `hn-dash-sample is-${s.penDash}`, style);
    setHnIcon(el('span', 'hn-ic hn-chev', style), 'chevron-down');
    const widths = el('div', 'hn-sub-group hn-widths', this.sub);
    s.widthPresets.forEach((w, i) => {
      const mm = w / MM;
      const b = control(widths, 'hn-width', `${t('width')} ${mm.toFixed(1)} mm`, (btn) => a.onWidthPreset(i, btn));
      b.dataset.index = String(i);
      const bar = el('span', 'hn-width-bar', b);
      const isHl = s.tool === 'highlighter';
      const px = isHl ? 3 + i * 2.5 : Math.min(7, Math.max(1.2, 1.2 + i * 2 + mm * 1.2));
      bar.style.height = `${px}px`;
      setSelected(b, Math.abs(w - s.width) < 0.01);
    });
    this.sep();
    this.colorStrip(s.palette, s.penColor, (c) => a.onColor(c));
  }

  /** Horizontally scrollable colour circles with a trailing "+" (native colour picker). */
  private colorStrip(palette: string[], current: string, onPick: (c: string) => void): void {
    const strip = el('div', 'hn-colors', this.sub);
    for (const c of palette) {
      colorSwatch(strip, c, c.toLowerCase() === current.toLowerCase(), () => onPick(c), (b) => this.a.onRemoveColor(c, b));
    }
    // "+" opens the system colour picker (grid / spectrum / sliders on iPad)
    const add = el('label', 'hn-swatch hn-swatch-add', strip);
    add.title = t('addColor');
    add.setAttribute('aria-label', t('addColor'));
    setHnIcon(add, 'plus');
    const input = el('input', 'hn-color-input', add);
    input.type = 'color';
    input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#1a1a1a';
    input.addEventListener('change', () => this.a.onAddColor(input.value));
    // keep the active colour visible by scrolling only the strip itself (scrollIntoView would also
    // scroll Obsidian's / HandNote's overflow:hidden containers on iOS and shift the page)
    window.requestAnimationFrame(() => {
      const act = strip.querySelector<HTMLElement>('.is-active');
      if (!act) return;
      if (act.offsetLeft < strip.scrollLeft) strip.scrollLeft = act.offsetLeft - 6;
      else if (act.offsetLeft + act.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = act.offsetLeft + act.offsetWidth - strip.clientWidth + 6;
    });
  }

  private eraserSub(s: ToolbarState): void {
    const a = this.a;
    const label = s.eraserMode === 'precise' ? 'eraserPrecise' : s.eraserMode === 'stroke' ? 'eraserStroke' : 'eraserStandard';
    const typeBtn = control(this.sub, 'hn-eraser-type', t(label), (b) => a.onEraserType(b));
    setHnIcon(el('span', 'hn-ic', typeBtn), 'eraser');
    el('span', 'hn-btn-label', typeBtn, t(label));
    setHnIcon(el('span', 'hn-ic hn-chev', typeBtn), 'chevron-down');
    this.sep();
    const sizes = el('div', 'hn-sub-group hn-eraser-sizes', this.sub);
    [0, 1, 2].forEach((i) => {
      const b = control(sizes, 'hn-size', `${t('eraserSize')} ${i + 1}`, () => a.onEraserSize(i));
      b.dataset.index = String(i);
      const dot = el('span', 'hn-size-dot', b);
      const d = [8, 13, 19][i];
      dot.style.width = dot.style.height = `${d}px`;
      setSelected(b, i === s.eraserSize);
    });
    this.sep();
    const hl = toolButton(this.sub, 'highlighter', t('highlighterOnly'), 'hn-hl-only', () => a.onHighlighterOnly(!s.highlighterOnly));
    setSelected(hl, s.highlighterOnly);
  }

  private lassoSub(s: ToolbarState): void {
    const a = this.a;
    const modes = el('div', 'hn-sub-group', this.sub);
    for (const [m, icon, label] of [
      ['free', 'lasso', 'lassoFree'],
      ['rect', 'lasso-rect', 'lassoRect'],
    ] as const) {
      const b = toolButton(modes, icon, t(label), 'hn-lasso-mode', () => a.onLassoMode(m));
      b.dataset.mode = m;
      setSelected(b, s.lasso.mode === m);
    }
    this.sep();
    const f = control(this.sub, 'hn-lasso-filter', t('lassoContent'), (b) => a.onLassoFilter(b));
    setHnIcon(el('span', 'hn-ic', f), 'sliders');
    el('span', 'hn-btn-label', f, t('lassoContent'));
  }

  private laserSub(s: ToolbarState): void {
    const a = this.a;
    const modes = el('div', 'hn-sub-group', this.sub);
    for (const [m, icon, label] of [
      ['dot', 'laser-dot', 'laserDot'],
      ['trail', 'laser-trail', 'laserTrail'],
    ] as const) {
      const b = toolButton(modes, icon, t(label), 'hn-laser-mode', () => a.onLaserMode(m));
      b.dataset.mode = m;
      setSelected(b, s.laser.mode === m);
    }
    this.sep();
    const strip = el('div', 'hn-colors', this.sub);
    for (const c of LASER_COLORS) colorSwatch(strip, c, s.laser.color === c, () => a.onLaserColor(c));
    if (s.laser.mode === 'trail') {
      this.sep();
      // how long the trail stays after the last movement: 1 s / 2 s / 5 s (tap to cycle)
      const i = LASER_HOLD_CHOICES.indexOf(s.laser.holdMs);
      const next = LASER_HOLD_CHOICES[(i + 1) % LASER_HOLD_CHOICES.length];
      const hold = control(this.sub, 'hn-laser-hold', t('laserHold'), () => a.onLaserHold(next));
      setHnIcon(el('span', 'hn-ic', hold), 'laser-trail');
      el('span', 'hn-btn-label', hold, `${(s.laser.holdMs / 1000).toFixed(s.laser.holdMs % 1000 ? 1 : 0)} s`);
    }
  }

  private imageSub(): void {
    const b = control(this.sub, 'hn-insert-image', t('insertImage'), () => this.a.onInsertImage());
    setHnIcon(el('span', 'hn-ic', b), 'image');
    el('span', 'hn-btn-label', b, t('insertImage'));
  }

  private shapeSub(s: ToolbarState): void {
    const a = this.a;
    const groups: ShapeKind[][] = [
      ['line', 'arrow', 'curve', 'elbow'],
      ['rect', 'ellipse', 'triangle', 'diamond', 'roundrect'],
    ];
    const labels: Record<string, string> = {
      line: 'shapeLine',
      arrow: 'shapeArrow',
      curve: 'shapeCurve',
      elbow: 'shapeElbow',
      rect: 'shapeRect',
      ellipse: 'shapeEllipse',
      triangle: 'shapeTriangle',
      diamond: 'shapeDiamond',
      roundrect: 'shapeRoundrect',
    };
    groups.forEach((grp, gi) => {
      if (gi) this.sep();
      const g = el('div', 'hn-sub-group', this.sub);
      for (const k of grp) {
        const b = toolButton(g, k, t(labels[k]), 'hn-shape-kind', () => a.onShapeKind(k));
        b.dataset.kind = k;
        setSelected(b, s.shape.kind === k);
      }
    });
    this.sep();
    const st = control(this.sub, 'hn-shape-style hn-stroke-style', t('lineStyle'), (b) => a.onShapeStyle(b));
    st.dataset.dash = s.shape.dash;
    el('span', `hn-dash-sample is-${s.shape.dash}`, st);
    setHnIcon(el('span', 'hn-ic hn-chev', st), 'chevron-down');
    const cb = control(this.sub, 'hn-color-btn', t('color'), (b) => a.onShapeColor(b));
    const dot = el('span', 'hn-color-dot', cb);
    dot.style.setProperty('--sw', s.shape.color);
    dot.classList.toggle('is-filled', s.shape.fill);
  }

  private textSub(s: ToolbarState): void {
    const a = this.a;
    const cb = control(this.sub, 'hn-color-btn', t('color'), (b) => a.onTextColor(b));
    const dot = el('span', 'hn-color-dot is-solid', cb);
    dot.style.setProperty('--sw', s.text.color);
    const size = control(this.sub, 'hn-text-size', t('textSize'), (b) => a.onTextSize(b));
    el('span', 'hn-btn-label', size, String(s.text.size));
    setHnIcon(el('span', 'hn-ic hn-chev', size), 'chevron-down');
    const fontLabel = t(s.text.font === 'serif' ? 'fontSerif' : s.text.font === 'mono' ? 'fontMono' : s.text.font === 'hand' ? 'fontHand' : 'fontSans');
    const font = control(this.sub, 'hn-text-font', t('font'), (b) => a.onTextFont(b));
    el('span', 'hn-btn-label', font, fontLabel);
    setHnIcon(el('span', 'hn-ic hn-chev', font), 'chevron-down');
    this.sep();
    const bold = toolButton(this.sub, 'bold', t('bold'), 'hn-text-bold', () => a.onTextToggle('bold'));
    setSelected(bold, s.text.bold);
    const it = toolButton(this.sub, 'italic', t('italic'), 'hn-text-italic', () => a.onTextToggle('italic'));
    setSelected(it, s.text.italic);
    toolButton(this.sub, `align-${s.text.align}`, t('align'), 'hn-text-align', () => a.onTextAlign());
  }

  destroy(): void {
    this.el.remove();
    this.sub.remove();
  }
}

export function isPenKindActive(tool: Tool, drawShape: boolean, k: PenKind): boolean {
  if (k === 'shapepen') return drawShape;
  return !drawShape && (tool as InkTool) === k;
}
