/**
 * Fixed page layout of an imported Office document (0.9): what to draw where, in page units (pt).
 *
 * Word / PowerPoint / Excel content does not have fixed pages the way a PDF does: line breaks
 * depend on fonts, and fonts differ between Windows, macOS and iPad. Annotations need a page that
 * never moves under the ink, so the layout is computed ONCE at import and stored next to the
 * original as `<file>.handnote-layout.json` (a small JSON file, synced like any vault file). Every
 * device draws the same lines at the same positions from it; glyph shapes may differ slightly, line
 * positions do not. Images are read from the original file when drawn (never copied).
 */

export type DLOp =
  /** text run: baseline at (x, y); f = index into fonts; z = size (pt) */
  | { k: 't'; x: number; y: number; s: string; f: number; z: number; c?: string; b?: 1; i?: 1; u?: 1; st?: 1; w?: number; rot?: number; ox?: number; oy?: number }
  /** rectangle (fill and / or stroke) */
  | { k: 'r'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number; dash?: number[] }
  /** line */
  | { k: 'l'; x1: number; y1: number; x2: number; y2: number; stroke: string; lw: number; dash?: number[] }
  /** picture from the original file (ZIP part name); crop = fractions cut from left, top, right,
   *  bottom of the source picture; rot = degrees clockwise around the centre; fh / fv = flips */
  | { k: 'img'; x: number; y: number; w: number; h: number; part: string; crop?: [number, number, number, number]; rot?: number; fh?: 1; fv?: 1 }
  /** ellipse inside the box */
  | { k: 'e'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number; dash?: number[] }
  /** polygon / polyline: flat list x0, y0, x1, y1, …; c = closed; brk = point indexes where a new sub-path starts */
  | { k: 'pg'; pts: number[]; c?: 1; fill?: string; stroke?: string; lw?: number; dash?: number[]; brk?: number[] };

/**
 * The cell grid of a spreadsheet page: where its rows and columns are (page units), so a point on
 * the page — an annotation — maps back to its cell (src/import/xlsx.ts `cellAt`).
 */
export interface DLGrid {
  sheet: string;
  /** top-left of the first cell */
  x: number;
  y: number;
  /** sheet row numbers (1-based) shown on the page, top to bottom, and their heights */
  rows: number[];
  heights: number[];
  /** sheet column numbers (1-based), left to right, and their widths */
  cols: number[];
  widths: number[];
}

export interface DLPage {
  w: number;
  h: number;
  /** page background colour (slides) */
  bg?: string;
  ops: DLOp[];
  /** spreadsheet pages: the cell grid */
  grid?: DLGrid;
}

export interface DisplayList {
  v: 1;
  kind: 'docx' | 'pptx' | 'xlsx' | 'doc';
  /** CSS font-family lists referenced by text ops */
  fonts: string[];
  pages: DLPage[];
  /** what was approximated or left out (shown in the import notice / docs) */
  notes: string[];
  /** SHA-256 of the original file the layout was computed from */
  sha256?: string;
  /** HandNote version that computed it */
  by?: string;
}

export const LAYOUT_SUFFIX = '.handnote-layout.json';

/** Map an Office font name to a CSS family list available on desktop and iPad. */
export function cssFamily(name: string | undefined, fallback: 'sans' | 'serif' | 'mono' = 'sans'): string {
  const n = (name ?? '').toLowerCase();
  const SANS = '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  const SERIF = '"Times New Roman", Times, Georgia, "Songti SC", STSong, SimSun, "Noto Serif CJK SC", serif';
  const MONO = 'Menlo, Consolas, "Courier New", monospace';
  if (/consolas|courier|mono|menlo/.test(n)) return MONO;
  if (/times|cambria|georgia|garamond|book antiqua|palatino|song|宋|simsun|serif|明|kai|楷|fangsong|仿宋/.test(n)) return SERIF;
  if (n) return SANS;
  return fallback === 'serif' ? SERIF : fallback === 'mono' ? MONO : SANS;
}

export function fontCss(op: { b?: 1; i?: 1; z: number }, family: string): string {
  return `${op.i ? 'italic ' : ''}${op.b ? 'bold ' : ''}${op.z}px ${family}`;
}

/** Validate a stored layout (it is a vault file: treat it as untrusted). */
export function parseDisplayList(text: string): DisplayList {
  const o = JSON.parse(text) as Partial<DisplayList>;
  if (!o || o.v !== 1 || !Array.isArray(o.pages) || !Array.isArray(o.fonts)) throw new Error('not a HandNote layout file');
  const fonts = o.fonts.filter((f): f is string => typeof f === 'string').map((f) => f.slice(0, 300));
  const okNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
  const COLOR = /^#[0-9a-fA-F]{3,8}$/;
  const dashOf = (d: unknown): number[] | undefined => (Array.isArray(d) && d.length <= 8 && d.every((x) => okNum(x) && (x as number) >= 0) ? (d as number[]).map((x) => Math.min(200, x)) : undefined);
  const paint = (op: { fill?: unknown; stroke?: unknown; lw?: unknown; dash?: unknown }) => ({
    ...(typeof op.fill === 'string' && COLOR.test(op.fill) ? { fill: op.fill } : {}),
    ...(typeof op.stroke === 'string' && COLOR.test(op.stroke) ? { stroke: op.stroke, lw: okNum(op.lw) ? Math.min(50, op.lw as number) : 0.75 } : {}),
    ...(dashOf(op.dash) ? { dash: dashOf(op.dash) } : {}),
  });
  const pages: DLPage[] = [];
  for (const p of o.pages.slice(0, 5000)) {
    if (!p || !okNum(p.w) || !okNum(p.h) || p.w < 10 || p.h < 10 || !Array.isArray(p.ops)) continue;
    const ops: DLOp[] = [];
    for (const op of p.ops.slice(0, 200000)) {
      if (!op || typeof op !== 'object') continue;
      if (op.k === 't' && okNum(op.x) && okNum(op.y) && typeof op.s === 'string' && Number.isInteger(op.f) && op.f >= 0 && op.f < fonts.length && okNum(op.z) && op.z > 0) {
        ops.push({ k: 't', x: op.x, y: op.y, s: op.s.slice(0, 2000), f: op.f, z: Math.min(400, op.z), ...(op.c && COLOR.test(op.c) ? { c: op.c } : {}), ...(op.b ? { b: 1 } : {}), ...(op.i ? { i: 1 } : {}), ...(op.u ? { u: 1 } : {}), ...(op.st ? { st: 1 } : {}), ...(typeof op.w === 'number' && okNum(op.w) && op.w > 0 ? { w: op.w } : {}), ...(okNum(op.rot) && op.rot && okNum(op.ox) && okNum(op.oy) ? { rot: op.rot, ox: op.ox, oy: op.oy } : {}) });
      } else if (op.k === 'r' && okNum(op.x) && okNum(op.y) && okNum(op.w) && okNum(op.h)) {
        ops.push({ k: 'r', x: op.x, y: op.y, w: op.w, h: op.h, ...paint(op) });
      } else if (op.k === 'l' && okNum(op.x1) && okNum(op.y1) && okNum(op.x2) && okNum(op.y2) && COLOR.test(op.stroke)) {
        ops.push({ k: 'l', x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2, stroke: op.stroke, lw: okNum(op.lw) ? Math.min(50, op.lw) : 0.75, ...(dashOf(op.dash) ? { dash: dashOf(op.dash) } : {}) });
      } else if (op.k === 'img' && okNum(op.x) && okNum(op.y) && okNum(op.w) && okNum(op.h) && typeof op.part === 'string' && /^[\w./ -]{1,300}$/.test(op.part) && !op.part.includes('..')) {
        const crop = Array.isArray(op.crop) && op.crop.length === 4 && op.crop.every((v) => okNum(v) && Math.abs(v) < 1) ? (op.crop.slice() as [number, number, number, number]) : undefined;
        ops.push({ k: 'img', x: op.x, y: op.y, w: op.w, h: op.h, part: op.part, ...(crop ? { crop } : {}), ...(okNum(op.rot) && op.rot ? { rot: op.rot } : {}), ...(op.fh ? { fh: 1 } : {}), ...(op.fv ? { fv: 1 } : {}) });
      } else if (op.k === 'e' && okNum(op.x) && okNum(op.y) && okNum(op.w) && okNum(op.h)) {
        ops.push({ k: 'e', x: op.x, y: op.y, w: op.w, h: op.h, ...paint(op) });
      } else if (op.k === 'pg' && Array.isArray(op.pts) && op.pts.length >= 4 && op.pts.length <= 20000 && op.pts.length % 2 === 0 && op.pts.every(okNum)) {
        const brk = Array.isArray(op.brk) && op.brk.length < 1000 && op.brk.every((v) => Number.isInteger(v) && v > 0 && v < op.pts.length / 2) ? op.brk.slice() : undefined;
        ops.push({ k: 'pg', pts: op.pts.slice(), ...(op.c ? { c: 1 } : {}), ...paint(op), ...(brk ? { brk } : {}) });
      }
    }
    const g = p.grid;
    const ints = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.length <= 20000 && a.every((v) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2_000_000);
    const nums = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((v) => okNum(v) && (v as number) >= 0);
    const grid: DLGrid | undefined =
      g && typeof g === 'object' && typeof g.sheet === 'string' && okNum(g.x) && okNum(g.y) && Array.isArray(g.rows) && Array.isArray(g.cols) && ints(g.rows, g.rows.length) && ints(g.cols, g.cols.length) && nums(g.heights, g.rows.length) && nums(g.widths, g.cols.length)
        ? { sheet: g.sheet.slice(0, 200), x: g.x, y: g.y, rows: g.rows.slice(), heights: g.heights.slice(), cols: g.cols.slice(), widths: g.widths.slice() }
        : undefined;
    pages.push({ w: p.w, h: p.h, ...(p.bg && COLOR.test(p.bg) ? { bg: p.bg } : {}), ops, ...(grid ? { grid } : {}) });
  }
  const kind = o.kind === 'pptx' || o.kind === 'xlsx' || o.kind === 'doc' ? o.kind : 'docx';
  const sha = typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : undefined;
  return {
    v: 1,
    kind,
    fonts,
    pages,
    notes: Array.isArray(o.notes) ? o.notes.filter((x): x is string => typeof x === 'string').slice(0, 50) : [],
    ...(sha ? { sha256: sha } : {}),
    ...(typeof o.by === 'string' ? { by: o.by.slice(0, 40) } : {}),
  };
}

/**
 * Draw one page. `ctx` maps page units (the caller scaled it); `image(part)` returns a decoded
 * picture or null (then a light placeholder box is drawn).
 */
export function drawDisplayPage(ctx: CanvasRenderingContext2D, dl: DisplayList, page: DLPage, image: (part: string) => CanvasImageSource | null): void {
  ctx.fillStyle = page.bg ?? '#ffffff';
  ctx.fillRect(0, 0, page.w, page.h);
  ctx.textBaseline = 'alphabetic';
  for (const op of page.ops) {
    if (op.k === 't') {
      const fam = dl.fonts[op.f] ?? 'sans-serif';
      if (op.rot && op.ox !== undefined && op.oy !== undefined) {
        // text of a rotated shape: turned around the shape's centre
        ctx.save();
        ctx.translate(op.ox, op.oy);
        ctx.rotate((op.rot * Math.PI) / 180);
        ctx.translate(-op.ox, -op.oy);
      }
      ctx.font = fontCss(op, fam);
      ctx.fillStyle = op.c ?? '#000000';
      // this device's font may be wider than the importing device's: squeeze to the stored width so
      // the text never runs into what follows (positions are fixed; only glyph shapes differ)
      const real = ctx.measureText(op.s).width;
      const w = op.w && real > op.w * 1.01 ? op.w : real;
      if (w < real) {
        ctx.save();
        ctx.translate(op.x, op.y);
        ctx.scale(w / real, 1);
        ctx.fillText(op.s, 0, 0);
        ctx.restore();
      } else ctx.fillText(op.s, op.x, op.y);
      if (op.u || op.st) ctx.fillRect(op.x, op.u ? op.y + op.z * 0.12 : op.y - op.z * 0.3, w, Math.max(0.5, op.z / 18));
      if (op.rot && op.ox !== undefined && op.oy !== undefined) ctx.restore();
    } else if (op.k === 'r') {
      if (op.fill) {
        ctx.fillStyle = op.fill;
        ctx.fillRect(op.x, op.y, op.w, op.h);
      }
      if (op.stroke) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = op.lw ?? 0.75;
        ctx.setLineDash(op.dash ?? []);
        ctx.strokeRect(op.x, op.y, op.w, op.h);
        ctx.setLineDash([]);
      }
    } else if (op.k === 'l') {
      ctx.strokeStyle = op.stroke;
      ctx.lineWidth = op.lw;
      ctx.setLineDash(op.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (op.k === 'e' || op.k === 'pg') {
      ctx.beginPath();
      if (op.k === 'e') ctx.ellipse(op.x + op.w / 2, op.y + op.h / 2, Math.abs(op.w / 2), Math.abs(op.h / 2), 0, 0, Math.PI * 2);
      else {
        const brk = new Set(op.brk ?? []);
        for (let i = 0; i < op.pts.length; i += 2) {
          if (i === 0 || brk.has(i / 2)) {
            if (i && op.c) ctx.closePath();
            ctx.moveTo(op.pts[i], op.pts[i + 1]);
          } else ctx.lineTo(op.pts[i], op.pts[i + 1]);
        }
        if (op.c) ctx.closePath();
      }
      if (op.fill) {
        ctx.fillStyle = op.fill;
        ctx.fill('evenodd');
      }
      if (op.stroke) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = op.lw ?? 0.75;
        ctx.lineJoin = 'round';
        ctx.setLineDash(op.dash ?? []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (op.k === 'img') {
      const im = image(op.part);
      if (im && (op.crop || op.rot || op.fh || op.fv)) {
        ctx.save();
        ctx.translate(op.x + op.w / 2, op.y + op.h / 2);
        if (op.rot) ctx.rotate((op.rot * Math.PI) / 180);
        ctx.scale(op.fh ? -1 : 1, op.fv ? -1 : 1);
        const iw = (im as { width: number }).width;
        const ih = (im as { height: number }).height;
        const [l, t, r, b] = op.crop ?? [0, 0, 0, 0];
        const sx = Math.max(0, l) * iw;
        const sy = Math.max(0, t) * ih;
        const sw = Math.max(1, (1 - Math.max(0, l) - Math.max(0, r)) * iw);
        const sh = Math.max(1, (1 - Math.max(0, t) - Math.max(0, b)) * ih);
        ctx.drawImage(im, sx, sy, Math.min(sw, iw - sx), Math.min(sh, ih - sy), -op.w / 2, -op.h / 2, op.w, op.h);
        ctx.restore();
      } else if (im) ctx.drawImage(im, op.x, op.y, op.w, op.h);
      else {
        ctx.fillStyle = '#f1f2f4';
        ctx.fillRect(op.x, op.y, op.w, op.h);
        ctx.strokeStyle = '#c9cdd3';
        ctx.lineWidth = 0.75;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      }
    }
  }
}
