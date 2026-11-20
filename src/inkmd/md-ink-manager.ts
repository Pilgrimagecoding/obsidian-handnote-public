import { Compartment } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { FileView, MarkdownView, Notice, TFile, TFolder, editorInfoField, type WorkspaceLeaf } from 'obsidian';
import { annotationPath, legacyAnnotationPath, relocatedChild, isMarkdownPath } from '../document/annotation-path';
import { t } from '../ui/i18n';
import { InkFileStore } from './ink-file';
import { annotationHasInk } from './auto-open';
import { MdInkLayer } from './md-ink-layer';
import { openMarkdownExport } from '../plugin/md-export';
import type HandNotePlugin from '../plugin/main';

/** View type of 0.12.0-beta.1 (separate annotation view); tabs left in it reopen in the editor. */
export const LEGACY_MD_INK_VIEW = 'handnote-markdown-ink';

/**
 * Ink on Markdown (0.12): turns HandNote ink on and off in Markdown tabs.
 *
 * - A HandNote icon in the header of every Markdown tab (public API `ItemView.addAction`, one per
 *   view, removed on unload) toggles the ink of that tab. The note stays in Obsidian's own editor.
 * - An editor extension (`registerEditorExtension`) gives each Markdown editor's EditorView to
 *   this manager and forwards its updates (edits move the ink's lines).
 * - Annotations are saved beside each note (ink-file.ts); one tab writes them
 *   (another tab on the same note shows them read-only); they follow a renamed note.
 */
export class MdInkManager {
  private views = new Set<EditorView>();
  private layers = new Map<EditorView, MdInkLayer>();
  private buttons = new Map<MarkdownView, HTMLElement>();
  private toggleQueue: Promise<void> = Promise.resolve();
  /** the file each tab last opened (its ink shown automatically once; then the user's choice stands) */
  private autoSeen = new WeakMap<MarkdownView, string>();
  private renameQueue: Promise<void> = Promise.resolve();
  /** where an ink layer makes its editor non-editable (Scribble) — empty otherwise */
  private readonly editable = new Compartment();

  constructor(private readonly plugin: HandNotePlugin) {}

  start(): void {
    const plugin = this.plugin;
    const views = this.views;
    const layers = this.layers;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the editor extension class below calls back into this manager
    const mgr = this;
    plugin.registerEditorExtension([
      this.editable.of([]),
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            views.add(view);
          }
          update(u: ViewUpdate): void {
            const layer = layers.get(this.view);
            if (!layer) return;
            // another note opened in this tab: its ink mode ends (after this update: nothing may be
            // dispatched while the editor updates)
            if (layer.md.file !== layer.file) {
              const v = this.view;
              // only that layer: the next note's ink may be open in this editor by then
              window.setTimeout(() => {
                const l = layers.get(v);
                if (l && l.md.file !== l.file) void mgr.close(v);
              }, 0);
            } else layer.update(u);
          }
          destroy(): void {
            views.delete(this.view);
            void mgr.close(this.view, true);
          }
        },
      ),
    ]);
    const workspace = plugin.app.workspace;
    workspace.onLayoutReady(() => {
      this.addButtons();
      this.autoOpen();
    });
    plugin.registerEvent(
      workspace.on('layout-change', () => {
        this.addButtons();
        this.checkLayers();
        this.autoOpen();
      }),
    );
    plugin.registerEvent(
      workspace.on('active-leaf-change', () => {
        this.addButtons();
        this.autoOpen();
      }),
    );
    plugin.registerEvent(workspace.on('file-open', () => this.autoOpen()));
    plugin.registerEvent(
      plugin.app.vault.on('modify', (f) => {
        for (const l of this.layers.values()) if (l.storePath === f.path) void l.externalChange();
      }),
    );
    plugin.registerEvent(
      plugin.app.vault.on('create', (f) => {
        for (const l of this.layers.values()) if (l.storePath === f.path) void l.externalChange();
      }),
    );
    // a renamed / moved note keeps its annotations; a deleted note's annotations are kept (never
    // deleted automatically)
    plugin.registerEvent(
      plugin.app.vault.on('rename', (f, oldPath) => {
        const next = f.path;
        const moves = f instanceof TFile && isMarkdownPath(next) && isMarkdownPath(oldPath)
          ? [{ file: f, old: oldPath, next }]
          : f instanceof TFolder ? plugin.app.vault.getFiles()
            .filter((file) => isMarkdownPath(file.path) && file.path.startsWith(next + '/'))
            .map((file) => ({ file, old: oldPath + file.path.slice(next.length), next: file.path })) : [];
        // Folder moves already moved their sidecars. Retarget before an autosave can recreate
        // the former directory; individual Markdown renames leave the sidecar in its old place.
        for (const move of moves) for (const layer of this.layers.values()) {
          if (layer.file === move.file) layer.moved(move.next, f instanceof TFolder
            ? relocatedChild(layer.storePath, oldPath, next) : layer.storePath);
        }
        for (const move of moves) this.renameQueue = this.renameQueue
          .then(() => this.moveAnnotations(move.old, move.next, move.file))
          .catch((e) => console.warn('HandNote: moving annotations failed', e));
      }),
    );
    plugin.addTranslatedCommand({
      id: 'annotate-markdown',
      name: 'cmd.annotateMarkdown',
      checkCallback: (checking) => {
        const md = workspace.getActiveViewOfType(MarkdownView);
        if (!md?.file) return false;
        if (!checking) void this.toggle(md);
        return true;
      },
    });
    plugin.registerView(LEGACY_MD_INK_VIEW, (leaf) => new LegacyInkView(leaf, this));
    plugin.register(() => {
      for (const v of [...this.layers.keys()]) void this.close(v);
      for (const b of this.buttons.values()) b.remove();
      this.buttons.clear();
    });
  }

  /** Settings changed elsewhere (a HandNote note's toolbar). */
  settingsUpdated(): void {
    for (const [md, button] of this.buttons) this.setButton(md, button.classList.contains('is-active'));
    for (const l of this.layers.values()) l.settingsUpdated();
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.layers.values()].map((l) => l.flush()));
  }

  isOn(md: MarkdownView): boolean {
    return !!this.layerOf(md);
  }

  private layerOf(md: MarkdownView): MdInkLayer | null {
    for (const l of this.layers.values()) if (l.md === md) return l;
    return null;
  }

  private editorViewOf(md: MarkdownView): EditorView | null {
    for (const v of this.views) if (v.state.field(editorInfoField, false) === md) return v;
    return null;
  }

  private addButtons(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (!(v instanceof MarkdownView) || this.buttons.has(v)) continue;
      const b = v.addAction('pen-tool', t('mdAnnotate'), () => void this.toggle(v));
      b.addClass('hn-md-action');
      this.buttons.set(v, b);
    }
    // views that are gone
    for (const [v, b] of this.buttons) {
      if (!b.isConnected && !this.plugin.app.workspace.getLeavesOfType('markdown').some((l) => l.view === v)) this.buttons.delete(v);
    }
  }

  private setButton(md: MarkdownView, on: boolean): void {
    const b = this.buttons.get(md);
    if (!b) return;
    b.toggleClass('is-active', on);
    b.setAttribute('aria-label', on ? t('mdExit') : t('mdAnnotate'));
  }

  /** Ink ends when the tab shows the reading view or another kind of view. */
  private checkLayers(): void {
    for (const [v, l] of this.layers) {
      const alive = l.md.leaf.view === l.md && l.md.getMode() === 'source' && l.md.file === l.file;
      if (!alive) void this.close(v);
    }
  }

  toggle(md: MarkdownView): Promise<void> {
    return this.queue(() => this.toggleNow(md));
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    const next = this.toggleQueue.then(fn);
    this.toggleQueue = next.catch((e) => { console.error('HandNote annotation handoff', e); new Notice(t('mdMoveFailed')); });
    return next;
  }

  /**
   * A note with annotations opens with them shown, once per opening in a tab: leaving the
   * annotation mode keeps it off until another note is opened in that tab. Only in the editing
   * view (a tab opened in the reading view stays as it is); a note without ink opens normally.
   */
  private autoOpen(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const md = leaf.view;
      if (!(md instanceof MarkdownView) || !md.file) continue;
      const file = md.file;
      if (this.autoSeen.get(md) === file.path) continue;
      const editing = md.getMode() === 'source';
      // the editor is not attached yet: decided at the next workspace event
      if (editing && !this.editorViewOf(md)) continue;
      this.autoSeen.set(md, file.path);
      if (!editing || this.layerOf(md)?.file === file || [...this.layers.values()].some((l) => l.file === file)) continue;
      void this.readAnnotation(file.path).then((text) => {
        const vault = this.plugin.app.vault;
        if (!annotationHasInk(text, file.path, (p) => vault.getAbstractFileByPath(p) instanceof TFile)) return;
        return this.queue(async () => {
          // still this note, still the editing view, ink not opened meanwhile
          if (md.file !== file || md.getMode() !== 'source' || this.autoSeen.get(md) !== file.path) return;
          const cur = this.layerOf(md);
          if (cur?.file === file) return;
          if (cur) await this.close(cur.view);
          if ([...this.layers.values()].some((l) => l.file === file)) return;
          await this.toggleNow(md);
        });
      }).catch((e) => console.warn('HandNote: reading annotations failed', e));
    }
  }

  /** The note's annotation file (or its pre-beta.10 location), null when there is none. */
  private async readAnnotation(mdPath: string): Promise<string | null> {
    const adapter = this.plugin.app.vault.adapter;
    for (const p of [annotationPath(mdPath), legacyAnnotationPath(mdPath)]) {
      if (await adapter.exists(p)) return adapter.read(p);
    }
    return null;
  }

  async openAnnotations(path: string, leaf: WorkspaceLeaf): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await leaf.setViewState({ type: 'markdown', state: { file: path, mode: 'source', source: false }, active: true });
    if (leaf.view instanceof MarkdownView && !this.isOn(leaf.view)) await this.toggle(leaf.view);
  }

  private async toggleNow(md: MarkdownView): Promise<void> {
    const cur = this.layerOf(md);
    if (cur) {
      await this.close(cur.view);
      return;
    }
    const file = md.file;
    if (!file) return;
    // the ink goes on the editing view (live preview): leave the reading view first
    if (md.getMode() !== 'source') {
      await md.setState({ ...md.getState(), mode: 'source' }, { history: false });
      await new Promise((r) => window.setTimeout(r, 60));
    }
    const ev = this.editorViewOf(md);
    if (!ev) {
      new Notice(t('mdNoEditor'), 6000);
      return;
    }
    // Match public 0.12.3: the existing annotation tab keeps writing ownership.
    const other = [...this.layers.values()].some((l) => l.file === file);
    let layer: MdInkLayer | null = null;
    const plugin = this.plugin;
    const store = new InkFileStore(plugin.app, plugin.recovery, () => plugin.settings.deviceId, file.path, {
      status: (s) => layer?.setStatus(s),
      beforeSave: (d) => layer?.refreshAnchors(d),
      reloaded: (d) => layer?.setDocument(d, store.readOnly),
    });
    layer = new MdInkLayer(md, ev, store, {
      version: plugin.manifest.version,
      settings: () => plugin.settings.editor,
      settingsChanged: (s) => {
        plugin.settings.editor = s;
        plugin.queueSaveSettings();
        plugin.broadcastSettings(null);
      },
      exit: () => void this.close(ev),
      export: format => { if (layer) openMarkdownExport(plugin.app, layer, format); },
    }, this.editable);
    this.layers.set(ev, layer);
    this.setButton(md, true);
    const doc = await store.load();
    if (!doc) {
      await this.close(ev);
      return;
    }
    if (other) {
      store.readOnly = true;
      new Notice(t('mdOtherTab'), 6000);
    }
    layer.setDocument(doc, store.readOnly);
    layer.setStatus(store.readOnly ? 'readonly' : 'saved');
  }

  async close(ev: EditorView, viewGone = false): Promise<void> {
    const l = this.layers.get(ev);
    if (!l) return;
    this.layers.delete(ev);
    this.setButton(l.md, false);
    await l.close(viewGone);
  }

  private async moveAnnotations(oldMd: string, newMd: string, file: TFile): Promise<void> {
    const to = annotationPath(newMd);
    const open = [...this.layers.values()].filter((l) => l.file === file);
    for (const l of open) await l.flush();
    const app = this.plugin.app;
    const adapter = app.vault.adapter;
    let from = open[0]?.storePath ?? annotationPath(oldMd);
    try {
      if (!await adapter.exists(from)) {
        const legacy = legacyAnnotationPath(oldMd);
        if (await adapter.exists(legacy)) from = legacy;
        else if (await adapter.exists(to)) from = to; // moved with its containing folder
      }
      if (await adapter.exists(from)) {
        if (from !== to && await adapter.exists(to)) {
          new Notice(`HandNote: ${t('mdMoveExists')} "${to}"`, 10000);
          return;
        }
        const header = JSON.parse((await adapter.read(from)).split('\n')[0].replace(/,\s*$/, '') + '}');
        if (header.annotates !== oldMd && header.annotates !== newMd) {
          new Notice(t('mdAnnotationCollision'), 10000);
          return;
        }
        if (from !== to) {
          const f = app.vault.getAbstractFileByPath(from);
          if (f instanceof TFile) await app.vault.rename(f, to);
          else await adapter.rename(from, to);
        }
        // Change only annotation metadata; preserve every line of ink verbatim.
        const updateLink = (text: string) => {
          const end = text.indexOf('\n');
          if (end < 0) return text;
          const h = JSON.parse(text.slice(0, end).replace(/,\s*$/, '') + '}');
          if (h.annotates !== oldMd) return text;
          h.annotates = newMd;
          return JSON.stringify(h).slice(0, -1) + ',' + text.slice(end);
        };
        const target = app.vault.getAbstractFileByPath(to);
        if (target instanceof TFile) await app.vault.process(target, updateLink);
        // Obsidian normally indexes rename synchronously; unindexed files keep their old
        // header until InkFileStore loads them, avoiding an unguarded adapter overwrite.
      }
      for (const l of open) l.moved(newMd, to);
    } catch (e) {
      console.warn('HandNote: moving annotations failed', e);
      new Notice(`HandNote: ${t('mdMoveFailed')} "${from}"`, 10000);
    }
  }
}

/** A tab left in the annotation view of 0.12.0-beta.1: shows the note in the editor with ink on. */
class LegacyInkView extends FileView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly mgr: MdInkManager,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return LEGACY_MD_INK_VIEW;
  }
  getDisplayText(): string {
    return this.file?.basename ?? 'HandNote';
  }
  canAcceptExtension(): boolean {
    return false;
  }
  async onLoadFile(file: TFile): Promise<void> {
    const leaf = this.leaf;
    window.setTimeout(() => {
      void (async () => {
        await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: false }, active: true });
        if (leaf.view instanceof MarkdownView) await this.mgr.toggle(leaf.view);
      })();
    }, 0);
  }
}
