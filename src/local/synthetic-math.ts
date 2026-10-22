/**
 * Synthetic handwritten math (MOCK DATA): single-stroke glyph skeletons laid out by a tiny
 * expression tree (sequence, superscript, subscript, fraction, square root), with per-glyph jitter,
 * slant and wobble. Used to exercise the local math pipeline end to end (rendering → model →
 * LaTeX) when no real handwriting is available. It is NOT a substitute for real handwriting:
 * accuracy measured on it is reported separately and labelled "synthetic".
 */

export type Pt = [number, number];
export interface InkStrokeSim {
  pts: Pt[];
}

// glyph skeletons: unit height 1 (cap height), y down; x-height glyphs sit in [0.45, 1]
const G: Record<string, { w: number; s: Pt[][] }> = {
  '0': { w: 0.6, s: [ellipse(0.3, 0.5, 0.3, 0.5)] },
  '1': { w: 0.4, s: [[[0.05, 0.22], [0.3, 0], [0.3, 1]]] },
  '2': { w: 0.6, s: [[[0.03, 0.25], [0.15, 0.06], [0.35, 0], [0.55, 0.1], [0.56, 0.32], [0.02, 1], [0.62, 1]]] },
  '3': { w: 0.6, s: [[[0.05, 0.1], [0.3, 0], [0.55, 0.12], [0.5, 0.38], [0.25, 0.48], [0.52, 0.56], [0.6, 0.8], [0.4, 1], [0.05, 0.92]]] },
  '4': { w: 0.65, s: [[[0.45, 0], [0.02, 0.68], [0.65, 0.68]], [[0.48, 0.3], [0.48, 1]]] },
  '5': { w: 0.6, s: [[[0.55, 0], [0.12, 0], [0.08, 0.45], [0.35, 0.38], [0.58, 0.55], [0.55, 0.88], [0.3, 1], [0.03, 0.9]]] },
  '6': { w: 0.6, s: [[[0.5, 0.02], [0.2, 0.25], [0.05, 0.65], [0.15, 0.95], [0.4, 1], [0.58, 0.8], [0.5, 0.55], [0.25, 0.52], [0.07, 0.7]]] },
  '7': { w: 0.6, s: [[[0.02, 0], [0.6, 0], [0.22, 1]]] },
  '8': { w: 0.6, s: [[[0.5, 0.12], [0.3, 0], [0.08, 0.15], [0.15, 0.4], [0.45, 0.55], [0.58, 0.8], [0.35, 1], [0.05, 0.85], [0.15, 0.6], [0.48, 0.4], [0.52, 0.18]]] },
  '9': { w: 0.6, s: [[[0.55, 0.3], [0.4, 0.45], [0.12, 0.42], [0.05, 0.2], [0.25, 0], [0.5, 0.05], [0.56, 0.3], [0.5, 1]]] },
  x: { w: 0.55, s: [[[0, 0.45], [0.55, 1]], [[0.55, 0.45], [0, 1]]] },
  y: { w: 0.55, s: [[[0, 0.45], [0.28, 0.9]], [[0.55, 0.45], [0.12, 1.4]]] },
  a: { w: 0.55, s: [[[0.45, 0.55], [0.3, 0.45], [0.08, 0.55], [0.05, 0.85], [0.25, 1], [0.45, 0.85], [0.47, 0.45], [0.5, 1]]] },
  b: { w: 0.55, s: [[[0.08, 0], [0.08, 1], [0.08, 0.7], [0.3, 0.48], [0.5, 0.6], [0.5, 0.88], [0.3, 1], [0.08, 0.9]]] },
  c: { w: 0.5, s: [[[0.45, 0.52], [0.25, 0.45], [0.05, 0.6], [0.05, 0.85], [0.25, 1], [0.47, 0.92]]] },
  n: { w: 0.55, s: [[[0.05, 0.45], [0.05, 1], [0.05, 0.6], [0.25, 0.45], [0.48, 0.55], [0.5, 1]]] },
  '+': { w: 0.6, s: [[[0.02, 0.6], [0.58, 0.6]], [[0.3, 0.32], [0.3, 0.88]]] },
  '-': { w: 0.5, s: [[[0.02, 0.6], [0.48, 0.6]]] },
  '=': { w: 0.6, s: [[[0.02, 0.48], [0.58, 0.48]], [[0.02, 0.72], [0.58, 0.72]]] },
  '(': { w: 0.3, s: [[[0.28, -0.05], [0.08, 0.3], [0.05, 0.6], [0.1, 0.9], [0.28, 1.15]]] },
  ')': { w: 0.3, s: [[[0.02, -0.05], [0.22, 0.3], [0.25, 0.6], [0.2, 0.9], [0.02, 1.15]]] },
};

function ellipse(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 - (i / 16) * Math.PI * 2;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

export type MathNode = string | { seq: MathNode[] } | { sup: [MathNode, MathNode] } | { sub: [MathNode, MathNode] } | { frac: [MathNode, MathNode] } | { sqrt: MathNode };

interface Box {
  w: number;
  /** extent above / below the baseline (baseline = bottom of a digit) */
  up: number;
  down: number;
  draw(x: number, base: number, out: Pt[][]): void;
}

function layout(n: MathNode, size: number): Box {
  if (typeof n === 'string') {
    const parts = Array.from(n);
    if (parts.length > 1) return layout({ seq: parts }, size);
    const g = G[n];
    if (!g) throw new Error(`no glyph for ${n}`);
    const descend = Math.max(0, ...g.s.flat().map((p) => p[1] - 1));
    return {
      w: g.w * size + size * 0.18,
      up: size,
      down: descend * size,
      draw: (x, base, out) => {
        for (const st of g.s) out.push(st.map(([px, py]) => [x + px * size, base - size + py * size]));
      },
    };
  }
  if ('seq' in n) {
    const kids = n.seq.map((k) => layout(k, size));
    return {
      w: kids.reduce((a, k) => a + k.w, 0),
      up: Math.max(...kids.map((k) => k.up)),
      down: Math.max(0, ...kids.map((k) => k.down)),
      draw: (x, base, out) => {
        let cx = x;
        for (const k of kids) {
          k.draw(cx, base, out);
          cx += k.w;
        }
      },
    };
  }
  if ('sup' in n || 'sub' in n) {
    const [b, s] = 'sup' in n ? n.sup : n.sub;
    const bb = layout(b, size);
    const sb = layout(s, size * 0.6);
    const shift = 'sup' in n ? -size * 0.55 : size * 0.3;
    return {
      w: bb.w + sb.w,
      up: Math.max(bb.up, sb.up - shift),
      down: Math.max(bb.down, sb.down + shift),
      draw: (x, base, out) => {
        bb.draw(x, base, out);
        sb.draw(x + bb.w, base + shift, out);
      },
    };
  }
  if ('frac' in n) {
    const nb = layout(n.frac[0], size * 0.9);
    const db = layout(n.frac[1], size * 0.9);
    const w = Math.max(nb.w, db.w) + size * 0.3;
    const bar = -size * 0.4;
    return {
      w: w + size * 0.2,
      up: -bar + size * 0.15 + nb.down + nb.up,
      down: bar + size * 0.15 + db.up + db.down,
      draw: (x, base, out) => {
        nb.draw(x + (w - nb.w) / 2, base + bar - size * 0.15 - nb.down, out);
        out.push([[x, base + bar], [x + w, base + bar]]);
        db.draw(x + (w - db.w) / 2, base + bar + size * 0.15 + db.up, out);
      },
    };
  }
  const rb = layout(n.sqrt, size);
  const top = rb.up + size * 0.2;
  return {
    w: rb.w + size * 0.6,
    up: top,
    down: rb.down + size * 0.05,
    draw: (x, base, out) => {
      out.push([[x, base - size * 0.45], [x + size * 0.12, base - size * 0.55], [x + size * 0.3, base + size * 0.05], [x + size * 0.48, base - top], [x + size * 0.55 + rb.w, base - top]]);
      rb.draw(x + size * 0.55, base, out);
    },
  };
}

/** Deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strokes of an expression in page units, densified (a point every ~0.8 unit) and perturbed. */
export function mathInk(n: MathNode, opts: { x?: number; y?: number; size?: number; seed?: number; jitter?: number } = {}): Pt[][] {
  const size = opts.size ?? 28;
  const r = rng(opts.seed ?? 1);
  const j = opts.jitter ?? 1;
  const box = layout(n, size);
  const raw: Pt[][] = [];
  box.draw(opts.x ?? 60, (opts.y ?? 100) + box.up, raw);
  const slant = (r() - 0.5) * 0.15 * j;
  return raw.map((st) => {
    const dx = (r() - 0.5) * size * 0.06 * j;
    const dy = (r() - 0.5) * size * 0.06 * j;
    const out: Pt[] = [];
    for (let k = 1; k < st.length; k++) {
      const [ax, ay] = st[k - 1];
      const [bx, by] = st[k];
      const m = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 0.8));
      for (let q = 0; q < m; q++) {
        const t = q / m;
        const wob = Math.sin((k + t) * 2.1) * size * 0.012 * j;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        out.push([x + dx + wob - (y - (opts.y ?? 100)) * slant, y + dy + wob]);
      }
    }
    const [lx, ly] = st[st.length - 1];
    out.push([lx + dx - (ly - (opts.y ?? 100)) * slant, ly + dy]);
    return out;
  });
}

/** The synthetic test set: expression tree + expected LaTeX (CROHME token style). */
export const MATH_CASES: { name: string; node: MathNode; latex: string }[] = [
  { name: 'x^2+y^2', node: { seq: [{ sup: ['x', '2'] }, '+', { sup: ['y', '2'] }] }, latex: 'x ^ { 2 } + y ^ { 2 }' },
  { name: 'sqrt(x+1)', node: { sqrt: 'x+1' }, latex: '\\sqrt { x + 1 }' },
  { name: 'a/b', node: { frac: ['a', 'b'] }, latex: '\\frac { a } { b }' },
  { name: 'a+b=c', node: 'a+b=c', latex: 'a + b = c' },
  { name: '2x+3=7', node: '2x+3=7', latex: '2 x + 3 = 7' },
  { name: '1/2', node: { frac: ['1', '2'] }, latex: '\\frac { 1 } { 2 }' },
  { name: '(a+b)^2', node: { seq: ['(a+b', { sup: [')', '2'] }] }, latex: '( a + b ) ^ { 2 }' },
  { name: 'y=2x+1', node: 'y=2x+1', latex: 'y = 2 x + 1' },
  { name: 'sqrt(x^2+y^2)', node: { sqrt: { seq: [{ sup: ['x', '2'] }, '+', { sup: ['y', '2'] }] } }, latex: '\\sqrt { x ^ { 2 } + y ^ { 2 } }' },
  { name: 'x_1+x_2', node: { seq: [{ sub: ['x', '1'] }, '+', { sub: ['x', '2'] }] }, latex: 'x _ { 1 } + x _ { 2 }' },
  { name: '(x+1)/(y-1)', node: { frac: ['x+1', 'y-1'] }, latex: '\\frac { x + 1 } { y - 1 }' },
  { name: '3+4=7', node: '3+4=7', latex: '3 + 4 = 7' },
  { name: 'n^2-1', node: { seq: [{ sup: ['n', '2'] }, '-1'] }, latex: 'n ^ { 2 } - 1' },
  { name: '5x-8=0', node: '5x-8=0', latex: '5 x - 8 = 0' },
  { name: 'b^2-4ac', node: { seq: [{ sup: ['b', '2'] }, '-4ac'] }, latex: 'b ^ { 2 } - 4 a c' },
];
