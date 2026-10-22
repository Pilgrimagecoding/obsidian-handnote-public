import type { Stroke } from '../document/model';
import type { InkLine, InkStrokeIn } from './types';

/**
 * Local ink analysis — no network, deterministic.
 *
 *  - `toInkStrokes`: HandNote strokes → recognition input (x/y/t/p arrays, time monotonic across
 *    strokes). This is the vector input MyScript-style recognizers take directly; nothing is
 *    re-rendered to a picture for them.
 *  - `segmentLines`: groups strokes into lines of handwriting (reading order), so converted text
 *    lands where it was written, line by line, instead of where a model guessed a box.
 */

export interface StrokeBox {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function strokeBox(s: Stroke): StrokeBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.samples) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { id: s.id, x0, y0, x1, y1 };
}

/** Strokes in writing order with one shared time base (ms), page units. */
export function toInkStrokes(strokes: Stroke[]): InkStrokeIn[] {
  const sorted = [...strokes].sort((a, b) => a.created - b.created);
  const t0 = sorted[0]?.created ?? 0;
  let last = 0;
  return sorted.map((s) => {
    const base = Math.max(last, s.created - t0);
    const ts = s.samples.map((p) => Math.round(base + p.t));
    last = (ts[ts.length - 1] ?? base) + 1;
    return {
      id: s.id,
      xs: s.samples.map((p) => Math.round(p.x * 100) / 100),
      ys: s.samples.map((p) => Math.round(p.y * 100) / 100),
      ts,
      ps: s.samples.map((p) => Math.round((s.hasPressure ? p.p : 0.5) * 1000) / 1000),
    };
  });
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Group strokes into text lines. A stroke joins the line whose vertical band it overlaps most
 * (relative to the typical character height); dots and short marks join the nearest line. Lines
 * are returned top to bottom, strokes left to right inside a line.
 */
export function segmentLines(boxes: StrokeBox[]): InkLine[] {
  if (!boxes.length) return [];
  // typical glyph height: median of the taller strokes (dots and dashes are not representative)
  const heights = boxes.map((b) => b.y1 - b.y0);
  const tall = heights.filter((h) => h >= median(heights) * 0.6);
  const hChar = Math.max(4, median(tall.length ? tall : heights));
  const bands: { y0: number; y1: number; members: StrokeBox[] }[] = [];
  const bySize = [...boxes].sort((a, b) => b.y1 - b.y0 - (a.y1 - a.y0)); // big strokes define lines first
  for (const b of bySize) {
    const cy = (b.y0 + b.y1) / 2;
    let best = -1;
    let bestScore = 0;
    bands.forEach((band, i) => {
      const ov = Math.min(b.y1, band.y1) - Math.max(b.y0, band.y0);
      const h = Math.min(b.y1 - b.y0, band.y1 - band.y0) || 1;
      let score = ov > 0 ? ov / Math.max(1, Math.min(h, hChar)) : 0;
      // small marks (dots, commas, accents): centre within half a glyph of the band
      if (score === 0 && b.y1 - b.y0 < hChar * 0.45) {
        const d = cy < band.y0 ? band.y0 - cy : cy > band.y1 ? cy - band.y1 : 0;
        if (d < hChar * 0.6) score = 0.5 - d / (2 * hChar);
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0 && bestScore >= 0.35) {
      const band = bands[best];
      // a band never grows beyond ~1.6 glyph heights: that would swallow the next line
      const ny0 = Math.min(band.y0, b.y0);
      const ny1 = Math.max(band.y1, b.y1);
      if (ny1 - ny0 <= hChar * 1.8 || b.y1 - b.y0 >= ny1 - ny0 - 1) {
        band.y0 = ny0;
        band.y1 = ny1;
      }
      band.members.push(b);
    } else {
      bands.push({ y0: b.y0, y1: b.y1, members: [b] });
    }
  }
  // merge bands that overlap heavily (a line started by two separate tall strokes)
  bands.sort((a, b) => a.y0 - b.y0);
  const merged: typeof bands = [];
  for (const band of bands) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const ov = Math.min(prev.y1, band.y1) - Math.max(prev.y0, band.y0);
      if (ov > Math.min(prev.y1 - prev.y0, band.y1 - band.y0) * 0.5) {
        prev.y0 = Math.min(prev.y0, band.y0);
        prev.y1 = Math.max(prev.y1, band.y1);
        prev.members.push(...band.members);
        continue;
      }
    }
    merged.push({ ...band, members: [...band.members] });
  }
  // bands made only of small marks (dots / accents written before their line) join the nearest line
  for (let i = merged.length - 1; i >= 0; i--) {
    const band = merged[i];
    if (merged.length < 2 || band.members.some((m) => m.y1 - m.y0 >= hChar * 0.45)) continue;
    const cy = (band.y0 + band.y1) / 2;
    let best = -1;
    let bd = Infinity;
    merged.forEach((o, j) => {
      if (j === i || o.members.every((m) => m.y1 - m.y0 < hChar * 0.45)) return;
      const d = cy < o.y0 ? o.y0 - cy : cy > o.y1 ? cy - o.y1 : 0;
      if (d < bd) {
        bd = d;
        best = j;
      }
    });
    if (best >= 0 && bd < hChar * 0.75) {
      merged[best].members.push(...band.members);
      merged.splice(i, 1);
    }
  }
  // a band whose strokes lie mostly inside a bigger band's vertical extent belongs to that line
  // (Chinese characters have many short strokes at their top or bottom)
  const ext = (b: (typeof merged)[number]) => ({ y0: Math.min(...b.members.map((m) => m.y0)), y1: Math.max(...b.members.map((m) => m.y1)) });
  for (let changed = true; changed && merged.length > 1; ) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      const a = ext(merged[i]);
      const ha = a.y1 - a.y0 || 1;
      for (let j = 0; j < merged.length; j++) {
        if (i === j) continue;
        const b = ext(merged[j]);
        const hb = b.y1 - b.y0;
        if (hb < ha) continue;
        const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ov > ha * 0.6) {
          merged[j].members.push(...merged[i].members);
          merged.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
  }
  // a much shorter band right above or below a line is a fragment of it: the row of dots on top
  // of 觉 / 学 / 常, or the strokes under 照 / 熟, written close to their characters
  const xext = (b: (typeof merged)[number]) => ({ x0: Math.min(...b.members.map((m) => m.x0)), x1: Math.max(...b.members.map((m) => m.x1)) });
  for (let changed = true; changed && merged.length > 1; ) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      const a = ext(merged[i]);
      const ax = xext(merged[i]);
      const ha = a.y1 - a.y0;
      let best = -1;
      let bg = Infinity;
      merged.forEach((o, j) => {
        if (j === i) return;
        const b = ext(o);
        const hb = b.y1 - b.y0;
        if (hb < Math.max(ha * 1.8, hChar * 0.8)) return;
        const bx = xext(o);
        if (Math.min(ax.x1, bx.x1) - Math.max(ax.x0, bx.x0) < -hChar * 0.5) return;
        const gap = Math.max(0, a.y0 > b.y1 ? a.y0 - b.y1 : b.y0 - a.y1);
        if (gap < hb * 0.3 && gap < bg) {
          bg = gap;
          best = j;
        }
      });
      if (best >= 0) {
        merged[best].members.push(...merged[i].members);
        merged.splice(i, 1);
        changed = true;
      }
    }
  }
  merged.sort((a, b) => ext(a).y0 - ext(b).y0);
  return merged.map((band, index) => {
    const m = band.members.sort((a, b) => a.x0 - b.x0);
    const x0 = Math.min(...m.map((s) => s.x0));
    const x1 = Math.max(...m.map((s) => s.x1));
    const y0 = Math.min(...m.map((s) => s.y0));
    const y1 = Math.max(...m.map((s) => s.y1));
    return { index, strokeIds: m.map((s) => s.id), x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
}

/** Most used ink colour of a set of strokes (converted text keeps the writer's colour). */
export function dominantColor(strokes: Stroke[], fallback: string): string {
  const n = new Map<string, number>();
  for (const s of strokes) {
    if (s.tool === 'highlighter') continue;
    n.set(s.color, (n.get(s.color) ?? 0) + s.samples.length);
  }
  let best = fallback;
  let bn = 0;
  for (const [c, k] of n) {
    if (k > bn) {
      bn = k;
      best = c;
    }
  }
  return best;
}
