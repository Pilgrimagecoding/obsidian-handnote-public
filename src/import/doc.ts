/**
 * Word 97–2003 (.doc) → WordprocessingML parts, laid out by the Word (.docx) engine (0.9).
 *
 * Reads the binary format far enough for annotation: the document text (piece table, both 8-bit
 * and UTF-16 pieces), paragraphs with their alignment, indents, spacing and heading level, runs
 * with bold / italic / underline / strike / size / colour / font, page and line breaks, field
 * results, and tables (rows, cells, column widths, cell borders, merged cells). Page size and
 * margins come from the first section. Left out and noted: pictures and drawings, list numbers
 * and bullets, headers / footers, footnotes, comments, text boxes. Encrypted files are refused.
 * Nothing in the file is executed (macros in .doc files are never run).
 */
import { Cfb, CfbError } from './cfb';
import type { PartSource } from './docx';

export class DocFormatError extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const i16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Windows-1252 for 0x80–0x9F (8-bit pieces)
const CP1252: Record<number, number> = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
// Word's 16-colour index (ico)
const ICO = ['', '000000', '0000FF', '00FFFF', '00FF00', 'FF00FF', 'FF0000', 'FFFF00', 'FFFFFF', '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'C0C0C0'];
const HL = ['', 'black', 'blue', 'cyan', 'green', 'magenta', 'red', 'yellow', 'white', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray'];

interface Sprm {
  op: number;
  arg: Uint8Array;
}

/** Parse a grpprl (sequence of property modifiers). */
export function sprms(b: Uint8Array, from: number, to: number): Sprm[] {
  const out: Sprm[] = [];
  let p = from;
  while (p + 2 <= to && out.length < 10_000) {
    const op = u16(b, p);
    p += 2;
    const spra = op >> 13;
    let len: number;
    if (spra === 0 || spra === 1) len = 1;
    else if (spra === 2 || spra === 4 || spra === 5) len = 2;
    else if (spra === 3) len = 4;
    else if (spra === 7) len = 3;
    else if (op === 0xd608 || op === 0xd606) {
      // sprmTDefTable / sprmTDefTable10: 2-byte size (+1)
      len = Math.max(0, u16(b, p) - 1);
      p += 2;
    } else if (op === 0xc615) {
      // sprmPChgTabs: 1-byte size; 255 = a longer structure (skip it all)
      len = b[p] === 255 ? to - p : b[p] + 1;
    } else {
      len = b[p];
      p += 1;
    }
    if (p + len > to) break;
    out.push({ op, arg: b.subarray(p, p + len) });
    p += len;
  }
  return out;
}

interface Para {
  istd: number;
  jc?: number;
  inTable: boolean;
  ttp: boolean;
  left?: number;
  right?: number;
  first?: number;
  before?: number;
  after?: number;
  line?: [number, number];
  /** TDefTable of a row end: cell boundaries (twips) and cell flags / borders */
  cells?: { x: number[]; tc: { merged: boolean; first: boolean; vMerge: boolean; vRestart: boolean; borders: boolean[] }[] };
  list?: boolean;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
}

interface Chp {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  hps?: number;
  color?: string;
  hl?: string;
  font?: string;
  fontEa?: string;
  vanish?: boolean;
  special?: boolean;
  sup?: number;
}

function paraProps(grpprl: Sprm[], istd: number): Para {
  const p: Para = { istd, inTable: false, ttp: false };
  for (const s of grpprl) {
    const a = s.arg;
    switch (s.op) {
      case 0x2403:
      case 0x2461:
        p.jc = a[0];
        break;
      case 0x2416:
        p.inTable = a[0] === 1;
        break;
      case 0x2417:
        p.ttp = a[0] === 1;
        break;
      case 0x6649: // sprmPItap (nesting level)
        if (u32(a, 0) > 0) p.inTable = true;
        break;
      case 0x664a: // sprmPDtap
        break;
      case 0x840f:
      case 0x845e:
        p.left = i16(a, 0);
        break;
      case 0x840e:
      case 0x845d:
        p.right = i16(a, 0);
        break;
      case 0x8411:
      case 0x8460:
        p.first = i16(a, 0);
        break;
      case 0xa413:
        p.before = u16(a, 0);
        break;
      case 0xa414:
        p.after = u16(a, 0);
        break;
      case 0x6412:
        p.line = [i16(a, 0), i16(a, 2)];
        break;
      case 0x260a:
      case 0x460b:
        p.list = true;
        break;
      case 0x2407:
        p.pageBreakBefore = a[0] === 1;
        break;
      case 0x2406:
        p.keepNext = a[0] === 1;
        break;
      case 0xd608: {
        const n = a[0];
        const x: number[] = [];
        for (let i = 0; i <= n && 1 + i * 2 + 2 <= a.length; i++) x.push(i16(a, 1 + i * 2));
        const tc: NonNullable<Para['cells']>['tc'] = [];
        const tcAt = 1 + (n + 1) * 2;
        for (let i = 0; i < n; i++) {
          const o = tcAt + i * 20;
          if (o + 20 > a.length) {
            tc.push({ merged: false, first: false, vMerge: false, vRestart: false, borders: [true, true, true, true] });
            continue;
          }
          const grf = u16(a, o);
          // Brc80: dptLineWidth, brcType, ico, flags — top, left, bottom, right
          const brc = [4, 8, 12, 16].map((k) => {
            const t = a[o + k + 1];
            return t !== 0 && t !== 0xff;
          });
          tc.push({ first: !!(grf & 0x1), merged: !!(grf & 0x2), vMerge: !!(grf & 0x20), vRestart: !!(grf & 0x40), borders: brc });
        }
        p.cells = { x, tc };
        break;
      }
      default:
        break;
    }
  }
  return p;
}

function charProps(grpprl: Sprm[], fonts: string[]): Chp {
  const c: Chp = {};
  const toggle = (v: number) => v === 1 || v === 0x81;
  for (const s of grpprl) {
    const a = s.arg;
    switch (s.op) {
      case 0x0835:
        c.b = toggle(a[0]);
        break;
      case 0x0836:
        c.i = toggle(a[0]);
        break;
      case 0x0837:
      case 0x2a53:
        c.strike = toggle(a[0]);
        break;
      case 0x2a3e:
        c.u = a[0] !== 0;
        break;
      case 0x4a43:
        c.hps = u16(a, 0);
        break;
      case 0x2a42:
        if (ICO[a[0]]) c.color = ICO[a[0]];
        break;
      case 0x6870:
        if (!(a[3] & 0xff)) c.color = [a[0], a[1], a[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        break;
      case 0x2a0c:
        if (HL[a[0]]) c.hl = HL[a[0]];
        break;
      case 0x4a4f:
      case 0x4a51:
        c.font = fonts[u16(a, 0)];
        break;
      case 0x4a50:
        c.fontEa = fonts[u16(a, 0)];
        break;
      case 0x083c:
        c.vanish = toggle(a[0]);
        break;
      case 0x0855:
        c.special = toggle(a[0]);
        break;
      case 0x2a48:
        c.sup = a[0];
        break;
      default:
        break;
    }
  }
  return c;
}

/** FKP pages of a bin table: FC ranges → property bytes. */
function fkpRuns(wd: Uint8Array, table: Uint8Array, fc: number, lcb: number, papx: boolean): { start: number; end: number; grpprl: Sprm[]; istd: number }[] {
  const out: { start: number; end: number; grpprl: Sprm[]; istd: number }[] = [];
  if (!lcb || fc + lcb > table.length) return out;
  const n = (lcb - 4) / 8;
  for (let i = 0; i < n && i < 100_000; i++) {
    const pn = u32(table, fc + 4 * (n + 1) + i * 4) & 0x3fffff;
    const base = pn * 512;
    if (base + 512 > wd.length) continue;
    const crun = wd[base + 511];
    for (let k = 0; k < crun; k++) {
      const start = u32(wd, base + k * 4);
      const end = u32(wd, base + (k + 1) * 4);
      if (papx) {
        const bOff = wd[base + 4 * (crun + 1) + k * 13] * 2;
        if (!bOff) {
          out.push({ start, end, grpprl: [], istd: 0 });
          continue;
        }
        let q = base + bOff;
        let cb = wd[q];
        q++;
        let len: number;
        if (cb === 0) {
          cb = wd[q];
          q++;
          len = cb * 2;
        } else len = cb * 2 - 1;
        const istd = u16(wd, q);
        out.push({ start, end, grpprl: sprms(wd, q + 2, Math.min(base + 511, q + len)), istd });
      } else {
        const bOff = wd[base + 4 * (crun + 1) + k] * 2;
        if (!bOff) {
          out.push({ start, end, grpprl: [], istd: 0 });
          continue;
        }
        const cb = wd[base + bOff];
        out.push({ start, end, grpprl: sprms(wd, base + bOff + 1, Math.min(base + 511, base + bOff + 1 + cb)), istd: 0 });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function findRun<T extends { start: number; end: number }>(runs: T[], fc: number): T | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (fc < r.start) hi = mid - 1;
    else if (fc >= r.end) lo = mid + 1;
    else return r;
  }
  return undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DocConversion {
  parts: PartSource;
  notes: string[];
}

/** Convert a .doc file to the WordprocessingML parts the layout engine reads. */
export function convertDoc(bytes: Uint8Array): DocConversion {
  let cfb: Cfb;
  try {
    cfb = new Cfb(bytes);
  } catch (e) {
    throw new DocFormatError(`damaged .doc file (${(e as Error).message})`);
  }
  if (cfb.has('EncryptionInfo')) throw new DocFormatError('this file is password-protected (encrypted) — remove the password in Word / WPS, or save it as PDF');
  const wd = cfb.stream('WordDocument');
  if (!wd || wd.length < 0x200) throw new DocFormatError('not a Word document (no WordDocument stream)');
  if (u16(wd, 0) !== 0xa5ec) throw new DocFormatError('not a Word 97–2003 document');
  const nFib = u16(wd, 2);
  if (nFib < 0xc1) throw new DocFormatError('a Word 95 or older document — open it in Word / WPS and save it as .docx or PDF');
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw new DocFormatError('this file is password-protected (encrypted) — remove the password in Word / WPS, or save it as PDF');
  const table = cfb.stream(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new DocFormatError('damaged .doc file (no table stream)');
  const notes = new Set<string>();
  const ccpText = u32(wd, 0x4c);
  if (u32(wd, 0x50) > 0) notes.add('footnotes');
  if (u32(wd, 0x54) > 0) notes.add('headers-footers');
  if (u32(wd, 0x5c) > 0) notes.add('comments');
  if (u32(wd, 0x64) > 0) notes.add('text-boxes');
  const fcLcb = (i: number) => [u32(wd, 0x9a + i * 8), u32(wd, 0x9a + i * 8 + 4)] as const;

  // fonts (SttbfFfn)
  const fonts: string[] = [];
  {
    const [fc, lcb] = fcLcb(15);
    if (lcb && fc + lcb <= table.length) {
      const count = u16(table, fc);
      let p = fc + 4;
      for (let i = 0; i < count && p < fc + lcb; i++) {
        const len = table[p];
        const start = p + 1 + 39;
        let name = '';
        for (let q = start; q + 1 < p + 1 + len; q += 2) {
          const ch = u16(table, q);
          if (!ch) break;
          name += String.fromCharCode(ch);
        }
        fonts.push(name);
        p += 1 + len;
      }
    }
  }

  // text through the piece table
  const [fcClx, lcbClx] = fcLcb(33);
  if (!lcbClx || fcClx + lcbClx > table.length) throw new DocFormatError('damaged .doc file (no piece table)');
  let p = fcClx;
  while (p < fcClx + lcbClx && table[p] === 1) p += 3 + i16(table, p + 1);
  if (table[p] !== 2) throw new DocFormatError('damaged .doc file (piece table)');
  const lcb = u32(table, p + 1);
  const plc = p + 5;
  const n = Math.floor((lcb - 4) / 12);
  const chars: string[] = [];
  const fcs: number[] = [];
  for (let i = 0; i < n && chars.length < ccpText; i++) {
    const cp0 = u32(table, plc + i * 4);
    const cp1 = u32(table, plc + (i + 1) * 4);
    const raw = u32(table, plc + (n + 1) * 4 + i * 8 + 2);
    const compressed = (raw & 0x40000000) !== 0;
    const fc = raw & 0x3fffffff;
    for (let k = 0; k < cp1 - cp0 && chars.length < ccpText; k++) {
      if (compressed) {
        const at = fc / 2 + k;
        const c = wd[at] ?? 0;
        chars.push(String.fromCharCode(CP1252[c] ?? c));
        fcs.push(at);
      } else {
        const at = fc + k * 2;
        chars.push(String.fromCharCode(u16(wd, at)));
        fcs.push(at);
      }
    }
  }
  const [fcPapx, lcbPapx] = fcLcb(13);
  const [fcChpx, lcbChpx] = fcLcb(12);
  const papx = fkpRuns(wd, table, fcPapx, lcbPapx, true);
  const chpx = fkpRuns(wd, table, fcChpx, lcbChpx, false);

  // page setup of the first section
  let pgW = 11906;
  let pgH = 16838;
  let mar = [1440, 1800, 1440, 1800]; // top, right, bottom, left (Word's Chinese default)
  {
    const [fc, lcbSed] = fcLcb(6);
    if (lcbSed >= 16 && fc + lcbSed <= table.length) {
      const nSed = (lcbSed - 4) / 16;
      const fcSepx = u32(table, fc + (nSed + 1) * 4 + 2);
      if (fcSepx !== 0xffffffff && fcSepx + 2 < wd.length) {
        const cb = u16(wd, fcSepx);
        for (const s of sprms(wd, fcSepx + 2, Math.min(wd.length, fcSepx + 2 + cb))) {
          if (s.op === 0xb01f) pgW = u16(s.arg, 0);
          else if (s.op === 0xb020) pgH = u16(s.arg, 0);
          else if (s.op === 0x9023) mar[0] = Math.abs(i16(s.arg, 0));
          else if (s.op === 0xb022) mar[1] = u16(s.arg, 0);
          else if (s.op === 0x9024) mar[2] = Math.abs(i16(s.arg, 0));
          else if (s.op === 0xb021) mar[3] = u16(s.arg, 0);
        }
      }
    }
    if (pgW < 1440 || pgW > 31680 || pgH < 1440 || pgH > 31680) {
      pgW = 11906;
      pgH = 16838;
    }
    mar = mar.map((v) => Math.max(0, Math.min(5000, v)));
  }

  // stylesheet: names, base styles, paragraph and character properties of each style
  interface Std {
    istd: number;
    sti: number;
    stk: number;
    base: number;
    name: string;
    papx: Sprm[];
    chpx: Sprm[];
  }
  const styles: Std[] = [];
  {
    const [fc, lcbSt] = fcLcb(1);
    if (lcbSt > 4 && fc + lcbSt <= table.length) {
      const end = fc + lcbSt;
      const cbStshi = u16(table, fc);
      const cstd = u16(table, fc + 2);
      const cbBase = u16(table, fc + 4) || 10;
      let q = fc + 2 + cbStshi;
      for (let istd = 0; istd < cstd && q + 2 <= end && istd < 4000; istd++) {
        const cb = u16(table, q);
        q += 2;
        const at = q;
        q += cb;
        if (!cb || at + cbBase > end) continue;
        const sti = u16(table, at) & 0x0fff;
        const v2 = u16(table, at + 2);
        const stk = v2 & 0xf;
        const base = v2 >> 4;
        const cupx = u16(table, at + 4) & 0xf;
        let r = at + cbBase;
        const cch = u16(table, r);
        let name = '';
        for (let k = 0; k < cch && r + 2 + k * 2 + 1 < at + cb; k++) name += String.fromCharCode(u16(table, r + 2 + k * 2));
        r += 2 + cch * 2 + 2;
        const upx: Uint8Array[] = [];
        for (let k = 0; k < cupx && r + 2 <= at + cb; k++) {
          if (r % 2) r++;
          const cbu = u16(table, r);
          upx.push(table.subarray(r + 2, Math.min(at + cb, r + 2 + cbu)));
          r += 2 + cbu;
        }
        let papxS: Sprm[] = [];
        let chpxS: Sprm[] = [];
        if (stk === 1) {
          if (upx[0]) papxS = sprms(upx[0], 2, upx[0].length);
          if (upx[1]) chpxS = sprms(upx[1], 0, upx[1].length);
        } else if (stk === 2 && upx[0]) chpxS = sprms(upx[0], 0, upx[0].length);
        styles[istd] = { istd, sti, stk, base, name, papx: papxS, chpx: chpxS };
      }
    }
  }
  const styleIds = new Set(styles.filter((x) => x && x.stk === 1).map((x) => x.istd));

  // paragraphs → runs → XML
  const rPrOf = (c: Chp) =>
    [
      c.font || c.fontEa ? `<w:rFonts${c.font ? ` w:ascii="${esc(c.font)}" w:hAnsi="${esc(c.font)}"` : ''}${c.fontEa ? ` w:eastAsia="${esc(c.fontEa)}"` : ''}/>` : '',
      c.b ? '<w:b/>' : '',
      c.i ? '<w:i/>' : '',
      c.strike ? '<w:strike/>' : '',
      c.u ? '<w:u w:val="single"/>' : '',
      c.color ? `<w:color w:val="${c.color}"/>` : '',
      c.hps ? `<w:sz w:val="${Math.max(2, Math.min(3276, c.hps))}"/>` : '',
      c.hl ? `<w:highlight w:val="${c.hl}"/>` : '',
      c.sup === 1 ? '<w:vertAlign w:val="superscript"/>' : c.sup === 2 ? '<w:vertAlign w:val="subscript"/>' : '',
    ].join('');
  const pPrOf = (pp: Para) =>
    [
      styleIds.has(pp.istd) ? `<w:pStyle w:val="s${pp.istd}"/>` : '',
      pp.pageBreakBefore ? '<w:pageBreakBefore/>' : '',
      pp.keepNext ? '<w:keepNext/>' : '',
      pp.left !== undefined || pp.right !== undefined || pp.first !== undefined ? `<w:ind${pp.left !== undefined ? ` w:left="${pp.left}"` : ''}${pp.right !== undefined ? ` w:right="${pp.right}"` : ''}${pp.first !== undefined ? (pp.first < 0 ? ` w:hanging="${-pp.first}"` : ` w:firstLine="${pp.first}"`) : ''}/>` : '',
      pp.before !== undefined || pp.after !== undefined || pp.line ? `<w:spacing${pp.before !== undefined ? ` w:before="${pp.before}"` : ''}${pp.after !== undefined ? ` w:after="${pp.after}"` : ''}${pp.line ? (pp.line[1] ? ` w:line="${Math.abs(pp.line[0])}" w:lineRule="auto"` : pp.line[0] < 0 ? ` w:line="${-pp.line[0]}" w:lineRule="exact"` : ` w:line="${pp.line[0]}" w:lineRule="atLeast"`) : ''}/>` : '',
      pp.jc === 1 ? '<w:jc w:val="center"/>' : pp.jc === 2 ? '<w:jc w:val="right"/>' : pp.jc === 3 || pp.jc === 4 ? '<w:jc w:val="both"/>' : '',
    ].join('');

  interface PBuilt {
    xml: string;
    para: Para;
    end: string; // the end mark: \r paragraph, \x07 cell / row
    pageBreakAfter: boolean;
  }
  const built: PBuilt[] = [];
  let runsXml = '';
  let curText = '';
  let curChp: Chp | null = null;
  let curKey = '';
  const fieldStack: ('code' | 'result')[] = [];
  let pendingBreakPage = false;
  const flush = () => {
    if (curText && curChp) runsXml += `<w:r>${rPrOf(curChp) ? `<w:rPr>${rPrOf(curChp)}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(curText)}</w:t></w:r>`;
    curText = '';
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const fc = fcs[i];
    const cr = findRun(chpx, fc);
    const chp = cr ? charProps(cr.grpprl, fonts) : {};
    const key = JSON.stringify(chp);
    const code = ch.charCodeAt(0);
    // fields: show the result, never the field code
    if (code === 0x13) {
      fieldStack.push('code');
      continue;
    }
    if (code === 0x14) {
      if (fieldStack.length) fieldStack[fieldStack.length - 1] = 'result';
      continue;
    }
    if (code === 0x15) {
      fieldStack.pop();
      continue;
    }
    if (fieldStack.includes('code')) continue;
    if (code === 0x0d || code === 0x07) {
      flush();
      const pr = findRun(papx, fc);
      const para = paraProps(pr?.grpprl ?? [], pr?.istd ?? 0);
      built.push({ xml: runsXml, para, end: ch, pageBreakAfter: pendingBreakPage });
      pendingBreakPage = false;
      runsXml = '';
      curChp = null;
      curKey = '';
      continue;
    }
    if (chp.vanish) continue;
    if (chp.special || code < 0x20) {
      // special characters: pictures, drawn objects, footnote marks, breaks
      if (code === 0x01 || code === 0x08) notes.add('pictures');
      else if (code === 0x02) notes.add('footnotes');
      else if (code === 0x05) notes.add('comments');
      else if (code === 0x0b) {
        flush();
        runsXml += '<w:r><w:br/></w:r>';
      } else if (code === 0x0c) {
        flush();
        runsXml += '<w:r><w:br w:type="page"/></w:r>';
      } else if (code === 0x09) {
        flush();
        runsXml += '<w:r><w:tab/></w:r>';
      } else if (code === 0x1e) curText += '-';
      continue;
    }
    if (key !== curKey) {
      flush();
      curChp = chp;
      curKey = key;
    }
    curText += ch === ' ' ? ' ' : ch;
  }
  flush();
  if (runsXml) built.push({ xml: runsXml, para: { istd: 0, inTable: false, ttp: false }, end: '\r', pageBreakAfter: false });

  // group into body: paragraphs and tables (cells end with \x07, rows end with a TTP paragraph)
  const body: string[] = [];
  const pXml = (b: PBuilt) => `<w:p>${pPrOf(b.para) ? `<w:pPr>${pPrOf(b.para)}</w:pPr>` : ''}${b.xml}</w:p>`;
  let row: PBuilt[][] = [];
  let cell: PBuilt[] = [];
  let rows: { cells: PBuilt[][]; def?: Para['cells'] }[] = [];
  const closeTable = () => {
    if (!rows.length) return;
    // the grid: every cell boundary of every row (merged cells span several grid columns)
    const bounds = [...new Set(rows.flatMap((r) => r.def?.x ?? []))].sort((a, b) => a - b);
    const ncol = Math.max(1, ...rows.map((r) => r.cells.length));
    const even = Math.floor((pgW - mar[1] - mar[3]) / ncol);
    const grid = bounds.length > 1 ? bounds.slice(1).map((x, i) => Math.max(50, x - bounds[i])) : Array.from({ length: ncol }, () => even);
    let xml = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    for (const r of rows) {
      const def = r.def;
      xml += '<w:tr>';
      r.cells.forEach((c, ci) => {
        const tc = def?.tc[ci];
        if (tc?.merged) return; // continuation of a horizontally merged cell
        let last = ci + 1;
        while (def?.tc[last]?.merged) last++;
        let span = 1;
        let w = grid[ci] ?? even;
        if (def && bounds.length > 1 && def.x.length > last) {
          const a = bounds.indexOf(def.x[ci]);
          const z = bounds.indexOf(def.x[last]);
          if (a >= 0 && z > a) span = z - a;
          w = def.x[last] - def.x[ci];
        }
        const b = tc?.borders ?? [true, true, true, true];
        const bd = (name: string, on: boolean) => `<w:${name} w:val="${on ? 'single' : 'nil'}" w:sz="4"/>`;
        xml += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${tc?.vMerge ? (tc.vRestart ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : ''}<w:tcBorders>${bd('top', b[0])}${bd('left', b[1])}${bd('bottom', b[2])}${bd('right', b[3])}</w:tcBorders></w:tcPr>${c.map(pXml).join('') || '<w:p/>'}</w:tc>`;
      });
      xml += '</w:tr>';
    }
    body.push(xml + '</w:tbl>');
    rows = [];
  };
  for (const b of built) {
    if (b.para.inTable || b.end === '\x07') {
      if (b.para.ttp) {
        // row end mark: closes the row
        if (cell.length) row.push(cell);
        rows.push({ cells: row, ...(b.para.cells ? { def: b.para.cells } : {}) });
        row = [];
        cell = [];
        continue;
      }
      cell.push(b);
      if (b.end === '\x07') {
        row.push(cell);
        cell = [];
      }
      continue;
    }
    if (row.length || cell.length) {
      if (cell.length) row.push(cell);
      rows.push({ cells: row });
      row = [];
      cell = [];
    }
    closeTable();
    body.push(pXml(b));
    if (b.pageBreakAfter) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }
  if (row.length || cell.length) {
    if (cell.length) row.push(cell);
    rows.push({ cells: row });
  }
  closeTable();
  if (built.some((b) => b.para.list)) notes.add('lists');

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docXml = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="${pgW}" w:h="${pgH}"/><w:pgMar w:top="${mar[0]}" w:right="${mar[1]}" w:bottom="${mar[2]}" w:left="${mar[3]}"/></w:sectPr></w:body></w:document>`;
  // the document's own paragraph styles (Normal, headings, …) with their properties; built-in
  // heading styles (sti 1–9) keep with the next paragraph
  const styleXml = styles
    .filter((x) => x && x.stk === 1)
    .map((x) => {
      const pp = paraProps(x.papx, x.istd);
      if (x.sti >= 1 && x.sti <= 9) pp.keepNext = true;
      const pPr = pPrOf({ ...pp, istd: -1 });
      const rPr = rPrOf(charProps(x.chpx, fonts));
      const based = x.base !== 0xfff && styleIds.has(x.base) && x.base !== x.istd ? `<w:basedOn w:val="s${x.base}"/>` : '';
      return `<w:style w:type="paragraph"${x.istd === 0 ? ' w:default="1"' : ''} w:styleId="s${x.istd}"><w:name w:val="${esc(x.name || `style ${x.istd}`)}"/>${based}${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`;
    })
    .join('');
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>${styleXml}</w:styles>`;
  const parts: Record<string, string> = { 'word/document.xml': docXml, 'word/styles.xml': stylesXml };
  return { parts: { text: (name: string) => Promise.resolve(parts[name] ?? null) }, notes: [...notes] };
}

export { CfbError };
