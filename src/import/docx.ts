/**
 * Word (.docx) → fixed pages for annotation (0.9, Phase 3).
 *
 * Reads the document part, styles, numbering, theme fonts and relationships with HandNote's own
 * XML reader (no DTDs, no external entities, nothing executed), and lays the body out on pages of
 * the document's size: paragraphs (styles, headings, alignment, indents, spacing, line spacing,
 * runs with bold / italic / underline / strike / colour / size / highlight / super- and
 * subscript), bullets and numbered lists, manual line and page breaks, tabs, inline pictures,
 * tables (column widths, merged cells, shading, borders) and section page sizes.
 *
 * Not a Word replica: the page break positions are HandNote's own (fonts differ per device, which is
 * exactly why the result is computed once and stored). Headers / footers, footnotes, floating text
 * boxes, charts, SmartArt, equations and comments are left out and listed in `notes`.
 */
import { cssFamily, type DLOp, type DLPage, type DisplayList } from './display-list';
import { flowLines, cssOf, effSize, type Line, type Measurer, type Run, type RunStyle } from './flow';
import { attr, find, kid, kids, num, parseXml, type XNode } from './xml';
import { relsOf, resolvePart } from './zip';

const TW = 1 / 20; // twips → pt
const EMU = 1 / 12700; // EMU → pt
const HL: Record<string, string> = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000' };

interface PProps {
  align?: string;
  indL?: number;
  indR?: number;
  first?: number;
  before?: number;
  after?: number;
  line?: number;
  lineRule?: string;
  numId?: string;
  ilvl?: number;
  shading?: string;
  borderBottom?: boolean;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  /** no space between paragraphs of the same style */
  contextual?: boolean;
  outline?: number;
}

interface RProps {
  font?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  vert?: 'super' | 'sub';
  hidden?: boolean;
  caps?: boolean;
}

interface Style {
  id: string;
  type: string;
  name: string;
  basedOn?: string;
  p: PProps;
  r: RProps;
  node: XNode;
}

const onOff = (n: XNode | undefined): boolean | undefined => {
  if (!n) return undefined;
  const v = attr(n, 'w:val');
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
};

function readR(rPr: XNode | undefined, theme: { major: string; minor: string; majorEa: string; minorEa: string }): RProps {
  const r: RProps = {};
  if (!rPr) return r;
  const f = kid(rPr, 'w:rFonts');
  if (f) {
    const ea = attr(f, 'w:eastAsia');
    const ascii = attr(f, 'w:ascii') ?? attr(f, 'w:hAnsi');
    const th = attr(f, 'w:asciiTheme') ?? attr(f, 'w:hAnsiTheme');
    const eaTh = attr(f, 'w:eastAsiaTheme');
    const fromTheme = (t?: string) => (t ? (t.startsWith('major') ? (t.includes('EastAsia') ? theme.majorEa : theme.major) : t.includes('EastAsia') ? theme.minorEa : theme.minor) : undefined);
    r.font = ascii ?? fromTheme(th) ?? ea ?? fromTheme(eaTh);
  }
  const sz = kid(rPr, 'w:sz');
  if (sz) r.size = num(attr(sz, 'w:val'), 22) / 2;
  const b = onOff(kid(rPr, 'w:b'));
  if (b !== undefined) r.bold = b;
  const i = onOff(kid(rPr, 'w:i'));
  if (i !== undefined) r.italic = i;
  const u = kid(rPr, 'w:u');
  if (u) r.underline = attr(u, 'w:val') !== 'none';
  const st = onOff(kid(rPr, 'w:strike')) ?? onOff(kid(rPr, 'w:dstrike'));
  if (st !== undefined) r.strike = st;
  const c = attr(kid(rPr, 'w:color'), 'w:val');
  if (c && /^[0-9a-fA-F]{6}$/.test(c)) r.color = `#${c.toLowerCase()}`;
  const hl = attr(kid(rPr, 'w:highlight'), 'w:val');
  if (hl && HL[hl]) r.highlight = HL[hl];
  const shd = attr(kid(rPr, 'w:shd'), 'w:fill');
  if (!r.highlight && shd && /^[0-9a-fA-F]{6}$/.test(shd) && shd.toLowerCase() !== 'ffffff') r.highlight = `#${shd.toLowerCase()}`;
  const va = attr(kid(rPr, 'w:vertAlign'), 'w:val');
  if (va === 'superscript') r.vert = 'super';
  else if (va === 'subscript') r.vert = 'sub';
  const h = onOff(kid(rPr, 'w:vanish'));
  if (h !== undefined) r.hidden = h;
  const caps = onOff(kid(rPr, 'w:caps'));
  if (caps !== undefined) r.caps = caps;
  return r;
}

function readP(pPr: XNode | undefined): PProps {
  const p: PProps = {};
  if (!pPr) return p;
  const jc = attr(kid(pPr, 'w:jc'), 'w:val');
  if (jc) p.align = jc;
  const ind = kid(pPr, 'w:ind');
  if (ind) {
    const l = attr(ind, 'w:left') ?? attr(ind, 'w:start');
    const r = attr(ind, 'w:right') ?? attr(ind, 'w:end');
    if (l !== undefined) p.indL = num(l) * TW;
    if (r !== undefined) p.indR = num(r) * TW;
    if (attr(ind, 'w:firstLine') !== undefined) p.first = num(attr(ind, 'w:firstLine')) * TW;
    if (attr(ind, 'w:hanging') !== undefined) p.first = -num(attr(ind, 'w:hanging')) * TW;
  }
  const sp = kid(pPr, 'w:spacing');
  if (sp) {
    if (attr(sp, 'w:before') !== undefined) p.before = num(attr(sp, 'w:before')) * TW;
    if (attr(sp, 'w:after') !== undefined) p.after = num(attr(sp, 'w:after')) * TW;
    if (attr(sp, 'w:line') !== undefined) {
      p.line = num(attr(sp, 'w:line'));
      p.lineRule = attr(sp, 'w:lineRule') ?? 'auto';
    }
  }
  const np = kid(pPr, 'w:numPr');
  if (np) {
    const id = attr(kid(np, 'w:numId'), 'w:val');
    if (id !== undefined) p.numId = id;
    p.ilvl = num(attr(kid(np, 'w:ilvl'), 'w:val'), 0);
  }
  const shd = attr(kid(pPr, 'w:shd'), 'w:fill');
  if (shd && /^[0-9a-fA-F]{6}$/.test(shd) && shd.toLowerCase() !== 'ffffff') p.shading = `#${shd.toLowerCase()}`;
  const bdr = kid(kid(pPr, 'w:pBdr'), 'w:bottom');
  if (bdr && attr(bdr, 'w:val') !== 'nil' && attr(bdr, 'w:val') !== 'none') p.borderBottom = true;
  if (onOff(kid(pPr, 'w:pageBreakBefore'))) p.pageBreakBefore = true;
  const cs = onOff(kid(pPr, 'w:contextualSpacing'));
  if (cs !== undefined) p.contextual = cs;
  const kn = onOff(kid(pPr, 'w:keepNext'));
  if (kn !== undefined) p.keepNext = kn;
  const ol = attr(kid(pPr, 'w:outlineLvl'), 'w:val');
  if (ol !== undefined) p.outline = num(ol);
  return p;
}

interface NumLevel {
  fmt: string;
  text: string;
  start: number;
  indL?: number;
  first?: number;
  font?: string;
}

const BULLET_MAP: Record<string, string> = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', o: '◦', '': '■', '': '◆' };

function roman(n: number): string {
  const v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const s = ['m', 'cm', 'd', 'cd', 'c', 'xc', 'l', 'xl', 'x', 'ix', 'v', 'iv', 'i'];
  let out = '';
  for (let i = 0; i < v.length; i++)
    while (n >= v[i]) {
      out += s[i];
      n -= v[i];
    }
  return out;
}

function fmtNum(n: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter':
      return String.fromCharCode(97 + ((n - 1) % 26));
    case 'upperLetter':
      return String.fromCharCode(65 + ((n - 1) % 26));
    case 'lowerRoman':
      return roman(n);
    case 'upperRoman':
      return roman(n).toUpperCase();
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'ideographTraditional': {
      const d = '〇一二三四五六七八九';
      if (n <= 10) return n === 10 ? '十' : d[n];
      if (n < 20) return '十' + d[n % 10];
      if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
      return String(n);
    }
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    default:
      return String(n);
  }
}

export interface DocxOptions {
  measure: Measurer;
  /** cancel long layouts */
  signal?: AbortSignal;
  /** max pages laid out */
  maxPages?: number;
  /** blocks laid out so far / total (the layout yields to the UI between batches) */
  onProgress?: (done: number, total: number) => void;
  /** give the UI a turn during long layouts (the app passes a window timer) */
  yieldUi?: () => Promise<void>;
}

/** Where the WordprocessingML parts come from: a .docx archive, or parts converted from a .doc. */
export interface PartSource {
  text(name: string): Promise<string | null>;
}

export async function layoutDocx(zip: PartSource, opts: DocxOptions, kind: 'docx' | 'doc' = 'docx'): Promise<DisplayList> {
  const notes = new Set<string>();
  const m = opts.measure;
  const docXml = await zip.text('word/document.xml');
  if (!docXml) throw new Error('word/document.xml is missing');
  const doc = parseXml(docXml);
  const body = kid(doc, 'w:body');
  if (!body) throw new Error('the document has no body');

  // relationships (pictures)
  const rels = new Map<string, string>();
  const relXml = await zip.text(relsOf('word/document.xml'));
  if (relXml) {
    for (const r of kids(parseXml(relXml), 'Relationship')) {
      if (attr(r, 'TargetMode') === 'External') continue; // never load remote resources
      const id = attr(r, 'Id');
      const target = attr(r, 'Target');
      if (id && target) rels.set(id, resolvePart('word/document.xml', target));
    }
  }

  // theme fonts
  const theme = { major: '', minor: '', majorEa: '', minorEa: '' };
  const themeXml = await zip.text('word/theme/theme1.xml');
  if (themeXml) {
    const t = parseXml(themeXml);
    const fs = find(t, 'a:fontScheme')[0];
    const maj = kid(fs, 'a:majorFont');
    const min = kid(fs, 'a:minorFont');
    theme.major = attr(kid(maj, 'a:latin'), 'typeface') ?? '';
    theme.minor = attr(kid(min, 'a:latin'), 'typeface') ?? '';
    theme.majorEa = attr(kid(maj, 'a:ea'), 'typeface') || theme.major;
    theme.minorEa = attr(kid(min, 'a:ea'), 'typeface') || theme.minor;
  }

  // styles
  const styles = new Map<string, Style>();
  let defR: RProps = { size: 10.5 };
  let defP: PProps = {};
  let defParaStyle = '';
  const stylesXml = await zip.text('word/styles.xml');
  if (stylesXml) {
    const s = parseXml(stylesXml);
    const dd = kid(s, 'w:docDefaults');
    defR = { size: 10, ...readR(kid(kid(dd, 'w:rPrDefault'), 'w:rPr'), theme) };
    defP = readP(kid(kid(dd, 'w:pPrDefault'), 'w:pPr'));
    for (const st of kids(s, 'w:style')) {
      const id = attr(st, 'w:styleId') ?? '';
      const type = attr(st, 'w:type') ?? '';
      if (type === 'paragraph' && attr(st, 'w:default') === '1') defParaStyle = id;
      styles.set(id, { id, type, name: (attr(kid(st, 'w:name'), 'w:val') ?? id).toLowerCase(), basedOn: attr(kid(st, 'w:basedOn'), 'w:val'), p: readP(kid(st, 'w:pPr')), r: readR(kid(st, 'w:rPr'), theme), node: st });
    }
  } else defR = { size: 10.5, font: theme.minor };
  if (!defR.font) defR.font = theme.minor || 'Calibri';
  const styleChain = (id: string | undefined): Style[] => {
    const out: Style[] = [];
    let cur = id ? styles.get(id) : undefined;
    for (let i = 0; cur && i < 20; i++) {
      out.unshift(cur);
      cur = cur.basedOn ? styles.get(cur.basedOn) : undefined;
    }
    return out;
  };

  // numbering
  const abstract = new Map<string, Map<number, NumLevel>>();
  const numToAbs = new Map<string, string>();
  const numStart = new Map<string, Map<number, number>>();
  const numXml = await zip.text('word/numbering.xml');
  if (numXml) {
    const n = parseXml(numXml);
    for (const a of kids(n, 'w:abstractNum')) {
      const lv = new Map<number, NumLevel>();
      for (const l of kids(a, 'w:lvl')) {
        const p = readP(kid(l, 'w:pPr'));
        const r = readR(kid(l, 'w:rPr'), theme);
        lv.set(num(attr(l, 'w:ilvl'), 0), { fmt: attr(kid(l, 'w:numFmt'), 'w:val') ?? 'decimal', text: attr(kid(l, 'w:lvlText'), 'w:val') ?? '', start: num(attr(kid(l, 'w:start'), 'w:val'), 1), indL: p.indL, first: p.first, font: r.font });
      }
      abstract.set(attr(a, 'w:abstractNumId') ?? '', lv);
    }
    for (const x of kids(n, 'w:num')) {
      const id = attr(x, 'w:numId') ?? '';
      numToAbs.set(id, attr(kid(x, 'w:abstractNumId'), 'w:val') ?? '');
      for (const o of kids(x, 'w:lvlOverride')) {
        const so = attr(kid(o, 'w:startOverride'), 'w:val');
        if (so !== undefined) {
          if (!numStart.has(id)) numStart.set(id, new Map());
          numStart.get(id)?.set(num(attr(o, 'w:ilvl'), 0), num(so, 1));
        }
      }
    }
  }
  const counters = new Map<string, number[]>();

  // fonts used by the layout (index into DisplayList.fonts)
  const fonts: string[] = [];
  const fontIx = (name: string | undefined, fb: 'sans' | 'serif' = 'sans') => {
    const css = cssFamily(name, fb);
    let i = fonts.indexOf(css);
    if (i < 0) i = fonts.push(css) - 1;
    return i;
  };

  // sections: page size / margins (the body's last sectPr is the default; paragraph sectPr ends a section)
  interface Sect {
    w: number;
    h: number;
    top: number;
    bottom: number;
    left: number;
    right: number;
  }
  const readSect = (s: XNode | undefined): Sect => {
    const sz = kid(s, 'w:pgSz');
    const mar = kid(s, 'w:pgMar');
    let w = num(attr(sz, 'w:w'), 11906) * TW;
    let h = num(attr(sz, 'w:h'), 16838) * TW;
    if (attr(sz, 'w:orient') === 'landscape' && w < h) [w, h] = [h, w];
    return { w: Math.max(100, Math.min(4000, w)), h: Math.max(100, Math.min(4000, h)), top: Math.abs(num(attr(mar, 'w:top'), 1440)) * TW, bottom: Math.abs(num(attr(mar, 'w:bottom'), 1440)) * TW, left: num(attr(mar, 'w:left'), 1440) * TW, right: num(attr(mar, 'w:right'), 1440) * TW };
  };
  let sect = readSect(kid(body, 'w:sectPr'));
  // the first section's size: a paragraph sectPr (if any) applies to the content before it
  const firstParaSect = find(body, 'w:sectPr').find((s) => s !== kid(body, 'w:sectPr'));
  if (firstParaSect) sect = readSect(firstParaSect);

  const pages: DLPage[] = [];
  let page: DLPage = { w: sect.w, h: sect.h, ops: [] };
  pages.push(page);
  let y = sect.top;
  let pageEmpty = true;
  const maxPages = opts.maxPages ?? 2000;
  const newPage = () => {
    if (pages.length >= maxPages) throw new Error(`the document is longer than ${maxPages} pages`);
    page = { w: sect.w, h: sect.h, ops: [] };
    pages.push(page);
    y = sect.top;
    pageEmpty = true;
  };
  const contentW = () => sect.w - sect.left - sect.right;
  const bottom = () => sect.h - sect.bottom;

  /** Paragraph properties: defaults < table style (cells) < paragraph style < direct formatting. */
  const resolveP = (pPr: XNode | undefined, base?: { p: PProps; r: RProps }): { p: PProps; r: RProps; direct: PProps; sid: string } => {
    const sid = attr(kid(pPr, 'w:pStyle'), 'w:val') ?? defParaStyle;
    const chain = styleChain(sid);
    let p: PProps = { ...defP, ...base?.p };
    let r: RProps = { ...defR, ...base?.r };
    for (const s of chain) {
      p = { ...p, ...s.p };
      r = { ...r, ...s.r };
    }
    const direct = readP(pPr);
    p = { ...p, ...direct };
    return { p, r, direct, sid };
  };

  const runStyle = (r: RProps): RunStyle => ({
    font: fontIx(r.font),
    size: Math.max(1, Math.min(200, r.size ?? 10.5)),
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic ? { italic: true } : {}),
    ...(r.color && r.color !== '#000000' && r.color !== '#auto' ? { color: r.color } : {}),
    ...(r.underline ? { underline: true } : {}),
    ...(r.strike ? { strike: true } : {}),
    ...(r.highlight ? { highlight: r.highlight } : {}),
    ...(r.vert ? { vert: r.vert } : {}),
  });

  /** Runs of a paragraph (and whether it contains a page break). */
  const collectRuns = (p: XNode, baseR: RProps): { runs: Run[]; pageBreak: boolean } => {
    const runs: Run[] = [];
    let pageBreak = false;
    const visit = (n: XNode, charStyle?: string) => {
      for (const c of n.children) {
        switch (c.name) {
          case 'w:r': {
            const rPr = kid(c, 'w:rPr');
            const cs = attr(kid(rPr, 'w:rStyle'), 'w:val') ?? charStyle;
            let r: RProps = { ...baseR };
            for (const s of styleChain(cs)) r = { ...r, ...s.r };
            r = { ...r, ...readR(rPr, theme) };
            if (r.hidden) break;
            const st = runStyle(r);
            for (const e of c.children) {
              if (e.name === 'w:t') runs.push({ kind: 'text', text: r.caps ? e.text.toUpperCase() : e.text, style: st });
              else if (e.name === 'w:tab' || e.name === 'w:ptab') runs.push({ kind: 'tab', style: st });
              else if (e.name === 'w:br' || e.name === 'w:cr') {
                if (attr(e, 'w:type') === 'page') pageBreak = true;
                else runs.push({ kind: 'br', style: st });
              } else if (e.name === 'w:noBreakHyphen') runs.push({ kind: 'text', text: '-', style: st });
              else if (e.name === 'w:sym') {
                const ch = attr(e, 'w:char');
                if (ch) runs.push({ kind: 'text', text: BULLET_MAP[String.fromCharCode(parseInt(ch, 16))] ?? String.fromCharCode(parseInt(ch, 16) & 0xff || 0x2022), style: st });
              } else if (e.name === 'w:drawing' || e.name === 'w:pict' || e.name === 'mc:AlternateContent') {
                const blip = find(e, 'a:blip')[0];
                const ext = find(e, 'wp:extent')[0];
                const rid = attr(blip, 'r:embed');
                const part = rid ? rels.get(rid) : undefined;
                if (find(e, 'wp:anchor').length) notes.add('floating-pictures');
                if (part && ext) runs.push({ kind: 'image', part, w: num(attr(ext, 'cx')) * EMU, h: num(attr(ext, 'cy')) * EMU });
                else if (find(e, 'c:chart').length || find(e, 'dgm:relIds').length) notes.add('charts');
                else if (find(e, 'wps:txbx').length || find(e, 'v:textbox').length) notes.add('text-boxes');
              } else if (e.name === 'w:footnoteReference' || e.name === 'w:endnoteReference') notes.add('footnotes');
              else if (e.name === 'w:object') notes.add('embedded-objects');
            }
            break;
          }
          case 'w:hyperlink':
          case 'w:smartTag':
          case 'w:ins':
          case 'w:fldSimple':
          case 'w:customXml':
            visit(c, c.name === 'w:hyperlink' ? (styles.has('Hyperlink') ? 'Hyperlink' : charStyle) : charStyle);
            break;
          case 'w:sdt':
            visit(kid(c, 'w:sdtContent') ?? c, charStyle);
            break;
          case 'm:oMath':
          case 'm:oMathPara':
            notes.add('equations');
            break;
          default:
            break;
        }
      }
    };
    visit(p);
    return { runs, pageBreak };
  };

  const lineHeightFor = (p: PProps) => (size: number) => {
    const single = size * 1.17;
    if (p.line === undefined) return single;
    if (p.lineRule === 'exact') return Math.max(1, p.line * TW);
    if (p.lineRule === 'atLeast') return Math.max(single, p.line * TW);
    return single * Math.max(0.5, Math.min(5, p.line / 240));
  };

  const numberText = (p: PProps): { text: string; lvl?: NumLevel } | null => {
    if (!p.numId || p.numId === '0') return null;
    const abs = abstract.get(numToAbs.get(p.numId) ?? '');
    const ilvl = p.ilvl ?? 0;
    const lvl = abs?.get(ilvl);
    if (!lvl) return null;
    const key = numToAbs.get(p.numId) ?? p.numId;
    const c = counters.get(key) ?? [];
    const start = numStart.get(p.numId)?.get(ilvl) ?? lvl.start;
    c[ilvl] = (c[ilvl] ?? start - 1) + 1;
    for (let k = ilvl + 1; k < 9; k++) c[k] = undefined as unknown as number;
    counters.set(key, c);
    if (lvl.fmt === 'bullet') return { text: BULLET_MAP[lvl.text] ?? (lvl.text && lvl.text.charCodeAt(0) < 0xf000 ? lvl.text : '•'), lvl };
    if (lvl.fmt === 'none') return { text: '', lvl };
    const text = lvl.text.replace(/%(\d)/g, (_, d: string) => {
      const k = Number(d) - 1;
      const l2 = abs?.get(k);
      return fmtNum(c[k] ?? l2?.start ?? 1, k === ilvl ? lvl.fmt : (l2?.fmt ?? 'decimal'));
    });
    return { text, lvl };
  };

  /** Lay out a paragraph into lines of `width` (no page logic). */
  const paraLines = (pNode: XNode, width: number, base?: { p: PProps; r: RProps }): { lines: Line[]; p: PProps; pageBreak: boolean; indL: number; sid: string } => {
    const pPr = kid(pNode, 'w:pPr');
    const { p, r, direct, sid } = resolveP(pPr, base);
    const { runs, pageBreak } = collectRuns(pNode, r);
    const num1 = numberText(p);
    // indents: direct formatting > the list level > the paragraph style
    let indL = direct.indL ?? num1?.lvl?.indL ?? p.indL ?? 0;
    let first = direct.first ?? num1?.lvl?.first ?? p.first ?? 0;
    if (num1 && num1.text) {
      const st = runStyle({ ...r, font: num1.lvl?.font && !/symbol|wingdings/i.test(num1.lvl.font) ? num1.lvl.font : r.font });
      runs.unshift({ kind: 'text', text: num1.text, style: st }, { kind: 'tab', style: st });
    }
    indL = Math.max(-sect.left, Math.min(width * 0.8, indL));
    first = Math.max(-indL - sect.left, first);
    const w = Math.max(20, width - indL - Math.max(0, p.indR ?? 0));
    // tabs inside a hanging indent jump to the indent
    const lines = flowLines(runs, w, first, m, fonts, lineHeightFor(p), first < 0 ? -first : 36);
    return { lines, p, pageBreak, indL, sid };
  };

  /** Draw lines at (x0, y0); returns the ops. */
  const drawLines = (lines: Line[], x0: number, y0: number, width: number, p: PProps, ops: DLOp[]) => {
    let yy = y0;
    for (const ln of lines) {
      const free = width - ln.width;
      const dx = p.align === 'center' ? free / 2 : p.align === 'right' || p.align === 'end' ? free : 0;
      const base = yy + ln.ascent;
      for (const pc of ln.pieces) {
        const x = x0 + dx + pc.x;
        if (pc.image) ops.push({ k: 'img', x, y: base - pc.image.h, w: pc.image.w, h: pc.image.h, part: pc.image.part });
        else if (pc.text && pc.style) {
          const s = pc.style;
          const text = pc.text.replace(/\s+$/, '');
          if (s.highlight && text) ops.push({ k: 'r', x, y: base - s.size * 0.85, w: pc.w, h: s.size * 1.1, fill: s.highlight });
          if (!text) continue;
          const shift = s.vert === 'super' ? -s.size * 0.35 : s.vert === 'sub' ? s.size * 0.15 : 0;
          const tw = Math.round(m.width(text, cssOf(s, fonts)) * 100) / 100;
          ops.push({ k: 't', x, y: base + shift, s: text, f: s.font, z: effSize(s), w: tw, ...(s.color ? { c: s.color } : {}), ...(s.bold ? { b: 1 } : {}), ...(s.italic ? { i: 1 } : {}), ...(s.underline ? { u: 1 } : {}), ...(s.strike ? { st: 1 } : {}) });
        }
      }
      yy += ln.height;
    }
    return yy;
  };

  let prevPara: { sid: string; after: number; contextual: boolean } | null = null;
  const placeParagraph = (pNode: XNode, laid: ReturnType<typeof paraLines>, keepWith: number) => {
    const { lines, p, pageBreak, indL, sid } = laid;
    // contextual spacing: no space between two paragraphs of the same style (list items)
    const sameCtx = !!prevPara && prevPara.sid === sid && (p.contextual || prevPara.contextual);
    if (sameCtx && prevPara && !pageEmpty) y -= prevPara.after;
    if (p.pageBreakBefore && !pageEmpty) newPage();
    // "keep with next" (headings): move to the next page when it and the start of what follows do not fit
    if (p.keepNext && !pageEmpty) {
      const h = (p.before ?? 0) + lines.reduce((a, l) => a + l.height, 0) + (p.after ?? 0) + keepWith;
      if (y + h > bottom() && h < bottom() - sect.top) newPage();
    }
    const before = pageEmpty || sameCtx ? 0 : (p.before ?? 0);
    y += before;
    const x0 = sect.left + indL;
    const w = contentW() - indL - Math.max(0, p.indR ?? 0);
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      if (y + ln.height > bottom() && !pageEmpty) newPage();
      // shading behind the line
      if (p.shading) page.ops.push({ k: 'r', x: sect.left + indL, y, w, h: ln.height, fill: p.shading });
      y = drawLines([ln], x0, y, w, p, page.ops);
      pageEmpty = false;
      // a picture taller than the page: scale is not changed, it is clipped by the page
    }
    if (p.borderBottom) page.ops.push({ k: 'l', x1: sect.left + indL, y1: y + 1, x2: sect.left + indL + w, y2: y + 1, stroke: '#000000', lw: 0.5 });
    y += p.after ?? 0;
    prevPara = { sid, after: p.after ?? 0, contextual: !!p.contextual };
    if (pageBreak) newPage();
    const ps = kid(kid(pNode, 'w:pPr'), 'w:sectPr');
    if (ps) {
      // end of a section: the next content uses the following section's page settings
      const next = nextSect.get(ps);
      if (next) {
        sect = next;
        if (attr(kid(ps, 'w:type'), 'w:val') !== 'continuous') newPage();
      }
    }
  };

  // section that follows each paragraph-level sectPr
  const allSects = find(body, 'w:sectPr');
  const nextSect = new Map<XNode, Sect>();
  for (let i = 0; i < allSects.length - 1; i++) nextSect.set(allSects[i], readSect(allSects[i + 1]));

  const placeTable = (tbl: XNode) => {
    const grid = kids(kid(tbl, 'w:tblGrid'), 'w:gridCol').map((g) => num(attr(g, 'w:w')) * TW);
    const rows = kids(tbl, 'w:tr');
    if (!rows.length) return;
    const avail = contentW();
    let cols = grid.length ? grid : [avail];
    const total = cols.reduce((a, b) => a + b, 0) || avail;
    if (total > avail || total < 10) cols = cols.map((c) => (c / total) * avail);
    const tblPr = kid(tbl, 'w:tblPr');
    // table style chain (the default table style when none is named): borders, cell margins, and
    // paragraph / run properties of the text in its cells
    const tsChain = styleChain(attr(kid(tblPr, 'w:tblStyle'), 'w:val') ?? [...styles.values()].find((x) => x.type === 'table' && attr(x.node, 'w:default') === '1')?.id);
    const tblProp = (name: string): XNode | undefined => kid(tblPr, name) ?? [...tsChain].reverse().map((x) => kid(kid(x.node, 'w:tblPr'), name)).find(Boolean);
    let base: { p: PProps; r: RProps } = { p: {}, r: {} };
    for (const x of tsChain) base = { p: { ...base.p, ...x.p }, r: { ...base.r, ...x.r } };
    const tb = tblProp('w:tblBorders');
    /** A border line from a border element: null when absent / none, else its colour and width. */
    const lineOf = (b: XNode | undefined): { c: string; lw: number } | null | undefined => {
      if (!b) return undefined;
      const v = attr(b, 'w:val') ?? 'single';
      if (v === 'nil' || v === 'none') return null;
      const c = attr(b, 'w:color');
      return { c: c && /^[0-9a-fA-F]{6}$/.test(c) ? `#${c.toLowerCase()}` : '#000000', lw: Math.max(0.25, Math.min(6, num(attr(b, 'w:sz'), 4) / 8)) };
    };
    /** Border of a cell side: the cell's own setting, else the table's (outer or inside line). */
    const side = (tcPr: XNode | undefined, name: string, tableName: string) => {
      const own = lineOf(kid(kid(tcPr, 'w:tcBorders'), name) ?? (name === 'w:left' ? kid(kid(tcPr, 'w:tcBorders'), 'w:start') : name === 'w:right' ? kid(kid(tcPr, 'w:tcBorders'), 'w:end') : undefined));
      if (own !== undefined) return own;
      return lineOf(kid(tb, tableName) ?? (tableName === 'w:left' ? kid(tb, 'w:start') : tableName === 'w:right' ? kid(tb, 'w:end') : undefined)) ?? null;
    };
    const push = (l: { c: string; lw: number } | null, x1: number, y1: number, x2: number, y2: number) => {
      if (l) page.ops.push({ k: 'l', x1, y1, x2, y2, stroke: l.c, lw: l.lw });
    };
    // bottoms of the previous row's cells, drawn once it is known whether a merged cell continues below
    let pending: { x: number; w: number; y: number; tcPr: XNode | undefined }[] = [];
    const flushBottoms = (last: boolean, continuing: Set<number> = new Set()) => {
      for (const b of pending) if (!continuing.has(Math.round(b.x))) push(side(b.tcPr, 'w:bottom', last ? 'w:bottom' : 'w:insideH'), b.x, b.y, b.x + b.w, b.y);
      pending = [];
    };
    const mar = tblProp('w:tblCellMar');
    const marOf = (n: string, alt: string, fb: number) => {
      const e = kid(mar, n) ?? kid(mar, alt);
      return e ? num(attr(e, 'w:w')) * TW : fb;
    };
    const padL = marOf('w:left', 'w:start', 5.4);
    const padR = marOf('w:right', 'w:end', 5.4);
    const padT = marOf('w:top', 'w:top', 0);
    const padB = marOf('w:bottom', 'w:bottom', 0);
    const x0 = sect.left + num(attr(tblProp('w:tblInd'), 'w:w')) * TW;
    for (const [ri, tr] of rows.entries()) {
      // cells of this row
      const cells: { x: number; w: number; lines: { lines: Line[]; p: PProps; indL: number }[]; fill?: string; vcont: boolean; tcPr: XNode | undefined; first: boolean; last: boolean }[] = [];
      const tcs = kids(tr, 'w:tc');
      let ci = 0;
      for (const [k, tc] of tcs.entries()) {
        const tcPr = kid(tc, 'w:tcPr');
        const span = Math.max(1, num(attr(kid(tcPr, 'w:gridSpan'), 'w:val'), 1));
        const x = x0 + cols.slice(0, ci).reduce((a, b) => a + b, 0);
        const w = cols.slice(ci, ci + span).reduce((a, b) => a + b, 0) || cols[cols.length - 1] || 50;
        ci += span;
        const vm = kid(tcPr, 'w:vMerge');
        const vcont = !!vm && attr(vm, 'w:val') !== 'restart';
        const fill = attr(kid(tcPr, 'w:shd'), 'w:fill');
        const paras = vcont ? [] : kids(tc, 'w:p').map((pn) => paraLines(pn, Math.max(10, w - padL - padR), base));
        if (find(tc, 'w:tbl').length) notes.add('nested-tables');
        cells.push({ x, w, lines: paras, ...(fill && /^[0-9a-fA-F]{6}$/.test(fill) && fill.toLowerCase() !== 'ffffff' ? { fill: `#${fill.toLowerCase()}` } : {}), vcont, tcPr, first: k === 0, last: k === tcs.length - 1 });
      }
      const cellH = (c: (typeof cells)[number]) => c.lines.reduce((a, l) => a + l.lines.reduce((s, ln) => s + ln.height, 0) + (l.p.after ?? 0), 0) + padT + padB;
      const trH = kid(kid(tr, 'w:trPr'), 'w:trHeight');
      const rowH = Math.max(attr(trH, 'w:hRule') === 'exact' ? 0 : 14, num(attr(trH, 'w:val')) * TW, ...cells.map(cellH));
      if (y + rowH > bottom() && !pageEmpty) {
        flushBottoms(true);
        newPage();
      } else flushBottoms(false, new Set(cells.filter((c) => c.vcont).map((c) => Math.round(c.x))));
      const rowTop = ri === 0 || pageEmpty;
      for (const c of cells) {
        if (c.fill) page.ops.push({ k: 'r', x: c.x, y, w: c.w, h: rowH, fill: c.fill });
        let cy = y + padT;
        for (const l of c.lines) {
          cy = drawLines(l.lines, c.x + padL + l.indL, cy, c.w - padL - padR - l.indL, l.p, page.ops);
          cy += l.p.after ?? 0;
        }
        // inner horizontal lines are the bottoms of the row above (one line, not two)
        if (rowTop) push(side(c.tcPr, 'w:top', ri === 0 ? 'w:top' : 'w:insideH'), c.x, y, c.x + c.w, y);
        push(side(c.tcPr, 'w:left', c.first ? 'w:left' : 'w:insideV'), c.x, y, c.x, y + rowH);
        push(side(c.tcPr, 'w:right', c.last ? 'w:right' : 'w:insideV'), c.x + c.w, y, c.x + c.w, y + rowH);
        pending.push({ x: c.x, w: c.w, y: y + rowH, tcPr: c.tcPr });
      }
      y += rowH;
      pageEmpty = false;
    }
    flushBottoms(true);
    prevPara = null;
  };

  /** Rough height of the start of a block (for "keep with next"); no side effects. */
  const firstHeight = (n: XNode | undefined): number => {
    if (!n) return 0;
    if (n.name === 'w:tbl') return 24;
    if (n.name !== 'w:p') return 0;
    let h = 16;
    for (const d of find(n, 'w:drawing')) {
      const ext = find(d, 'wp:extent')[0];
      if (ext) h = Math.max(h, num(attr(ext, 'cy')) * EMU + 4);
    }
    return h;
  };
  const blocks = (container: XNode, out: XNode[] = []): XNode[] => {
    for (const c of container.children) {
      if (c.name === 'w:p' || c.name === 'w:tbl') out.push(c);
      else if (c.name === 'w:sdt') blocks(kid(c, 'w:sdtContent') ?? c, out);
      else if (c.name === 'w:customXml') blocks(c, out);
      else if (c.name === 'w:altChunk') notes.add('embedded-objects'); // embedded HTML / RTF: never rendered
    }
    return out;
  };
  const walk = async (container: XNode) => {
    const list = blocks(container);
    let last = Date.now();
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (Date.now() - last > 40) {
        // keep the app responsive during a long layout
        opts.onProgress?.(i, list.length);
        await (opts.yieldUi ? opts.yieldUi() : Promise.resolve());
        last = Date.now();
      }
      if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (c.name === 'w:p') placeParagraph(c, paraLines(c, contentW()), firstHeight(list[i + 1]));
      else placeTable(c);
    }
  };
  await walk(body);
  // drop a trailing empty page
  if (pages.length > 1 && !pages[pages.length - 1].ops.length) pages.pop();
  if (find(doc, 'w:headerReference').length || find(body, 'w:footerReference').length) notes.add('headers-footers');
  if (find(doc, 'w:commentReference').length) notes.add('comments');
  // 1/100 pt is far below what anyone can see; it keeps the stored layout small
  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const pg of pages) {
    pg.w = r2(pg.w);
    pg.h = r2(pg.h);
    for (const op of pg.ops) {
      const o = op as unknown as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'number') o[k] = r2(v);
      }
    }
  }
  return { v: 1, kind, fonts, pages, notes: [...notes] };
}

/** A canvas-based measurer (the app); results are cached per font + text. */
export function canvasMeasurer(): Measurer {
  const ctx = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : createEl('canvas').getContext('2d');
  if (!ctx) throw new Error('no canvas for text measurement');
  const cache = new Map<string, number>();
  return {
    width(text: string, font: string): number {
      const k = font + '\u0000' + text;
      let w = cache.get(k);
      if (w === undefined) {
        ctx.font = font;
        w = ctx.measureText(text).width;
        if (cache.size > 200000) cache.clear();
        cache.set(k, w);
      }
      return w;
    },
  };
}

export { cssOf };
