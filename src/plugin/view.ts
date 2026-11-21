import { notePackages, bindPackageSources } from '../storage/note-package';
import { FileView, Modal, Notice, Platform, TFile, setIcon, type WorkspaceLeaf } from 'obsidian';
import { imageMime } from './mime';
import { HandNoteEditor } from '../editor/handnote-editor';
import { parseDocument, serializeDocument } from '../document/codec';
import { createDocument, defaultBackground, newId, paperById, type HandNoteDocument } from '../document/model';
import { conflictCopyPath, decideExternalChange, decideSave } from '../storage/sync-guard';
import type HandNotePlugin from './main';
import { registerSources } from '../rendering/doc-layer';
import { t, tf } from '../ui/i18n';
import { documentMenuActions } from '../ui/document-actions';
import { pickNoteLink } from './links';

export const VIEW_TYPE = 'handnote-view';
export const EXTENSION = 'handnote';

const SAVE_DELAY_MS = 1200;
const JOURNAL_DELAY_MS = 400;

/**
 * Editor view for .handnote files.
 *
 * Extends FileView (not TextFileView) so that every write goes through saveNow(), which checks the
 * on-disk revision first and never silently overwrites a version that arrived via sync.
 */
export class HandNoteView extends FileView {
  editor: HandNoteEditor | null = null;
  private doc: HandNoteDocument | null = null;
  private baseRevision = 0;
  private lastWrittenRevision = -1;
  private dirty = false;
  private changeSeq = 0;
  private readOnly = false;
  private saveTimer: number | null = null;
  private journalTimer: number | null = null;
  private saving: Promise<void> = Promise.resolve();
  private backedUp = false;
  private loadToken = 0;
  /** opened from a damaged file: read-only, the user saves the recovered strokes as a copy */
  private recovered = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HandNotePlugin,
  ) {
    super(leaf);
    this.allowNoFile = false;
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getIcon(): string {
    return 'pen-tool';
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : 'HandNote';
  }

  canAcceptExtension(extension: string): boolean {
    return extension === EXTENSION;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('handnote-view-content');
    this.scope?.register(['Mod'], 'z', () => {
      this.editor?.undo();
      return false;
    });
    this.scope?.register(['Mod', 'Shift'], 'z', () => {
      this.editor?.redo();
      return false;
    });
    this.registerEvent(
      this.app.vault.on('modify', (f) => {
        if (this.file && f.path === this.file.path) void this.onExternalModify();
      }),
    );
  }

  async onClose(): Promise<void> {
    await this.flush();
    this.destroyEditor();
  }

  async onLoadFile(file: TFile): Promise<void> {
    const token = ++this.loadToken;
    this.destroyEditor();
    this.contentEl.empty();
    let text: string;
    try { text = await notePackages(this.app).read(file.path); }
    catch (e) {
      if (token !== this.loadToken) return;
      this.readOnly = true;
      this.contentEl.createDiv({ cls: 'hn-error', text: tf('openFailedNotice', { error: (e as Error).message }) });
      return;
    }
    if (token !== this.loadToken) return;
    let doc: HandNoteDocument;
    this.readOnly = false;
    this.recovered = false;
    this.backedUp = false;
    if (text.trim() === '') {
      doc = this.newDocument();
    } else {
      try {
        const res = parseDocument(text);
        doc = res.doc;
        this.readOnly = res.readOnly;
        if (res.recovered) {
          // never overwrite a damaged file with what could be salvaged from it: the note opens
          // read-only and the recovered strokes can be saved as a separate copy
          this.readOnly = true;
          this.recovered = true;
          new Notice(tf('recoveredNotice', { name: file.basename, count: countStrokes(res.doc) }), 12000);
          await this.plugin.recovery.backup(res.doc.id + '-damaged', text).catch(() => undefined);
        } else if (res.warnings.length) {
          console.warn('HandNote load warnings', file.path, res.warnings);
        }
        if (res.readOnly) new Notice(res.warnings.join('\n'), 8000);
      } catch (e) {
        this.contentEl.createDiv({ cls: 'hn-error', text: tf('openFailedNotice', { error: (e as Error).message }) });
        this.readOnly = true;
        return;
      }
    }
    if (doc.annotates && this.app.vault.getAbstractFileByPath(doc.annotates) instanceof TFile) {
      // A Markdown sidecar opens the original Markdown with its annotation layer. It must
      // never mount a second, independent canvas writer for the same ink file.
      const path = doc.annotates;
      window.setTimeout(() => { if (token === this.loadToken) void this.plugin.mdInk?.openAnnotations(path, this.leaf); }, 0);
      return;
    }
    bindPackageSources(doc, file.path);
    this.doc = doc;
    this.baseRevision = doc.revision;
    this.lastWrittenRevision = doc.revision;
    this.dirty = false;
    this.mountEditor(doc);
    await this.checkJournal(doc);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.flush();
    this.destroyEditor();
    this.doc = null;
  }

  private newDocument(): HandNoteDocument {
    const s = this.plugin.settings.editor;
    const paper = paperById(s.newPagePaper);
    return createDocument({
      width: paper.width,
      height: paper.height,
      background: defaultBackground(s.newPageBackground, s.newPaperTone),
      device: this.plugin.settings.deviceId,
    });
  }

  private mountEditor(doc: HandNoteDocument): void {
    this.plugin.handFont?.attach(this.contentEl.ownerDocument);
    this.editor = new HandNoteEditor(this.contentEl, doc, this.plugin.settings.editor, {
      isMobileApp: Platform.isMobileApp,
      notify: (msg) => new Notice(msg, 4000),
      onChange: () => this.markDirty(),
      onSettingsChange: (s) => {
        this.plugin.settings.editor = s;
        this.plugin.queueSaveSettings();
        this.plugin.broadcastSettings(this);
      },
      setIcon: (el, icon) => setIcon(el, icon),
      saveImage: (data, mime, name) => this.saveImage(data, mime, name),
      ai: this.plugin.aiBridge(),
      recognizer: this.plugin.recognizerBridge(),
      openAISettings: () => this.plugin.openSettings(),
      exportPage: (i, kind) => void this.plugin.exportPage(this, kind, i),
      exportView: () => void this.plugin.exportView(this),
      openLink: (linktext) => void this.app.workspace.openLinkText(linktext, this.file?.path ?? '', false),
      pickLink: () => pickNoteLink(this.app, this.file?.path ?? ''),
      imageBlob: async (src) => {
        const f = this.app.vault.getAbstractFileByPath(src);
        if (!(f instanceof TFile)) return null;
        return new Blob([await this.app.vault.readBinary(f)], { type: imageMime(f.extension) });
      },
      menuActions: documentMenuActions((action, all) => {
        if (action === 'png' || action === 'svg' || action === 'pdf') this.plugin.exportDocument(this, action, all);
        else if (action === 'import') this.plugin.importer.open(this);
        else {
          const snap = this.editor?.perf.snapshot();
          void navigator.clipboard.writeText('```json\n' + JSON.stringify(snap, null, 2) + '\n```\n')
            .then(() => new Notice(t('performanceCopied')))
            .catch(() => new Notice(t('clipboardUnavailable')));
        }
      }),
    });
    this.editor.setReadOnly(this.readOnly);
    this.editor.setStatus(this.readOnly ? 'readonly' : 'saved');
    if (doc.sources) void this.plugin.importer?.checkSources(this);
    if (this.recovered) this.showRecoveredBanner();
  }

  private showRecoveredBanner(): void {
    const bar = this.contentEl.createDiv({ cls: 'hn-recovered-banner' });
    bar.createSpan({ text: t('This file is damaged. It is shown read-only with the strokes that could be recovered; the file itself is not changed.') });
    const btn = bar.createEl('button', { text: t('Save recovered copy'), cls: 'mod-cta' });
    btn.addEventListener('click', () => void this.saveRecoveredCopy());
  }

  /** Write the recovered strokes to a new note next to the damaged one and open it. */
  async saveRecoveredCopy(): Promise<string | null> {
    const file = this.file;
    const doc = this.doc;
    if (!file || !doc || !this.recovered) return null;
    const path = conflictCopyPath(file.path, new Date(), (p) => this.app.vault.getAbstractFileByPath(p) !== null, 'recovered');
    const copy: HandNoteDocument = { ...doc, sources: structuredClone(doc.sources), id: newId('d'), revision: 0, modified: Date.now(), device: this.plugin.settings.deviceId };
    let created: TFile;
    if (await notePackages(this.app).isPacked(file.path)) {
      for (const source of Object.values(copy.sources ?? {})) if (source.containerId === doc.id) source.containerId = copy.id;
      await notePackages(this.app).copy(file.path, path, serializeDocument(copy));
      created = this.app.vault.getAbstractFileByPath(path) as TFile;
    } else created = await this.app.vault.create(path, serializeDocument(copy));
    new Notice(tf('recoveredSavedNotice', { name: created.basename }), 8000);
    await this.leaf.openFile(created);
    return path;
  }

  /** Store an inserted image as a vault attachment (Obsidian's attachment folder setting). */
  private async saveImage(data: ArrayBuffer, mime: string, name: string): Promise<string> {
    const extFromMime = mime.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png';
    const m = /\.([a-z0-9]+)$/i.exec(name);
    const ext = (m ? m[1] : extFromMime).toLowerCase();
    const d = new Date();
    const p = (n: number) => (n < 10 ? '0' + n : String(n));
    const base = `${this.file?.basename ?? 'HandNote'} image ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
    const path = await this.app.fileManager.getAvailablePathForAttachment(base, this.file?.path);
    const f = await this.app.vault.createBinary(path, data);
    return f.path;
  }

  private destroyEditor(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.journalTimer !== null) window.clearTimeout(this.journalTimer);
    this.saveTimer = null;
    this.journalTimer = null;
    this.editor?.destroy();
    this.editor = null;
  }

  getDocument(): HandNoteDocument | null {
    return this.doc;
  }

  // ---------------------------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------------------------

  /** A source reference of the note changed (file renamed / found again): save the new path. */
  sourcesChanged(): void {
    const d = this.doc;
    if (d?.sources) registerSources(d.sources);
    this.editor?.requestRedraw();
    this.markDirty();
  }

  private markDirty(): void {
    if (this.readOnly) return;
    this.dirty = true;
    this.changeSeq++;
    this.editor?.setStatus('dirty');
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.queueSave();
    }, SAVE_DELAY_MS);
    if (this.journalTimer !== null) window.clearTimeout(this.journalTimer);
    this.journalTimer = window.setTimeout(() => {
      this.journalTimer = null;
      void this.writeJournal();
    }, JOURNAL_DELAY_MS);
  }

  /** Commit the in-progress stroke and write immediately if there are unsaved changes. */
  async flush(): Promise<void> {
    this.editor?.commitPending();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) await this.queueSave();
    else await this.saving;
  }

  private queueSave(): Promise<void> {
    this.saving = this.saving.then(() => this.saveNow()).catch((e) => {
      console.error('HandNote save failed', e);
      this.editor?.setStatus('error');
      new Notice(tf('saveFailedNotice', { error: (e as Error).message }), 10000);
    });
    return this.saving;
  }

  private async saveNow(): Promise<void> {
    const file = this.file;
    const doc = this.doc;
    if (!file || !doc || this.readOnly || !this.dirty) return;
    this.editor?.setStatus('saving');
    const seqAtStart = this.changeSeq;

    const disk = await this.readDisk(file);
    const decision = decideSave(disk, { docId: doc.id, revision: this.baseRevision });
    if (decision.action === 'missing') {
      this.editor?.setStatus('error');
      new Notice(t('fileGoneNotice'), 10000);
      return;
    }
    if (decision.action === 'conflict' && disk !== null) {
      await this.preserveConflict(file, disk, decision.reason);
    }
    if (!this.backedUp && disk && decision.action === 'write') {
      await this.plugin.recovery.backup(doc.id, disk).catch(() => undefined);
      this.backedUp = true;
    }

    const newRev = Math.max(this.baseRevision, peekRevision(disk)) + 1;
    doc.revision = newRev;
    doc.modified = Date.now();
    doc.device = this.plugin.settings.deviceId;
    const text = serializeDocument(doc);
    let raced: string | null = null;
    if (await notePackages(this.app).isPacked(file.path)) await notePackages(this.app).write(file.path, text, disk ?? '');
    else await this.app.vault.process(file, (current) => {
      if (disk !== null && current !== disk) raced = current; // changed between read and write
      return text;
    });
    if (raced !== null) await this.preserveConflict(file, raced, 'file changed while saving');

    this.baseRevision = newRev;
    this.lastWrittenRevision = newRev;
    if (this.changeSeq === seqAtStart) {
      this.dirty = false;
      this.editor?.setStatus('saved');
      await this.plugin.recovery.clearJournal(doc.id).catch(() => undefined);
    } else {
      this.editor?.setStatus('dirty');
    }
  }

  private async readDisk(file: TFile): Promise<string | null> {
    try {
      if (!(await this.app.vault.adapter.exists(file.path))) return null;
      return await notePackages(this.app).read(file.path);
    } catch {
      return null;
    }
  }

  private async preserveConflict(file: TFile, content: string, reason: string): Promise<void> {
    const path = conflictCopyPath(file.path, new Date(), (p) => this.app.vault.getAbstractFileByPath(p) !== null);
    if (await notePackages(this.app).isPacked(file.path)) await notePackages(this.app).copy(file.path, path, content);
    else await this.app.vault.create(path, content);
    new Notice(tf('conflictNotice', { name: file.basename, reason, path: path.split('/').pop() ?? path }), 15000);
  }

  private async writeJournal(): Promise<void> {
    const doc = this.doc;
    const file = this.file;
    if (!doc || !file || !this.dirty) return;
    try {
      await this.plugin.recovery.writeJournal({
        path: file.path,
        docId: doc.id,
        baseRevision: this.baseRevision,
        savedAt: Date.now(),
        content: serializeDocument(doc),
      });
    } catch (e) {
      console.warn('HandNote journal write failed', e);
    }
  }

  private async checkJournal(doc: HandNoteDocument): Promise<void> {
    const j = await this.plugin.recovery.readJournal(doc.id);
    if (!j) return;
    let jdoc: HandNoteDocument;
    try {
      jdoc = parseDocument(j.content).doc;
    } catch {
      await this.plugin.recovery.clearJournal(doc.id);
      return;
    }
    if (serializeDocument({ ...jdoc, revision: doc.revision, modified: doc.modified, device: doc.device }) === serializeDocument(doc)) {
      await this.plugin.recovery.clearJournal(doc.id);
      return;
    }
    const when = new Date(j.savedAt).toLocaleString();
    new RecoveryModal(this.app, when, countStrokes(jdoc), countStrokes(doc), (restore) => {
      if (restore && this.editor) {
        // Base the restored state on the revision it was written against. If the file has moved on
        // since (e.g. a sync delivered a newer version), the next save keeps that version as a
        // conflict copy instead of overwriting it.
        jdoc.revision = doc.revision;
        this.baseRevision = j.baseRevision;
        this.doc = jdoc;
        this.editor.setDocument(jdoc, { keepCamera: true });
        this.markDirty();
      } else {
        void this.plugin.recovery.clearJournal(doc.id).catch(() => undefined);
      }
    }).open();
  }

  // ---------------------------------------------------------------------------------------------
  // External changes (sync)
  // ---------------------------------------------------------------------------------------------

  private async onExternalModify(): Promise<void> {
    const file = this.file;
    const doc = this.doc;
    if (!file || !doc || !this.editor) return;
    await this.saving;
    const disk = await this.readDisk(file);
    if (disk === null) return;
    const d = decideExternalChange(disk, { lastWrittenRevision: this.lastWrittenRevision, docId: doc.id, dirty: this.dirty });
    if (d === 'ignore-own-write') return;
    if (d === 'keep-local-and-resolve-on-save') {
      // the next save will keep the disk version as a conflict copy before writing ours
      return;
    }
    try {
      const res = parseDocument(disk);
      if (res.recovered) {
        // a damaged version arrived (interrupted sync / write): keep the intact open version; the
        // next save keeps the damaged one as a conflict copy before writing
        new Notice(tf('damagedSyncNotice', { name: file.basename }), 12000);
        return;
      }
      bindPackageSources(res.doc, file.path);
      this.doc = res.doc;
      this.baseRevision = res.doc.revision;
      this.lastWrittenRevision = res.doc.revision;
      this.readOnly = res.readOnly;
      this.editor.setDocument(res.doc, { keepCamera: true });
      this.editor.setReadOnly(res.readOnly);
      this.editor.setStatus('saved');
      new Notice(tf('reloadedNotice', { name: file.basename }), 4000);
    } catch (e) {
      console.warn('HandNote: external change could not be parsed; keeping the open version', e);
    }
  }
}

export function countStrokes(d: HandNoteDocument): number {
  return d.pages.reduce((n, p) => n + p.strokes.length, 0);
}

export function peekRevision(text: string | null): number {
  if (!text) return 0;
  const m = /"revision":(\d+)/.exec(text.slice(0, 600));
  return m ? Number(m[1]) : 0;
}

export class RecoveryModal extends Modal {
  constructor(
    app: import('obsidian').App,
    private readonly when: string,
    private readonly journalStrokes: number,
    private readonly diskStrokes: number,
    private readonly done: (restore: boolean) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: t('Unsaved handwriting found') });
    contentEl.createEl('p', {
      text: tf('journalNotice', { when: this.when, journal: this.journalStrokes, disk: this.diskStrokes }),
    });
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const restore = row.createEl('button', { text: t('Restore unsaved strokes'), cls: 'mod-cta' });
    const discard = row.createEl('button', { text: t('Discard') });
    restore.onclick = () => {
      this.done(true);
      this.close();
    };
    discard.onclick = () => {
      this.done(false);
      this.close();
    };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
