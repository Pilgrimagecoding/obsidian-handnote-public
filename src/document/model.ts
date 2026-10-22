import type { InkTool, InputSample, PenParams } from '../ink/types';
import type { Item } from './items';

export const FORMAT_ID = 'obsidian-handnote';
/**
 * Highest format version this plugin reads.
 *  1 — v0.1 files (all strokes engine 1)
 *  2 — v0.2 files that contain at least one engine-2 stroke. Writing version 2 only when needed keeps
 *      every file without engine-2 strokes readable *and editable* by v0.1, while v0.1 opens a file
 *      with engine-2 strokes read-only instead of silently dropping their parameters on save.
 *  3 — v0.3 files with text/image/shape items, pencil strokes, partially erased strokes or the
 *      natural pressure curve. Older versions open them read-only.
 *  4 — v0.4 files that use dashed / dotted strokes, groups, rotated items, curve / polyline
 *      connectors, arrow options or embedded images (assets). Files without these features are
 *      still written as version 1–3.
 *  5 — v0.5 files with formulas, mind maps or labelled flowchart shapes. Files without these are
 *      still written as version 1–4, so 0.4 keeps editing them.
 */
export const FORMAT_VERSION = 5;
/** Default geometry engine (v0.1 Baseline). */
export const ENGINE_VERSION = 1;
/** Fountain Pen Experimental (v0.2). */
export const ENGINE_EXPERIMENTAL = 2;
/** Highest geometry engine this plugin can render. */
export const MAX_ENGINE = 2;

export type BackgroundKind = 'blank' | 'ruled' | 'grid' | 'dots';

export interface PageBackground {
  kind: BackgroundKind;
  /** Line/grid spacing in page units. */
  spacing: number;
  /** Paper color. */
  paper: string;
  /** Line color. */
  line: string;
}

export interface Stroke {
  id: string;
  tool: InkTool;
  color: string;
  params: PenParams;
  /** Zoom at writing time, needed to reproduce screen-space stabilization. */
  zoom: number;
  hasPressure: boolean;
  engine: number;
  /** Wall-clock time the stroke started (ms since epoch). */
  created: number;
  samples: InputSample[];
  /** Partial-eraser fragment: bit 1 = start was cut, bit 2 = end was cut (no taper there). */
  cut?: number;
  /** Line style (v4). Missing = solid. */
  dash?: StrokeDash;
  /** Group id (v4): strokes and items with the same id are selected and moved together. */
  g?: string;
}

/** Dashed / dotted line style of ink strokes and connectors. Solid is the absence of the field. */
export type StrokeDash = 'dash' | 'dot';

/**
 * Image stored inside the .handnote file (v4). Items reference it with `src: "asset:<id>"`.
 * `data` is base64 without the data: prefix.
 */
export interface Asset {
  id: string;
  mime: string;
  w: number;
  h: number;
  data: string;
}

export interface Page {
  id: string;
  width: number;
  height: number;
  background: PageBackground;
  strokes: Stroke[];
  /** Text boxes, images and shapes (format v3). Painted: images, shapes, ink, then text. */
  items: Item[];
}

export interface HandNoteDocument {
  format: typeof FORMAT_ID;
  version: number;
  id: string;
  created: number;
  modified: number;
  /** Incremented on every save; used to detect writes from other devices (sync conflicts). */
  revision: number;
  /** Random id of the device that wrote the current revision. */
  device: string;
  pages: Page[];
  /** Embedded images (v4), by id. Only assets referenced by an item are written to the file. */
  assets?: Record<string, Asset>;
}

export interface PaperPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const PAPER_PRESETS: PaperPreset[] = [
  { id: 'a4', label: 'A4 Portrait', width: 595, height: 842 },
  { id: 'a4l', label: 'A4 Landscape', width: 842, height: 595 },
  { id: 'a5', label: 'A5 Portrait', width: 420, height: 595 },
  { id: '16x9', label: '16:9', width: 842, height: 474 },
];

/** Page sizes offered in "Change template" (portrait; landscape swaps width and height). */
export const PAGE_SIZES: { id: string; label: string; width: number; height: number }[] = [
  { id: 'a5', label: 'A5', width: 420, height: 595 },
  { id: 'a4', label: 'A4', width: 595, height: 842 },
  { id: 'a3', label: 'A3', width: 842, height: 1191 },
  { id: 'letter', label: 'Letter', width: 612, height: 792 },
];

/** Identify a page size (id + orientation); `custom` when it matches none. */
export function sizeOf(page: { width: number; height: number }): { id: string; landscape: boolean } {
  const landscape = page.width > page.height;
  const s = PAGE_SIZES.find((p) => {
    const w = landscape ? p.height : p.width;
    const h = landscape ? p.width : p.height;
    return Math.abs(w - page.width) < 1 && Math.abs(h - page.height) < 1;
  });
  return { id: s ? s.id : 'custom', landscape };
}

export function paperById(id: string): PaperPreset {
  return PAPER_PRESETS.find((p) => p.id === id) ?? PAPER_PRESETS[0];
}

export const BACKGROUND_DEFAULTS: Record<BackgroundKind, number> = {
  blank: 24,
  ruled: 24,
  grid: 14.17, // 5 mm
  dots: 14.17,
};

/** Paper tones: low-contrast light-gray (or warm) rules, never black lines. */
export const PAPER_TONES: Record<'white' | 'cream' | 'yellow', { paper: string; line: string }> = {
  white: { paper: '#ffffff', line: '#d6dbe2' },
  cream: { paper: '#f8f3e6', line: '#e2d8c4' },
  yellow: { paper: '#fcf6d9', line: '#e5dab3' },
};

export function defaultBackground(kind: BackgroundKind = 'ruled', tone: 'white' | 'cream' | 'yellow' = 'white'): PageBackground {
  const t = PAPER_TONES[tone] ?? PAPER_TONES.white;
  return { kind, spacing: BACKGROUND_DEFAULTS[kind], paper: t.paper, line: t.line };
}

export function toneOf(bg: PageBackground): 'white' | 'cream' | 'yellow' {
  for (const [k, v] of Object.entries(PAPER_TONES)) if (v.paper.toLowerCase() === bg.paper.toLowerCase()) return k as 'white' | 'cream' | 'yellow';
  return 'white';
}

let idCounter = 0;
export function newId(prefix = ''): string {
  idCounter = (idCounter + 1) % 1679616;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return prefix + Date.now().toString(36) + idCounter.toString(36) + rand;
}

export function createPage(width: number, height: number, background: PageBackground): Page {
  return { id: newId('p'), width, height, background: { ...background }, strokes: [], items: [] };
}

export function createDocument(
  opts: { width?: number; height?: number; background?: PageBackground; pages?: number; device?: string } = {},
): HandNoteDocument {
  const now = Date.now();
  const width = opts.width ?? 595;
  const height = opts.height ?? 842;
  const bg = opts.background ?? defaultBackground('ruled');
  const pages: Page[] = [];
  for (let i = 0; i < (opts.pages ?? 1); i++) pages.push(createPage(width, height, bg));
  return {
    format: FORMAT_ID,
    version: 1,
    id: newId('d'),
    created: now,
    modified: now,
    revision: 0,
    device: opts.device ?? '',
    pages,
  };
}

export function strokeCount(doc: HandNoteDocument): number {
  let n = 0;
  for (const p of doc.pages) n += p.strokes.length;
  return n;
}
