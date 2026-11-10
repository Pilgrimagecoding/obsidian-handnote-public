import { Compartment } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { FileView, MarkdownView, Notice, TFile, editorInfoField, type WorkspaceLeaf } from 'obsidian';
import { annotationPath, isMarkdownPath, parentFolder } from '../document/annotation-path';
import { t } from '../ui/i18n';
import { InkFileStore } from './ink-file';
import { MdInkLayer } from './md-ink-layer';
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
 * - Annotations are saved per note in `HandNote annotations/` (ink-file.ts); one tab writes them
 *   (another tab on the same note shows them read-only); they follow a renamed note.
 */
export class MdInkManager {
  private views = new Set<EditorView>();
  private layers = new Map<EditorView, MdInkLayer>();
  private buttons = new Map<MarkdownView, HTMLElement>();
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
              window.setTimeout(() => void mgr.close(v), 0);
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
    workspace.onLayoutReady(() => this.addButtons());
    plugin.registerEvent(
      workspace.on('layout-change', () => {
        this.addButtons();
        this.checkLayers();
      }),
    );
    plugin.registerEvent(workspace.on('active-leaf-change', () => this.addButtons()));
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
        if (f instanceof TFile && isMarkdownPath(f.path) && isMarkdownPath(oldPath)) void this.moveAnnotations(oldPath, f.path, f);
      }),
    );
    plugin.addCommand({
      id: 'annotate-markdown',
      name: t('cmd.annotateMarkdown'),
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

  async toggle(md: MarkdownView): Promise<void> {
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
    // one writer per note: another tab already annotates it
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
    const from = annotationPath(oldMd);
    const to = annotationPath(newMd);
    if (from === to) return;
    const open = [...this.layers.values()].filter((l) => l.file === file);
    for (const l of open) await l.flush();
    const app = this.plugin.app;
    const adapter = app.vault.adapter;
    try {
      if (await adapter.exists(from)) {
        if (await adapter.exists(to)) {
          new Notice(`HandNote: ${t('mdMoveExists')} "${to}"`, 10000);
          return;
        }
        let cur = '';
        for (const part of parentFolder(to) ? parentFolder(to).split('/') : []) {
          cur = cur ? `${cur}/${part}` : part;
          if (!(await adapter.exists(cur))) await app.vault.createFolder(cur).catch(() => undefined);
        }
        const f = app.vault.getAbstractFileByPath(from);
        if (f instanceof TFile) await app.vault.rename(f, to);
        else await adapter.rename(from, to);
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
