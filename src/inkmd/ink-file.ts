import { Notice, TFile, type App } from 'obsidian';
import { parseDocument, serializeDocument } from '../document/codec';
import { createDocument, defaultBackground, type HandNoteDocument } from '../document/model';
import { annotationPath, parentFolder } from '../document/annotation-path';
import { conflictCopyPath, decideExternalChange, decideSave } from '../storage/sync-guard';
import type { RecoveryStore } from '../storage/recovery';
import { RecoveryModal, countStrokes, peekRevision } from '../plugin/view';
import { t } from '../ui/i18n';

const SAVE_DELAY_MS = 1200;
const JOURNAL_DELAY_MS = 400;

export type InkStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'readonly';

export interface InkFileHooks {
  status(s: InkStatus): void;
  /** Called right before the document is serialized (refresh anchors). */
  beforeSave(doc: HandNoteDocument): void;
  /** A newer version arrived (sync) and replaced the open one. */
  reloaded(doc: HandNoteDocument): void;
}

/**
 * The annotations of one Markdown note (Ink on Markdown, 0.12): a `.handnote` file in
 * `HandNote annotations/` (annotation-path.ts). Same safety as an open note (view.ts): the
 * on-disk revision is checked before each write, a version changed elsewhere is kept as a copy,
 * unsaved ink goes to the recovery journal, a damaged file is shown read-only and never written.
 * The Markdown file itself is never written.
 */
export class InkFileStore {
  doc: HandNoteDocument | null = null;
  path: string;
  readOnly = false;
  private existed = false;
  private baseRevision = 0;
  private lastWrittenRevision = -1;
  private dirty = false;
  private changeSeq = 0;
  private saveTimer: number | null = null;
  private journalTimer: number | null = null;
  private saving: Promise<void> = Promise.resolve();
  private backedUp = false;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly recovery: RecoveryStore,
    private readonly deviceId: () => string,
    public mdPath: string,
    private readonly hooks: InkFileHooks,
  ) {
    this.path = annotationPath(mdPath);
  }

  /** Read the annotation file (or start an empty one; nothing is written before the first stroke). */
  async load(): Promise<HandNoteDocument | null> {
    this.readOnly = false;
    this.dirty = false;
    const disk = await this.readDisk();
    this.existed = disk !== null;
    let doc: HandNoteDocument;
    if (disk === null || disk.trim() === '') {
      doc = createDocument({ width: 700, height: 1000, background: defaultBackground('blank'), device: this.deviceId() });
    } else {
      try {
        const res = parseDocument(disk);
        doc = res.doc;
        this.readOnly = res.readOnly;
        if (res.recovered) {
          this.readOnly = true;
          new Notice(t('mdInkDamaged'), 12000);
          await this.recovery.backup(res.doc.id + '-damaged', disk).catch(() => undefined);
        } else if (res.readOnly) new Notice(res.warnings.join('\n'), 8000);
      } catch (e) {
        new Notice(`${t('mdInkUnreadable')} (${(e as Error).message})`, 10000);
        return null;
      }
      if (doc.pages.length !== 1 || doc.pages[0].board) {
        this.readOnly = true;
        doc.pages = doc.pages.slice(0, 1);
      }
    }
    doc.annotates = this.mdPath;
    this.doc = doc;
    this.baseRevision = doc.revision;
    this.lastWrittenRevision = doc.revision;
    this.hooks.status(this.readOnly ? 'readonly' : 'saved');
    if (!this.readOnly) void this.checkJournal(doc);
    return doc;
  }

  markDirty(): void {
    if (this.readOnly || this.disposed) return;
    this.dirty = true;
    this.changeSeq++;
    this.hooks.status('dirty');
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

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) await this.queueSave();
    else await this.saving;
  }

  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    if (this.journalTimer !== null) window.clearTimeout(this.journalTimer);
  }

  /** The note was renamed / moved and the annotation file with it (by the plugin). */
  moved(mdPath: string, path: string): void {
    this.mdPath = mdPath;
    this.path = path;
    if (this.doc) this.doc.annotates = mdPath;
  }

  private queueSave(): Promise<void> {
    this.saving = this.saving.then(() => this.saveNow()).catch((e) => {
      console.error('HandNote: saving annotations failed', e);
      this.hooks.status('error');
      new Notice(`${t('mdSaveFailed')} (${(e as Error).message})`, 10000);
    });
    return this.saving;
  }

  private async saveNow(): Promise<void> {
    const doc = this.doc;
    if (!doc || this.readOnly || !this.dirty) return;
    const path = this.path;
    this.hooks.status('saving');
    const seqAtStart = this.changeSeq;
    const disk = await this.readDisk();
    if (disk !== null && disk.trim() !== '') {
      const decision = decideSave(disk, { docId: doc.id, revision: this.baseRevision });
      if (decision.action === 'conflict') await this.preserveConflict(disk, decision.reason);
      if (!this.backedUp && decision.action === 'write') {
        await this.recovery.backup(doc.id, disk).catch(() => undefined);
        this.backedUp = true;
      }
    } else if (disk === null && this.existed) {
      // removed elsewhere (sync, file explorer): written again rather than losing the open ink
      new Notice(t('mdInkRecreated'), 8000);
    }
    this.hooks.beforeSave(doc);
    const newRev = Math.max(this.baseRevision, peekRevision(disk)) + 1;
    doc.revision = newRev;
    doc.modified = Date.now();
    doc.device = this.deviceId();
    doc.annotates = this.mdPath;
    const text = serializeDocument(doc);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      let raced: string | null = null;
      await this.app.vault.process(f, (current) => {
        if (disk !== null && current !== disk) raced = current;
        return text;
      });
      if (raced !== null) await this.preserveConflict(raced, 'file changed while saving');
    } else {
      await this.ensureFolder(parentFolder(path));
      await this.app.vault.create(path, text);
    }
    this.existed = true;
    this.baseRevision = newRev;
    this.lastWrittenRevision = newRev;
    if (this.changeSeq === seqAtStart) {
      this.dirty = false;
      this.hooks.status('saved');
      await this.recovery.clearJournal(doc.id).catch(() => undefined);
    } else {
      this.hooks.status('dirty');
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    let cur = '';
    for (const part of folder.split('/')) {
      cur = cur ? `${cur}/${part}` : part;
      if (await this.app.vault.adapter.exists(cur)) continue;
      try {
        await this.app.vault.createFolder(cur);
      } catch (e) {
        if (!(await this.app.vault.adapter.exists(cur))) throw e;
      }
    }
  }

  private async readDisk(): Promise<string | null> {
    try {
      if (!(await this.app.vault.adapter.exists(this.path))) return null;
      return await this.app.vault.adapter.read(this.path);
    } catch {
      return null;
    }
  }

  private async preserveConflict(content: string, reason: string): Promise<void> {
    const copy = conflictCopyPath(this.path, new Date(), (p) => this.app.vault.getAbstractFileByPath(p) !== null);
    await this.app.vault.create(copy, content);
    new Notice(`HandNote: ${t('mdInkConflict')} (${reason}) → "${copy.split('/').pop()}"`, 15000);
  }

  private async writeJournal(): Promise<void> {
    const doc = this.doc;
    if (!doc || !this.dirty) return;
    try {
      this.hooks.beforeSave(doc);
      await this.recovery.writeJournal({ path: this.path, docId: doc.id, baseRevision: this.baseRevision, savedAt: Date.now(), content: serializeDocument(doc) });
    } catch (e) {
      console.warn('HandNote journal write failed', e);
    }
  }

  private async checkJournal(doc: HandNoteDocument): Promise<void> {
    const j = await this.recovery.readJournal(doc.id);
    if (!j) return;
    let jdoc: HandNoteDocument;
    try {
      jdoc = parseDocument(j.content).doc;
    } catch {
      await this.recovery.clearJournal(doc.id);
      return;
    }
    const same = serializeDocument({ ...jdoc, revision: doc.revision, modified: doc.modified, device: doc.device, annotates: doc.annotates }) === serializeDocument(doc);
    if (same || jdoc.pages.length !== 1) {
      await this.recovery.clearJournal(doc.id);
      return;
    }
    new RecoveryModal(this.app, new Date(j.savedAt).toLocaleString(), countStrokes(jdoc), countStrokes(doc), (restore) => {
      if (restore && !this.disposed) {
        jdoc.revision = doc.revision;
        jdoc.annotates = doc.annotates;
        this.baseRevision = j.baseRevision;
        this.doc = jdoc;
        this.hooks.reloaded(jdoc);
        this.markDirty();
      } else {
        void this.recovery.clearJournal(doc.id).catch(() => undefined);
      }
    }).open();
  }

  /** The annotation file changed on disk (sync from another device). */
  async externalChange(): Promise<void> {
    const doc = this.doc;
    if (!doc || this.disposed) return;
    await this.saving;
    const disk = await this.readDisk();
    if (disk === null || disk.trim() === '') return;
    if (!this.existed && doc.pages[0]?.strokes.length) return; // the next save keeps the arrived one as a copy
    const d = decideExternalChange(disk, { lastWrittenRevision: this.lastWrittenRevision, docId: doc.id, dirty: this.dirty });
    if (d === 'ignore-own-write') return;
    if (d === 'keep-local-and-resolve-on-save' && this.existed) return;
    try {
      const res = parseDocument(disk);
      if (res.recovered || res.doc.pages.length !== 1 || res.doc.pages[0].board) return;
      res.doc.annotates = this.mdPath;
      this.doc = res.doc;
      this.existed = true;
      this.baseRevision = res.doc.revision;
      this.lastWrittenRevision = res.doc.revision;
      this.dirty = false;
      this.hooks.reloaded(res.doc);
      this.hooks.status(this.readOnly ? 'readonly' : 'saved');
      new Notice(t('mdInkReloaded'), 4000);
    } catch (e) {
      console.warn('HandNote: arrived annotations could not be read; keeping the open version', e);
    }
  }
}
