/**
 * Page renderer for Word / PowerPoint / Excel sources (0.9): draws a page of the stored layout
 * (DisplayList) into a canvas; pictures come from the original file's ZIP, decoded on demand.
 *
 * Memory: the last few layouts and archives stay open; decoded pictures are kept within a pixel
 * budget (oldest dropped first) and are decoded no larger than they are ever drawn. Only raster
 * formats the platform decodes are used (PNG, JPEG, GIF, BMP, WebP); SVG is never decoded (it can
 * reference remote resources), EMF / WMF / TIFF show a placeholder box.
 */
import type { DocSource } from '../document/model';
import { DocError, type DocPageRenderer, type RenderedPage } from '../rendering/doc-layer';
import { drawDisplayPage, type DisplayList } from './display-list';
import { ZipArchive } from './zip';

export const IMAGE_BUDGET_PX = 24_000_000;
const IMAGE_MAX_SIDE = 2048;
const IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** Picture format from the first bytes (null = not decoded). */
export function rasterKind(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

interface Pic {
  bmp: ImageBitmap | null;
  px: number;
  used: number;
}

export class OfficeRenderer implements DocPageRenderer {
  private layouts = new Map<string, { dl: Promise<DisplayList>; used: number }>();
  private zips = new Map<string, { zip: Promise<ZipArchive>; used: number }>();
  private pics = new Map<string, Pic>();
  private picPx = 0;

  constructor(
    /** Bytes of the original file (DocError('missing') when it cannot be found). */
    private readonly read: (src: DocSource) => Promise<ArrayBuffer>,
    /** The stored layout of a source (DocError when it is missing / unreadable). */
    private readonly layout: (src: DocSource) => Promise<DisplayList>,
    private readonly keep = 3,
  ) {}

  private lru<T>(m: Map<string, { used: number } & T>, key: string, make: () => T & { used: number }): T {
    const hit = m.get(key);
    if (hit) {
      hit.used = Date.now();
      return hit;
    }
    const v = make();
    m.set(key, v);
    if (m.size > this.keep) {
      const oldest = [...m.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      m.delete(oldest[0]);
    }
    return v;
  }

  layoutOf(src: DocSource): Promise<DisplayList> {
    const key = `${src.id}|${src.layout ?? ''}`;
    const e = this.lru(this.layouts, key, () => ({ dl: this.layout(src), used: Date.now() }));
    e.dl.catch(() => this.layouts.delete(key));
    return e.dl;
  }

  private zipOf(src: DocSource): Promise<ZipArchive> {
    const key = `${src.id}|${src.path}`;
    const e = this.lru(this.zips, key, () => ({ zip: this.read(src).then((b) => new ZipArchive(new Uint8Array(b))), used: Date.now() }));
    e.zip.catch(() => this.zips.delete(key));
    return e.zip;
  }

  /** Decode a picture once (no larger than `maxW` × `maxH` page units × 2). */
  private async picture(src: DocSource, part: string, drawW: number, drawH: number): Promise<ImageBitmap | null> {
    const key = `${src.id}|${src.path}|${part}`;
    const hit = this.pics.get(key);
    if (hit) {
      hit.used = Date.now();
      return hit.bmp;
    }
    let bmp: ImageBitmap | null = null;
    try {
      const zip = await this.zipOf(src);
      const bytes = await zip.bytesOf(part, IMAGE_MAX_BYTES);
      const type = bytes ? rasterKind(bytes) : null;
      if (bytes && type && typeof createImageBitmap === 'function') {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const full = await createImageBitmap(new Blob([copy.buffer], { type }));
        // never keep more pixels than the largest size it is drawn at (zoomed in: 4× page units)
        const cap = Math.min(IMAGE_MAX_SIDE, Math.max(64, Math.max(drawW, drawH) * 4));
        const k = Math.min(1, cap / Math.max(full.width, full.height));
        if (k < 1) {
          bmp = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: 'high' });
          full.close();
        } else bmp = full;
      }
    } catch {
      bmp = null; // a picture that cannot be decoded shows a placeholder; the page still renders
    }
    const px = bmp ? bmp.width * bmp.height : 0;
    this.pics.set(key, { bmp, px, used: Date.now() });
    this.picPx += px;
    while (this.picPx > IMAGE_BUDGET_PX && this.pics.size > 1) {
      const oldest = [...this.pics.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest[0] === key) break;
      this.pics.delete(oldest[0]);
      this.picPx -= oldest[1].px;
      oldest[1].bmp?.close();
    }
    return bmp;
  }

  async render(src: DocSource, n: number, w: number, h: number, signal: AbortSignal): Promise<RenderedPage> {
    if (src.kind === 'pdf') throw new DocError('unsupported', 'PDF pages are not rendered by the Office renderer');
    const dl = await this.layoutOf(src);
    const page = dl.pages[n - 1];
    if (!page) throw new DocError('damaged', `page ${n} is not in the stored layout`);
    // pictures first (async), then one synchronous draw
    const imgs = new Map<string, ImageBitmap | null>();
    for (const op of page.ops) {
      if (op.k !== 'img' || imgs.has(op.part)) continue;
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      imgs.set(op.part, await this.picture(src, op.part, op.w, op.h));
    }
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    const scale = Math.max(0.05, Math.min(w / page.w, h / page.h));
    const canvas = createEl('canvas');
    canvas.width = Math.max(1, Math.round(page.w * scale));
    canvas.height = Math.max(1, Math.round(page.h * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new DocError('failed', 'no canvas');
    ctx.scale(canvas.width / page.w, canvas.height / page.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, page.w, page.h);
    ctx.clip();
    drawDisplayPage(ctx, dl, page, (part) => imgs.get(part) ?? null);
    ctx.restore();
    return {
      image: canvas,
      width: canvas.width,
      height: canvas.height,
      release: () => {
        canvas.width = 0;
        canvas.height = 0;
      },
    };
  }

  /** Forget everything of a source (file changed, relinked). */
  forget(id: string): void {
    for (const m of [this.layouts, this.zips] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(`${id}|`)) m.delete(k);
    for (const [k, p] of [...this.pics.entries()])
      if (k.startsWith(`${id}|`)) {
        this.pics.delete(k);
        this.picPx -= p.px;
        p.bmp?.close();
      }
  }

  dispose(): void {
    this.layouts.clear();
    this.zips.clear();
    for (const p of this.pics.values()) p.bmp?.close();
    this.pics.clear();
    this.picPx = 0;
  }

  stats(): { layouts: number; archives: number; pictures: number; picturePx: number } {
    return { layouts: this.layouts.size, archives: this.zips.size, pictures: this.pics.size, picturePx: this.picPx };
  }
}
