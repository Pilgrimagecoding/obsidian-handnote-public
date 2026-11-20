import html2canvas from 'html2canvas';
import { PDFDocument } from 'pdf-lib';
import type { App } from 'obsidian';
import type { MdInkLayer } from '../inkmd/md-ink-layer';
import { DocumentExportModal } from './pdf-export';
import { storedZip } from '../storage/zip-store';
import { t } from '../ui/i18n';

export function openMarkdownExport(app: App, layer: MdInkLayer, format: 'pdf' | 'png' | 'svg'): void {
  new DocumentExportModal(app, null, format, undefined, undefined, {
    file: layer.file,
    make: (signal, report) => exportMarkdown(layer, format, signal, report),
  }).open();
}

/** All formats share the same composed pixels and include the actual Markdown layout. */
export async function exportMarkdown(layer: MdInkLayer, format: 'pdf' | 'png' | 'svg', signal: AbortSignal, report: (n: number, total: number) => void): Promise<File> {
  const files: { name: string; blob: Blob }[] = [];
  const pdf = format === 'pdf' ? await PDFDocument.create() : null;
  let bytes = 0;
  const stem = layer.file.basename || layer.file.path.split('/').pop()!.replace(/\.md$/i, '');
  await layer.exportTiles(signal, async (root, crop, ink, n, total) => {
    signal.throwIfAborted(); report(n, total);
    const canvas = await html2canvas(root, {
      foreignObjectRendering: true,
      ...crop, logging: false, backgroundColor: getComputedStyle(layer.md.contentEl).getPropertyValue('--background-primary').trim() || '#ffffff',
      ignoreElements: el => el.classList.contains('hn-ink-clip') || el.classList.contains('cm-cursorLayer') || el.classList.contains('cm-selectionLayer'),
      onclone: async (_doc, clone) => {
        // The native SVG renderer serializes only this subtree, without its ancestors
        // or DOM scroll state. Normalize its origin and encode scroll as a translation.
        const scrollTop = root.scrollTop, scrollLeft = root.scrollLeft;
        _doc.body.append(clone);
        Object.assign(clone.style, { position: 'fixed', left: '0px', top: '0px', margin: '0px', width: `${root.clientWidth}px`, height: `${root.clientHeight}px`, transform: 'none' });
        const wrapper = _doc.createElement('div');
        while (clone.firstChild) wrapper.append(clone.firstChild);
        wrapper.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
        clone.append(wrapper); clone.scrollTop = clone.scrollLeft = 0;
        // Use only locally readable image bytes; fail rather than silently omit attachments.
        for (const image of Array.from(clone.querySelectorAll('img'))) {
          if (!image.src || image.src.startsWith('data:')) continue;
          signal.throwIfAborted();
          const response = await fetch(image.src, { signal });
          if (!response.ok) throw new Error(`Image unavailable: ${image.alt || 'attachment'}`);
          const blob = await response.blob();
          if (blob.size > 32 * 1024 * 1024) throw new Error(t('exportPdfTooLarge'));
          image.srcset = '';
          image.src = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
        }
      },
    });
    try {
      signal.throwIfAborted();
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(ink, 0, 0);
      const sheet = document.createElement('canvas');
      sheet.width = Math.ceil(crop.pageWidth * crop.scale); sheet.height = Math.ceil(crop.pageHeight * crop.scale);
      const sheetCtx = sheet.getContext('2d')!;
      sheetCtx.fillStyle = getComputedStyle(layer.md.contentEl).getPropertyValue('--background-primary').trim() || '#ffffff';
      sheetCtx.fillRect(0, 0, sheet.width, sheet.height); sheetCtx.drawImage(canvas, 0, 0);
      canvas.width = sheet.width; canvas.height = sheet.height;
      canvas.getContext('2d')!.drawImage(sheet, 0, 0); sheet.width = sheet.height = 0;
      let blob: Blob;
      if (pdf) {
        const jpg = await canvasBlob(canvas, 'image/jpeg');
        bytes += jpg.size;
        if (bytes > 96 * 1024 * 1024) throw new Error(t('exportPdfTooLarge'));
        const image = await pdf.embedJpg(await jpg.arrayBuffer());
        const page = pdf.addPage([crop.pageWidth * 0.75, crop.pageHeight * 0.75]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        return;
      }
      if (format === 'png') blob = await canvasBlob(canvas, 'image/png');
      else blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image width="100%" height="100%" href="${canvas.toDataURL('image/png')}"/></svg>`], { type: 'image/svg+xml' });
      bytes += blob.size;
      if (bytes > 96 * 1024 * 1024) throw new Error(t('exportPdfTooLarge'));
      files.push({ name: `${stem} ${String(n).padStart(4, '0')}.${format}`, blob });
    } finally { canvas.width = canvas.height = 0; }
  });
  signal.throwIfAborted();
  if (pdf) return new File([Uint8Array.from(await pdf.save())], `${stem}.pdf`, { type: 'application/pdf' });
  if (files.length === 1) return new File([files[0].blob], `${stem}.${format}`, { type: files[0].blob.type });
  return new File([await storedZip(files)], `${stem}-${format}.zip`, { type: 'application/zip' });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('exportPngFailed'))), type, 0.97));
}
