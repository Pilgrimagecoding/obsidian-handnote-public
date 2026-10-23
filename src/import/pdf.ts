/**
 * PDF pages through PDF.js (0.9). HandNote does not bundle or download PDF.js: in Obsidian it uses
 * the copy that ships with Obsidian (`loadPdfJs()` from the Obsidian API, desktop and mobile), whose
 * worker Obsidian has already configured. Documents are opened with scripting, XFA and eval off;
 * nothing is fetched from the network (the bytes are passed in, fonts come from PDF.js itself).
 *
 * Only the small subset of the PDF.js API used here is typed (it is stable across PDF.js 2–5).
 */
import type { DocSource } from '../document/model';
import { DocError, type DocPageRenderer, type RenderedPage } from '../rendering/doc-layer';
import { LIMITS } from './detect';

export interface PdfViewport {
  width: number;
  height: number;
}
export interface PdfPage {
  rotate?: number;
  getViewport(o: { scale: number; rotation?: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; background?: string; annotationMode?: number; intent?: string }): { promise: Promise<void>; cancel(): void };
  cleanup?(): void;
}
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void> | void;
}
export interface PdfJsLib {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy?(): void; onPassword?: unknown };
}

/** Options that keep PDF.js from running code from the file or touching the network. */
const SAFE: Record<string, unknown> = {
  isEvalSupported: false,
  enableXfa: false,
  disableAutoFetch: true,
  disableStream: true,
  stopAtErrors: false,
};

export async function openPdf(lib: PdfJsLib, data: Uint8Array): Promise<PdfDocument> {
  const task = lib.getDocument({ data, ...SAFE });
  try {
    return await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? '';
    if (name === 'PasswordException') throw new DocError('unsupported', 'the PDF is password-protected');
    if (name === 'InvalidPDFException') throw new DocError('damaged', 'the PDF is damaged');
    throw new DocError('damaged', String((e as Error)?.message ?? e));
  }
}

/** Page sizes in points (PDF user space, rotation applied), for the pages of a new note. */
export async function pdfPageSizes(doc: PdfDocument, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<{ width: number; height: number }[]> {
  const n = Math.min(doc.numPages, LIMITS.maxPages);
  const out: { width: number; height: number }[] = [];
  for (let i = 1; i <= n; i++) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const p = await doc.getPage(i);
    const v = p.getViewport({ scale: 1 });
    out.push({ width: Math.max(20, Math.min(14400, v.width)), height: Math.max(20, Math.min(14400, v.height)) });
    p.cleanup?.();
    if (onProgress && (i % 10 === 0 || i === n)) onProgress(i, n);
  }
  return out;
}

/**
 * The page renderer for PDF sources: opens each file once (the last few stay open), renders one
 * page at a time into a canvas.
 */
export class PdfRenderer implements DocPageRenderer {
  private open = new Map<string, { doc: Promise<PdfDocument>; used: number }>();

  constructor(
    private readonly lib: () => Promise<PdfJsLib>,
    /** Bytes of the source file; reject with DocError('missing') when it cannot be found. */
    private readonly read: (src: DocSource) => Promise<ArrayBuffer>,
    private readonly keepOpen = 3,
  ) {}

  private docFor(src: DocSource): Promise<PdfDocument> {
    const key = `${src.id}|${src.path}`;
    const hit = this.open.get(key);
    if (hit) {
      hit.used = Date.now();
      return hit.doc;
    }
    const doc = (async () => openPdf(await this.lib(), new Uint8Array(await this.read(src))))();
    this.open.set(key, { doc, used: Date.now() });
    doc.catch(() => this.open.delete(key));
    if (this.open.size > this.keepOpen) {
      const oldest = [...this.open.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      this.open.delete(oldest[0]);
      void oldest[1].doc.then((d) => d.destroy()).catch(() => undefined);
    }
    return doc;
  }

  async render(src: DocSource, n: number, w: number, h: number, signal: AbortSignal): Promise<RenderedPage> {
    if (src.kind !== 'pdf') throw new DocError('unsupported', `${src.kind} pages are not rendered by the PDF renderer`);
    const doc = await this.docFor(src);
    if (n < 1 || n > doc.numPages) throw new DocError('damaged', `page ${n} is not in the PDF any more`);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(0.05, Math.min(w / base.width, h / base.height));
    const vp = page.getViewport({ scale });
    const canvas = createEl('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new DocError('failed', 'no canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport: vp, intent: 'display' });
    const abort = () => task.cancel();
    signal.addEventListener('abort', abort);
    try {
      await task.promise;
    } finally {
      signal.removeEventListener('abort', abort);
      page.cleanup?.();
    }
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

  /** Close every open document (plugin unload). */
  async dispose(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((x) => x.doc.then((d) => d.destroy()).catch(() => undefined)));
  }
}
