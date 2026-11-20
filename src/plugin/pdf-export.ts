import { Modal, Notice, Setting, normalizePath, Platform, type App, type TFile } from 'obsidian';
import type { HandNoteView } from './view';
import { pagesToPdf, renderExportCanvas, prepareExportPage } from '../rendering/pdf-export';
import { pageToSvg } from '../rendering/svg-export';
import { GeometryCache } from '../document/geometry-cache';
import { storedZip } from '../storage/zip-store';
import { t } from '../ui/i18n';
declare const require: (name: string) => any;

type Format = 'pdf' | 'png' | 'svg';
let active = false;
export function openPdfExport(app: App, view: HandNoteView): void { openDocumentExport(app, view, 'pdf'); }
export function openDocumentExport(app: App, view: HandNoteView, format: Format, all?: boolean, index?: number): void {
  if (active) { new Notice(t('exportPdfBusy')); return; }
  if (view.file && view.editor) new DocumentExportModal(app, view, format, all, index).open();
}

/** Export preparation is separate from the save click: iOS share needs fresh user activation. */
export class DocumentExportModal extends Modal {
  private readonly controller = new AbortController();
  private output: File | null = null;
  constructor(app: App, private view: HandNoteView | null, private format: Format, private all?: boolean, private index?: number,
    private prepared?: { file: TFile; make(signal: AbortSignal, report: (n: number, total: number) => void): Promise<File> }) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t(this.format === 'pdf' ? 'exportPdf' : this.format === 'png' ? 'exportPagePng' : 'exportPageSvg'));
    if (this.prepared) { void this.runPrepared(); return; }
    this.contentEl.createEl('p', { text: t('exportScopeDesc') });
    if (this.all !== undefined) { void this.run(this.all); return; }
    const row = new Setting(this.contentEl);
    row.addButton(b => b.setButtonText(t('exportPdfCurrent')).onClick(() => void this.run(false)));
    row.addButton(b => b.setButtonText(t('exportPdfAll')).onClick(() => void this.run(true)));
  }
  private async runPrepared(): Promise<void> {
    if (active || !this.prepared) { new Notice(t('exportPdfBusy')); this.close(); return; }
    active = true;
    const progress = this.contentEl.createEl('p', { text: t('mdExportPreparing') });
    new Setting(this.contentEl).addButton(b => b.setButtonText(t('cancel')).onClick(() => this.close()));
    try {
      this.output = await this.prepared.make(this.controller.signal, (n, total) => progress.setText(t('exportPdfProgress').replace('{n}', String(n)).replace('{total}', String(total))));
      this.controller.signal.throwIfAborted();
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: t('exportReady').replace('{name}', this.output.name) });
      this.contentEl.createEl('p', { text: t('mdExportDescription') });
      const buttons = new Setting(this.contentEl);
      buttons.addButton(b => b.setButtonText(t('exportLocal')).setCta().onClick(() => void this.saveLocal()));
      buttons.addButton(b => b.setButtonText(t('exportVault')).onClick(() => this.vaultDestination()));
    } catch (e) {
      this.output = null;
      if (!this.controller.signal.aborted) progress.setText(`${t('exportFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally { active = false; }
  }
  private async run(all: boolean): Promise<void> {
    if (active) return;
    const view = this.view; if (!view) return;
    const file = view.file, editor = view.editor;
    if (!file || !editor) return;
    editor.commitPending(); const doc = view.getDocument(); if (!doc) return;
    const current = this.index ?? editor.currentPageIndex();
    // Snapshot: edits made while the export yields must not change its page contents.
    const pages = structuredClone(all ? doc.pages : [doc.pages[current]]);
    if (pages.some(p => !p)) return;
    const stem = `${file.basename}${all || editor.isBoard ? '' : ` p${current + 1}`}`;
    const signal = this.controller.signal;
    active = true; this.contentEl.empty();
    const progress = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    new Setting(this.contentEl).addButton(b => b.setButtonText(t('cancel')).onClick(() => this.close()));
    try {
      let blob: Blob, extension = this.format as string;
      const report = (n: number, total: number) => progress.setText(t('exportPdfProgress').replace('{n}', String(Math.min(n, total))).replace('{total}', String(total)));
      if (this.format === 'pdf') blob = new Blob([await pagesToPdf(pages, { signal, onProgress: report })], { type: 'application/pdf' });
      else {
        const files: { name: string; blob: Blob }[] = []; let bytes = 0;
        for (let i = 0; i < pages.length; i++) {
          signal.throwIfAborted(); report(i + 1, pages.length);
          const page = pages[i];
          let image: Blob;
          if (this.format === 'svg' && !page.doc && !page.board?.frames.some(frame => frame.doc)) {
            await prepareExportPage(page, signal, i + 1);
            image = new Blob([pageToSvg(page, new GeometryCache())], { type: 'image/svg+xml' });
          } else {
            const { canvas, box } = await renderExportCanvas(page, signal, this.format === 'svg', i + 1);
            try {
              if (this.format === 'png') image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error(t('exportPngFailed'))), 'image/png'));
              else {
                const backgroundSvg = `<image x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" href="${canvas.toDataURL('image/png')}"/>`;
                image = new Blob([pageToSvg(page, new GeometryCache(), { background: false, backgroundSvg })], { type: 'image/svg+xml' });
              }
            } finally { canvas.width = canvas.height = 0; }
          }
          bytes += image.size;
          if (bytes > 128 * 1024 * 1024) throw new Error(t('exportPdfTooLarge'));
          files.push({ name: `${file.basename} p${String(all ? i + 1 : current + 1).padStart(4, '0')}.${this.format}`, blob: image });
        }
        signal.throwIfAborted();
        if (all && pages.length > 1) { blob = await storedZip(files); extension = 'zip'; }
        else blob = files[0].blob;
      }
      signal.throwIfAborted();
      this.output = new File([blob], `${stem}.${extension}`, { type: blob.type });
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: t('exportReady').replace('{name}', this.output.name) });
      const buttons = new Setting(this.contentEl);
      buttons.addButton(b => b.setButtonText(t('exportLocal')).setCta().onClick(() => void this.saveLocal()));
      buttons.addButton(b => b.setButtonText(t('exportVault')).onClick(() => this.vaultDestination()));
    } catch (e) {
      if (!signal.aborted) progress.setText(`${t('exportFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally { active = false; }
  }
  private async saveLocal(): Promise<void> {
    const file = this.output; if (!file) return;
    try {
      // Native desktop dialog provides an arbitrary local destination even in Electron builds
      // where the browser File System Access API is disabled.
      if (Platform.isDesktopApp && typeof require === 'function') {
        let dialog;
        try { dialog = require('@electron/remote').dialog; }
        catch { dialog = require('electron').remote?.dialog; }
        if (dialog) {
          const result = await dialog.showSaveDialog({ defaultPath: file.name, filters: [{ name: file.type, extensions: [file.name.split('.').pop()] }] });
          if (result.canceled || !result.filePath) { new Notice(t('exportCancelled')); return; }
          await require('fs').promises.writeFile(result.filePath, new Uint8Array(await file.arrayBuffer()));
          new Notice(t('exportDone').replace('{path}', result.filePath), 8000); this.close(); return;
        }
      }
      const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }> }).showSaveFilePicker;
      if (picker) {
        const handle = await picker.call(window, { suggestedName: file.name });
        const writable = await handle.createWritable();
        try { await writable.write(file); await writable.close(); } catch (e) { await writable.abort(); throw e; }
        new Notice(t('exportDone').replace('{path}', file.name), 8000); this.close(); return;
      }
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); new Notice(t('exportShared').replace('{name}', file.name), 10000); this.close(); return; }
      new Notice(t('exportLocalUnavailable'), 10000);
    } catch (e) {
      if ((e as Error).name === 'AbortError') new Notice(t('exportCancelled'));
      else new Notice(`${t('exportFailed')}: ${(e as Error).message}`, 8000);
    }
  }
  private vaultDestination(): void {
    if (!this.output) return;
    const file = this.output;
    this.contentEl.empty();
    const source = this.view?.file ?? this.prepared?.file;
    let path = normalizePath(`${source?.parent?.path === '/' ? '' : source?.parent?.path ?? ''}/${file.name}`);
    new Setting(this.contentEl).setName(t('exportPath')).addText(tx => tx.setValue(path).onChange(v => { path = v; }));
    new Setting(this.contentEl).addButton(b => b.setButtonText(t('exportPdfStart')).setCta().onClick(() => void (async () => {
      try {
        if (!path.trim() || /(^|[\/])\.\.([\/]|$)/.test(path)) throw new Error(t('exportInvalidPath'));
        const target = normalizePath(path.trim());
        if (this.app.vault.getAbstractFileByPath(target)) throw new Error(t('exportExists'));
        const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
        if (parent && !this.app.vault.getAbstractFileByPath(parent)) throw new Error(t('exportInvalidPath'));
        await this.app.vault.createBinary(target, await file.arrayBuffer());
        new Notice(t('exportDone').replace('{path}', target)); this.close();
      } catch (e) { new Notice(`${t('exportFailed')}: ${(e as Error).message}`, 8000); }
    })()));
  }
  onClose(): void { this.controller.abort(); this.output = null; this.contentEl.empty(); }
}
