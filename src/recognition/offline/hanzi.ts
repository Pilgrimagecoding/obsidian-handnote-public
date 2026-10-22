import { HANZI_CHARS, HANZI_COUNT, HANZI_DATA_B64 } from './hanzi-data.generated';

/**
 * Offline Chinese handwriting recognition from digital ink (no network, no keys).
 *
 * Independent implementation (HandNote). It reads the stroke templates of 9,507 characters
 * (Make Me a Hanzi data via HanziLookupJS, Arphic Public License — see vendor/hanzi-mmah/README.md):
 * every template is the character's strokes in standard stroke order, cut into straight
 * "sub-strokes" (direction, length, centre on a 16 × 16 grid).
 *
 * The written character goes through the same description; each candidate template is compared with
 * a banded sequence alignment (sub-strokes may be skipped on either side at a cost proportional to
 * their length), scored by direction, length and position agreement, normalised by the sequence
 * length and lightly biased towards common characters (GB2312 level 1 / 2).
 *
 * Honest limits (see docs/RECOGNITION_ARCHITECTURE.md): one character at a time (a line is split
 * by `recognizeLine`), relies on standard stroke order, Chinese characters only (no Latin letters,
 * digits or math), weak on joined cursive strokes.
 */

export type Pt = [number, number];

export interface HanziCandidate {
  ch: string;
  score: number;
}

interface Sub {
  dir: number; // 0..255, 0 = right, 64 = up (screen y grows down)
  len: number; // 0..255 of the square's diagonal
  cx: number; // 0..15
  cy: number; // 0..15
}

const HB = 16; // coarse histogram: 4 directions (undirected) × 4 quadrants, weighted by length

function histIndex(dir: number, cx: number, cy: number): number {
  const d = Math.round(((dir % 128) / 128) * 4) % 4; // undirected: 0 = —, 1 = /, 2 = |, 3 = \
  const q = (cx >= 8 ? 1 : 0) + (cy >= 8 ? 2 : 0);
  return q * 4 + d;
}

interface Db {
  /** coarse histograms (HB per template), for a fast first pass */
  hist: Float32Array;
  /** template indices grouped by stroke count */
  byStrokes: number[][];
  chars: string[];
  strokes: Uint8Array;
  subs: Uint8Array;
  gb: Uint8Array;
  offset: Uint32Array;
  data: Uint8Array;
}

let db: Db | null = null;

function decodeB64(s: string): Uint8Array {
  // atob exists in every browser and in Node 16+ (tests)
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode the template table once (lazy: only when offline recognition is first used). */
export function hanziDb(): Db {
  if (db) return db;
  const all = decodeB64(HANZI_DATA_B64);
  const n = HANZI_COUNT;
  const chars = Array.from(HANZI_CHARS);
  const strokes = all.subarray(0, n);
  const subs = all.subarray(n, 2 * n);
  const gb = all.subarray(2 * n, 3 * n);
  const data = all.subarray(3 * n);
  const offset = new Uint32Array(n);
  let o = 0;
  for (let i = 0; i < n; i++) {
    offset[i] = o;
    o += subs[i] * 3;
  }
  const hist = new Float32Array(n * HB);
  for (let i = 0; i < n; i++) {
    let tot = 0;
    for (let k = 0; k < subs[i]; k++) {
      const p = offset[i] + k * 3;
      const c = data[p + 2];
      const len = data[p + 1] + 8;
      hist[i * HB + histIndex(data[p], c >> 4, c & 15)] += len;
      tot += len;
    }
    for (let k = 0; k < HB; k++) hist[i * HB + k] /= tot || 1;
  }
  const byStrokes: number[][] = [];
  for (let i = 0; i < n; i++) (byStrokes[strokes[i]] ??= []).push(i);
  db = { hist, byStrokes, chars, strokes, subs, gb, offset, data };
  return db;
}

export function hanziSize(): number {
  return HANZI_COUNT;
}

// ------------------------------------------------------------------------------------------------
// Ink → sub-strokes
// ------------------------------------------------------------------------------------------------

/** Tuning knobs (exported for the offline benchmark; defaults chosen on synthetic ink). */
export const HANZI_TUNE = {
  method: 'ratio' as 'rdp' | 'ratio',
  eps: 0.05,
  minSeg: 0.09,
  step: 0.045,
  ratio: 1.07,
  sigma: 3.3,
  gapBase: 0.2,
  gapLen: 1.1,
  narrow: 1.5,
  wide: 1.2,
  mergeGap: 0.3,
  smooth: 2,
  /** templates kept by the coarse first pass */
  pool: 4000,
  /** cost of starting a new character (fraction of the line height): prefers whole characters */
  perChar: 0.2,
};

/** Light moving-average smoothing (keeps the end points). */
function smoothPts(pts: Pt[], passes: number): Pt[] {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    if (p.length < 3) return p;
    const q: Pt[] = [p[0]];
    for (let i = 1; i < p.length - 1; i++) q.push([(p[i - 1][0] + 2 * p[i][0] + p[i + 1][0]) / 4, (p[i - 1][1] + 2 * p[i][1] + p[i + 1][1]) / 4]);
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Resample a polyline to (roughly) constant spacing. */
function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let d = Math.hypot(bx - ax, by - ay);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push([ax, ay]);
      d = Math.hypot(bx - ax, by - ay);
      acc = 0;
    }
    acc += d;
  }
  const last = pts[pts.length - 1];
  const l = out[out.length - 1];
  if (Math.hypot(last[0] - l[0], last[1] - l[1]) > step * 0.3) out.push(last);
  return out;
}

/** Corners where the path stops being straight: path length from the last corner exceeds the chord. */
function ratioCorners(pts: Pt[], ratio: number, minSeg: number): number[] {
  const idx = [0];
  let start = 0;
  let path = 0;
  for (let i = 1; i < pts.length; i++) {
    path += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const chord = Math.hypot(pts[i][0] - pts[start][0], pts[i][1] - pts[start][1]);
    if (chord > minSeg * 0.5 && path > ratio * chord + 0.01) {
      // the corner is the point farthest from the chord start→i
      let best = start + 1;
      let bd = -1;
      for (let k = start + 1; k < i; k++) {
        const d = perpDist(pts[k], pts[start], pts[i]);
        if (d > bd) {
          bd = d;
          best = k;
        }
      }
      idx.push(best);
      start = best;
      path = 0;
      for (let k = best + 1; k <= i; k++) path += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
  }
  if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
  return idx;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / l;
}

/** Corner points of a stroke (Ramer–Douglas–Peucker), tolerance in normalised units. */
function corners(pts: Pt[], eps: number): number[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    let best = -1;
    let bd = eps;
    for (let k = i + 1; k < j; k++) {
      const d = perpDist(pts[k], pts[i], pts[j]);
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  const idx: number[] = [];
  keep.forEach((k, i) => k && idx.push(i));
  return idx;
}

/** Strokes (any units, y down) → normalised sub-strokes in writing order. */
export function describe(strokes: Pt[][]): { subs: Sub[]; strokeCount: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes)
    for (const [x, y] of s) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  const w = x1 - x0;
  const h = y1 - y0;
  const side = Math.max(w, h, 1e-6);
  const ox = x0 - (side - w) / 2;
  const oy = y0 - (side - h) / 2;
  const subs: Sub[] = [];
  let count = 0;
  for (const raw of strokes) {
    if (!raw.length) continue;
    count++;
    const T = HANZI_TUNE;
    const norm: Pt[] = raw.map(([x, y]) => [(x - ox) / side, (y - oy) / side]);
    const pts = T.method === 'ratio' ? smoothPts(resample(norm, T.step), T.smooth) : norm;
    let idx = pts.length > 2 ? (T.method === 'ratio' ? ratioCorners(pts, T.ratio, T.minSeg) : corners(pts, T.eps)) : [0, pts.length - 1];
    // drop tiny segments (hooks, jitter) by merging their corner away
    idx = idx.filter((v, k) => k === 0 || k === idx.length - 1 || Math.hypot(pts[v][0] - pts[idx[k - 1]][0], pts[v][1] - pts[idx[k - 1]][1]) > T.minSeg);
    if (idx.length > 2) {
      const last = idx.length - 1;
      if (Math.hypot(pts[idx[last]][0] - pts[idx[last - 1]][0], pts[idx[last]][1] - pts[idx[last - 1]][1]) < T.minSeg) idx.splice(last - 1, 1);
    }
    if (idx.length < 2) idx = [0, pts.length - 1];
    for (let k = 1; k < idx.length; k++) {
      const a = pts[idx[k - 1]];
      const b = pts[idx[k]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      let ang = Math.atan2(-dy, dx);
      if (ang < 0) ang += Math.PI * 2;
      subs.push({
        dir: (Math.round((ang / (Math.PI * 2)) * 256) % 256) | 0,
        len: Math.round(Math.min(1, Math.hypot(dx, dy) / Math.SQRT2) * 255),
        cx: Math.max(0, Math.min(15, Math.round(((a[0] + b[0]) / 2) * 15))),
        cy: Math.max(0, Math.min(15, Math.round(((a[1] + b[1]) / 2) * 15))),
      });
    }
  }
  return { subs, strokeCount: count };
}

// ------------------------------------------------------------------------------------------------
// Matching
// ------------------------------------------------------------------------------------------------

const DIR = new Float32Array(129);
for (let d = 0; d <= 128; d++) {
  const a = (d / 256) * Math.PI * 2;
  // full credit when aligned, none at 90°, a little back for reversed strokes (written backwards)
  DIR[d] = a <= Math.PI / 2 ? Math.cos(a) : Math.max(-0.6, Math.cos(a)) * 0.7;
}

function subScore(a: Sub, bDir: number, bLen: number, bC: number): number {
  let dd = Math.abs(a.dir - bDir);
  if (dd > 128) dd = 256 - dd;
  let ds = DIR[dd];
  // the direction of dots / very short strokes is unreliable
  const short = Math.min(a.len, bLen);
  if (short < 40) ds += (1 - ds) * (1 - short / 40) * 0.8;
  const lr = Math.min(a.len, bLen) / Math.max(a.len, bLen, 1);
  const ls = Math.sqrt(lr);
  let s = ds * (0.35 + 0.65 * ls);
  if (bC > 0) {
    const dx = a.cx - (bC >> 4);
    const dy = a.cy - (bC & 15);
    const ps = Math.exp(-(dx * dx + dy * dy) / (2 * HANZI_TUNE.sigma * HANZI_TUNE.sigma));
    s = s > 0 ? s * ps : s * (2 - ps);
  }
  return s;
}

const MAX_SUB = 64;
const M = new Float32Array((MAX_SUB + 1) * (MAX_SUB + 1));

function align(inp: Sub[], data: Uint8Array, off: number, m: number): number {
  const n = Math.min(inp.length, MAX_SUB);
  m = Math.min(m, MAX_SUB);
  const W = m + 1;
  const band = Math.max(4, Math.ceil(Math.max(n, m) * 0.45));
  const gapIn = (len: number) => HANZI_TUNE.gapBase + (HANZI_TUNE.gapLen * len) / 255;
  M[0] = 0;
  for (let j = 1; j <= m; j++) M[j] = M[j - 1] - gapIn(data[off + (j - 1) * 3 + 1]);
  for (let i = 1; i <= n; i++) {
    const a = inp[i - 1];
    M[i * W] = M[(i - 1) * W] - gapIn(a.len);
    const jFrom = Math.max(1, i - band);
    const jTo = Math.min(m, i + band);
    if (jFrom > 1) M[i * W + jFrom - 1] = -1e9;
    for (let j = jFrom; j <= jTo; j++) {
      const p = off + (j - 1) * 3;
      const bDir = data[p];
      const bLen = data[p + 1];
      const match = M[(i - 1) * W + j - 1] + subScore(a, bDir, bLen, data[p + 2]);
      const skipIn = M[(i - 1) * W + j] - gapIn(a.len);
      const skipT = M[i * W + j - 1] - gapIn(bLen);
      M[i * W + j] = match > skipIn ? (match > skipT ? match : skipT) : skipIn > skipT ? skipIn : skipT;
    }
    if (jTo < m) M[i * W + jTo + 1] = -1e9;
  }
  return M[n * W + m] / Math.max(n, m);
}

/** Best matching characters for one written character (strokes in writing order). */
export function recognizeChar(strokes: Pt[][], limit = 8): HanziCandidate[] {
  const d = hanziDb();
  const { subs, strokeCount } = describe(strokes);
  if (!subs.length) return [];
  const sTol = Math.max(2, Math.round(strokeCount * 0.3));
  const mTol = Math.max(4, Math.round(subs.length * 0.45));
  // first pass: coarse direction / quadrant histogram, keeps the closest templates
  const h = new Float32Array(HB);
  let tot = 0;
  for (const sb of subs) {
    h[histIndex(sb.dir, sb.cx, sb.cy)] += sb.len + 8;
    tot += sb.len + 8;
  }
  for (let k = 0; k < HB; k++) h[k] /= tot || 1;
  const pool: { i: number; dist: number }[] = [];
  for (let sc = Math.max(1, strokeCount - sTol); sc <= strokeCount + sTol && sc < d.byStrokes.length; sc++) {
    for (const i of d.byStrokes[sc] ?? []) {
      if (Math.abs(d.subs[i] - subs.length) > mTol) continue;
      let dist = 0;
      for (let k = 0; k < HB; k++) dist += Math.abs(h[k] - d.hist[i * HB + k]);
      pool.push({ i, dist });
    }
  }
  if (pool.length > HANZI_TUNE.pool) {
    pool.sort((a, b) => a.dist - b.dist);
    pool.length = HANZI_TUNE.pool;
  }
  const best: HanziCandidate[] = [];
  let worst = -Infinity;
  for (const { i } of pool) {
    const sc = d.strokes[i];
    const m = d.subs[i];
    let s = align(subs, d.data, d.offset[i], m);
    s -= 0.02 * Math.abs(sc - strokeCount);
    s += d.gb[i] === 1 ? 0.04 : d.gb[i] === 2 ? 0.015 : 0;
    if (best.length < limit || s > worst) {
      best.push({ ch: d.chars[i], score: s });
      best.sort((a, b) => b.score - a.score);
      if (best.length > limit) best.pop();
      worst = best[best.length - 1].score;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------
// Lines: split into characters (over-segmentation + best path)
// ------------------------------------------------------------------------------------------------

export interface InkStroke {
  pts: Pt[];
  t: number;
}

export interface LineChar {
  candidates: HanziCandidate[];
  /** Index range of the blocks that formed this character. */
  x: number;
  w: number;
}

interface Block {
  strokes: InkStroke[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function blocksOf(strokes: InkStroke[]): Block[] {
  const bs: Block[] = strokes.map((s) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return { strokes: [s], x0, x1, y0, y1 };
  });
  bs.sort((a, b) => a.x0 - b.x0);
  const out: Block[] = [];
  for (const b of bs) {
    const prev = out[out.length - 1];
    if (prev) {
      const ov = Math.min(prev.x1, b.x1) - Math.max(prev.x0, b.x0);
      if (ov > Math.min(prev.x1 - prev.x0, b.x1 - b.x0) * 0.3 || ov > 0 && b.x1 - b.x0 < (prev.x1 - prev.x0) * 0.5) {
        prev.strokes.push(...b.strokes);
        prev.x0 = Math.min(prev.x0, b.x0);
        prev.x1 = Math.max(prev.x1, b.x1);
        prev.y0 = Math.min(prev.y0, b.y0);
        prev.y1 = Math.max(prev.y1, b.y1);
        continue;
      }
    }
    out.push({ ...b, strokes: [...b.strokes] });
  }
  return out;
}

/**
 * Recognise one handwritten line of Chinese: the strokes are grouped into blocks (overlapping in x),
 * 1–3 neighbouring blocks may form a character (left / right components such as 明 = 日 + 月), and
 * the split with the best width-weighted score wins (characters are roughly square).
 */
export async function recognizeLine(strokes: InkStroke[], lineHeight: number, signal?: AbortSignal): Promise<LineChar[]> {
  const blocks = blocksOf(strokes);
  if (!blocks.length) return [];
  const h = Math.max(lineHeight, ...blocks.map((b) => b.y1 - b.y0), 1);
  const n = blocks.length;
  const cache = new Map<string, HanziCandidate[]>();
  const seg = async (i: number, j: number) => {
    const k = `${i}:${j}`;
    let c = cache.get(k);
    if (!c) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      // keep the UI (progress, Cancel) responsive between characters
      await new Promise<void>((r) => setTimeout(r, 0));
      const ss = blocks.slice(i, j).flatMap((b) => b.strokes).sort((a, b) => a.t - b.t);
      c = recognizeChar(ss.map((s) => s.pts), 6);
      cache.set(k, c);
    }
    return c;
  };
  const best = new Float64Array(n + 1).fill(-Infinity);
  const from = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let k = 1; k <= 6 && j - k >= 0; k++) {
      const i = j - k;
      if (best[i] === -Infinity) continue;
      // no character spans a wide gap
      let ok = true;
      for (let q = i + 1; q < j; q++) if (blocks[q].x0 - blocks[q - 1].x1 > HANZI_TUNE.mergeGap * h) ok = false;
      if (!ok) continue;
      const x0 = Math.min(...blocks.slice(i, j).map((b) => b.x0));
      const x1 = Math.max(...blocks.slice(i, j).map((b) => b.x1));
      if (k > 1 && x1 - x0 > 1.6 * h) break;
      const w = Math.max(x1 - x0, 1);
      const r = w / h;
      const c = await seg(i, j);
      if (!c.length) continue;
      const prior = -HANZI_TUNE.wide * Math.max(0, r - 1.3) - HANZI_TUNE.narrow * Math.max(0, 0.6 - r) / 0.6;
      const v = best[i] + (c[0].score + prior) * w - HANZI_TUNE.perChar * h;
      if (v > best[j]) {
        best[j] = v;
        from[j] = i;
      }
    }
  }
  const out: LineChar[] = [];
  for (let j = n; j > 0; ) {
    const i = from[j];
    if (i < 0) break;
    out.unshift({ candidates: await seg(i, j), x: blocks[i].x0, w: blocks[j - 1].x1 - blocks[i].x0 });
    j = i;
  }
  return out;
}
