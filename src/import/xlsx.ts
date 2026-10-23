/**
 * Excel (.xlsx) → fixed pages (0.9, Phase 5, option A).
 *
 * Every visible sheet is cut into pages along row and column ranges (about one screen of cells
 * each, down then across, like Excel's printing), frozen at import like Word pages. Each page
 * shows the sheet name and range, column letters and row numbers, gridlines, cell fills, borders,
 * merged cells, fonts and alignment, and the values as Excel shows them through their number
 * formats. Each page also stores its cell grid (row numbers / heights, column numbers / widths), so
 * any point on it — a stroke, a text box — maps back to its cell (`cellAt`).
 *
 * Values are what the file stores: formula results are the ones Excel saved last (never
 * recalculated — HandNote has no formula engine and does not pretend to), macros are never run,
 * external links are ignored. Charts, conditional formatting, comments, sparklines and pivot-table
 * behaviour are left out and listed in `notes`.
 */
import { cssFamily, type DLOp, type DLPage, type DisplayList, type DLGrid } from './display-list';
import { emitLines, flowLines, type Measurer, type RunStyle } from './flow';
import { BUILTIN_FORMATS, formatText, formatValue } from './numfmt';
import { attr, find, kid, kids, local, num, parseXml, type XNode } from './xml';
import { relsOf, resolvePart, type ZipArchive } from './zip';

const EMU = 1 / 12700;

export interface XlsxOptions {
  measure: Measurer;
  signal?: AbortSignal;
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
  yieldUi?: () => Promise<void>;
  /** cells with content laid out at most (a guard against runaway layouts) */
  maxCells?: number;
}

/** Page geometry (pt). */
/**
 * Pages are A4 sheets of paper (portrait, or landscape when the used columns are wider than a
 * portrait page), like a printout: the cells at their real size from the top-left corner, the rest
 * of the page free for notes (OneNote-style), never a page cut to the size of a few cells.
 */
export const XLSX_PAGE = { portrait: [595.28, 841.89] as const, landscape: [841.89, 595.28] as const, margin: 36, title: 20, colHdr: 16 };

// Excel's default indexed palette (indexes 0–63; 64 = system text, 65 = system background)
const INDEXED = '000000,FFFFFF,FF0000,00FF00,0000FF,FFFF00,FF00FF,00FFFF,000000,FFFFFF,FF0000,00FF00,0000FF,FFFF00,FF00FF,00FFFF,800000,008000,000080,808000,800080,008080,C0C0C0,808080,9999FF,993366,FFFFCC,CCFFFF,660066,FF8080,0066CC,CCCCFF,000080,FF00FF,FFFF00,00FFFF,800080,800000,008080,0000FF,00CCFF,CCFFFF,CCFFCC,FFFF99,99CCFF,FF99CC,CC99FF,FFCC99,3366FF,33CCCC,99CC00,FFCC00,FF9900,FF6600,666699,969696,003366,339966,003300,333300,993300,993366,333399,333333'.split(',');

export function colName(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** "BC12" → [row 12, col 55]. */
export function parseRef(ref: string): [number, number] | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref.toUpperCase());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), c];
}

/** The cell under a point of a sheet page ("Sheet1!C12"), or null outside the cells. */
export function cellAt(page: DLPage, x: number, y: number): { sheet: string; row: number; col: number; ref: string } | null {
  const g = page.grid;
  if (!g) return null;
  let yy = g.y;
  let row = -1;
  for (let i = 0; i < g.rows.length; i++) {
    if (y >= yy && y < yy + g.heights[i]) {
      row = g.rows[i];
      break;
    }
    yy += g.heights[i];
  }
  let xx = g.x;
  let col = -1;
  for (let i = 0; i < g.cols.length; i++) {
    if (x >= xx && x < xx + g.widths[i]) {
      col = g.cols[i];
      break;
    }
    xx += g.widths[i];
  }
  if (row < 0 || col < 0) return null;
  const ref = `${colName(col)}${row}`;
  return { sheet: g.sheet, row, col, ref: `${/^[A-Za-z_][\w.]*$/.test(g.sheet) ? g.sheet : `'${g.sheet.replace(/'/g, "''")}'`}!${ref}` };
}

const hsl = (rgb: [number, number, number]): [number, number, number] => {
  const [r, g, b] = rgb.map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
};
const rgbOf = ([h, s, l]: [number, number, number]): [number, number, number] => {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
};

interface Font {
  name?: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
}
interface Edge {
  c: string;
  lw: number;
  dash?: number[];
}
interface Border {
  left?: Edge;
  right?: Edge;
  top?: Edge;
  bottom?: Edge;
}
interface Xf {
  numFmt?: string;
  font: Font;
  fill?: string;
  pattern?: boolean;
  border: Border;
  h?: string;
  v?: string;
  wrap?: boolean;
  indent?: number;
  rot?: number;
}

export async function layoutXlsx(zip: ZipArchive, opts: XlsxOptions): Promise<DisplayList> {
  const notes = new Set<string>();
  const m = opts.measure;
  const maxPages = opts.maxPages ?? 2000;
  const maxCells = opts.maxCells ?? 400_000;
  const xml = async (part: string) => {
    const t = await zip.text(part);
    return t ? parseXml(t) : null;
  };
  const relsCache = new Map<string, Map<string, { target: string; type: string }>>();
  const rels = async (part: string) => {
    const hit = relsCache.get(part);
    if (hit) return hit;
    const out = new Map<string, { target: string; type: string }>();
    for (const r of kids((await xml(relsOf(part))) ?? undefined, 'Relationship')) {
      if (attr(r, 'TargetMode') === 'External') {
        notes.add('external-links');
        continue;
      }
      const id = attr(r, 'Id');
      const target = attr(r, 'Target');
      if (id && target) out.set(id, { target: resolvePart(part, target), type: (attr(r, 'Type') ?? '').split('/').pop() ?? '' });
    }
    relsCache.set(part, out);
    return out;
  };

  const wb = await xml('xl/workbook.xml');
  if (!wb) throw new Error('xl/workbook.xml is missing');
  const date1904 = ['1', 'true'].includes(attr(kid(wb, 'workbookPr'), 'date1904') ?? '');
  const wbRels = await rels('xl/workbook.xml');
  if ([...wbRels.values()].some((r) => r.type === 'externalLink')) notes.add('external-links');

  // theme colours (SpreadsheetML theme index order: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink)
  const themePart = [...wbRels.values()].find((r) => r.type === 'theme')?.target ?? 'xl/theme/theme1.xml';
  const theme = await xml(themePart);
  const scheme = find(theme ?? undefined, 'a:clrScheme')[0];
  const tc = (n: string, d: string) => {
    const e = kid(scheme, `a:${n}`)?.children[0];
    return (e?.name === 'a:sysClr' ? attr(e, 'lastClr') : attr(e, 'val')) ?? d;
  };
  const themeColors = [tc('lt1', 'FFFFFF'), tc('dk1', '000000'), tc('lt2', 'E7E6E6'), tc('dk2', '44546A'), tc('accent1', '4472C4'), tc('accent2', 'ED7D31'), tc('accent3', 'A5A5A5'), tc('accent4', 'FFC000'), tc('accent5', '5B9BD5'), tc('accent6', '70AD47'), tc('hlink', '0563C1'), tc('folHlink', '954F72')];
  const minorFont = attr(kid(kid(find(theme ?? undefined, 'a:fontScheme')[0], 'a:minorFont'), 'a:latin'), 'typeface');

  const color = (n: XNode | undefined, fallback?: string): string | undefined => {
    if (!n) return fallback;
    if (attr(n, 'auto') === '1') return fallback;
    let hex: string | undefined;
    const rgb = attr(n, 'rgb');
    if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) hex = rgb.slice(-6);
    else if (attr(n, 'theme') !== undefined) hex = themeColors[num(attr(n, 'theme'))];
    else if (attr(n, 'indexed') !== undefined) {
      const i = num(attr(n, 'indexed'));
      hex = i === 64 ? '000000' : i === 65 ? 'FFFFFF' : INDEXED[i];
    }
    if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return fallback;
    let c: [number, number, number] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    const tint = num(attr(n, 'tint'));
    if (tint) {
      const h = hsl(c);
      h[2] = tint < 0 ? h[2] * (1 + tint) : h[2] * (1 - tint) + tint;
      c = rgbOf(h);
    }
    return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  };

  // ---- styles
  const st = await xml('xl/styles.xml');
  const numFmts = new Map<number, string>();
  for (const f of kids(kid(st ?? undefined, 'numFmts'), 'numFmt')) numFmts.set(num(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? 'General');
  const fonts: Font[] = kids(kid(st ?? undefined, 'fonts'), 'font').map((f) => {
    const flag = (n: string) => {
      const e = kid(f, n);
      return e ? !['0', 'false'].includes(attr(e, 'val') ?? '1') : undefined;
    };
    const u = kid(f, 'u');
    return { name: attr(kid(f, 'name'), 'val') ?? minorFont, size: num(attr(kid(f, 'sz'), 'val'), 11), bold: flag('b'), italic: flag('i'), underline: u ? attr(u, 'val') !== 'none' : undefined, strike: flag('strike'), color: color(kid(f, 'color')) };
  });
  if (!fonts.length) fonts.push({ name: minorFont ?? 'Calibri', size: 11 });
  // patterned / gradient fills are drawn in one colour; noted only when a cell on a page uses one
  const patternFills = new Set<number>();
  const fills: (string | undefined)[] = kids(kid(st ?? undefined, 'fills'), 'fill').map((f, fi) => {
    const p = kid(f, 'patternFill');
    if (p) {
      const type = attr(p, 'patternType') ?? (kid(p, 'fgColor') ? 'solid' : 'none');
      if (type === 'none' || type === 'gray125') return undefined;
      if (type !== 'solid') patternFills.add(fi);
      return color(kid(p, 'fgColor')) ?? color(kid(p, 'bgColor'));
    }
    const g = kid(f, 'gradientFill');
    if (g) {
      patternFills.add(fi);
      return color(kid(kids(g, 'stop')[0], 'color'));
    }
    return undefined;
  });
  const edge = (e: XNode | undefined): Edge | undefined => {
    const style = attr(e, 'style');
    if (!e || !style || style === 'none') return undefined;
    const c = color(kid(e, 'color'), '#000000') ?? '#000000';
    const lw = /thick/.test(style) ? 2.25 : /medium/i.test(style) ? 1.5 : style === 'double' ? 1.5 : style === 'hair' ? 0.35 : 0.75;
    const dash = /dashDotDot/i.test(style) ? [4, 2, 1, 2, 1, 2] : /dashDot/i.test(style) ? [4, 2, 1, 2] : /dash/i.test(style) ? [3, 2] : /dotted|hair/.test(style) ? [1, 1.5] : undefined;
    return { c, lw, ...(dash ? { dash } : {}) };
  };
  const borders: Border[] = kids(kid(st ?? undefined, 'borders'), 'border').map((b) => ({ left: edge(kid(b, 'left') ?? kid(b, 'start')), right: edge(kid(b, 'right') ?? kid(b, 'end')), top: edge(kid(b, 'top')), bottom: edge(kid(b, 'bottom')) }));
  const xfs: Xf[] = kids(kid(st ?? undefined, 'cellXfs'), 'xf').map((x) => {
    const al = kid(x, 'alignment');
    const id = num(attr(x, 'numFmtId'));
    const rot = num(attr(al, 'textRotation'));
    return {
      numFmt: numFmts.get(id) ?? BUILTIN_FORMATS[id],
      font: fonts[num(attr(x, 'fontId'))] ?? fonts[0],
      fill: fills[num(attr(x, 'fillId'))],
      ...(patternFills.has(num(attr(x, 'fillId'))) ? { pattern: true } : {}),
      border: borders[num(attr(x, 'borderId'))] ?? {},
      h: attr(al, 'horizontal'),
      v: attr(al, 'vertical'),
      wrap: attr(al, 'wrapText') === '1' || attr(al, 'wrapText') === 'true',
      indent: num(attr(al, 'indent')),
      rot: rot === 255 ? 90 : rot > 90 ? -(rot - 90) : rot,
    };
  });
  const defXf: Xf = xfs[0] ?? { font: fonts[0], border: {} };

  // ---- shared strings
  const shared: string[] = [];
  const sst = await xml('xl/sharedStrings.xml');
  for (const si of kids(sst ?? undefined, 'si')) {
    // phonetic guides (rPh) are not part of the cell text
    const parts: string[] = [];
    const walk = (n: XNode) => {
      for (const c of n.children) {
        if (c.name === 'rPh' || c.name === 'phoneticPr') continue;
        if (c.name === 't') parts.push(c.text);
        else walk(c);
      }
    };
    walk(si);
    shared.push(parts.join(''));
  }

  const fontList: string[] = [];
  const fontIx = (name: string | undefined) => {
    const css = cssFamily(name, 'sans');
    let i = fontList.indexOf(css);
    if (i < 0) i = fontList.push(css) - 1;
    return i;
  };
  const runStyle = (f: Font, colorOverride?: string): RunStyle => ({
    font: fontIx(f.name),
    size: Math.max(1, Math.min(200, f.size)),
    ...(f.bold ? { bold: true } : {}),
    ...(f.italic ? { italic: true } : {}),
    ...((colorOverride ?? f.color) && (colorOverride ?? f.color) !== '#000000' ? { color: colorOverride ?? f.color } : {}),
    ...(f.underline ? { underline: true } : {}),
    ...(f.strike ? { strike: true } : {}),
  });
  const css = (s: RunStyle) => `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${s.size}px ${fontList[s.font] ?? 'sans-serif'}`;

  const pages: DLPage[] = [];
  let cellsSeen = 0;
  const sheets = kids(kid(wb, 'sheets'), 'sheet');
  let last = Date.now();

  for (const [si, sh] of sheets.entries()) {
    if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const name = attr(sh, 'name') ?? `Sheet${si + 1}`;
    if (attr(sh, 'state') === 'hidden' || attr(sh, 'state') === 'veryHidden') {
      notes.add('hidden-sheets');
      continue;
    }
    const rel = wbRels.get(attr(sh, 'r:id') ?? '');
    if (!rel) continue;
    if (rel.type === 'chartsheet') {
      notes.add('charts');
      continue;
    }
    const ws = await xml(rel.target);
    if (!ws) continue;
    opts.onProgress?.(si, sheets.length);
    const sheetView = kid(kid(ws, 'sheetViews'), 'sheetView');
    const gridlines = attr(sheetView, 'showGridLines') !== '0';
    if (kid(ws, 'conditionalFormatting')) notes.add('conditional-formatting');
    if (kid(ws, 'legacyDrawing')) notes.add('comments');

    // column widths (characters → pt, as Excel computes pixels for the default font)
    const sfp = kid(ws, 'sheetFormatPr');
    const defRowH = num(attr(sfp, 'defaultRowHeight'), 15) || 15;
    const charW = 7; // maximum digit width of Calibri 11 at 96 dpi
    const colPt = (w: number) => (Math.trunc(((256 * w + Math.trunc(128 / charW)) / 256) * charW) * 0.75);
    // default: baseColWidth characters + padding (8 → Excel's 64 px = 48 pt)
    const defColW = attr(sfp, 'defaultColWidth') !== undefined ? colPt(num(attr(sfp, 'defaultColWidth'))) : (num(attr(sfp, 'baseColWidth'), 8) * charW + 8) * 0.75;
    const colW = new Map<number, number>();
    const colHidden = new Set<number>();
    const colStyle = new Map<number, number>();
    for (const c of kids(kid(ws, 'cols'), 'col')) {
      const a = num(attr(c, 'min'));
      const b = Math.min(num(attr(c, 'max')), a + 16384);
      for (let k = a; k <= b; k++) {
        if (attr(c, 'hidden') === '1' || attr(c, 'hidden') === 'true') colHidden.add(k);
        if (attr(c, 'width') !== undefined) colW.set(k, colPt(num(attr(c, 'width'))));
        if (attr(c, 'style') !== undefined) colStyle.set(k, num(attr(c, 'style')));
      }
    }
    const widthOf = (c: number) => (colHidden.has(c) ? 0 : (colW.get(c) ?? defColW));

    // rows and cells
    interface Cell {
      text: string;
      kind: 'n' | 's' | 'b' | 'e';
      xf: Xf;
      color?: string;
    }
    const cells = new Map<number, Map<number, Cell>>();
    const styled = new Map<number, Map<number, Xf>>();
    const rowH = new Map<number, number>();
    const rowCustom = new Set<number>();
    const rowHidden = new Set<number>();
    let maxR = 0;
    let maxC = 0;
    let rowSeq = 0;
    for (const r of kids(kid(ws, 'sheetData'), 'row')) {
      const rn = num(attr(r, 'r'), rowSeq + 1);
      rowSeq = rn;
      if (attr(r, 'hidden') === '1' || attr(r, 'hidden') === 'true') rowHidden.add(rn);
      if (attr(r, 'ht') !== undefined) rowH.set(rn, num(attr(r, 'ht'), defRowH));
      if (attr(r, 'customHeight') === '1' || attr(r, 'customHeight') === 'true') rowCustom.add(rn);
      let colSeq = 0;
      for (const c of kids(r, 'c')) {
        const ref = parseRef(attr(c, 'r') ?? '') ?? [rn, colSeq + 1];
        const cn = ref[1];
        colSeq = cn;
        const xf = xfs[num(attr(c, 's'), colStyle.get(cn) ?? 0)] ?? defXf;
        const t = attr(c, 't') ?? 'n';
        const v = kid(c, 'v')?.text;
        const f = kid(c, 'f');
        if (f) notes.add(v === undefined ? 'formulas-no-value' : 'formulas-cached');
        let cell: Cell | null = null;
        if (t === 's' && v !== undefined) cell = { text: formatText(shared[num(v)] ?? '', xf.numFmt), kind: 's', xf };
        else if (t === 'inlineStr') cell = { text: formatText(find(kid(c, 'is'), 't').map((x) => x.text).join(''), xf.numFmt), kind: 's', xf };
        else if (t === 'str' && v !== undefined) cell = { text: formatText(v, xf.numFmt), kind: 's', xf };
        else if (t === 'b' && v !== undefined) cell = { text: v === '1' ? 'TRUE' : 'FALSE', kind: 'b', xf };
        else if (t === 'e' && v !== undefined) cell = { text: v, kind: 'e', xf };
        else if (t === 'd' && v !== undefined) {
          const ms = Date.parse(v);
          if (Number.isFinite(ms)) {
            const serial = ms / 86400000 + (date1904 ? 24107 : 25569);
            const fm = formatValue(serial, xf.numFmt && xf.numFmt !== 'General' ? xf.numFmt : 'yyyy/m/d', date1904);
            cell = { text: fm.text, kind: 'n', xf, ...(fm.color ? { color: fm.color } : {}) };
          }
        } else if (v !== undefined && v !== '') {
          const x = Number(v);
          if (Number.isFinite(x)) {
            const fm = formatValue(x, xf.numFmt, date1904);
            cell = { text: fm.text, kind: 'n', xf, ...(fm.color ? { color: fm.color } : {}) };
          }
        }
        if (cell && cell.text !== '') {
          if (!cells.has(rn)) cells.set(rn, new Map());
          cells.get(rn)?.set(cn, cell);
          maxR = Math.max(maxR, rn);
          maxC = Math.max(maxC, cn);
          if (++cellsSeen > maxCells) throw new Error(`the workbook has more than ${maxCells} filled cells — save the part you need as PDF and import that`);
        } else if (xf.fill || xf.border.left || xf.border.right || xf.border.top || xf.border.bottom) {
          if (!styled.has(rn)) styled.set(rn, new Map());
          styled.get(rn)?.set(cn, xf);
          maxR = Math.max(maxR, rn);
          maxC = Math.max(maxC, cn);
        }
      }
      if (Date.now() - last > 40) {
        await (opts.yieldUi ? opts.yieldUi() : Promise.resolve());
        last = Date.now();
        if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      }
    }

    // text running over empty cells past the last used column belongs to the page (as Excel prints it)
    for (const row of cells.values())
      for (const [c, cell] of row) {
        if (cell.kind !== 's' || cell.xf.wrap || (cell.xf.h && cell.xf.h !== 'left' && cell.xf.h !== 'general')) continue;
        if (row.has(c + 1)) continue;
        let need = m.width(cell.text, css(runStyle(cell.xf.font))) - (widthOf(c) - 4);
        let k = c;
        while (need > 0 && k < c + 26 && !row.has(k + 1)) {
          k++;
          need -= widthOf(k);
        }
        if (k > maxC) maxC = k;
      }

    // merged cells
    const merges: { r1: number; c1: number; r2: number; c2: number }[] = [];
    const covered = new Set<string>();
    for (const mc of kids(kid(ws, 'mergeCells'), 'mergeCell')) {
      const [a, b] = (attr(mc, 'ref') ?? '').split(':');
      const p = parseRef(a ?? '');
      const q = parseRef(b ?? a ?? '');
      if (!p || !q) continue;
      const mg = { r1: Math.min(p[0], q[0]), c1: Math.min(p[1], q[1]), r2: Math.max(p[0], q[0]), c2: Math.max(p[1], q[1]) };
      if ((mg.r2 - mg.r1 + 1) * (mg.c2 - mg.c1 + 1) > 1_000_000) continue;
      merges.push(mg);
      for (let r = mg.r1; r <= mg.r2; r++) for (let c = mg.c1; c <= mg.c2; c++) if (r !== mg.r1 || c !== mg.c1) covered.add(`${r}:${c}`);
      maxR = Math.max(maxR, mg.r2);
      maxC = Math.max(maxC, mg.c2);
    }
    const mergeAt = new Map(merges.map((mg) => [`${mg.r1}:${mg.c1}`, mg]));

    // pictures (drawing anchors), positioned in sheet coordinates later
    interface Pic {
      part: string;
      from: [number, number, number, number]; // col, colOff pt, row, rowOff pt
      to?: [number, number, number, number];
      ext?: [number, number];
    }
    const pics: Pic[] = [];
    const drawingRid = attr(kid(ws, 'drawing'), 'r:id');
    if (drawingRid) {
      const sRels = await rels(rel.target);
      const dPart = sRels.get(drawingRid)?.target;
      const drawing = dPart ? await xml(dPart) : null;
      const dRels = dPart ? await rels(dPart) : new Map<string, { target: string; type: string }>();
      for (const anchor of drawing?.children ?? []) {
        const an = local(anchor.name);
        if (!/Anchor$/.test(an)) continue;
        if (find(anchor, 'c:chart').length) {
          notes.add('charts');
          continue;
        }
        const blip = find(anchor, 'a:blip')[0];
        const target = dRels.get(attr(blip, 'r:embed') ?? '')?.target;
        if (!target) {
          if (find(anchor, 'xdr:sp').length || find(anchor, 'xdr:grpSp').length) notes.add('shapes');
          continue;
        }
        const pt = (n: XNode | undefined): [number, number, number, number] => [num(kid(n, 'xdr:col')?.text) + 1, num(kid(n, 'xdr:colOff')?.text) * EMU, num(kid(n, 'xdr:row')?.text) + 1, num(kid(n, 'xdr:rowOff')?.text) * EMU];
        const ext = kid(anchor, 'xdr:ext') ?? find(anchor, 'a:ext')[0];
        if (an === 'absoluteAnchor') {
          const pos = kid(anchor, 'xdr:pos');
          pics.push({ part: target, from: [1, num(attr(pos, 'x')) * EMU, 1, num(attr(pos, 'y')) * EMU], ext: [num(attr(ext, 'cx')) * EMU, num(attr(ext, 'cy')) * EMU] });
        } else
          pics.push({ part: target, from: pt(kid(anchor, 'xdr:from')), ...(an === 'twoCellAnchor' ? { to: pt(kid(anchor, 'xdr:to')) } : { ext: [num(attr(ext, 'cx')) * EMU, num(attr(ext, 'cy')) * EMU] as [number, number] }) });
        maxR = Math.max(maxR, pics[pics.length - 1].to?.[2] ?? pics[pics.length - 1].from[2]);
        maxC = Math.max(maxC, pics[pics.length - 1].to?.[0] ?? pics[pics.length - 1].from[0]);
      }
    }
    if (!maxR || !maxC) continue; // an empty sheet makes no page

    // row heights: stored, or grown for wrapped text (Excel auto-fits rows without a custom height)
    const heightOf = (r: number) => (rowHidden.has(r) ? 0 : (rowH.get(r) ?? defRowH));
    for (const [r, row] of cells) {
      if (rowCustom.has(r) || rowHidden.has(r)) continue;
      let need = 0;
      for (const [c, cell] of row) {
        if (!cell.xf.wrap || mergeAt.has(`${r}:${c}`)) continue;
        const s = runStyle(cell.xf.font);
        const lines = flowLines([{ kind: 'text', text: cell.text, style: s }], Math.max(4, widthOf(c) - 4), 0, m, fontList, (z) => z * 1.25);
        need = Math.max(need, lines.reduce((a, l) => a + l.height, 0) + 3);
      }
      if (need > heightOf(r)) rowH.set(r, Math.min(409, need));
    }

    // page breaks: columns across, rows down; never inside a merged range when avoidable
    const groups = (n: number, size: (i: number) => number, max: number, mergeSpan: (i: number) => number): [number, number][] => {
      const out: [number, number][] = [];
      let start = 1;
      let acc = 0;
      for (let i = 1; i <= n; i++) {
        const w = size(i);
        if (acc + w > max && i > start) {
          // move the break before a merged range that would be cut
          let br = i;
          const back = mergeSpan(i);
          if (back < i && back > start) br = back;
          out.push([start, br - 1]);
          start = br;
          acc = 0;
          for (let k = br; k < i; k++) acc += size(k);
        }
        acc += w;
      }
      out.push([start, n]);
      return out;
    };
    const mergeStartCol = (c: number) => Math.min(c, ...merges.filter((mg) => mg.c1 < c && mg.c2 >= c).map((mg) => mg.c1));
    const mergeStartRow = (r: number) => Math.min(r, ...merges.filter((mg) => mg.r1 < r && mg.r2 >= r).map((mg) => mg.r1));
    const hdrDigits = String(maxR).length;
    const rowHdrW = Math.max(24, hdrDigits * 6.5 + 10);
    let usedW = 0;
    for (let c = 1; c <= maxC; c++) usedW += widthOf(c);
    const M = XLSX_PAGE.margin;
    const portraitW = XLSX_PAGE.portrait[0] - 2 * M - rowHdrW;
    const [PW, PH] = usedW <= portraitW ? XLSX_PAGE.portrait : XLSX_PAGE.landscape;
    const maxW = PW - 2 * M - rowHdrW;
    const maxH = PH - 2 * M - XLSX_PAGE.title - XLSX_PAGE.colHdr;
    const colGroups = groups(maxC, widthOf, maxW, mergeStartCol).filter(([a, b]) => {
      for (let c = a; c <= b; c++) if (widthOf(c) > 0) return true;
      return false;
    });
    const rowGroups = groups(maxR, heightOf, maxH, mergeStartRow).filter(([a, b]) => {
      for (let r = a; r <= b; r++) if (heightOf(r) > 0) return true;
      return false;
    });
    if (pages.length + colGroups.length * rowGroups.length > maxPages) throw new Error(`the workbook needs more than ${maxPages} pages — save the part you need as PDF and import that`);

    const HDR_FILL = '#f3f3f3';
    const HDR_LINE = '#c8c8c8';
    const GRID = '#d9d9d9';
    const hdrStyle: RunStyle = { font: fontIx('Calibri'), size: 9, color: '#555555' };

    // pages: down, then across
    for (const [c1, c2] of colGroups) {
      for (const [r1, r2] of rowGroups) {
        if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        const rowsOn: number[] = [];
        const heights: number[] = [];
        for (let r = r1; r <= r2; r++)
          if (heightOf(r) > 0) {
            rowsOn.push(r);
            heights.push(heightOf(r));
          }
        const colsOn: number[] = [];
        const widths: number[] = [];
        for (let c = c1; c <= c2; c++)
          if (widthOf(c) > 0) {
            colsOn.push(c);
            widths.push(widthOf(c));
          }
        const gw = widths.reduce((a, b) => a + b, 0);
        const gh = heights.reduce((a, b) => a + b, 0);
        const x0 = M + rowHdrW;
        const y0 = M + XLSX_PAGE.title + XLSX_PAGE.colHdr;
        // a column / row bigger than the paper grows the page (rare); otherwise A4
        const W = Math.max(PW, x0 + gw + M);
        const H = Math.max(PH, y0 + gh + M);
        const ops: DLOp[] = [];
        const colX = new Map<number, number>();
        let xx = x0;
        colsOn.forEach((c, i) => {
          colX.set(c, xx);
          xx += widths[i];
        });
        const rowY = new Map<number, number>();
        let yy = y0;
        rowsOn.forEach((r, i) => {
          rowY.set(r, yy);
          yy += heights[i];
        });
        const spanX = (a: number, b: number) => {
          let x1: number | undefined;
          let x2 = 0;
          for (let c = a; c <= b; c++) {
            const cx = colX.get(c);
            if (cx === undefined) continue;
            x1 ??= cx;
            x2 = cx + widthOf(c);
          }
          return x1 === undefined ? null : [x1, x2];
        };
        const spanY = (a: number, b: number) => {
          let y1: number | undefined;
          let y2 = 0;
          for (let r = a; r <= b; r++) {
            const ry = rowY.get(r);
            if (ry === undefined) continue;
            y1 ??= ry;
            y2 = ry + heightOf(r);
          }
          return y1 === undefined ? null : [y1, y2];
        };

        // title: sheet and range
        const titleText = `${name} · ${colName(colsOn[0] ?? c1)}${rowsOn[0] ?? r1}:${colName(colsOn[colsOn.length - 1] ?? c2)}${rowsOn[rowsOn.length - 1] ?? r2}`;
        ops.push({ k: 't', x: M, y: M + 13, s: titleText, f: fontIx('Calibri'), z: 10, c: '#666666', w: Math.round(m.width(titleText, `10px ${fontList[fontIx('Calibri')]}`) * 100) / 100 });

        // headers
        ops.push({ k: 'r', x: x0, y: y0 - XLSX_PAGE.colHdr, w: gw, h: XLSX_PAGE.colHdr, fill: HDR_FILL });
        ops.push({ k: 'r', x: M, y: y0, w: rowHdrW, h: gh, fill: HDR_FILL });
        ops.push({ k: 'r', x: M, y: y0 - XLSX_PAGE.colHdr, w: rowHdrW, h: XLSX_PAGE.colHdr, fill: '#e8e8e8' });
        colsOn.forEach((c, i) => {
          const label = colName(c);
          const lw = m.width(label, css(hdrStyle));
          const cx = colX.get(c) ?? 0;
          if (widths[i] > lw + 2) ops.push({ k: 't', x: cx + (widths[i] - lw) / 2, y: y0 - 4.5, s: label, f: hdrStyle.font, z: 9, c: '#555555', w: Math.round(lw * 100) / 100 });
          ops.push({ k: 'l', x1: cx + widths[i], y1: y0 - XLSX_PAGE.colHdr, x2: cx + widths[i], y2: y0, stroke: HDR_LINE, lw: 0.5 });
        });
        rowsOn.forEach((r, i) => {
          const label = String(r);
          const lw = m.width(label, css(hdrStyle));
          const ry = rowY.get(r) ?? 0;
          if (heights[i] >= 8) ops.push({ k: 't', x: M + (rowHdrW - lw) / 2, y: ry + Math.min(heights[i], 15) - 4, s: label, f: hdrStyle.font, z: 9, c: '#555555', w: Math.round(lw * 100) / 100 });
          ops.push({ k: 'l', x1: M, y1: ry + heights[i], x2: x0, y2: ry + heights[i], stroke: HDR_LINE, lw: 0.5 });
        });
        ops.push({ k: 'l', x1: x0, y1: y0 - XLSX_PAGE.colHdr, x2: x0, y2: y0 + gh, stroke: HDR_LINE, lw: 0.75 });
        ops.push({ k: 'l', x1: M, y1: y0, x2: x0 + gw, y2: y0, stroke: HDR_LINE, lw: 0.75 });

        // gridlines
        if (gridlines) {
          for (const c of colsOn) {
            const gx = (colX.get(c) ?? 0) + widthOf(c);
            ops.push({ k: 'l', x1: gx, y1: y0, x2: gx, y2: y0 + gh, stroke: GRID, lw: 0.5 });
          }
          for (const r of rowsOn) {
            const gy = (rowY.get(r) ?? 0) + heightOf(r);
            ops.push({ k: 'l', x1: x0, y1: gy, x2: x0 + gw, y2: gy, stroke: GRID, lw: 0.5 });
          }
        }

        // fills, then borders, then text (merged cells first cover their gridlines)
        const boxOf = (r: number, c: number): [number, number, number, number] | null => {
          const mg = mergeAt.get(`${r}:${c}`);
          const sx = mg ? spanX(c, mg.c2) : spanX(c, c);
          const sy = mg ? spanY(r, mg.r2) : spanY(r, r);
          if (!sx || !sy) return null;
          return [sx[0], sy[0], sx[1] - sx[0], sy[1] - sy[0]];
        };
        const visit = (fn: (r: number, c: number, xf: Xf, cell?: Cell) => void) => {
          for (const r of rowsOn) {
            const row = cells.get(r);
            const srow = styled.get(r);
            for (const c of colsOn) {
              if (covered.has(`${r}:${c}`)) continue;
              const cell = row?.get(c);
              const xf = cell?.xf ?? srow?.get(c);
              if (xf) fn(r, c, xf, cell);
            }
          }
          // merged ranges that start above / left of this page
          for (const mg of merges) {
            if (mg.r1 >= r1 && mg.c1 >= c1) continue;
            if (mg.r2 < r1 || mg.c2 < c1 || mg.r1 > r2 || mg.c1 > c2) continue;
            notes.add('split-merges');
          }
        };
        visit((r, c, xf) => {
          const mg = mergeAt.get(`${r}:${c}`);
          if (mg) {
            const b = boxOf(r, c);
            if (b) ops.push({ k: 'r', x: b[0], y: b[1], w: b[2], h: b[3], fill: xf.fill ?? '#ffffff' });
          } else if (xf.fill) {
            if (xf.pattern) notes.add('patterns');
            const b = boxOf(r, c);
            if (b) ops.push({ k: 'r', x: b[0], y: b[1], w: b[2], h: b[3], fill: xf.fill });
          }
        });
        visit((r, c, xf) => {
          const b = boxOf(r, c);
          if (!b) return;
          const [bx, by, bw, bh] = b;
          const e = (ed: Edge | undefined, x1: number, y1: number, x2: number, y2: number) => {
            if (ed) ops.push({ k: 'l', x1, y1, x2, y2, stroke: ed.c, lw: ed.lw, ...(ed.dash ? { dash: ed.dash } : {}) });
          };
          e(xf.border.top, bx, by, bx + bw, by);
          e(xf.border.bottom, bx, by + bh, bx + bw, by + bh);
          e(xf.border.left, bx, by, bx, by + bh);
          e(xf.border.right, bx + bw, by, bx + bw, by + bh);
        });
        visit((r, c, xf, cell) => {
          if (!cell) return;
          const b = boxOf(r, c);
          if (!b) return;
          const [bx, by, bw, bh] = b;
          const s = runStyle(xf.font, cell.color);
          const h = xf.h && xf.h !== 'general' ? xf.h : cell.kind === 'n' ? 'right' : cell.kind === 'b' || cell.kind === 'e' ? 'center' : 'left';
          const pad = 2 + (xf.indent ?? 0) * 9;
          const first = ops.length;
          if (xf.wrap || h === 'justify' || h === 'distributed') {
            const lines = flowLines([{ kind: 'text', text: cell.text, style: s }], Math.max(4, bw - pad - 2), 0, m, fontList, (z) => z * 1.25);
            const th = lines.reduce((a, l) => a + l.height, 0);
            const ty = xf.v === 'top' ? by + 1 : xf.v === 'center' ? by + (bh - th) / 2 : by + bh - th - 1;
            emitLines(lines, bx + pad, ty, bw - pad - 2, h === 'center' ? 'ctr' : h === 'right' ? 'r' : 'l', m, fontList, ops);
          } else {
            let text = cell.text.replace(/\r?\n/g, ' ');
            let tw = m.width(text, css(s));
            // room to the right / left: text runs over empty neighbours, like Excel; numbers never do
            let room = bw - pad - 2;
            const mergeHere = mergeAt.has(`${r}:${c}`);
            if (cell.kind === 's' && !mergeHere && tw > room) {
              const step = h === 'right' ? -1 : 1;
              for (let k = c + step; k >= c1 && k <= c2; k += step) {
                if (!colX.has(k)) continue; // a hidden column: the text runs on past it
                if (cells.get(r)?.has(k) || covered.has(`${r}:${k}`) || mergeAt.has(`${r}:${k}`)) break;
                room += widthOf(k);
                if (tw <= room) break;
              }
            }
            if (tw > room) {
              if (cell.kind === 'n') {
                text = '#'.repeat(Math.max(1, Math.floor((bw - 4) / Math.max(1, m.width('#', css(s))))));
                tw = m.width(text, css(s));
              } else {
                // cut at the cell edge (the next cell has content)
                while (text.length > 1 && m.width(text, css(s)) > room) text = text.slice(0, -1);
                tw = m.width(text, css(s));
              }
            }
            const tx = h === 'right' ? bx + bw - 2 - tw - (xf.indent ?? 0) * 9 : h === 'center' || h === 'centerContinuous' ? bx + (bw - tw) / 2 : bx + pad;
            const ty = xf.v === 'top' ? by + s.size * 0.95 + 1 : xf.v === 'center' ? by + bh / 2 + s.size * 0.35 : by + bh - s.size * 0.22 - 1.5;
            if (text) ops.push({ k: 't', x: tx, y: ty, s: text, f: s.font, z: s.size, w: Math.round(tw * 100) / 100, ...(s.color ? { c: s.color } : {}), ...(s.bold ? { b: 1 as const } : {}), ...(s.italic ? { i: 1 as const } : {}), ...(s.underline ? { u: 1 as const } : {}), ...(s.strike ? { st: 1 as const } : {}) });
          }
          if (xf.rot) {
            const ox = Math.round((bx + bw / 2) * 100) / 100;
            const oy = Math.round((by + bh / 2) * 100) / 100;
            for (let i = first; i < ops.length; i++) {
              const o = ops[i];
              if (o.k === 't') Object.assign(o, { rot: -xf.rot, ox, oy });
            }
          }
        });

        // pictures over the cells (the part on this page; a picture across a page break is split)
        const sheetX = (c: number) => {
          let x = 0;
          for (let k = 1; k < c; k++) x += widthOf(k);
          return x;
        };
        const sheetY = (r: number) => {
          let y = 0;
          for (let k = 1; k < r; k++) y += heightOf(k);
          return y;
        };
        const pageSX = sheetX(colsOn[0] ?? c1);
        const pageSY = sheetY(rowsOn[0] ?? r1);
        for (const p of pics) {
          const px1 = sheetX(p.from[0]) + p.from[1];
          const py1 = sheetY(p.from[2]) + p.from[3];
          const px2 = p.to ? sheetX(p.to[0]) + p.to[1] : px1 + (p.ext?.[0] ?? 0);
          const py2 = p.to ? sheetY(p.to[2]) + p.to[3] : py1 + (p.ext?.[1] ?? 0);
          const iw = px2 - px1;
          const ih = py2 - py1;
          if (iw <= 0 || ih <= 0) continue;
          const vx1 = Math.max(px1, pageSX);
          const vy1 = Math.max(py1, pageSY);
          const vx2 = Math.min(px2, pageSX + gw);
          const vy2 = Math.min(py2, pageSY + gh);
          if (vx2 <= vx1 || vy2 <= vy1) continue;
          const crop: [number, number, number, number] = [(vx1 - px1) / iw, (vy1 - py1) / ih, (px2 - vx2) / iw, (py2 - vy2) / ih];
          ops.push({ k: 'img', x: x0 + vx1 - pageSX, y: y0 + vy1 - pageSY, w: vx2 - vx1, h: vy2 - vy1, part: p.part, ...(crop.some((v) => v > 0.0001) ? { crop: crop.map((v) => Math.round(v * 10000) / 10000) as [number, number, number, number] } : {}) });
        }

        const grid: DLGrid = { sheet: name.slice(0, 200), x: x0, y: y0, rows: rowsOn, heights, cols: colsOn, widths };
        pages.push({ w: W, h: H, ops, grid });
      }
    }
  }
  if (!pages.length) throw new Error('the workbook has no visible cells');

  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const pg of pages) {
    pg.w = r2(pg.w);
    pg.h = r2(pg.h);
    for (const op of pg.ops) {
      const o = op as unknown as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'number' && k !== 'f') o[k] = r2(v);
      }
    }
    if (pg.grid) {
      pg.grid.x = r2(pg.grid.x);
      pg.grid.y = r2(pg.grid.y);
      pg.grid.heights = pg.grid.heights.map(r2);
      pg.grid.widths = pg.grid.widths.map(r2);
    }
  }
  return { v: 1, kind: 'xlsx', fonts: fontList, pages, notes: [...notes] };
}
