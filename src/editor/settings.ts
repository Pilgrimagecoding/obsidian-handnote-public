import { DEFAULT_PEN_PARAMS, EXPERIMENTAL_FOUNTAIN, HIGHLIGHTER_COLORS, INK_COLORS, WIDTH_STEPS, defaultColor, sanitizeExperimental, sanitizeParams } from '../ink/presets';
import type { InputModeSetting } from '../input/input-mode';
import type { InkTool, PenParams, Tool } from '../ink/types';
import type { BackgroundKind, StrokeDash as DocDash } from '../document/model';
import type { ArrowHead, ShapeKind, TextAlign, TextFont } from '../document/items';

/** Line style choice in the UI ('solid' is stored as "no dash field"). */
export type StrokeDash = 'solid' | DocDash;

export interface PenSetting {
  color: string;
  params: PenParams;
}

/** Per-device editor settings (stored in the plugin's data.json, which is not synced). */
export type FountainVariant = 'baseline' | 'experimental';
export type PaperTone = 'white' | 'cream' | 'yellow';
export type EraserMode = 'precise' | 'standard' | 'stroke';

export interface ShapeSettings {
  kind: ShapeKind;
  color: string;
  strokeWidth: number;
  fill: boolean;
  fillOpacity: number;
  dash: StrokeDash;
  /** Arrow heads of arrow / curve / elbow connectors. */
  arrows: 'end' | 'both' | 'none';
  head: ArrowHead;
}

/** Which kinds of content the lasso picks up (GoodNotes "lasso content"). */
export interface LassoFilter {
  ink: boolean;
  highlighter: boolean;
  shapes: boolean;
  connectors: boolean;
  text: boolean;
  images: boolean;
}

export interface LassoSettings {
  mode: 'free' | 'rect';
  filter: LassoFilter;
}

export interface LaserSettings {
  mode: 'dot' | 'trail';
  color: string;
  /**
   * How long the whole trail stays fully visible after the last pen movement (ms). While the pen
   * keeps writing — also across lifts within this time — nothing disappears.
   */
  holdMs: number;
  /** Duration of the fade-out once the hold time has passed (ms). */
  fadeMs: number;
}

export const LASER_HOLD_CHOICES = [1000, 2000, 5000];

export type ImageStorage = 'embed' | 'attachment';

export interface TextSettings {
  size: number;
  color: string;
  font: TextFont;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
}

/** Current pen model generation; older settings get the new pen defaults once (see migration). */
export const PEN_MODEL = 3;

export interface EditorSettings {
  tool: Tool;
  /** Last ink tool (the top-bar pen button returns to it). */
  lastPen: InkTool;
  /** "Draw shape" pen: fountain/pencil strokes that look like shapes become clean shapes. */
  drawShape: boolean;
  pens: Record<InkTool, PenSetting>;
  /** Fountain pen A/B: v0.1 Baseline (engine 1) or the default pen (engine 2). */
  fountainVariant: FountainVariant;
  /** Parameters of the engine-2 fountain pen (color is shared with the fountain pen). */
  experimental: PenParams;
  /** Pen model generation of these settings (PEN_MODEL). */
  penModel: number;
  /** Three quick widths per ink tool (page units), editable with the width slider. */
  widthPresets: Record<InkTool, number[]>;
  /** Colour circles of the sub-toolbar (custom colours are added at the front). */
  inkPalette: string[];
  highlighterPalette: string[];
  /** Per-device input conventions; never stored in .handnote files. */
  inputMode: InputModeSetting;
  /** Collect detailed input diagnostics (local only). */
  diagnostics: boolean;
  /** Subtle paper grain on the page background. */
  paperTexture: boolean;
  /** Paper tone used for new pages. */
  newPaperTone: PaperTone;
  /** Legacy (v0.1/v0.2) eraser radius in screen px. */
  eraserRadius: number;
  eraserMode: EraserMode;
  /** 0 small, 1 medium, 2 large. */
  eraserSize: number;
  eraserHighlighterOnly: boolean;
  shape: ShapeSettings;
  text: TextSettings;
  /** Line style per ink tool (v0.4). */
  penDash: Record<InkTool, StrokeDash>;
  lasso: LassoSettings;
  laser: LaserSettings;
  /** New images: stored inside the .handnote file (default) or as vault attachments. */
  imageStorage: ImageStorage;
  /** The sub-toolbar under the main toolbar is shown. */
  subbarOpen: boolean;
  /** Let fingers draw (for devices without a pen). Two fingers still navigate. */
  fingerDrawing: boolean;
  /** Extend the live stroke with PointerEvent.getPredictedEvents() where available. */
  usePrediction: boolean;
  /** Two-finger tap = undo, three-finger tap = redo. */
  tapGestures: boolean;
  /**
   * One-finger double tap switches pen ⇄ eraser — the stand-in for the Apple Pencil double tap,
   * which iPadOS does not deliver to web content (Obsidian plugins).
   */
  fingerDoubleTapEraser: boolean;
  showHud: boolean;
  newPagePaper: string; // paper preset id
  newPageBackground: BackgroundKind;
}

/** Eraser radius in screen px for each size step. */
export const ERASER_SIZES = [5, 11, 22];

export function defaultEditorSettings(): EditorSettings {
  return {
    tool: 'fountain',
    lastPen: 'fountain',
    drawShape: false,
    pens: {
      fountain: { color: defaultColor('fountain'), params: { ...DEFAULT_PEN_PARAMS.fountain } },
      pencil: { color: '#3a3a3a', params: { ...DEFAULT_PEN_PARAMS.pencil } },
      ballpoint: { color: defaultColor('ballpoint'), params: { ...DEFAULT_PEN_PARAMS.ballpoint } },
      highlighter: { color: defaultColor('highlighter'), params: { ...DEFAULT_PEN_PARAMS.highlighter, width: WIDTH_STEPS.highlighter[1] } },
    },
    fountainVariant: 'experimental',
    experimental: { ...EXPERIMENTAL_FOUNTAIN },
    penModel: PEN_MODEL,
    widthPresets: {
      fountain: [...WIDTH_STEPS.fountain],
      pencil: [...WIDTH_STEPS.pencil],
      ballpoint: [...WIDTH_STEPS.ballpoint],
      highlighter: [...WIDTH_STEPS.highlighter],
    },
    inkPalette: [...INK_COLORS],
    highlighterPalette: [...HIGHLIGHTER_COLORS],
    inputMode: 'auto',
    diagnostics: false,
    paperTexture: false,
    newPaperTone: 'white',
    eraserRadius: 10,
    eraserMode: 'standard',
    eraserSize: 1,
    eraserHighlighterOnly: false,
    shape: { kind: 'rect', color: '#1a1a1a', strokeWidth: 1.5, fill: false, fillOpacity: 0.25, dash: 'solid', arrows: 'end', head: 'open' },
    text: { size: 16, color: '#1a1a1a', font: 'sans', bold: false, italic: false, align: 'left' },
    penDash: { fountain: 'solid', pencil: 'solid', ballpoint: 'solid', highlighter: 'solid' },
    lasso: { mode: 'free', filter: { ink: true, highlighter: true, shapes: true, connectors: true, text: true, images: true } },
    laser: { mode: 'trail', color: '#ff3b30', holdMs: 2000, fadeMs: 700 },
    imageStorage: 'embed',
    subbarOpen: true,
    fingerDrawing: false,
    usePrediction: false,
    tapGestures: true,
    fingerDoubleTapEraser: true,
    showHud: false,
    newPagePaper: 'a4',
    newPageBackground: 'ruled',
  };
}

const TOOLS: Tool[] = ['fountain', 'pencil', 'ballpoint', 'highlighter', 'eraser', 'text', 'image', 'shape', 'lasso', 'laser'];
const INK: InkTool[] = ['fountain', 'pencil', 'ballpoint', 'highlighter'];
const BGS: BackgroundKind[] = ['blank', 'ruled', 'grid', 'dots'];
const SHAPES: ShapeKind[] = ['rect', 'roundrect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow', 'elbow', 'curve'];
const DASHES: StrokeDash[] = ['solid', 'dash', 'dot'];

function dash(v: unknown): StrokeDash {
  return DASHES.includes(v as StrokeDash) ? (v as StrokeDash) : 'solid';
}
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function colorList(v: unknown, fb: string[]): string[] {
  if (!Array.isArray(v)) return [...fb];
  const out: string[] = [];
  for (const c of v) if (typeof c === 'string' && COLOR_RE.test(c) && !out.includes(c.toLowerCase())) out.push(c.toLowerCase());
  return out.length ? out.slice(0, 40) : [...fb];
}

function num(v: unknown, fb: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
}

export function sanitizeEditorSettings(raw: unknown): EditorSettings {
  const d = defaultEditorSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<EditorSettings>;
  // settings written before the v0.3 pen model get the new pen defaults once (colours are kept)
  const oldModel = (r.penModel ?? 0) < PEN_MODEL;
  const pens = { ...d.pens };
  for (const t of INK) {
    const p = r.pens?.[t];
    const color = typeof p?.color === 'string' && COLOR_RE.test(p.color) ? p.color : d.pens[t].color;
    const resetParams = oldModel && (t === 'highlighter' || t === 'pencil');
    pens[t] = { color, params: resetParams || !p ? { ...d.pens[t].params } : sanitizeParams(t, p.params) };
  }
  const wp = { ...d.widthPresets };
  if (!oldModel && r.widthPresets) {
    for (const t of INK) {
      const a = r.widthPresets[t];
      if (Array.isArray(a) && a.length === 3 && a.every((v) => typeof v === 'number' && v > 0.1 && v < 80)) wp[t] = a.slice();
    }
  }
  const sh = (r.shape ?? {}) as Partial<ShapeSettings>;
  const tx = (r.text ?? {}) as Partial<TextSettings>;
  const tool = TOOLS.includes(r.tool as Tool) ? (r.tool as Tool) : d.tool;
  return {
    tool: tool === 'ballpoint' ? 'fountain' : tool,
    lastPen: INK.includes(r.lastPen as InkTool) && r.lastPen !== 'ballpoint' ? (r.lastPen as InkTool) : 'fountain',
    drawShape: r.drawShape === true,
    pens,
    fountainVariant: r.fountainVariant === 'baseline' ? 'baseline' : 'experimental',
    experimental: oldModel ? { ...EXPERIMENTAL_FOUNTAIN } : sanitizeExperimental(r.experimental),
    penModel: PEN_MODEL,
    widthPresets: wp,
    inkPalette: colorList(r.inkPalette, d.inkPalette),
    highlighterPalette: colorList(r.highlighterPalette, d.highlighterPalette),
    inputMode: r.inputMode === 'pen' || r.inputMode === 'mouse' ? r.inputMode : 'auto',
    diagnostics: r.diagnostics === true,
    paperTexture: r.paperTexture === true,
    newPaperTone: r.newPaperTone === 'cream' || r.newPaperTone === 'yellow' ? r.newPaperTone : 'white',
    eraserRadius: typeof r.eraserRadius === 'number' && r.eraserRadius > 2 ? Math.min(60, r.eraserRadius) : d.eraserRadius,
    eraserMode: r.eraserMode === 'precise' || r.eraserMode === 'stroke' ? r.eraserMode : 'standard',
    eraserSize: Math.round(num(r.eraserSize, 1, 0, 2)),
    eraserHighlighterOnly: r.eraserHighlighterOnly === true,
    shape: {
      kind: SHAPES.includes(sh.kind as ShapeKind) ? (sh.kind as ShapeKind) : d.shape.kind,
      color: typeof sh.color === 'string' && COLOR_RE.test(sh.color) ? sh.color : d.shape.color,
      strokeWidth: num(sh.strokeWidth, d.shape.strokeWidth, 0.3, 12),
      fill: sh.fill === true,
      fillOpacity: num(sh.fillOpacity, d.shape.fillOpacity, 0.05, 1),
      dash: dash(sh.dash),
      arrows: sh.arrows === 'both' || sh.arrows === 'none' ? sh.arrows : 'end',
      head: sh.head === 'filled' ? 'filled' : 'open',
    },
    text: {
      size: num(tx.size, d.text.size, 6, 96),
      color: typeof tx.color === 'string' && COLOR_RE.test(tx.color) ? tx.color : d.text.color,
      font: tx.font === 'serif' || tx.font === 'mono' || tx.font === 'hand' ? tx.font : 'sans',
      bold: tx.bold === true,
      italic: tx.italic === true,
      align: tx.align === 'center' || tx.align === 'right' ? tx.align : 'left',
    },
    penDash: {
      fountain: dash(r.penDash?.fountain),
      pencil: dash(r.penDash?.pencil),
      ballpoint: dash(r.penDash?.ballpoint),
      highlighter: dash(r.penDash?.highlighter),
    },
    lasso: {
      mode: r.lasso?.mode === 'rect' ? 'rect' : 'free',
      filter: (() => {
        const f = (r.lasso?.filter ?? {}) as Partial<LassoFilter>;
        const keys: (keyof LassoFilter)[] = ['ink', 'highlighter', 'shapes', 'connectors', 'text', 'images'];
        const out = { ...d.lasso.filter };
        for (const k of keys) if (typeof f[k] === 'boolean') out[k] = f[k];
        if (!keys.some((k) => out[k])) return { ...d.lasso.filter };
        return out;
      })(),
    },
    laser: {
      mode: r.laser?.mode === 'dot' ? 'dot' : 'trail',
      color: typeof r.laser?.color === 'string' && COLOR_RE.test(r.laser.color) ? r.laser.color : d.laser.color,
      holdMs: num(r.laser?.holdMs, d.laser.holdMs, 300, 10000),
      fadeMs: num(r.laser?.fadeMs, d.laser.fadeMs, 200, 4000),
    },
    imageStorage: r.imageStorage === 'attachment' ? 'attachment' : 'embed',
    subbarOpen: r.subbarOpen !== false,
    fingerDrawing: r.fingerDrawing === true,
    // v0.1 → v0.2 migration: predicted ink is reset to OFF (default) until device data shows it helps
    usePrediction: r.fountainVariant === undefined ? false : r.usePrediction === true,
    tapGestures: r.tapGestures !== false,
    fingerDoubleTapEraser: r.fingerDoubleTapEraser !== false,
    showHud: r.showHud === true,
    newPagePaper: typeof r.newPagePaper === 'string' ? r.newPagePaper : d.newPagePaper,
    newPageBackground: BGS.includes(r.newPageBackground as BackgroundKind) ? (r.newPageBackground as BackgroundKind) : d.newPageBackground,
  };
}

/**
 * Add a colour to a palette: new colours go to the front; a colour that is already there moves to
 * the front instead of being added twice.
 */
export function addPaletteColor(palette: string[], color: string): string[] {
  const c = color.toLowerCase();
  if (!COLOR_RE.test(c)) return palette;
  return [c, ...palette.filter((p) => p.toLowerCase() !== c)].slice(0, 40);
}
