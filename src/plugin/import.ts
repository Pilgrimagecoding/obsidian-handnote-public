/**
 * Document import in Obsidian (0.9): pick a file (this device or the vault), check what it really
 * is, keep the original as a separate vault file, and create pages that show it under the ink.
 *
 * Rules (docs/IMPORT_ARCHITECTURE.md):
 *  - the original file is never modified and never copied into the .handnote note;
 *  - a file picked from the device is stored once in the vault (Obsidian's attachment folder
 *    setting); the same file already in the vault (same size and SHA-256) is reused;
 *  - everything happens on the device: PDF.js is the copy shipped with Obsidian (loadPdfJs);
 *  - cancel or failure rolls back what this import created (the stored copy, nothing else).
 */
import { FuzzySuggestModal, Modal, Notice, Platform, TFile, loadPdfJs, normalizePath, type App } from 'obsidian';
import { serializeDocument } from '../document/codec';
import { createDocument, type DocKind, type DocSource } from '../document/model';
import { DocError, docCacheStats, forgetSource, markSourceFailed, setDocCacheBudget, setDocRenderer, sourceById, type DocPageRenderer, type RenderedPage } from '../rendering/doc-layer';
import { LIMITS, describeBytes, detectFormat, sha256Hex } from '../import/detect';
import { PdfRenderer, openPdf, pdfPageSizes, type PdfJsLib } from '../import/pdf';
import { documentPages, makeSource } from '../import/pages';
import { LAYOUT_SUFFIX, parseDisplayList, type DisplayList } from '../import/display-list';
import { canvasMeasurer, layoutDocx } from '../import/docx';
import { convertDoc } from '../import/doc';
import { layoutPptx } from '../import/pptx';
import { cellAt as xlsxCellAt, layoutXlsx } from '../import/xlsx';
import { OfficeRenderer } from '../import/office-render';
import { ZipArchive } from '../import/zip';
import { t } from '../ui/i18n';
import type HandNotePlugin from './main';
import type { HandNoteView } from './view';

export const IMPORT_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'doc'];
/**
 * File types offered in the system picker. Deliberately broad: on iPadOS a file whose type is not in
 * the list is greyed out with no explanation (a .doc, a Pages file, a cloud file of another type).
 * HandNote identifies the content itself and explains what it cannot import.
 * `application/octet-stream` (= any data) keeps every file selectable in the iPadOS Files picker.
 */
const ACCEPT = [
  '.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls', '.docm', '.pptm', '.xlsm', '.odt', '.odp', '.ods', '.rtf', '.pages', '.key', '.numbers', '.csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.ms-powerpoint', 'application/vnd.ms-excel',
  'application/octet-stream',
].join(',');

/** Steps of an import, named in error messages so the user sees where it stopped. */
type Stage = 'read' | 'detect' | 'open' | 'layout' | 'store' | 'note';

class ImportError extends Error {
  constructor(
    readonly stage: Stage,
    readonly reason: string,
    readonly detail = '',
  ) {
    super(reason);
    this.name = 'ImportError';
  }
}

const describe = (e: unknown): string => {
  if (e instanceof ImportError) return e.reason;
  const err = e as { name?: string; message?: string } | undefined;
  const msg = err?.message || String(e);
  return err?.name && err.name !== 'Error' && !msg.includes(err.name) ? `${err.name}: ${msg}` : msg;
};

/**
 * Read a picked file in pieces with progress (a 100 MB file from a cloud provider can take a while
 * on iPad; the user sees it advance and can cancel). Read errors are explained: on iPadOS they
 * usually mean the Files app could not hand the file over (still downloading, provider refused).
 */
async function readPicked(file: File, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<ArrayBuffer> {
  const total = file.size;
  const out = new Uint8Array(total);
  const CHUNK = 8 * 1024 * 1024;
  for (let off = 0; off < total; off += CHUNK) {
    if (signal.aborted) throw new Cancelled();
    let part: ArrayBuffer;
    try {
      part = await file.slice(off, Math.min(total, off + CHUNK)).arrayBuffer();
    } catch (e) {
      throw new ImportError('read', fill(t('importReadFailed'), { error: describe(e) }));
    }
    out.set(new Uint8Array(part), off);
    progress(Math.min(total, off + CHUNK), total);
  }
  return out.buffer;
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);
const sizeText = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${mb(n)} MB`);

/** The failure, stated fully (stays until closed; details can be copied for a bug report). */
class ImportFailedModal extends Modal {
  constructor(
    app: App,
    private readonly name: string,
    private readonly stage: Stage | null,
    private readonly reason: string,
    private readonly detail: string,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t('importFailedTitle'));
    this.contentEl.createEl('p', { text: fill(t('importFailedWhat'), { name: this.name, stage: this.stage ? t(`importStage.${this.stage}`) : '—' }) });
    this.contentEl.createEl('p', { text: this.reason, cls: 'hn-import-reason' });
    if (this.detail) this.contentEl.createEl('pre', { text: this.detail, cls: 'hn-import-detail' });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const copy = row.createEl('button', { text: t('importCopyDetails') });
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(`HandNote import: ${this.name}\nstage: ${this.stage ?? '-'}\n${this.reason}\n${this.detail}`).then(() => new Notice(t('importCopied')));
    });
    row.createEl('button', { text: 'OK', cls: 'mod-cta' }).addEventListener('click', () => this.close());
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? `{${k}}`));

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Office kinds whose pages are laid out by this version. */
const LAID_OUT: DocKind[] = ['docx', 'pptx', 'xlsx', 'doc'];

/** Names a layout of `base` may have (plain or gzip-compressed). */
const layoutNamesOf = (base: string) => [`${base}${LAYOUT_SUFFIX}`, `${base}${LAYOUT_SUFFIX}.gz`];
/** Where the layout of an original is looked for when the note's record is gone. */
const layoutNames = (origPath: string) => layoutNamesOf(origPath);

async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate a stored layout (capped: a layout file is untrusted vault data). */
async function gunzipText(b: Uint8Array, max = 256 * 1024 * 1024): Promise<string> {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  const reader = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error('layout file too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const x of parts) {
    out.set(x, p);
    p += x.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Compute the fixed page layout of an Office file. */
async function computeLayout(kind: DocKind, bytes: Uint8Array, zip: ZipArchive | null, sha: string, signal: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<DisplayList> {
  const o = { measure: canvasMeasurer(), signal, maxPages: LIMITS.maxPages, onProgress, yieldUi: () => new Promise<void>((r) => window.setTimeout(r, 0)) };
  let dl: DisplayList;
  if (kind === 'doc') {
    // Word 97–2003: converted to the parts the Word layout reads (text, paragraphs, tables)
    const conv = convertDoc(bytes);
    dl = await layoutDocx(conv.parts, o, 'doc');
    dl.notes = [...new Set(['doc-simplified', ...conv.notes, ...dl.notes])];
  } else if (kind === 'docx') dl = await layoutDocx(zip ?? new ZipArchive(bytes), o);
  else if (kind === 'pptx') dl = await layoutPptx(zip ?? new ZipArchive(bytes), o);
  else if (kind === 'xlsx') dl = await layoutXlsx(zip ?? new ZipArchive(bytes), o);
  else throw new DocError('unsupported', `${kind.toUpperCase()} pages are not supported by this version`);
  return { ...dl, sha256: sha, by: 'handnote-0.9' };
}

/** Progress dialog with a Cancel button. */
class ProgressModal extends Modal {
  private msg: HTMLElement;
  readonly ctl = new AbortController();
  private done = false;

  constructor(app: App, title: string) {
    super(app);
    this.titleEl.setText(title);
    this.msg = this.contentEl.createDiv({ cls: 'hn-import-progress' });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const b = row.createEl('button', { text: t('importCancel') });
    b.addEventListener('click', () => this.close());
  }

  set(text: string): void {
    this.msg.setText(text);
  }

  finish(): void {
    this.done = true;
    this.close();
  }

  onClose(): void {
    if (!this.done) this.ctl.abort();
    this.contentEl.empty();
  }
}

class VaultFilePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly onPick: (f: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder(t('importPickVault'));
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => IMPORT_EXTENSIONS.includes(f.extension.toLowerCase()));
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}

/** First dialog: where the file comes from, and (inside a note) where its pages go. */
class ImportModal extends Modal {
  constructor(
    app: App,
    private readonly view: HandNoteView | null,
    private readonly go: (src: { files?: File[]; vault?: TFile }, intoNote: boolean) => void,
    private readonly folder: string,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t('importTitle'));
    this.contentEl.createEl('p', { text: fill(t('importIntro'), { folder: this.folder || t('importAttachmentFolder') }), cls: 'setting-item-description' });
    let intoNote = !!this.view;
    if (this.view) {
      const choice = this.contentEl.createDiv({ cls: 'hn-import-choice' });
      for (const [val, label] of [
        [true, t('importIntoNote')],
        [false, t('importAsNewNote')],
      ] as const) {
        const l = choice.createEl('label');
        const r = l.createEl('input', { type: 'radio' });
        r.name = 'hn-import-target';
        r.checked = val === intoNote;
        r.addEventListener('change', () => (intoNote = val));
        l.appendText(' ' + label);
      }
    }
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const dev = row.createEl('button', { text: t('importFromDevice'), cls: 'mod-cta' });
    // The picker opens inside the tap (iPadOS user-gesture rule), from an input that lives in the
    // document body, and this dialog closes in the same tap: on iPad a system picker presented over
    // an open dialog could leave the whole window unresponsive after it was dismissed.
    dev.addEventListener('click', () => {
      const doc = this.contentEl.ownerDocument;
      doc.querySelectorAll('input.hn-import-input').forEach((x) => x.remove());
      const input = doc.body.createEl('input', { type: 'file', cls: 'hn-hidden hn-import-input' });
      input.accept = ACCEPT;
      // multiple: iPadOS shows the Files picker in selection mode (a circle on each file, then
      // "Open"), the way GoodNotes does — a tap selects visibly instead of returning at once
      input.multiple = true;
      const target = intoNote;
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        if (files.length) this.go({ files }, target);
      });
      input.addEventListener('cancel', () => input.remove());
      input.click();
      this.close();
    });
    const vault = row.createEl('button', { text: t('importFromVault') });
    vault.addEventListener('click', () => {
      this.close();
      new VaultFilePicker(this.app, (f) => this.go({ vault: f }, intoNote)).open();
    });
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/** Renders imported pages by kind: PDF with PDF.js, Word from its stored layout. */
class Renderers implements DocPageRenderer {
  constructor(
    private readonly pdf: PdfRenderer,
    private readonly office: OfficeRenderer,
  ) {}
  render(src: DocSource, n: number, w: number, h: number, signal: AbortSignal): Promise<RenderedPage> {
    if (src.kind === 'pdf') return this.pdf.render(src, n, w, h, signal);
    if (LAID_OUT.includes(src.kind)) return this.office.render(src, n, w, h, signal);
    return Promise.reject(new DocError('unsupported', `${src.kind.toUpperCase()} pages are not supported by this version`));
  }
}

export class DocumentImporter {
  private pdf: PdfRenderer;
  private office: OfficeRenderer;
  private pdfLib: Promise<PdfJsLib> | null = null;

  constructor(private readonly plugin: HandNotePlugin) {
    this.pdf = new PdfRenderer(() => this.lib(), (src) => this.readSource(src));
    this.office = new OfficeRenderer(
      (src) => this.readSource(src),
      (src) => this.readLayout(src),
    );
    setDocCacheBudget(Platform.isMobile ? 24_000_000 : 64_000_000);
    setDocRenderer(new Renderers(this.pdf, this.office));
    plugin.register(() => {
      setDocRenderer(null);
      void this.pdf.dispose();
      this.office.dispose();
    });
    // a missing source that appears again (restored, synced): show it again
    plugin.registerEvent(
      plugin.app.vault.on('create', (file) => {
        if (!(file instanceof TFile)) return;
        for (const v of plugin.views())
          for (const s of Object.values(v.getDocument()?.sources ?? {}))
            if (s.path === file.path || s.layout === file.path) {
              forgetSource(s.id);
              this.office.forget(s.id);
              v.editor?.requestRedraw();
            }
      }),
    );
    // a stored layout deleted while its note is open: drop what was drawn from it (it is computed
    // again from the original when the page is next drawn)
    plugin.registerEvent(
      plugin.app.vault.on('delete', (file) => {
        for (const v of plugin.views())
          for (const s of Object.values(v.getDocument()?.sources ?? {}))
            if (s.layout === file.path) {
              this.office.forget(s.id);
              forgetSource(s.id);
              v.editor?.requestRedraw();
            }
      }),
    );
    // a source renamed / moved inside Obsidian: update the notes that are open
    plugin.registerEvent(
      plugin.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        for (const v of plugin.views()) {
          const doc = v.getDocument();
          let changed = false;
          for (const s of Object.values(doc?.sources ?? {})) {
            if (s.layout === oldPath) {
              s.layout = file.path;
              this.office.forget(s.id);
              changed = true;
            }
            if (s.path === oldPath) {
              s.path = file.path;
              changed = true;
            } else if (s.path === file.path) {
              // a missing source is back under its old name: show it again
              forgetSource(s.id);
              v.editor?.requestRedraw();
            }
          }
          if (changed) v.sourcesChanged();
        }
      }),
    );
  }

  private get app(): App {
    return this.plugin.app;
  }

  private lib(): Promise<PdfJsLib> {
    if (!this.pdfLib) {
      this.pdfLib = (async () => {
        const lib = (await loadPdfJs()) as PdfJsLib | undefined;
        if (!lib || typeof lib.getDocument !== 'function') throw new DocError('unsupported', t('importNoPdf'));
        return lib;
      })();
      this.pdfLib.catch(() => (this.pdfLib = null));
    }
    return this.pdfLib;
  }

  /**
   * Bytes of a source. When the file is not at its path any more (renamed or moved while the note
   * was closed, synced under another name), a file with the same extension, size and SHA-256 is
   * looked for and the reference is updated.
   */
  async readSource(src: DocSource): Promise<ArrayBuffer> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(src.path));
    if (f instanceof TFile) return this.app.vault.readBinary(f);
    const ext = src.path.split('.').pop()?.toLowerCase() ?? '';
    const candidates = this.app.vault.getFiles().filter((x) => x.extension.toLowerCase() === ext && x.stat.size === src.size).slice(0, 12);
    for (const c of candidates) {
      const bytes = await this.app.vault.readBinary(c);
      if (src.sha256 && (await sha256Hex(bytes)) !== src.sha256) continue;
      const old = src.path;
      src.path = c.path;
      for (const v of this.plugin.views()) if (Object.values(v.getDocument()?.sources ?? {}).some((s) => s.id === src.id)) v.sourcesChanged();
      new Notice(`HandNote: ${old} → ${c.path}`);
      return bytes;
    }
    throw new DocError('missing', `${src.name} not found`);
  }

  /**
   * The stored page layout of a Word / PowerPoint / Excel source. Looked for at its recorded path,
   * then next to the original; when it is gone, it is computed again from the original (same result
   * on the same device; another device's fonts may differ slightly) and stored again.
   */
  async readLayout(src: DocSource): Promise<DisplayList> {
    const tryRead = async (path: string | undefined): Promise<DisplayList | null> => {
      if (!path) return null;
      const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(f instanceof TFile)) return null;
      try {
        return await this.loadLayoutFile(f);
      } catch {
        throw new DocError('damaged', t('importLayoutFailed'));
      }
    };
    let dl = await tryRead(src.layout);
    if (!dl) {
      for (const next of layoutNames(src.path)) {
        dl = await tryRead(next).catch(() => null);
        if (dl && (!src.sha256 || dl.sha256 === src.sha256)) {
          this.setLayoutPath(src, next);
          break;
        }
        dl = null;
      }
      if (!dl) {
        // compute again from the original
        const bytes = new Uint8Array(await this.readSource(src));
        const sha = await sha256Hex(bytes);
        dl = await computeLayout(src.kind, bytes, null, sha, new AbortController().signal);
        const path = await this.writeLayout(src.path, dl, sha);
        this.setLayoutPath(src, path.path);
        new Notice(fill(t('importLayoutMissing'), { name: src.name }), 10000);
      }
    }
    if (src.pages && dl.pages.length !== src.pages) console.warn(`HandNote: layout of ${src.name} has ${dl.pages.length} pages, the note expects ${src.pages}`);
    return dl;
  }

  /** A stored layout: JSON, or gzip-compressed JSON for large layouts (big sheets). */
  private async loadLayoutFile(f: TFile): Promise<DisplayList> {
    if (f.extension.toLowerCase() === 'gz') return parseDisplayList(await gunzipText(new Uint8Array(await this.app.vault.readBinary(f))));
    return parseDisplayList(await this.app.vault.read(f));
  }

  private setLayoutPath(src: DocSource, path: string): void {
    if (src.layout === path) return;
    src.layout = path;
    for (const v of this.plugin.views()) {
      const s = v.getDocument()?.sources?.[src.id];
      if (s) {
        s.layout = path;
        v.sourcesChanged();
      }
    }
  }

  /**
   * Store a layout next to the original. An existing layout of the same file (same SHA-256) is reused,
   * never overwritten: notes that already annotate it keep exactly their pages. Layouts above 1 MB
   * (large spreadsheets) are stored gzip-compressed (`.handnote-layout.json.gz`, about 10× smaller).
   */
  private async writeLayout(origPath: string, dl: DisplayList, sha: string): Promise<{ path: string; created: TFile | null }> {
    const prior = await this.existingLayout(origPath, sha);
    if (prior) return { path: prior.path, created: null };
    const text = JSON.stringify(dl);
    const big = text.length > 1_000_000 && typeof CompressionStream !== 'undefined';
    const bases = [origPath, `${origPath}.${sha.slice(0, 8)}`, ...Array.from({ length: 98 }, (_, i) => `${origPath}.${sha.slice(0, 8)}-${i + 2}`)];
    for (const base of bases) {
      if (layoutNamesOf(base).some((p) => this.app.vault.getAbstractFileByPath(normalizePath(p)))) continue;
      const path = normalizePath(`${base}${LAYOUT_SUFFIX}${big ? '.gz' : ''}`);
      const created = big ? await this.app.vault.createBinary(path, (await gzipText(text)).buffer as ArrayBuffer) : await this.app.vault.create(path, text);
      return { path: created.path, created };
    }
    throw new Error('no free name for the page layout file');
  }

  /** The stored layout reused for a file imported again (pages identical to the earlier import). */
  private async existingLayout(origPath: string, sha: string): Promise<{ path: string; dl: DisplayList } | null> {
    for (const path of [...layoutNamesOf(origPath), ...layoutNamesOf(`${origPath}.${sha.slice(0, 8)}`)]) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(f instanceof TFile)) continue;
      try {
        const dl = await this.loadLayoutFile(f);
        if (dl.sha256 === sha) return { path, dl };
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /**
   * When a note opens: every source must be where the note says. A source that moved while the note
   * was closed is found again (same size + SHA-256) and the reference updated; one that is gone shows
   * as missing (no stale pixels from an earlier session).
   */
  async checkSources(view: HandNoteView): Promise<void> {
    const doc = view.getDocument();
    for (const src of Object.values(doc?.sources ?? {})) {
      const layoutGone = !!src.layout && !(this.app.vault.getAbstractFileByPath(normalizePath(src.layout)) instanceof TFile);
      if (layoutGone) {
        // drawn again from a found / recomputed layout, never from pixels of the lost one
        this.office.forget(src.id);
        forgetSource(src.id);
        view.editor?.requestRedraw();
      }
      if (this.app.vault.getAbstractFileByPath(normalizePath(src.path)) instanceof TFile) continue;
      forgetSource(src.id);
      this.office.forget(src.id);
      try {
        await this.readSource(src); // relinks (and saves the new path) when it finds the file
      } catch (e) {
        markSourceFailed(src.id, e instanceof DocError ? e : new DocError('missing', `${src.name} not found`));
      }
      view.editor?.requestRedraw();
    }
  }

  /** "Import document…" (command palette, editor menu). */
  open(view: HandNoteView | null): void {
    new ImportModal(this.app, view, (src, intoNote) => void this.runMany(src, intoNote ? view : null), this.plugin.settings.importFolder).open();
  }

  /** Several picked files, one after the other (into this note: one after another, in order). */
  async runMany(src: { files?: File[]; vault?: TFile }, into: HandNoteView | null): Promise<void> {
    if (src.vault) {
      await this.run({ vault: src.vault }, into);
      return;
    }
    let at: number | undefined;
    for (const file of src.files ?? []) {
      const r = await this.run({ file }, into, at);
      if (r?.cancelled) break;
      if (r && into) at = r.index + r.count;
    }
  }

  /** File explorer: a PDF in the vault → new note with its pages. */
  annotate(file: TFile): void {
    void this.run({ vault: file }, null);
  }

  async run(src: { file?: File; vault?: TFile }, into: HandNoteView | null, at?: number): Promise<{ index: number; count: number; cancelled?: boolean } | null> {
    let placed: { index: number; count: number } | null = null;
    const name = src.vault?.name ?? src.file?.name ?? 'document';
    const prog = new ProgressModal(this.app, t('importTitle'));
    prog.open();
    prog.set(fill(t('importReading'), { name }));
    let stored: TFile | null = null;
    let layoutFile: TFile | null = null;
    let stage: Stage = 'read';
    const size = src.vault?.stat.size ?? src.file?.size ?? 0;
    const check = () => {
      if (prog.ctl.signal.aborted) throw new Cancelled();
    };
    // give the progress dialog a frame before the work starts (it must be visible at once)
    await new Promise((r) => window.setTimeout(r, 30));
    try {
      if (size > LIMITS.maxFile) throw new ImportError('read', fill(t('importTooLarge'), { size: mb(size), max: mb(LIMITS.maxFile) }));
      if (src.file && size === 0) throw new ImportError('read', t('importEmptyCloud'));
      let buf: ArrayBuffer;
      if (src.vault) {
        try {
          buf = await this.app.vault.readBinary(src.vault);
        } catch (e) {
          throw new ImportError('read', describe(e));
        }
      } else buf = await readPicked(src.file as File, prog.ctl.signal, (done, total) => prog.set(fill(t('importReadingMb'), { name, done: mb(done), total: mb(total) })));
      check();
      stage = 'detect';
      const bytes = new Uint8Array(buf);
      let zip: ZipArchive | null = null;
      const det = await detectFormat(bytes, name, async (e) => {
        zip ??= new ZipArchive(bytes);
        return (await zip.text(e.name, 2 * 1024 * 1024)) ?? '';
      });
      check();
      if ((det.kind === 'pptx' || det.kind === 'xlsx' || det.kind === 'docx') && !LAID_OUT.includes(det.kind)) throw new ImportError('detect', fill(t('importOfficeLater'), { kind: det.kind.toUpperCase() }));
      if (det.kind !== 'pdf' && det.kind !== 'docx' && det.kind !== 'pptx' && det.kind !== 'xlsx' && det.kind !== 'doc') throw new ImportError('detect', det.problem ?? 'unsupported file', describeBytes(bytes, name));
      const kind: DocKind = det.kind;
      const sha = await sha256Hex(bytes);
      check();
      let sizes: { width: number; height: number }[];
      let layout: DisplayList | null = null;
      if (kind === 'pdf') {
        stage = 'open';
        // open first: a damaged / password-protected PDF fails before anything is written
        const pdf = await openPdf(await this.lib(), bytes.slice());
        try {
          sizes = await pdfPageSizes(pdf, (done, total) => prog.set(fill(t('importPages'), { done, total })), prog.ctl.signal);
        } finally {
          void Promise.resolve(pdf.destroy()).catch(() => undefined);
        }
      } else {
        stage = 'layout';
        // the same file imported before: reuse its layout so the pages are identical
        const prior = src.vault ? await this.existingLayout(src.vault.path, sha) : null;
        layout = prior?.dl ?? (await computeLayout(kind, bytes, zip, sha, prog.ctl.signal, (done, total) => prog.set(fill(t('importLayout'), { done, total }))));
        sizes = layout.pages.map((p) => ({ width: p.w, height: p.h }));
      }
      check();
      if (!sizes.length) throw new ImportError(stage, t('importNoPages'));
      stage = 'store';
      const notePath = into?.file?.path ?? this.plugin.newNotePath(name.replace(/\.[^.]+$/, ''), src.vault ?? null);
      // the original file: the vault file itself, the same file already in the vault, or a new copy
      let path: string;
      if (src.vault) path = src.vault.path;
      else {
        const same = await this.findSame(kind, bytes.byteLength, sha);
        check();
        if (same) {
          path = same.path;
          new Notice(fill(t('importDuplicate'), { path }));
        } else {
          // the stored copy carries the extension of what it really is (cloud files sometimes arrive
          // without one, or with the wrong one), so Obsidian and HandNote recognise it later
          const base = name.replace(/\.[^.]*$/, '') || 'document';
          const target = await this.originalPath(`${base}.${kind}`, notePath);
          stored = await this.app.vault.createBinary(target, buf);
          path = stored.path;
        }
      }
      check();
      const source: DocSource = makeSource(kind, path, bytes.byteLength, sha, sizes.length);
      if (layout) {
        const prior = await this.existingLayout(path, sha);
        if (prior) {
          // keep the layout already stored for this file (other notes annotate exactly those pages)
          source.layout = prior.path;
          sizes = prior.dl.pages.map((p) => ({ width: p.w, height: p.h }));
          source.pages = sizes.length;
          layout = prior.dl;
        } else {
          const w = await this.writeLayout(path, layout, sha);
          layoutFile = w.created;
          source.layout = w.path;
        }
        this.office.forget(source.id);
      }
      check();
      stage = 'note';
      if (into?.editor) {
        placed = { index: into.editor.insertDocumentPages(source, sizes, at), count: sizes.length };
      } else {
        const doc = createDocument({ device: this.plugin.settings.deviceId });
        doc.pages = documentPages(source, sizes);
        doc.sources = { [source.id]: source };
        await this.plugin.ensureFolderOf(notePath);
        const file = await this.app.vault.create(notePath, serializeDocument(doc));
        await this.app.workspace.getLeaf('tab').openFile(file);
      }
      prog.finish();
      const notes = layout?.notes.length ? '\n' + fill(t('importNotes'), { list: layout.notes.map((n) => t(`dlNote.${n}`)).join(', ') }) : '';
      new Notice(fill(t('importDone'), { n: sizes.length, name: source.name }) + notes, notes ? 10000 : 5000);
      return placed ?? { index: 0, count: sizes.length };
    } catch (e) {
      prog.finish();
      // roll back what this import created
      if (layoutFile) await this.app.fileManager.trashFile(layoutFile).catch(() => undefined);
      if (stored) await this.app.fileManager.trashFile(stored).catch(() => undefined);
      if (e instanceof Cancelled || (e as { name?: string })?.name === 'AbortError') {
        new Notice(t('importCancelled'));
        return { index: -1, count: 0, cancelled: true };
      }
      else {
        const st = e instanceof ImportError ? e.stage : stage;
        // the file's size and first bytes; a stack trace only for unexpected errors (not for the
        // explained ones, whose trace says nothing useful)
        const stack = e instanceof ImportError ? '' : ((e as Error)?.stack ?? '').split('\n').filter((l) => l.trim() && !/^\w*Error@?$|^@$/.test(l.trim())).slice(0, 4).join('\n');
        const detail = [e instanceof ImportError && e.detail ? e.detail : `${name}: ${sizeText(size)}`, stack].filter(Boolean).join('\n');
        console.warn('HandNote: import failed', name, st, e);
        new ImportFailedModal(this.app, name, st, describe(e), detail).open();
      }
      return null;
    }
  }

  /** Where a picked original is stored: the import folder of the settings, else Obsidian's attachment location. */
  private async originalPath(fileName: string, notePath: string): Promise<string> {
    const folder = this.plugin.settings.importFolder.trim();
    if (!folder) return this.app.fileManager.getAvailablePathForAttachment(fileName, notePath);
    const dir = normalizePath(folder);
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => undefined);
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    for (let i = 0; i < 1000; i++) {
      const p = normalizePath(`${dir}/${stem}${i ? ` ${i}` : ''}${ext}`);
      if (!this.app.vault.getAbstractFileByPath(p)) return p;
    }
    throw new Error('no free name in the import folder');
  }

  /** A vault file with the same extension, size and SHA-256 (the same document imported before). */
  private async findSame(kind: DocKind, size: number, sha: string): Promise<TFile | null> {
    const cands = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === kind && f.stat.size === size).slice(0, 12);
    for (const c of cands) if ((await sha256Hex(await this.app.vault.readBinary(c))) === sha) return c;
    return null;
  }

  /** Page cache statistics (tests / diagnostics). */
  cacheStats(): ReturnType<typeof docCacheStats> {
    return docCacheStats();
  }

  /**
   * The spreadsheet cell under a point of an imported sheet page ("Sheet1!C12"), or null (other
   * pages, outside the cells). Annotations on sheet pages are anchored to cells this way.
   */
  async cellAt(src: DocSource, pageNumber: number, x: number, y: number): Promise<string | null> {
    if (src.kind !== 'xlsx') return null;
    const dl = await this.office.layoutOf(src);
    const page = dl.pages[pageNumber - 1];
    return page ? (xlsxCellAt(page, x, y)?.ref ?? null) : null;
  }

  /** Office renderer statistics (tests / diagnostics). */
  officeStats(): ReturnType<OfficeRenderer['stats']> {
    return this.office.stats();
  }

  /** The current source record (tests / diagnostics). */
  source(id: string): DocSource | undefined {
    return sourceById(id);
  }
}
