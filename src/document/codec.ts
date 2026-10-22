import type { InkTool, InputSample } from '../ink/types';
import { sanitizeParams } from '../ink/presets';
import {
  BACKGROUND_DEFAULTS,
  ENGINE_VERSION,
  FORMAT_ID,
  FORMAT_VERSION,
  MAX_ENGINE,
  type BackgroundKind,
  type HandNoteDocument,
  type Page,
  type PageBackground,
  type Stroke,
  type Asset,
  newId,
} from './model';
import { LINE_KINDS, fitConnector, normAngle, type Attachment, type Item, type ShapeKind, type TextAlign, type TextFont } from './items';
import { MAP_LAYOUTS, MAP_LIMITS, MAP_THEMES, nodeId, type MapLayoutId, type MapThemeId, type MindNode } from '../mindmap/model';
import { stripControl } from '../utils/text';

/**
 * .handnote file codec.
 *
 * The file is valid JSON, written "one stroke per line" so that:
 *  - diffs and sync conflicts are line-oriented and readable;
 *  - a truncated or partially corrupted file can be recovered stroke by stroke
 *    (see recoverDocument), instead of losing the whole page.
 *
 * Samples are quantized and delta-encoded ("d1"):
 *   x, y in 1/100 page unit, pressure in 1/1000, time in ms, tilt in whole degrees.
 * Every value is an integer delta from the previous sample, which keeps files ~3x smaller than
 * plain float arrays while staying human-inspectable JSON.
 */

const XY_Q = 100;
const P_Q = 1000;

export interface ParseResult {
  doc: HandNoteDocument;
  warnings: string[];
  /** File written by a newer plugin version: open it, but never save over it. */
  readOnly: boolean;
  /** True when the file was not valid JSON and recoverDocument() had to salvage it. */
  recovered: boolean;
}

export class HandNoteParseError extends Error {}

// ------------------------------------------------------------------------------------------------
// Sample encoding
// ------------------------------------------------------------------------------------------------

export function quantizeSample(s: InputSample): InputSample {
  const q: InputSample = {
    x: Math.round(s.x * XY_Q) / XY_Q,
    y: Math.round(s.y * XY_Q) / XY_Q,
    p: Math.round(clamp01(s.p) * P_Q) / P_Q,
    t: Math.round(s.t),
  };
  if (s.tx !== undefined && s.ty !== undefined && Number.isFinite(s.tx) && Number.isFinite(s.ty)) {
    q.tx = Math.round(s.tx);
    q.ty = Math.round(s.ty);
  }
  return q;
}

function clamp01(v: number): number {
  return v < 0 || !Number.isFinite(v) ? 0 : v > 1 ? 1 : v;
}

export function encodeSamples(samples: readonly InputSample[]): { pts: number[]; tilt?: number[] } {
  const pts: number[] = [];
  const hasTilt = samples.length > 0 && samples.every((s) => s.tx !== undefined && s.ty !== undefined);
  const tilt: number[] = [];
  let px = 0;
  let py = 0;
  let pp = 0;
  let pt = 0;
  let ptx = 0;
  let pty = 0;
  for (const s of samples) {
    const x = Math.round(s.x * XY_Q);
    const y = Math.round(s.y * XY_Q);
    const p = Math.round(clamp01(s.p) * P_Q);
    const t = Math.round(s.t);
    pts.push(x - px, y - py, p - pp, t - pt);
    px = x;
    py = y;
    pp = p;
    pt = t;
    if (hasTilt) {
      const tx = Math.round(s.tx as number);
      const ty = Math.round(s.ty as number);
      tilt.push(tx - ptx, ty - pty);
      ptx = tx;
      pty = ty;
    }
  }
  return hasTilt ? { pts, tilt } : { pts };
}

export function decodeSamples(pts: unknown, tilt?: unknown): InputSample[] {
  if (!Array.isArray(pts) || pts.length % 4 !== 0) throw new HandNoteParseError('bad sample array');
  const arr = pts as unknown[];
  const tl = Array.isArray(tilt) ? (tilt as unknown[]) : null;
  const out: InputSample[] = [];
  const hasTilt = !!tl && tl.length === (arr.length / 4) * 2;
  let x = 0;
  let y = 0;
  let p = 0;
  let t = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0, j = 0; i < arr.length; i += 4, j += 2) {
    const a = arr[i];
    const b = arr[i + 1];
    const c = arr[i + 2];
    const d = arr[i + 3];
    if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number' || typeof d !== 'number') {
      throw new HandNoteParseError('non-numeric sample');
    }
    x += a;
    y += b;
    p += c;
    t += d;
    const s: InputSample = { x: x / XY_Q, y: y / XY_Q, p: p / P_Q, t };
    if (hasTilt) {
      tx += Number((tl)[j]);
      ty += Number((tl)[j + 1]);
      s.tx = tx;
      s.ty = ty;
    }
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Serialization
// ------------------------------------------------------------------------------------------------

function strokeToJson(s: Stroke): string {
  const enc = encodeSamples(s.samples);
  const o: Record<string, unknown> = {
    id: s.id,
    tool: s.tool,
    color: s.color,
    params: roundParams(s.params as unknown as Record<string, number>),
    zoom: Math.round(s.zoom * 1000) / 1000,
    hasPressure: s.hasPressure,
    engine: s.engine,
    created: s.created,
    enc: 'd1',
    pts: enc.pts,
  };
  if (enc.tilt) o.tilt = enc.tilt;
  if (s.cut) o.cut = s.cut;
  if (s.dash) o.dash = s.dash;
  if (s.g) o.g = s.g;
  return JSON.stringify(o);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** One item per line; numbers rounded to 1/100 unit; keys in a canonical order (id, type, a–z). */
function itemToJson(it: Item): string {
  const src = it as unknown as Record<string, unknown>;
  const keys = Object.keys(src)
    .filter((k) => k !== 'id' && k !== 'type' && src[k] !== undefined)
    .sort();
  const o: Record<string, unknown> = { id: src.id, type: src.type };
  for (const k of keys) o[k] = src[k];
  return JSON.stringify(o, (_k, v: unknown) => (typeof v === 'number' ? r2(v) : v));
}

function roundParams(p: Record<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of Object.keys(p)) o[k] = Math.round(p[k] * 1000) / 1000;
  return o;
}

const V4_ITEM_KEYS = ['rot', 'g', 'dash', 'arrowStart', 'arrowEnd', 'head', 'c', 'pts', 'latex'];

function itemNeedsV4(it: Item): boolean {
  const r = it as unknown as Record<string, unknown>;
  if (V4_ITEM_KEYS.some((k) => r[k] !== undefined)) return true;
  if (it.type === 'shape' && (it.kind === 'curve' || it.kind === 'polyline')) return true;
  if (it.type === 'text' && it.font === 'hand') return true;
  if (it.type === 'image' && it.src.startsWith('asset:')) return true;
  return false;
}

function itemNeedsV5(it: Item): boolean {
  return it.type === 'formula' || it.type === 'mindmap' || (it.type === 'shape' && (!!it.label || it.vfirst === true));
}

/** Lowest format version that can represent the document (see FORMAT_VERSION). */
export function requiredVersion(doc: HandNoteDocument): number {
  let v = 1;
  for (const p of doc.pages) {
    for (const it of p.items ?? []) {
      if (itemNeedsV5(it)) return 5;
      if (itemNeedsV4(it)) v = Math.max(v, 4);
      v = Math.max(v, 3);
    }
    for (const s of p.strokes) {
      if (s.dash || s.g) v = Math.max(v, 4);
      if (s.tool === 'pencil' || s.cut || s.params.pressureCurve === 4) v = Math.max(v, 3);
      if (s.engine >= 2) v = Math.max(v, 2);
    }
  }
  return v;
}

/** Ids of the embedded assets referenced by image items (only these are written). */
export function referencedAssets(doc: HandNoteDocument): string[] {
  const ids: string[] = [];
  for (const p of doc.pages)
    for (const it of p.items ?? []) {
      if (it.type !== 'image' || !it.src.startsWith('asset:')) continue;
      const id = it.src.slice(6);
      if (!ids.includes(id)) ids.push(id);
    }
  return ids;
}

export function serializeDocument(doc: HandNoteDocument): string {
  const header = {
    format: FORMAT_ID,
    version: doc.version > FORMAT_VERSION ? doc.version : requiredVersion(doc),
    id: doc.id,
    created: doc.created,
    modified: doc.modified,
    revision: doc.revision,
    device: doc.device,
  };
  const lines: string[] = [];
  const h = JSON.stringify(header);
  lines.push(h.slice(0, -1) + ',');
  lines.push('"pages":[');
  doc.pages.forEach((page, pi) => {
    const ph = JSON.stringify({ id: page.id, width: page.width, height: page.height, background: page.background });
    lines.push(ph.slice(0, -1) + ',"strokes":[');
    page.strokes.forEach((s, si) => {
      lines.push(strokeToJson(s) + (si < page.strokes.length - 1 ? ',' : ''));
    });
    const items = page.items ?? [];
    if (items.length) {
      lines.push('],"items":[');
      items.forEach((it, ii) => lines.push(itemToJson(it) + (ii < items.length - 1 ? ',' : '')));
    }
    lines.push(']}' + (pi < doc.pages.length - 1 ? ',' : ''));
  });
  // embedded images: one asset per line after the pages (large lines, but line-recoverable)
  const assets = referencedAssets(doc)
    .map((id) => doc.assets?.[id])
    .filter((a): a is Asset => !!a);
  if (assets.length) {
    lines.push('],"assets":[');
    assets.forEach((a, i) => lines.push(JSON.stringify({ id: a.id, mime: a.mime, w: a.w, h: a.h, data: a.data }) + (i < assets.length - 1 ? ',' : '')));
  }
  lines.push(']}');
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------------------------------------
// Parsing and validation
// ------------------------------------------------------------------------------------------------

const TOOLS: InkTool[] = ['fountain', 'pencil', 'ballpoint', 'highlighter'];
const BG_KINDS: BackgroundKind[] = ['blank', 'ruled', 'grid', 'dots'];
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function num(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}

function str(v: unknown, fb: string): string {
  return typeof v === 'string' ? v : fb;
}

export function validateStroke(o: unknown, warnings: string[]): Stroke | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const tool = r.tool as InkTool;
  if (!TOOLS.includes(tool)) {
    warnings.push(`Skipped stroke with unknown tool "${String(r.tool)}"`);
    return null;
  }
  let samples: InputSample[];
  try {
    if (r.enc === 'd1') samples = decodeSamples(r.pts, r.tilt);
    else {
      warnings.push(`Skipped stroke with unknown encoding "${String(r.enc)}"`);
      return null;
    }
  } catch (e) {
    warnings.push(`Skipped stroke with corrupt samples (${(e as Error).message})`);
    return null;
  }
  if (samples.length === 0) return null;
  const color = str(r.color, '#000000');
  return {
    id: str(r.id, newId('s')),
    tool,
    color: COLOR_RE.test(color) ? color : '#000000',
    params: sanitizeParams(tool, r.params as Record<string, number>),
    zoom: num(r.zoom, 1) > 0 ? num(r.zoom, 1) : 1,
    hasPressure: r.hasPressure !== false,
    engine: Math.min(MAX_ENGINE, Math.max(1, Math.round(num(r.engine, ENGINE_VERSION)))),
    created: num(r.created, 0),
    samples,
    ...(typeof r.cut === 'number' && r.cut > 0 && r.cut <= 3 ? { cut: Math.round(r.cut) } : {}),
    ...(r.dash === 'dash' || r.dash === 'dot' ? { dash: r.dash } : {}),
    ...(groupId(r.g) ? { g: r.g as string } : {}),
  };
}

function groupId(v: unknown): boolean {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

const MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Largest embedded image accepted when reading (base64 characters). */
export const MAX_ASSET_CHARS = 40 * 1024 * 1024;

export function validateAsset(o: unknown, warnings: string[]): Asset | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(r.id)) return null;
  if (typeof r.mime !== 'string' || !MIMES.includes(r.mime)) {
    warnings.push(`Skipped embedded image with unsupported type "${String(r.mime)}"`);
    return null;
  }
  if (typeof r.data !== 'string' || r.data.length === 0 || r.data.length > MAX_ASSET_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(r.data)) {
    warnings.push('Skipped damaged embedded image');
    return null;
  }
  return { id: r.id, mime: r.mime, w: Math.max(1, Math.round(num(r.w, 1))), h: Math.max(1, Math.round(num(r.h, 1))), data: r.data };
}

const SHAPE_KINDS: ShapeKind[] = ['rect', 'roundrect', 'ellipse', 'triangle', 'diamond', 'polygon', 'line', 'arrow', 'elbow', 'curve', 'polyline'];
const FONTS: TextFont[] = ['sans', 'serif', 'mono', 'hand'];
/** Limits applied to every item read from a file (or produced by AI conversion). */
export const ITEM_LIMITS = { coord: 100000, text: 20000, polyPoints: 400 };
const ALIGNS: TextAlign[] = ['left', 'center', 'right'];

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function pt(v: unknown): [number, number] | undefined {
  const L = ITEM_LIMITS.coord;
  return Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [Math.min(L, Math.max(-L, v[0])), Math.min(L, Math.max(-L, v[1]))] : undefined;
}

function attachment(v: unknown): Attachment | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !finite(r.ax) || !finite(r.ay)) return undefined;
  return { id: r.id, ax: Math.min(1, Math.max(0, r.ax)), ay: Math.min(1, Math.max(0, r.ay)) };
}

/** Validate one text / image / shape item (unknown types are skipped with a warning). */
export function validateItem(o: unknown, warnings: string[]): Item | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const L = ITEM_LIMITS.coord;
  const cl = (v: number) => Math.min(L, Math.max(-L, v));
  const base: { id: string; x: number; y: number; w: number; h: number; created: number; rot?: number; g?: string } = {
    id: str(r.id, newId('i')),
    x: cl(num(r.x, 0)),
    y: cl(num(r.y, 0)),
    w: Math.min(L, Math.max(0, num(r.w, 0))),
    h: Math.min(L, Math.max(0, num(r.h, 0))),
    created: num(r.created, 0),
  };
  if (finite(r.rot) && Math.abs(r.rot) > 1e-6) base.rot = normAngle(r.rot);
  if (groupId(r.g)) base.g = r.g as string;
  const color = (v: unknown, fb: string) => (typeof v === 'string' && COLOR_RE.test(v) ? v : fb);
  if (r.type === 'text') {
    return {
      ...base,
      type: 'text',
      text: str(r.text, '').slice(0, ITEM_LIMITS.text),
      ...(typeof r.latex === 'string' && r.latex ? { latex: r.latex.slice(0, ITEM_LIMITS.text) } : {}),
      size: Math.min(400, Math.max(4, num(r.size, 16))),
      color: color(r.color, '#1a1a1a'),
      font: FONTS.includes(r.font as TextFont) ? (r.font as TextFont) : 'sans',
      bold: r.bold === true,
      italic: r.italic === true,
      align: ALIGNS.includes(r.align as TextAlign) ? (r.align as TextAlign) : 'left',
      autoWidth: r.autoWidth !== false,
    };
  }
  if (r.type === 'image') {
    if (typeof r.src !== 'string' || r.src === '') {
      warnings.push('Skipped image without source');
      return null;
    }
    const c = r.crop;
    const crop =
      Array.isArray(c) && c.length === 4 && c.every(finite) ? (c.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number]) : undefined;
    return { ...base, type: 'image', src: r.src, natW: Math.max(1, num(r.natW, base.w || 1)), natH: Math.max(1, num(r.natH, base.h || 1)), ...(crop ? { crop } : {}) };
  }
  if (r.type === 'shape') {
    const kind = SHAPE_KINDS.includes(r.kind as ShapeKind) ? (r.kind as ShapeKind) : 'rect';
    const shape: Item = {
      ...base,
      type: 'shape',
      kind,
      stroke: color(r.stroke, '#1a1a1a'),
      strokeWidth: Math.min(40, Math.max(0.1, num(r.strokeWidth, 1.5))),
      fill: typeof r.fill === 'string' && COLOR_RE.test(r.fill) ? r.fill : null,
      fillOpacity: Math.min(1, Math.max(0, num(r.fillOpacity, 1))),
    };
    if (Array.isArray(r.points) && r.points.length >= 6 && r.points.length % 2 === 0 && r.points.every(finite)) {
      shape.points = (r.points).map((v) => Math.min(1, Math.max(0, v)));
    }
    const sh = shape;
    if (r.dash === 'dash' || r.dash === 'dot') sh.dash = r.dash;
    if (!LINE_KINDS.includes(kind) && r.label && typeof r.label === 'object') {
      const lb = r.label as Record<string, unknown>;
      const text = str(lb.text, '').slice(0, 2000);
      if (text) sh.label = { text, size: Math.min(200, Math.max(4, num(lb.size, 14))), color: color(lb.color, '#1a1a1a'), ...(FONTS.includes(lb.font as TextFont) ? { font: lb.font as TextFont } : {}) };
    }
    if (LINE_KINDS.includes(kind)) {
      const a = pt(r.a);
      const b = pt(r.b);
      if (!a || !b) {
        warnings.push('Skipped connector without end points');
        return null;
      }
      sh.a = a;
      sh.b = b;
      const c = pt(r.c);
      if (kind === 'curve') sh.c = c ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (kind === 'polyline' && Array.isArray(r.pts) && r.pts.length % 2 === 0 && r.pts.length <= ITEM_LIMITS.polyPoints * 2 && r.pts.every(finite)) {
        sh.pts = (r.pts).map(cl);
      }
      if (typeof r.arrowStart === 'boolean') sh.arrowStart = r.arrowStart;
      if (typeof r.arrowEnd === 'boolean') sh.arrowEnd = r.arrowEnd;
      if (r.head === 'open' || r.head === 'filled') sh.head = r.head;
      if (kind === 'elbow' && r.vfirst === true) sh.vfirst = true;
      const from = attachment(r.from);
      const to = attachment(r.to);
      if (from) sh.from = from;
      if (to) sh.to = to;
      return fitConnector(sh);
    }
    return sh;
  }
  if (r.type === 'formula') {
    const latex = str(r.latex, '').slice(0, ITEM_LIMITS.text);
    if (!latex.trim()) {
      warnings.push('Skipped empty formula');
      return null;
    }
    return { ...base, type: 'formula', latex, color: color(r.color, '#1a1a1a'), size: Math.min(400, Math.max(4, num(r.size, 18))) };
  }
  if (r.type === 'mindmap') {
    const count = { n: 0 };
    const root = validateMindNode(r.root, 0, count, new Set());
    if (!root) {
      warnings.push('Skipped mind map without topics');
      return null;
    }
    if (count.n > MAP_LIMITS.maxNodes) warnings.push(`Mind map truncated to ${MAP_LIMITS.maxNodes} topics`);
    const { rot: _rot, ...upright } = base;
    return {
      ...upright,
      type: 'mindmap',
      root,
      theme: MAP_THEMES.includes(r.theme as MapThemeId) ? (r.theme as MapThemeId) : 'academic',
      layout: MAP_LAYOUTS.includes(r.layout as MapLayoutId) ? (r.layout as MapLayoutId) : 'balanced',
      scale: Math.min(8, Math.max(0.1, num(r.scale, 1))),
    };
  }
  warnings.push(`Skipped item with unknown type "${String(r.type)}"`);
  return null;
}

function validateMindNode(o: unknown, depth: number, count: { n: number }, ids: Set<string>): MindNode | null {
  if (!o || typeof o !== 'object' || count.n >= MAP_LIMITS.maxNodes) return null;
  const r = o as Record<string, unknown>;
  count.n++;
  let id = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : nodeId();
  if (ids.has(id)) id = nodeId();
  ids.add(id);
  const node: MindNode = { id, text: stripControl(str(r.text, '')).slice(0, MAP_LIMITS.maxText), children: [] };
  if (r.collapsed === true) node.collapsed = true;
  if (depth < MAP_LIMITS.maxDepth && Array.isArray(r.children)) {
    for (const c of r.children) {
      const v = validateMindNode(c, depth + 1, count, ids);
      if (v) node.children.push(v);
    }
  }
  return node;
}

function validateBackground(o: unknown): PageBackground {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const kind = BG_KINDS.includes(r.kind as BackgroundKind) ? (r.kind as BackgroundKind) : 'blank';
  const paper = str(r.paper, '#ffffff');
  const line = str(r.line, '#c9d3e0');
  return {
    kind,
    spacing: Math.max(4, num(r.spacing, BACKGROUND_DEFAULTS[kind])),
    paper: COLOR_RE.test(paper) ? paper : '#ffffff',
    line: COLOR_RE.test(line) ? line : '#c9d3e0',
  };
}

function validatePageHeader(o: unknown): Page | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const width = num(r.width, 595);
  const height = num(r.height, 842);
  return {
    id: str(r.id, newId('p')),
    width: width > 10 ? width : 595,
    height: height > 10 ? height : 842,
    background: validateBackground(r.background),
    strokes: [],
    items: [],
  };
}

function validateDocument(o: unknown, warnings: string[]): { doc: HandNoteDocument; readOnly: boolean } {
  if (!o || typeof o !== 'object') throw new HandNoteParseError('not an object');
  const r = o as Record<string, unknown>;
  if (r.format !== FORMAT_ID) throw new HandNoteParseError('not a HandNote file');
  const version = num(r.version, 0);
  const readOnly = version > FORMAT_VERSION;
  if (readOnly) warnings.push(`File version ${version} is newer than this plugin (${FORMAT_VERSION}); opened read-only.`);
  const pages: Page[] = [];
  if (Array.isArray(r.pages)) {
    for (const po of r.pages) {
      const page = validatePageHeader(po);
      if (!page) continue;
      const strokes = (po as Record<string, unknown>).strokes;
      if (Array.isArray(strokes)) {
        for (const so of strokes) {
          const s = validateStroke(so, warnings);
          if (s) page.strokes.push(s);
        }
      }
      const items = (po as Record<string, unknown>).items;
      if (Array.isArray(items)) {
        for (const io of items) {
          const it = validateItem(io, warnings);
          if (it) page.items.push(it);
        }
      }
      pages.push(page);
    }
  }
  let assets: Record<string, Asset> | undefined;
  if (Array.isArray(r.assets)) {
    for (const ao of r.assets) {
      const a = validateAsset(ao, warnings);
      if (a) (assets ??= {})[a.id] = a;
    }
  }
  return {
    doc: {
      format: FORMAT_ID,
      version: readOnly ? version : Math.max(1, version),
      id: str(r.id, newId('d')),
      created: num(r.created, Date.now()),
      modified: num(r.modified, Date.now()),
      revision: Math.max(0, Math.floor(num(r.revision, 0))),
      device: str(r.device, ''),
      pages,
      ...(assets ? { assets } : {}),
    },
    readOnly,
  };
}

/** Parse a .handnote file. Falls back to line-based recovery for damaged files. */
export function parseDocument(text: string): ParseResult {
  const warnings: string[] = [];
  if (text.trim() === '') {
    throw new HandNoteParseError('empty file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const rec = recoverDocument(text);
    if (!rec) throw new HandNoteParseError('file is not valid JSON and could not be recovered');
    return rec;
  }
  const { doc, readOnly } = validateDocument(parsed, warnings);
  if (doc.pages.length === 0) warnings.push('Document had no pages');
  return { doc, warnings, readOnly, recovered: false };
}

/**
 * Salvage a damaged file (truncated write, sync conflict markers, partial corruption).
 * Recovers the header fields it can find and every stroke line that still parses on its own.
 */
export function recoverDocument(text: string): ParseResult | null {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].includes(FORMAT_ID)) return null;
  const warnings: string[] = ['File was damaged; recovered what could be read.'];
  let header: Record<string, unknown> = {};
  try {
    header = JSON.parse(lines[0].replace(/,\s*$/, '') + '}') as Record<string, unknown>;
  } catch {
    warnings.push('Header damaged');
  }
  const pages: Page[] = [];
  let current: Page | null = null;
  let lost = 0;
  let recAssets: Record<string, Asset> | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line === '"pages":[' || /^\]\}?,?$/.test(line) || line === ']}' || line === '],"items":[' || line === '],"assets":[') continue;
    if (line.endsWith('"strokes":[')) {
      try {
        const ph = JSON.parse(line.slice(0, -'"strokes":['.length).replace(/,\s*$/, '') + '}') as unknown;
        current = validatePageHeader(ph);
        if (current) pages.push(current);
      } catch {
        lost++;
      }
      continue;
    }
    if (line.startsWith('{"id"')) {
      try {
        const so = JSON.parse(line.replace(/,\s*$/, '')) as unknown;
        if (so && typeof so === 'object' && 'mime' in so && 'data' in so) {
          const a = validateAsset(so, warnings);
          if (a) (recAssets ??= {})[a.id] = a;
          else lost++;
          continue;
        }
        if (so && typeof so === 'object' && 'type' in so) {
          const it = validateItem(so, warnings);
          if (it) {
            if (!current) {
              current = validatePageHeader({});
              if (current) pages.push(current);
            }
            current?.items.push(it);
          } else lost++;
          continue;
        }
        const s = validateStroke(so, warnings);
        if (s) {
          if (!current) {
            current = validatePageHeader({});
            if (current) pages.push(current);
          }
          current?.strokes.push(s);
        } else lost++;
      } catch {
        lost++;
      }
      continue;
    }
    lost++;
  }
  if (lost > 0) warnings.push(`${lost} damaged line(s) could not be recovered.`);
  try {
    const { doc, readOnly } = validateDocument({ ...header, format: FORMAT_ID, pages: [] }, warnings);
    doc.pages = pages;
    if (recAssets) doc.assets = recAssets;
    return { doc, warnings, readOnly, recovered: true };
  } catch {
    return null;
  }
}

/** Cheap header peek without parsing the whole file (used for conflict detection). */
export function peekHeader(text: string): { id: string | null; revision: number | null; device: string | null } {
  const head = text.slice(0, 600);
  const id = /"id":"([^"]*)"/.exec(head);
  const rev = /"revision":(\d+)/.exec(head);
  const dev = /"device":"([^"]*)"/.exec(head);
  return { id: id ? id[1] : null, revision: rev ? Number(rev[1]) : null, device: dev ? dev[1] : null };
}
