import { FuzzySuggestModal, Notice, TFile, normalizePath, type App } from 'obsidian';
import type HandNotePlugin from './main';
import { notePackages } from '../storage/note-package';
import { parseDocument, serializeDocument } from '../document/codec';
import { documentLinks, linkNames, retargetDocument } from '../document/links';
import { fitTextBox } from '../rendering/items-paint';
import { HandNoteView, EXTENSION } from './view';
import { t, tf } from '../ui/i18n';

/** Choose a file of the vault to link to. */
class NotePicker extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly done: (f: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder(t('linkPickPlaceholder'));
  }

  getItems(): TFile[] {
    const cfg = this.app.vault.configDir + '/';
    return this.app.vault
      .getFiles()
      .filter((f) => !f.path.startsWith(cfg))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(f: TFile): string {
    return f.extension === 'md' ? f.path.slice(0, -3) : f.path;
  }

  onChooseItem(f: TFile): void {
    this.chosen = true;
    this.done(f);
  }

  onClose(): void {
    super.onClose();
    // Obsidian closes the modal before it reports the choice
    window.setTimeout(() => {
      if (!this.chosen) this.done(null);
    }, 0);
  }
}

/** The link text (as Obsidian would write it from `sourcePath`) of a file the user picks, or null. */
export function pickNoteLink(app: App, sourcePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    new NotePicker(app, (f) => resolve(f ? app.metadataCache.fileToLinktext(f, sourcePath, true) : null)).open();
  });
}

const isNote = (f: unknown): f is TFile => f instanceof TFile && f.extension === EXTENSION;

interface Entry {
  mtime: number;
  size: number;
  /** link paths as typed, one per link */
  links: string[];
}

const CACHE_VERSION = 1;
const REINDEX_MS = 800;

/**
 * `[[links]]` in handwritten notes, for Obsidian: they are published in the metadata cache's
 * `resolvedLinks` / `unresolvedLinks` (the graph and link counts read them), and links to a
 * renamed file are rewritten in the notes (Obsidian only rewrites Markdown and canvas files).
 * The index is kept in the plugin folder, so a vault is read in full only once.
 */
export class HandNoteLinks {
  private readonly index = new Map<string, Entry>();
  /** source path → what was published for it */
  private readonly published = new Map<string, Record<string, number>>();
  private readonly timers = new Map<string, number>();
  private saveTimer = 0;
  private republishTimer = 0;
  private ready = false;
  private triggering = false;

  constructor(
    private readonly plugin: HandNotePlugin,
    private readonly cachePath: string,
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  start(): void {
    const { app, plugin } = this;
    app.workspace.onLayoutReady(() => void this.scanAll());
    plugin.registerEvent(app.vault.on('modify', (f) => isNote(f) && this.queue(f.path)));
    plugin.registerEvent(app.vault.on('create', (f) => this.ready && isNote(f) && this.queue(f.path)));
    plugin.registerEvent(
      app.vault.on('delete', (f) => {
        if (!isNote(f)) return;
        this.index.delete(f.path);
        this.unpublish(f.path);
        this.changed();
      }),
    );
    plugin.registerEvent(app.vault.on('rename', (f, old) => void this.renamed(f, old)));
    // a note created / renamed elsewhere may resolve a link that was unresolved (and the other way)
    plugin.registerEvent(
      app.metadataCache.on('resolved', () => {
        if (this.triggering || !this.ready) return;
        window.clearTimeout(this.republishTimer);
        this.republishTimer = window.setTimeout(() => this.publishAll(), 300);
      }),
    );
    plugin.register(() => {
      for (const id of this.timers.values()) window.clearTimeout(id);
      window.clearTimeout(this.republishTimer);
      if (this.saveTimer) {
        window.clearTimeout(this.saveTimer);
        void this.saveCache();
      }
      for (const p of [...this.published.keys()]) this.unpublish(p);
    });
  }

  /** Link paths of a note (as typed), for tests and diagnostics. */
  linksOf(path: string): string[] {
    return this.index.get(path)?.links.slice() ?? [];
  }

  private async scanAll(): Promise<void> {
    const cached = await this.loadCache();
    const files = this.app.vault.getFiles().filter(isNote);
    let read = 0;
    for (const f of files) {
      const c = cached.get(f.path);
      if (c && c.mtime === f.stat.mtime && c.size === f.stat.size) this.index.set(f.path, c);
      else {
        await this.reindex(f, false);
        // keep the interface responsive while a large vault is read the first time
        if (++read % 8 === 0) await new Promise((r) => window.setTimeout(r, 0));
      }
    }
    this.ready = true;
    this.publishAll();
    if (read || cached.size !== files.length) this.changed();
  }

  private queue(path: string): void {
    window.clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      window.setTimeout(() => {
        this.timers.delete(path);
        const f = this.app.vault.getAbstractFileByPath(path);
        if (isNote(f)) void this.reindex(f, true);
      }, REINDEX_MS),
    );
  }

  private async reindex(f: TFile, publish: boolean): Promise<void> {
    let links: string[] = [];
    try {
      const text = await notePackages(this.app).read(f.path);
      // most notes have no link: no need to parse them
      if (text.includes('[[')) links = documentLinks(parseDocument(text).doc).map((l) => l.target);
    } catch {
      links = this.index.get(f.path)?.links ?? [];
    }
    const prev = this.index.get(f.path);
    this.index.set(f.path, { mtime: f.stat.mtime, size: f.stat.size, links });
    if (!publish) return;
    if (!prev || prev.links.join('\n') !== links.join('\n')) {
      this.publish(f.path);
      this.trigger([f.path]);
    }
    this.changed();
  }

  private publishAll(): void {
    const paths: string[] = [];
    for (const path of this.index.keys()) if (this.publish(path)) paths.push(path);
    if (paths.length) this.trigger(paths);
  }

  /** Put the note's links into the metadata cache; true when that changed something. */
  private publish(path: string): boolean {
    const mc = this.app.metadataCache;
    const links = this.index.get(path)?.links ?? [];
    if (!links.length) return this.unpublish(path);
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};
    for (const target of links) {
      const dest = mc.getFirstLinkpathDest(target, path);
      if (dest) resolved[dest.path] = (resolved[dest.path] ?? 0) + 1;
      else unresolved[target] = (unresolved[target] ?? 0) + 1;
    }
    const same = (a: Record<string, number> | undefined, b: Record<string, number>): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);
    if (same(this.published.get(path), resolved) && same(mc.resolvedLinks[path], resolved) && same(mc.unresolvedLinks[path], unresolved)) return false;
    mc.resolvedLinks[path] = resolved;
    mc.unresolvedLinks[path] = unresolved;
    this.published.set(path, resolved);
    return true;
  }

  private unpublish(path: string): boolean {
    if (!this.published.has(path)) return false;
    const mc = this.app.metadataCache;
    this.published.delete(path);
    delete mc.resolvedLinks[path];
    delete mc.unresolvedLinks[path];
    return true;
  }

  /** Tell the graph / link views (they listen to the metadata cache). */
  private trigger(paths: string[]): void {
    const mc = this.app.metadataCache;
    this.triggering = true;
    try {
      for (const p of paths) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f instanceof TFile) mc.trigger('resolve', f);
      }
      mc.trigger('resolved');
    } finally {
      this.triggering = false;
    }
  }

  private async renamed(f: unknown, old: string): Promise<void> {
    if (!(f instanceof TFile)) return;
    if (isNote(f)) {
      const e = this.index.get(old);
      this.index.delete(old);
      this.unpublish(old);
      if (e) this.index.set(f.path, e);
      this.queue(f.path);
    }
    // notes whose links pointed to the old path: rewritten (Obsidian's "Automatically update
    // internal links" setting is respected)
    const auto = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.('alwaysUpdateLinks');
    if (auto === false) return;
    const sources = [...this.published].filter(([, r]) => r[old]).map(([p]) => (p === old ? f.path : p));
    let n = 0;
    for (const src of sources) {
      const next = this.app.metadataCache.fileToLinktext(f, src, true);
      try {
        if (await this.retarget(src, (target) => linkNames(target, old), next)) n++;
      } catch (e) {
        console.warn('HandNote: updating links failed', src, e);
      }
    }
    if (n) new Notice(tf('linksUpdated', { n }));
    this.publishAll();
  }

  /** Rewrite one note's links: through its open view (undoable, saved as usual), else in the file. */
  private async retarget(path: string, matches: (target: string) => boolean, next: string): Promise<boolean> {
    for (const leaf of this.app.workspace.getLeavesOfType('handnote-view')) {
      const v = leaf.view;
      if (v instanceof HandNoteView && v.file?.path === path && v.editor) return v.editor.retargetLinks(matches, next);
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const packages = notePackages(this.app);
    const text = await packages.read(path);
    const res = parseDocument(text);
    if (res.readOnly || res.recovered) return false;
    const doc = res.doc;
    if (!retargetDocument(doc, matches, next, fitTextBox)) return false;
    doc.revision += 1;
    doc.modified = Date.now();
    doc.device = this.plugin.settings.deviceId;
    const out = serializeDocument(doc);
    if (await packages.isPacked(path)) await packages.write(path, out, text);
    else {
      let raced = false;
      await this.app.vault.process(file, (cur) => {
        if (cur !== text) {
          raced = true;
          return cur;
        }
        return out;
      });
      if (raced) return false;
    }
    return true;
  }

  private changed(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void this.saveCache();
    }, 2000);
  }

  private async loadCache(): Promise<Map<string, Entry>> {
    const out = new Map<string, Entry>();
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.cachePath))) return out;
      const raw = JSON.parse(await adapter.read(this.cachePath)) as { v?: number; notes?: Record<string, Entry> };
      if (raw.v !== CACHE_VERSION || !raw.notes) return out;
      for (const [p, e] of Object.entries(raw.notes)) {
        if (e && typeof e.mtime === 'number' && typeof e.size === 'number' && Array.isArray(e.links)) out.set(p, { mtime: e.mtime, size: e.size, links: e.links.filter((x) => typeof x === 'string') });
      }
    } catch {
      /* a damaged cache is rebuilt */
    }
    return out;
  }

  private async saveCache(): Promise<void> {
    const notes: Record<string, Entry> = {};
    for (const [p, e] of this.index) notes[p] = e;
    try {
      await this.app.vault.adapter.write(normalizePath(this.cachePath), JSON.stringify({ v: CACHE_VERSION, notes }));
    } catch (e) {
      console.warn('HandNote: saving the link index failed', e);
    }
  }
}
