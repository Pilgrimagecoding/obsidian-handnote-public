import { TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { parseDocument } from '../document/codec';
import { GeometryCache } from '../document/geometry-cache';
import type { HandNoteDocument } from '../document/model';
import { renderPageToCanvas } from '../rendering/paint';
import { preloadImages, registerAssets } from '../rendering/items-paint';
import type HandNotePlugin from './main';
import { EXTENSION } from './view';

/**
 * Renders ![[note.handnote]] embeds in Markdown (Reading view and Live Preview).
 *
 * Obsidian has no public API for custom embed renderers, so (like other ink plugins) this watches
 * the DOM for Obsidian's generic `.internal-embed` placeholders whose `src` points at a .handnote
 * file and replaces their content with a rendered, read-only preview. Tapping the preview opens the
 * full editor. Only public APIs (vault, metadataCache, workspace) are used to resolve and open files.
 */

const SRC_RE = new RegExp(`\\.${EXTENSION}(#.*)?$`, 'i');

interface Mounted {
  path: string;
  mtime: number;
  width: number;
}

export class EmbedManager {
  private observer: MutationObserver | null = null;
  /** how many times an embed was (re)drawn — a loop shows up here (tests) */
  mounts = 0;
  private scheduled = false;
  private mounted = new WeakMap<HTMLElement, Mounted>();
  private live = new Set<HTMLElement>();
  private docCache = new Map<string, { mtime: number; doc: HandNoteDocument; geo: GeometryCache }>();

  constructor(private readonly plugin: HandNotePlugin) {}

  start(): void {
    const app = this.plugin.app;
    this.plugin.registerMarkdownPostProcessor((el, ctx) => this.scan(el, ctx));
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.plugin.register(() => this.observer?.disconnect());
    this.plugin.registerEvent(
      app.vault.on('modify', (f) => {
        if (f instanceof TFile && f.extension === EXTENSION) {
          this.docCache.delete(f.path);
          this.refreshPath(f.path);
        }
      }),
    );
    this.plugin.registerEvent(
      app.vault.on('rename', (_f, oldPath) => {
        this.docCache.delete(oldPath);
      }),
    );
    this.plugin.register(() => {
      for (const el of this.live) {
        el.querySelector('.hn-embed')?.remove();
        delete el.dataset.hnEmbed;
      }
      this.live.clear();
    });
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    window.requestAnimationFrame(() => {
      this.scheduled = false;
      this.scan(document.body);
      for (const el of [...this.live]) if (!el.isConnected) this.live.delete(el);
    });
  }

  private scan(root: HTMLElement, ctx?: MarkdownPostProcessorContext): void {
    const nodes = root.querySelectorAll<HTMLElement>('.internal-embed[src]');
    nodes.forEach((el) => {
      const src = el.getAttribute('src') ?? '';
      if (!SRC_RE.test(src)) return;
      // Obsidian may replace our content when it (re)loads the embed: re-mount if our node is gone
      const has = el.querySelector(':scope > .hn-embed');
      if (el.dataset.hnEmbed === 'mounted' && has) return;
      void this.mount(el, src, ctx?.sourcePath ?? this.sourcePathFor(el));
    });
  }

  private sourcePathFor(el: HTMLElement): string {
    let found = '';
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const v = leaf.view as unknown as { containerEl?: HTMLElement; file?: TFile };
      if (v.containerEl?.contains(el) && v.file) found = v.file.path;
    });
    return found || this.plugin.app.workspace.getActiveFile()?.path || '';
  }

  private resolve(src: string, sourcePath: string): TFile | null {
    const link = src.replace(/#.*$/, '');
    const f = this.plugin.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    return f instanceof TFile ? f : null;
  }

  private async loadDoc(file: TFile): Promise<{ doc: HandNoteDocument; geo: GeometryCache } | null> {
    const c = this.docCache.get(file.path);
    if (c && c.mtime === file.stat.mtime) return c;
    try {
      const text = await this.plugin.app.vault.cachedRead(file);
      const res = parseDocument(text);
      registerAssets(res.doc.assets);
      const entry = { mtime: file.stat.mtime, doc: res.doc, geo: new GeometryCache() };
      this.docCache.set(file.path, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private async mount(el: HTMLElement, src: string, sourcePath: string): Promise<void> {
    this.mounts++;
    el.dataset.hnEmbed = 'mounted';
    const file = this.resolve(src, sourcePath);
    if (!file) {
      el.dataset.hnEmbed = 'missing';
      return;
    }
    const data = await this.loadDoc(file);
    // Obsidian sets classes/children asynchronously; clear its generic file placeholder
    el.empty();
    el.addClass('hn-embed-host');
    const box = el.createDiv({ cls: 'hn-embed' });
    box.setAttr('role', 'button');
    box.setAttr('aria-label', `Open handwritten note ${file.basename}`);
    const open = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      void this.plugin.app.workspace.getLeaf(this.plugin.settings.embedOpensNewTab ? 'tab' : false).openFile(file);
    };
    box.addEventListener('click', open);
    // keep Obsidian's own embed click handling (which would open the raw file) out of the way
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    if (!data) {
      box.createDiv({ cls: 'hn-embed-error', text: `HandNote: could not read ${file.name}` });
      return;
    }
    const pagesEl = box.createDiv({ cls: 'hn-embed-pages' });
    const max = this.plugin.settings.embedMaxPages;
    const pages = max > 0 ? data.doc.pages.slice(0, max) : data.doc.pages;
    const width = Math.max(120, Math.min(el.clientWidth || el.parentElement?.clientWidth || 600, 1400));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const page of pages) {
      const canvas = pagesEl.createEl('canvas', { cls: 'hn-embed-page' });
      const scale = Math.min((width * dpr) / page.width, 2400 / page.width);
      renderPageToCanvas(canvas, page, data.geo, scale);
      canvas.style.aspectRatio = `${page.width} / ${page.height}`;
      if (page.items?.some((i) => i.type === 'image')) void preloadImages(page).then(() => renderPageToCanvas(canvas, page, data.geo, scale));
    }
    const more = data.doc.pages.length - pages.length;
    const footer = box.createDiv({ cls: 'hn-embed-footer' });
    footer.setText(`✒ ${file.basename}${more > 0 ? ` · +${more} more page${more > 1 ? 's' : ''}` : ''} · tap to edit`);
    this.mounted.set(el, { path: file.path, mtime: file.stat.mtime, width });
    this.live.add(el);
  }

  private refreshPath(path: string): void {
    for (const el of this.live) {
      const m = this.mounted.get(el);
      if (m && m.path === path && el.isConnected) {
        delete el.dataset.hnEmbed;
        const src = el.getAttribute('src') ?? '';
        void this.mount(el, src, this.sourcePathFor(el));
      }
    }
  }
}
