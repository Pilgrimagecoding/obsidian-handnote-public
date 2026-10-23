/**
 * Line breaking for imported Office text (0.9): runs of styled text → lines of positioned pieces.
 * Latin text breaks at spaces (a word longer than the line is split), CJK text between any two
 * characters, closing punctuation never starts a line and opening punctuation never ends one.
 * Measurements come from a Measurer (canvas measureText in the app, a fixed-width stand-in in tests).
 */
import { fontCss, type DLOp } from './display-list';

export interface Measurer {
  /** Width of `text` drawn with the CSS `font` (px = page units). */
  width(text: string, font: string): number;
}

export interface RunStyle {
  font: number;
  size: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  underline?: boolean;
  strike?: boolean;
  highlight?: string;
  vert?: 'super' | 'sub';
}

export type Run =
  | { kind: 'text'; text: string; style: RunStyle }
  | { kind: 'image'; part: string; w: number; h: number }
  | { kind: 'tab'; style: RunStyle }
  | { kind: 'br'; style: RunStyle };

export interface Piece {
  x: number;
  w: number;
  text?: string;
  style?: RunStyle;
  image?: { part: string; w: number; h: number };
}

export interface Line {
  pieces: Piece[];
  width: number;
  /** distance from the top of the line box to the baseline */
  ascent: number;
  height: number;
  /** the line ends the paragraph or a manual break (no justification) */
  last: boolean;
}

const CJK = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
const NO_START = /^[，。、；：！？）》」』】〕〉…—,.;:!?)\]}%’”]/;
const NO_END = /[（《「『【〔〈([{‘“]$/;

export function effSize(s: RunStyle): number {
  return s.vert ? s.size * 0.65 : s.size;
}

export function cssOf(s: RunStyle, fonts: string[]): string {
  return fontCss({ z: effSize(s), ...(s.bold ? { b: 1 as const } : {}), ...(s.italic ? { i: 1 as const } : {}) }, fonts[s.font] ?? 'sans-serif');
}

interface Atom {
  text?: string;
  style: RunStyle;
  image?: { part: string; w: number; h: number };
  w: number;
  tab?: boolean;
  br?: boolean;
  /** whitespace at the end (dropped at a line end) */
  trail: number;
}

function atomsOf(runs: Run[], m: Measurer, fonts: string[]): Atom[] {
  const out: Atom[] = [];
  for (const r of runs) {
    if (r.kind === 'image') {
      out.push({ image: { part: r.part, w: r.w, h: r.h }, style: { font: 0, size: 0 }, w: r.w, trail: 0 });
      continue;
    }
    if (r.kind === 'tab') {
      out.push({ tab: true, style: r.style, w: 0, trail: 0 });
      continue;
    }
    if (r.kind === 'br') {
      out.push({ br: true, style: r.style, w: 0, trail: 0 });
      continue;
    }
    const css = cssOf(r.style, fonts);
    const re = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[^\s\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+\s*|\s+/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(r.text))) {
      const t = mm[0];
      const core = t.replace(/\s+$/, '');
      const w = m.width(t, css);
      const trail = core.length < t.length ? w - (core ? m.width(core, css) : 0) : 0;
      out.push({ text: t, style: r.style, w, trail });
    }
  }
  return out;
}

/**
 * Break runs into lines of `width`; the first line starts at `firstIndent` (may be negative for a
 * hanging indent). `lineHeight(size)` gives the line box height for the largest font on the line.
 */
export function flowLines(runs: Run[], width: number, firstIndent: number, m: Measurer, fonts: string[], lineHeight: (size: number) => number, tabStop = 36): Line[] {
  const atoms = atomsOf(runs, m, fonts);
  // text size of a line that holds only pictures
  const baseSize = runs.find((r): r is Extract<Run, { style: RunStyle }> => 'style' in r)?.style.size ?? 11;
  const lines: Line[] = [];
  let cur: Atom[] = [];
  let x = firstIndent;
  const lineStart = () => (lines.length === 0 ? firstIndent : 0);
  const close = (last: boolean) => {
    // drop trailing whitespace width
    let w = x;
    const tail = cur[cur.length - 1];
    if (tail && tail.trail) w -= tail.trail;
    const pieces: Piece[] = [];
    let px = lineStart();
    let maxSize = 0;
    let maxImg = 0;
    let prevText = false;
    for (const a of cur) {
      const isText = a.text !== undefined && !a.image;
      if (a.image) {
        pieces.push({ x: px, w: a.w, image: a.image });
        maxImg = Math.max(maxImg, a.image.h);
      } else if (a.text !== undefined) {
        const prev = pieces[pieces.length - 1];
        // merge consecutive atoms of the same style into one piece
        if (prevText && prev && prev.style === a.style && prev.text !== undefined) {
          prev.text += a.text;
          prev.w += a.w;
        } else pieces.push({ x: px, w: a.w, text: a.text, style: a.style });
        maxSize = Math.max(maxSize, a.style.size);
      } else if (!a.image) maxSize = Math.max(maxSize, a.style.size);
      px += a.w;
      prevText = isText;
    }
    if (!maxSize) maxSize = baseSize;
    const textH = lineHeight(maxSize);
    const height = Math.max(textH, maxImg + (maxImg ? maxSize * 0.25 : 0));
    const ascent = maxImg ? Math.max(maxImg, maxSize * 0.8 + (textH - maxSize) / 2) : maxSize * 0.8 + (textH - maxSize * 1.0) / 2;
    lines.push({ pieces, width: Math.max(0, w - lineStart()), ascent, height, last });
    cur = [];
    x = 0;
  };
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.br) {
      if (!cur.length) cur.push({ ...a, text: '', w: 0 });
      close(true);
      continue;
    }
    if (a.tab) {
      const next = (Math.floor((x + 0.01) / tabStop) + 1) * tabStop;
      a.w = Math.max(0, next - x);
      cur.push(a);
      x = next;
      continue;
    }
    const glue = a.text !== undefined && NO_START.test(a.text) && cur.length > 0;
    const prevOpen = cur.length > 0 && cur[cur.length - 1].text !== undefined && NO_END.test((cur[cur.length - 1].text as string).trim());
    const fits = x + a.w - a.trail <= width + 0.01;
    if (!fits && cur.length && glue) {
      // closing punctuation never starts a line: the character before it moves down with it
      const prev = cur[cur.length - 1];
      if (cur.length > 1 && prev.text !== undefined && CJK.test(prev.text)) {
        const moved = cur.pop() as Atom;
        x -= moved.w;
        close(false);
        cur.push(moved);
        x = moved.w;
      }
    } else if (!fits && cur.length) {
      // keep an opening bracket with what follows it
      if (prevOpen && cur.length > 1) {
        const moved = cur.pop() as Atom;
        x -= moved.w;
        close(false);
        cur.push(moved);
        x = moved.w;
      } else close(false);
    }
    if (a.text !== undefined && a.w - a.trail > width && !CJK.test(a.text)) {
      // a single word wider than the line: split it by characters
      const css = cssOf(a.style, fonts);
      let part = '';
      for (const ch of Array.from(a.text)) {
        const w2 = m.width(part + ch, css);
        if (x + w2 > width && part) {
          cur.push({ text: part, style: a.style, w: m.width(part, css), trail: 0 });
          x += m.width(part, css);
          close(false);
          part = ch;
        } else part += ch;
      }
      if (part) {
        const w3 = m.width(part, css);
        cur.push({ text: part, style: a.style, w: w3, trail: 0 });
        x += w3;
      }
      continue;
    }
    cur.push(a);
    x += a.w;
  }
  if (cur.length || !lines.length) {
    if (!cur.length) {
      const s = runs.find((r): r is Extract<Run, { style: RunStyle }> => 'style' in r)?.style ?? { font: 0, size: 11 };
      cur.push({ text: '', style: s, w: 0, trail: 0 });
    }
    close(true);
  }
  return lines;
}

/**
 * Emit text / picture / highlight ops for laid-out lines (Word paragraphs, slide text boxes, table
 * cells). `align`: 'l' | 'ctr' | 'r' (anything else = left). Returns the y below the last line.
 */
export function emitLines(lines: Line[], x0: number, y0: number, width: number, align: string, m: Measurer, fonts: string[], ops: DLOp[]): number {
  let yy = y0;
  for (const ln of lines) {
    const free = width - ln.width;
    const dx = align === 'ctr' || align === 'center' ? free / 2 : align === 'r' || align === 'right' || align === 'end' ? free : 0;
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
}

