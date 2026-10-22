import type { FormulaItem } from '../document/items';

/**
 * Formula rendering on the canvas.
 *
 * Obsidian 1.14 ships MathJax 4.1.3 with the CHTML output only (VERIFIED in the desktop app:
 * `MathJax.tex2chtml` exists, `tex2svg` does not, and `output/svg` is not in the bundle). CHTML is
 * HTML laid out by the browser with MathJax's web fonts, so a formula is rendered ONCE off-screen
 * in the document and snapshotted into a small display list — characters (font, size, baseline
 * position, colour) and rules (fraction bars, radical overlines) — which the canvas replays at any
 * zoom with `fillText`, using the very same MathJax fonts the page already loaded. The result looks
 * exactly like math in Obsidian notes and needs no extra library.
 *
 * Without MathJax (the test lab, or before it loads) the LaTeX source is drawn as code instead.
 * Rendering errors are reported, never thrown at the editor.
 */

export interface FGlyph {
  t: string;
  /** em units of the formula size, origin top-left */
  x: number;
  y: number;
  family: string;
  size: number;
  weight: string;
  style: string;
  color: string | null;
}

export interface FRule {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string | null;
}

export interface FormulaDrawing {
  w: number;
  h: number;
  glyphs: FGlyph[];
  rules: FRule[];
  error: string | null;
  /** Rendered by MathJax (false = source fallback). */
  math: boolean;
}

export interface MathEngine {
  /** LaTeX → laid-out-ready CHTML element (display mode). */
  render(latex: string): Promise<HTMLElement>;
  /** Flush MathJax's stylesheet after rendering (Obsidian: finishRenderMath). */
  finish(): Promise<void> | void;
}

export const FORMULA_PAD = 0.25; // em around the formula

let engine: MathEngine | null = null;
const cache = new Map<string, FormulaDrawing>();
const pending = new Map<string, Promise<FormulaDrawing>>();
const listeners = new Set<() => void>();

export function setMathEngine(e: MathEngine | null): void {
  engine = e;
  cache.clear();
  pending.clear();
}

export function hasMathEngine(): boolean {
  return !!engine;
}

export function onFormulaReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Source fallback: the LaTeX drawn as one line of code. */
export function sourceDrawing(latex: string, error: string | null = null): FormulaDrawing {
  const t = latex.replace(/\s+/g, ' ').trim() || '∅';
  return { w: Math.max(1, t.length * 0.55), h: 1.3, glyphs: [{ t, x: 0, y: 1, family: 'ui-monospace, Menlo, Consolas, monospace', size: 0.85, weight: '400', style: 'normal', color: null }], rules: [], error, math: false };
}

/** Cached drawing, or null while it renders (rendering starts on first call). */
export function formulaDrawing(latex: string): FormulaDrawing | null {
  const hit = cache.get(latex);
  if (hit) return hit;
  if (!engine) return sourceDrawing(latex);
  if (!pending.has(latex)) {
    void renderFormula(latex).then(() => {
      for (const l of listeners) l();
    });
  }
  return null;
}

const BASE = 48; // px used for the off-screen layout

function parseColor(c: string): string | null {
  if (!c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)) return null;
  return c;
}

/** Render (or fetch from cache) a formula's display list. Never throws. */
export function renderFormula(latex: string): Promise<FormulaDrawing> {
  const hit = cache.get(latex);
  if (hit) return Promise.resolve(hit);
  const run = pending.get(latex);
  if (run) return run;
  const p = (async (): Promise<FormulaDrawing> => {
    if (!engine || typeof document === 'undefined') return sourceDrawing(latex);
    const host = createDiv();
    host.className = 'hn-formula-measure';
    host.style.cssText = `position:fixed;left:-20000px;top:0;font-size:${BASE}px;line-height:normal;pointer-events:none;contain:layout style;color:#000;white-space:nowrap;`;
    document.body.appendChild(host);
    try {
      const el = await engine.render(latex);
      host.appendChild(el);
      await engine.finish();
      const fontsUsed = new Set<string>();
      for (const e of Array.from(el.querySelectorAll('*'))) {
        const s = getComputedStyle(e);
        fontsUsed.add(`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`);
      }
      try {
        await Promise.all([...fontsUsed].map((f) => document.fonts.load(f).catch(() => [])));
        await document.fonts.ready;
      } catch {
        /* fonts API missing: draw with what is there */
      }
      return snapshot(el, latex);
    } catch (e) {
      return sourceDrawing(latex, e instanceof Error ? e.message : String(e));
    } finally {
      host.remove();
    }
  })().then((d) => {
    cache.set(latex, d);
    pending.delete(latex);
    if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    return d;
  });
  pending.set(latex, p);
  return p;
}

const metricCtx = (() => {
  let c: CanvasRenderingContext2D | null = null;
  return () => {
    if (!c && typeof document !== 'undefined') c = document.createElement('canvas').getContext('2d');
    return c;
  };
})();

function snapshot(root: HTMLElement, latex: string): FormulaDrawing {
  const math = root.querySelector<HTMLElement>('mjx-math') ?? root;
  const origin = math.getBoundingClientRect();
  const glyphs: FGlyph[] = [];
  const rules: FRule[] = [];
  let x0 = 0;
  let y0 = 0;
  let x1 = origin.width;
  let y1 = origin.height;
  const ctx = metricCtx();
  const errEl = root.querySelector('mjx-merror');
  const error = errEl ? (errEl.getAttribute('data-mjx-error') || errEl.textContent || 'LaTeX error').slice(0, 200) : null;
  const rootColor = getComputedStyle(math).color;
  const walker = document.createTreeWalker(math, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? '';
    const parent = n.parentElement;
    if (!parent || !text.trim()) continue;
    const s = getComputedStyle(parent);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const size = parseFloat(s.fontSize) || BASE;
    const font = `${s.fontStyle} ${s.fontWeight} ${size}px ${s.fontFamily}`;
    let asc = 0.8;
    if (ctx) {
      ctx.font = font;
      const m = ctx.measureText('Hg');
      const a = m.fontBoundingBoxAscent;
      const d = m.fontBoundingBoxDescent;
      if (a > 0 && d >= 0) asc = a / (a + d);
    }
    const color = s.color !== rootColor ? parseColor(s.color) : null;
    let i = 0;
    for (const ch of Array.from(text)) {
      const len = ch.length;
      if (ch.trim()) {
        range.setStart(n, i);
        range.setEnd(n, i + len);
        const r = range.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const gx = r.left - origin.left;
          const gy = r.top - origin.top + r.height * asc;
          glyphs.push({ t: ch, x: gx / BASE, y: gy / BASE, family: s.fontFamily, size: size / BASE, weight: s.fontWeight, style: s.fontStyle, color });
          x0 = Math.min(x0, gx);
          x1 = Math.max(x1, r.right - origin.left);
          y0 = Math.min(y0, r.top - origin.top);
          y1 = Math.max(y1, r.bottom - origin.top);
        }
      }
      i += len;
    }
  }
  range.detach?.();
  for (const e of Array.from(math.querySelectorAll<HTMLElement>('*'))) {
    const s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    const rel = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    const side = (name: 'Top' | 'Bottom' | 'Left' | 'Right') => {
      const w = parseFloat(s.getPropertyValue(`border-${name.toLowerCase()}-width`)) || 0;
      if (w <= 0 || s.getPropertyValue(`border-${name.toLowerCase()}-style`) === 'none') return;
      const c = parseColor(s.getPropertyValue(`border-${name.toLowerCase()}-color`));
      if (!c) return;
      const col = c !== rootColor ? c : null;
      if (name === 'Top') rules.push({ x: rel.x / BASE, y: rel.y / BASE, w: rel.w / BASE, h: w / BASE, color: col });
      else if (name === 'Bottom') rules.push({ x: rel.x / BASE, y: (rel.y + rel.h - w) / BASE, w: rel.w / BASE, h: w / BASE, color: col });
      else if (name === 'Left') rules.push({ x: rel.x / BASE, y: rel.y / BASE, w: w / BASE, h: rel.h / BASE, color: col });
      else rules.push({ x: (rel.x + rel.w - w) / BASE, y: rel.y / BASE, w: w / BASE, h: rel.h / BASE, color: col });
    };
    side('Top');
    side('Bottom');
    side('Left');
    side('Right');
    const bg = parseColor(s.backgroundColor);
    if (bg && e.tagName.toLowerCase() !== 'mjx-merror') rules.push({ x: rel.x / BASE, y: rel.y / BASE, w: rel.w / BASE, h: rel.h / BASE, color: bg });
  }
  if (!glyphs.length && !rules.length) return sourceDrawing(latex, error ?? 'empty rendering');
  // normalise so the top-left of everything drawn is (0, 0)
  const ox = x0 / BASE;
  const oy = y0 / BASE;
  for (const g of glyphs) {
    g.x -= ox;
    g.y -= oy;
  }
  for (const r of rules) {
    r.x -= ox;
    r.y -= oy;
  }
  return { w: (x1 - x0) / BASE, h: (y1 - y0) / BASE, glyphs, rules, error, math: true };
}

/** Box (page units) of a formula drawn at `size`. */
export function formulaBoxSize(d: FormulaDrawing, size: number): { w: number; h: number } {
  return { w: (d.w + FORMULA_PAD * 2) * size, h: (d.h + FORMULA_PAD * 2) * size };
}

/** Replay a drawing into the item's box (uniformly fitted, centred). */
export function paintFormula(ctx: CanvasRenderingContext2D, it: FormulaItem): void {
  const d = formulaDrawing(it.latex) ?? sourceDrawing(it.latex);
  const box = formulaBoxSize(d, it.size);
  const k = Math.min(it.w / box.w, it.h / box.h);
  const s = it.size * (Number.isFinite(k) && k > 0 ? k : 1);
  const ox = it.x + (it.w - (d.w + FORMULA_PAD * 2) * s) / 2 + FORMULA_PAD * s;
  const oy = it.y + (it.h - (d.h + FORMULA_PAD * 2) * s) / 2 + FORMULA_PAD * s;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const r of d.rules) {
    ctx.fillStyle = r.color ?? it.color;
    ctx.fillRect(ox + r.x * s, oy + r.y * s, Math.max(r.w * s, 0.3), Math.max(r.h * s, 0.3));
  }
  let lastFont = '';
  for (const g of d.glyphs) {
    const f = `${g.style} ${g.weight} ${g.size * s}px ${g.family}`;
    if (f !== lastFont) {
      ctx.font = f;
      lastFont = f;
    }
    ctx.fillStyle = g.color ?? (d.math ? it.color : 'rgba(110,110,110,1)');
    ctx.fillText(g.t, ox + g.x * s, oy + g.y * s);
  }
  if (d.error) {
    ctx.strokeStyle = '#c92a2a';
    ctx.lineWidth = Math.max(0.6, s * 0.04);
    ctx.setLineDash([s * 0.12, s * 0.08]);
    ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
  }
  ctx.restore();
}

/** Markdown for a formula (display math). */
export function formulaMarkdown(latex: string): string {
  return `$$\n${latex.trim()}\n$$`;
}
