import type { GeometryCache } from '../document/geometry-cache';
import type { Stroke } from '../document/model';
import type { Item } from '../document/items';
import { paintItem } from '../rendering/items-paint';
import { inkPath } from '../rendering/paint';
import type { AIImage } from '../ai/types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Picture of a selection for vision models, tuned for reading handwriting:
 *  - ink in near-black regardless of pen colour (coloured, thin or highlighter ink lowers OCR
 *    accuracy), highlighter strokes left out of text tasks;
 *  - long side capped per provider (DeepSeek bills at most 1024 tokens per image — bigger pictures
 *    only cost upload time), short side at least ~480 px so small writing stays legible;
 *  - PNG for ink (small and sharp), JPEG when the selection contains photos.
 */
export function rasterForRecognition(
  strokes: Stroke[],
  items: Item[],
  bounds: Box,
  cache: GeometryCache,
  opts: { maxSide: number; blackInk: boolean; skipHighlighter: boolean },
): { image: AIImage; bounds: Box; canvas: HTMLCanvasElement } {
  const pad = Math.max(6, Math.max(bounds.w, bounds.h) * 0.04);
  const b = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  const long = Math.max(b.w, b.h);
  const short = Math.max(1, Math.min(b.w, b.h));
  const scale = Math.min(opts.maxSide / long, Math.max(2, 480 / short, 640 / long));
  const finalScale = Math.min(scale, opts.maxSide / long);
  const w = Math.max(32, Math.round(b.w * finalScale));
  const h = Math.max(32, Math.round(b.h * finalScale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(finalScale, 0, 0, finalScale, -b.x * finalScale, -b.y * finalScale);
  for (const it of items) if (it.type !== 'text' && it.type !== 'formula') paintItem(ctx, it);
  for (const s of strokes) {
    if (s.tool === 'highlighter' && opts.skipHighlighter) continue;
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1;
    ctx.fillStyle = opts.blackInk && s.tool !== 'highlighter' ? '#111111' : s.color;
    ctx.fill(inkPath(s, cache.get(s)), 'nonzero');
  }
  ctx.globalAlpha = 1;
  for (const it of items) if (it.type === 'text' || it.type === 'formula') paintItem(ctx, it);
  const photo = items.some((i) => i.type === 'image');
  const mime = photo ? 'image/jpeg' : 'image/png';
  const url = cv.toDataURL(mime, 0.85);
  return { image: { mime, base64: url.slice(url.indexOf(',') + 1), width: w, height: h }, bounds: b, canvas: cv };
}

/** Small, fast, non-cryptographic hash (cache keys only). */
export function quickHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}
