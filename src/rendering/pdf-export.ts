/*!
PDF export dependencies
pdf-lib
MIT License

Copyright (c) 2019 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


@pdf-lib/standard-fonts
MIT License

Copyright (c) 2018 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


@pdf-lib/upng
MIT License

Copyright (c) 2017 Photopea

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


pako
(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


tslib
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
*/
import { PDFDocument, rgb } from 'pdf-lib';
import type { Page } from '../document/model';
import { GeometryCache } from '../document/geometry-cache';
import { framePage, pageRenderBox, paintPaper, paintFrame, paintBoardBackground, paintPageContent } from './paint';
import { renderDocForExport } from './doc-layer';
import { getImage, preloadImages, paintItemsBelow, paintItemsAbove } from './items-paint';
import { inkSvgPaths } from './svg-export';
import { renderFormula } from './formula';
import { t } from '../ui/i18n';

export interface PdfExportOptions {
  signal?: AbortSignal;
  onProgress?(page: number, total: number): void;
  /** Compressed image budget. The final PDF needs another contiguous allocation when saved. */
  maxBytes?: number;
}

/** Bound every canvas independently; do not allocate a canvas for the whole notebook. */
export function pdfExportScale(width: number, height: number): number {
  if (!(width > 0 && height > 0 && Number.isFinite(width + height))) throw new Error('Invalid page dimensions');
  return Math.min(300 / 72, 8192 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
}

/** High-quality 300-DPI background with vector ink; one page's raster layers at a time. */
export async function pagesToPdf(pages: readonly Page[], options: PdfExportOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (!pages.length) throw new Error('No pages');
  const check = () => options.signal?.throwIfAborted();
  check();
  const pdf = await PDFDocument.create();
  pdf.setCreator('HandNote');
  let canvas = document.createElement('canvas');
  let totalBytes = 0;
  const maxBytes = options.maxBytes ?? 96 * 1024 * 1024;
  try {
    for (let i = 0; i < pages.length; i++) {
      check();
      options.onProgress?.(i + 1, pages.length);
      const page = pages[i];
      const { canvas: rendered, box } = await renderExportCanvas(page, options.signal, false, i + 1, 'below');
      canvas = rendered;
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error(t('exportPdfFailed'))), 'image/jpeg', 0.98));
      canvas.width = canvas.height = 0;
      check();
      totalBytes += blob.size;
      if (totalBytes > maxBytes) throw new Error(t('exportPdfTooLarge'));
      const image = await pdf.embedJpg(await blob.arrayBuffer());
      const output = pdf.addPage([box.w, box.h]);
      output.drawImage(image, { x: 0, y: 0, width: box.w, height: box.h });
      await image.embed();
      canvas.width = canvas.height = 1;
      const colorCtx = canvas.getContext('2d')!;
      let inkCount = 0;
      for (const ink of inkSvgPaths(page, new GeometryCache())) {
        check();
        // Canvas resolves every supported CSS colour, including short hex and rgba.
        colorCtx.clearRect(0, 0, 1, 1); colorCtx.fillStyle = ink.color; colorCtx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
        totalBytes += ink.d.length;
        if (totalBytes > maxBytes) throw new Error(t('exportPdfTooLarge'));
        output.drawSvgPath(ink.d, { x: -box.x, y: box.h + box.y, color: rgb(r / 255, g / 255, b / 255), opacity: ink.opacity * a / 255, borderWidth: 0 });
        if (++inkCount % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      canvas.width = canvas.height = 0;
      if (page.items?.some(it => it.type === 'text' || it.type === 'formula')) {
        canvas = (await renderExportCanvas(page, options.signal, false, i + 1, 'above')).canvas;
        const top = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error(t('exportPdfFailed'))), 'image/png'));
        canvas.width = canvas.height = 0; check(); totalBytes += top.size;
        if (totalBytes > maxBytes) throw new Error(t('exportPdfTooLarge'));
        const overlay = await pdf.embedPng(await top.arrayBuffer());
        output.drawImage(overlay, { x: 0, y: 0, width: box.w, height: box.h }); await overlay.embed();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    check();
    options.onProgress?.(pages.length + 1, pages.length);
    const bytes = await pdf.save({ objectsPerTick: 20 });
    check();
    return bytes as Uint8Array<ArrayBuffer>;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function prepareExportPage(page: Page, signal?: AbortSignal, pageNumber = 1): Promise<void> {
  await preloadImages(page); signal?.throwIfAborted();
  for (const item of page.items ?? []) {
    if (item.type === 'image' && !getImage(item.src)) throw new Error(t('exportPdfMissing').replace('{n}', String(pageNumber)));
    if (item.type === 'formula') await renderFormula(item.latex);
    signal?.throwIfAborted();
  }
}

/** Shared sequential renderer for PNG, PDF and the background embedded in SVG. Caller releases canvas. */
export async function renderExportCanvas(page: Page, signal?: AbortSignal, backgroundOnly = false, pageNumber = 1, layer: 'all' | 'below' | 'above' = 'all') {
  const check = () => signal?.throwIfAborted();
  const canvas = document.createElement('canvas');
  try {
    // A page-local cache can be released after each page instead of retaining every outline.
    const geo = new GeometryCache();
    const box = pageRenderBox(page, geo);
    const scale = pdfExportScale(box.w, box.h);
    const missing = () => new Error(t('exportPdfMissing').replace('{n}', String(pageNumber)));
    await prepareExportPage(page, signal, pageNumber);
    check();
    canvas.width = Math.max(1, Math.round(box.w * scale));
    canvas.height = Math.max(1, Math.round(box.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(t('exportPdfFailed'));
    ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
    type DocPainter = (ctx: CanvasRenderingContext2D, page: Page, scale: number) => boolean;
    const paper = async (p: Page, draw: (paint: DocPainter) => void) => {
      check();
      let background;
      try { background = await renderDocForExport(p, scale, signal); }
      catch { check(); throw missing(); }
      try {
        check();
        draw((c, target) => {
          if (!background) return false;
          c.drawImage(background.image, 0, 0, target.width, target.height);
          return true;
        });
      } finally { background?.release?.(); }
    };
    if (layer === 'above') { /* transparent text/formula overlay, no paper or imported source */ }
    else if (page.board) {
      paintBoardBackground(ctx, page.background, box.x, box.y, box.x + box.w, box.y + box.h, scale);
      for (const frame of page.board.frames) {
        await paper(framePage(frame), (paint) => paintFrame(ctx, frame, scale, 'rgba(0,0,0,0.12)', false, paint));
      }
    } else await paper(page, (paint) => paintPaper(ctx, page, scale, false, paint));
    ctx.save();
    ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    if (layer === 'above') paintItemsAbove(ctx, page);
    else if (layer === 'below') paintItemsBelow(ctx, page);
    else if (!backgroundOnly) paintPageContent(ctx, page, geo);
    ctx.restore();
    // JPEG has no alpha; explicitly composite transparent board regions on white.
    if (layer !== 'above') {
      ctx.save(); ctx.resetTransform(); ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
    }
    return { canvas, box };
  } catch (e) { canvas.width = canvas.height = 0; throw e; }
}
