/**
 * Stroke → model input, rendered from the saved ink (never a screenshot of the page):
 *
 *  - math (private edition): white strokes on black, content scaled to 128 px high and placed top-left in a
 *    256 px high canvas whose width is a multiple of 64 (CROHME convention);
 *    mask 1 = padding.
 *  - text (PP-OCRv5 rec): one handwritten LINE at a time (lines come from the local ink
 *    analysis), black ink on white, 48 px high, width from the aspect ratio, normalised to
 *    [-1, 1] in 3 channels.
 *
 * Strokes are drawn with round caps at a resolution-independent width, so the size the user
 * wrote at and the zoom do not matter.
 */

export type Pt = [number, number];

export interface MathInput {
  tensor: Float32Array;
  h: number;
  w: number;
  mask: Uint8Array;
}

export interface LineInput {
  tensor: Float32Array;
  w: number;
}

function bbox(strokes: Pt[][]) {
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
  return { x0, y0, x1, y1, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function canvas(w: number, h: number): { c: HTMLCanvasElement | OffscreenCanvas; g: CanvasRenderingContext2D } {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = (c as HTMLCanvasElement).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  return { c, g };
}

function draw(g: CanvasRenderingContext2D, strokes: Pt[][], map: (p: Pt) => Pt, width: number, color: string): void {
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of strokes) {
    if (!s.length) continue;
    const pts = s.map(map);
    if (pts.length === 1) {
      g.beginPath();
      g.arc(pts[0][0], pts[0][1], width / 2, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    // quadratic smoothing through midpoints
    for (let i = 1; i < pts.length - 1; i++) g.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    g.stroke();
  }
}

export const MATH_RENDER = { H: 256, contentH: 128, maxW: 1024, minW: 128, align: 64, pad: 16, line: 3 };

export function renderMath(strokes: Pt[][], o = MATH_RENDER): MathInput {
  const b = bbox(strokes);
  const scale = Math.min(o.contentH / b.h, (o.maxW - o.pad) / b.w);
  const dw = Math.max(1, Math.round(b.w * scale));
  const dh = Math.max(1, Math.round(b.h * scale));
  const W = Math.min(o.maxW, Math.max(o.minW, Math.ceil((dw + o.pad) / o.align) * o.align));
  const { g } = canvas(W, o.H);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, o.H);
  const half = o.line / 2;
  draw(g, strokes, ([x, y]) => [(x - b.x0) * scale + half, (y - b.y0) * scale + half], o.line, '#fff');
  const img = g.getImageData(0, 0, W, o.H).data;
  const tensor = new Float32Array(W * o.H);
  for (let i = 0; i < tensor.length; i++) tensor[i] = (img[i * 4] * 0.299 + img[i * 4 + 1] * 0.587 + img[i * 4 + 2] * 0.114) / 255;
  const mask = new Uint8Array(W * o.H);
  const cw = Math.min(W, dw + o.line + 1);
  const ch = Math.min(o.H, dh + o.line + 1);
  for (let y = 0; y < o.H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = y < ch && x < cw ? 0 : 1;
  return { tensor, h: o.H, w: W, mask };
}

export const TEXT_RENDER = { H: 48, contentH: 34, pad: 6, maxW: 2400, line: 3.2 };

/** One line of handwriting → PP-OCR rec input (also returns the canvas for previews / tests). */
export function renderLine(strokes: Pt[][], o = TEXT_RENDER): LineInput & { canvas: HTMLCanvasElement | OffscreenCanvas } {
  const b = bbox(strokes);
  const scale = o.contentH / b.h;
  const W = Math.min(o.maxW, Math.max(o.H, Math.ceil(b.w * scale + o.pad * 2)));
  const { c, g } = canvas(W, o.H);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, o.H);
  const top = (o.H - b.h * scale) / 2;
  draw(g, strokes, ([x, y]) => [(x - b.x0) * scale + o.pad, (y - b.y0) * scale + top], o.line, '#000');
  const img = g.getImageData(0, 0, W, o.H).data;
  const n = W * o.H;
  const tensor = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    // PaddleOCR rec normalisation: (x / 255 - 0.5) / 0.5, BGR order (grey ink: channels equal)
    tensor[i] = (img[i * 4 + 2] / 255 - 0.5) / 0.5;
    tensor[n + i] = (img[i * 4 + 1] / 255 - 0.5) / 0.5;
    tensor[2 * n + i] = (img[i * 4] / 255 - 0.5) / 0.5;
  }
  return { tensor, w: W, canvas: c };
}
