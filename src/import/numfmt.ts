/**
 * Excel number formats (0.9 import): the text a cell shows for its stored (cached) value.
 *
 * Covers what spreadsheets use day to day: General, fixed decimals, thousands separators,
 * percentages, scientific notation, currency and literal text, negative / zero / text sections,
 * colours ([Red]…), dates and times (both date systems, Chinese built-ins), elapsed time ([h]), and
 * the text placeholder @. Values are never recalculated — this only formats what the file stores.
 */

/** Built-in format codes (ECMA-376 18.8.30; 14 / 22 follow the Chinese locale's short date). */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"¥"#,##0;"¥"-#,##0',
  6: '"¥"#,##0;[Red]"¥"-#,##0',
  7: '"¥"#,##0.00;"¥"-#,##0.00',
  8: '"¥"#,##0.00;[Red]"¥"-#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'yyyy/m/d',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'yyyy/m/d h:mm',
  27: 'yyyy"年"m"月"',
  28: 'm"月"d"日"',
  29: 'm"月"d"日"',
  30: 'm-d-yy',
  31: 'yyyy"年"m"月"d"日"',
  32: 'h"时"mm"分"',
  33: 'h"时"mm"分"ss"秒"',
  34: '上午/下午h"时"mm"分"',
  35: '上午/下午h"时"mm"分"ss"秒"',
  36: 'yyyy"年"m"月"',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("¥"* #,##0_);_("¥"* (#,##0);_("¥"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("¥"* #,##0.00_);_("¥"* (#,##0.00);_("¥"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
  50: 'yyyy"年"m"月"',
  51: 'm"月"d"日"',
  52: 'yyyy"年"m"月"',
  53: 'm"月"d"日"',
  54: 'm"月"d"日"',
  55: '上午/下午h"时"mm"分"',
  56: '上午/下午h"时"mm"分"ss"秒"',
  57: 'yyyy"年"m"月"',
  58: 'm"月"d"日"',
};

export interface Formatted {
  text: string;
  /** colour from a [Red]-style section */
  color?: string;
}

const COLORS: Record<string, string> = { red: '#ff0000', blue: '#0000ff', green: '#008000', black: '#000000', white: '#ffffff', yellow: '#ffff00', magenta: '#ff00ff', cyan: '#00ffff' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Split a format code into sections at ';' outside quotes / brackets / escapes. */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  let br = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\\' && !q) {
      cur += c + (code[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') q = !q;
    else if (!q && c === '[') br = true;
    else if (!q && c === ']') br = false;
    if (c === ';' && !q && !br) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Remove quoted literals and escapes (to look at the code's tokens only). */
const bare = (s: string) => s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, (m) => (/^\[h+\]$|^\[m+\]$|^\[s+\]$/i.test(m) ? m : ''));

export function isDateFormat(code: string): boolean {
  const b = bare(sections(code)[0] ?? '');
  return /[yd]|h|s|\[h+\]|上午|AM\/PM/i.test(b.replace(/General/gi, '')) || /(^|[^0#?])m+([^0#?]|$)/i.test(b.replace(/General/gi, '').replace(/E[+-]/gi, ''));
}

/** Excel serial date → parts (1900 system with its 29-Feb-1900 quirk, or the 1904 system). */
export function serialToDate(serial: number, date1904 = false): { y: number; m: number; d: number; wd: number; H: number; M: number; S: number; ms: number } {
  let days = Math.floor(serial);
  // to the millisecond, so 0.9999999 of a day does not show as 23:59:59
  let ms = Math.round((serial - days) * 86400000);
  if (ms >= 86400000) {
    ms -= 86400000;
    days += 1;
  }
  // 1900 system: serial 1 = 1900-01-01, serial 60 = Excel's 1900-02-29 that never was, 25569 = 1970-01-01;
  // 1904 system: serial 0 = 1904-01-01, 24107 = 1970-01-01
  const epochDays = date1904 ? days - 24107 : days - 25569 + (days < 60 ? 1 : 0);
  const dt = new Date(epochDays * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay(), H: Math.floor(ms / 3600000), M: Math.floor((ms % 3600000) / 60000), S: Math.floor((ms % 60000) / 1000), ms: ms % 1000 };
}

function formatDate(v: number, code: string, date1904: boolean): string {
  const t = serialToDate(v, date1904);
  const ampm = /AM\/PM|A\/P|上午\/下午/i.test(code);
  let out = '';
  let lastWasHour = false;
  const toks = code.match(/"[^"]*"|\\.|\[h+\]|\[m+\]|\[s+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|\.0+|AM\/PM|A\/P|上午\/下午|./gi) ?? [];
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    const lk = k.toLowerCase();
    if (k.startsWith('"')) out += k.slice(1, -1);
    else if (k.startsWith('\\')) out += k.slice(1);
    else if (/^\[h+\]$/i.test(k)) {
      out += String(Math.floor(v * 24));
      lastWasHour = true;
    } else if (/^\[m+\]$/i.test(k)) out += String(Math.floor(v * 1440));
    else if (/^\[s+\]$/i.test(k)) out += String(Math.floor(v * 86400));
    else if (lk === 'yyyy') out += String(t.y);
    else if (lk === 'yy') out += String(t.y % 100).padStart(2, '0');
    else if (lk === 'd') out += String(t.d);
    else if (lk === 'dd') out += String(t.d).padStart(2, '0');
    else if (lk === 'ddd') out += DAYS[t.wd].slice(0, 3);
    else if (lk === 'dddd') out += DAYS[t.wd];
    else if (lk === 'h' || lk === 'hh') {
      let H = t.H;
      if (ampm) H = H % 12 || 12;
      out += lk === 'hh' ? String(H).padStart(2, '0') : String(H);
      lastWasHour = true;
      continue;
    } else if (lk === 's' || lk === 'ss') out += lk === 'ss' ? String(t.S).padStart(2, '0') : String(t.S);
    else if (/^\.0+$/.test(k)) out += '.' + String(t.ms).padStart(3, '0').slice(0, k.length - 1);
    else if (lk === 'am/pm') out += t.H < 12 ? 'AM' : 'PM';
    else if (lk === 'a/p') out += t.H < 12 ? 'A' : 'P';
    else if (k === '上午/下午') out += t.H < 12 ? '上午' : '下午';
    else if (lk.startsWith('m')) {
      // minutes right after an hour or right before seconds; otherwise months
      const next = toks.slice(i + 1).find((x) => /^[a-z]/i.test(x) || x.startsWith('['));
      const minute = (lastWasHour || /^s/i.test(next ?? '')) && lk.length <= 2;
      if (minute) out += lk === 'mm' ? String(t.M).padStart(2, '0') : String(t.M);
      else out += lk === 'm' ? String(t.m) : lk === 'mm' ? String(t.m).padStart(2, '0') : lk === 'mmm' ? MONTHS[t.m - 1].slice(0, 3) : lk === 'mmmmm' ? MONTHS[t.m - 1][0] : MONTHS[t.m - 1];
    } else if (k === '_') i++; // skip the padding character
    else if (k === '*') i++;
    else out += k;
    if (/[a-z]/i.test(k) && !/^h/i.test(k)) lastWasHour = false;
  }
  return out;
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatNumber(v: number, code: string): string {
  // literal text around the number part
  let pre = '';
  let post = '';
  let num = '';
  let seenNum = false;
  let percent = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      const j = code.indexOf('"', i + 1);
      const lit = code.slice(i + 1, j < 0 ? undefined : j);
      if (seenNum) post += lit;
      else pre += lit;
      i = j < 0 ? code.length : j;
    } else if (c === '\\') {
      if (seenNum) post += code[i + 1] ?? '';
      else pre += code[i + 1] ?? '';
      i++;
    } else if (c === '_') {
      if (seenNum) post += ' ';
      else pre += ' ';
      i++;
    } else if (c === '*') i++;
    else if (c === '[') {
      const j = code.indexOf(']', i);
      const inner = code.slice(i + 1, j);
      const cur = /^\$([^-\]]*)/.exec(inner);
      if (cur && cur[1]) {
        if (seenNum) post += cur[1];
        else pre += cur[1];
      }
      i = j < 0 ? code.length : j;
    } else if (/[0#?.,]/.test(c) || (seenNum && /[eE]/.test(c) && /[+-]/.test(code[i + 1] ?? ''))) {
      if (post) {
        // digits after a literal: part of the same number pattern (rare); keep simple
        num += c;
        continue;
      }
      num += c;
      seenNum = true;
      if (/[eE]/.test(c)) {
        num += code[i + 1];
        i++;
        while (/[0#]/.test(code[i + 1] ?? '')) num += code[++i];
      }
    } else if (c === '%') {
      percent++;
      if (seenNum) post += '%';
      else pre += '%';
    } else if (seenNum) post += c;
    else pre += c;
  }
  let x = v * Math.pow(100, percent);
  if (!num) return pre + post;
  const sci = /[eE][+-]/.exec(num);
  if (sci) {
    const [mant, expPart] = num.split(/[eE][+-]/);
    const dec = (mant.split('.')[1] ?? '').replace(/[^0#?]/g, '').length;
    const expDigits = Math.max(1, expPart.replace(/[^0]/g, '').length);
    if (x === 0) return pre + (0).toFixed(dec) + 'E+' + '0'.repeat(expDigits) + post;
    let e = Math.floor(Math.log10(Math.abs(x)));
    let m = x / Math.pow(10, e);
    if (Number(m.toFixed(dec)) >= 10) {
      m /= 10;
      e += 1;
    }
    return pre + m.toFixed(dec) + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(expDigits, '0') + post;
  }
  // trailing commas scale by thousands
  let scaled = num;
  while (scaled.endsWith(',')) {
    x /= 1000;
    scaled = scaled.slice(0, -1);
  }
  const [ip, dp = ''] = scaled.split('.');
  const decZero = dp.replace(/[^0]/g, '').length;
  const decAll = dp.replace(/[^0#?]/g, '').length;
  const thousands = ip.includes(',');
  const minInt = ip.replace(/[^0]/g, '').length;
  let s = Math.abs(x).toFixed(decAll);
  // optional decimals (#): drop trailing zeros beyond the required ones
  if (decAll > decZero && s.includes('.')) {
    const [a, b] = s.split('.');
    let bb = b;
    while (bb.length > decZero && bb.endsWith('0')) bb = bb.slice(0, -1);
    s = bb ? `${a}.${bb}` : a;
  }
  let [a, b] = s.split('.');
  if (a === '0' && minInt === 0) a = '';
  a = a.padStart(minInt, '0');
  if (thousands) a = groupThousands(a);
  const body = b !== undefined ? `${a}.${b}` : dp.includes('.') || scaled.includes('.') ? (decAll ? `${a}.` : a) : a;
  return pre + body + post;
}

/**
 * The text Excel shows for a number in a format. `General` shows up to 11 significant digits like
 * Excel; dates follow the workbook's date system.
 */
export function formatValue(v: number, code: string | undefined, date1904 = false): Formatted {
  const fmt = code && code.trim() ? code : 'General';
  const secs = sections(fmt);
  let sec = secs[0];
  let neg = false;
  // conditional sections ([>=100]) are rare; the usual positive;negative;zero;text order is used
  if (v < 0 && secs.length >= 2 && secs[1] !== undefined) {
    sec = secs[1];
    neg = true;
  } else if (v === 0 && secs.length >= 3) sec = secs[2];
  let color: string | undefined;
  sec = sec.replace(/\[(red|blue|green|black|white|yellow|magenta|cyan)\]/i, (_, c: string) => {
    color = COLORS[c.toLowerCase()];
    return '';
  });
  sec = sec.replace(/\[[<>=][^\]]*\]/g, '');
  const x = neg ? Math.abs(v) : v;
  let text: string;
  if (/^general$/i.test(sec.trim()) || !sec.trim()) text = general(v);
  else if (/General/i.test(sec)) text = sec.replace(/"([^"]*)"/g, '$1').replace(/General/i, general(x));
  else if (isDateFormat(sec)) text = v < 0 ? '#'.repeat(8) : formatDate(v, sec, date1904);
  else if (/^@$/.test(sec.trim())) text = general(v);
  else text = formatNumber(x, sec);
  // a negative number in a single-section format keeps its sign
  if (v < 0 && !neg) text = '-' + text;
  return color ? { text, color } : { text };
}

/** Text in a format with a text section ("@"). */
export function formatText(s: string, code: string | undefined): string {
  if (!code) return s;
  const secs = sections(code);
  const sec = secs.length >= 4 ? secs[3] : secs.find((x) => x.includes('@'));
  if (!sec) return s;
  return sec.replace(/"([^"]*)"/g, '$1').replace(/_./g, ' ').replace(/\*./g, '').replace('@', s);
}

/** Excel's General format: up to 11 significant digits, scientific for very large / small. */
export function general(v: number): string {
  if (!Number.isFinite(v)) return '#NUM!';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e11 || a < 1e-9) {
    const s = v.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E');
    return s.replace(/E([+-])(\d)$/, 'E$10$2');
  }
  const digits = Math.max(0, 10 - Math.floor(Math.log10(a)));
  let s = v.toFixed(Math.min(digits, 10));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
