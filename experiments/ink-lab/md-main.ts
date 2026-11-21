/** Standalone integration harness: real CodeMirror + the production Markdown ink layer. */
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MdInkLayer } from '../../src/inkmd/md-ink-layer';
import { createDocument, defaultBackground } from '../../src/document/model';
import { defaultEditorSettings } from '../../src/editor/settings';
import { exportMarkdown } from '../../src/plugin/md-export';
import { renderEmbedPage } from '../../src/plugin/embed-page';
import { GeometryCache } from '../../src/document/geometry-cache';
import { registerAssets } from '../../src/rendering/items-paint';
import { renderPageToCanvas } from '../../src/rendering/paint';
import { registerSources, setDocRenderer } from '../../src/rendering/doc-layer';

const proto = HTMLElement.prototype as any;
proto.addClass = function (...names: string[]) { this.classList.add(...names); };
proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
proto.hasClass = function (name: string) { return this.classList.contains(name); };
proto.toggleClass = function (name: string, value: boolean) { this.classList.toggle(name, value); };
proto.empty = function () { this.replaceChildren(); };
proto.createEl = function (tag: string, options: any = {}) {
  const element = document.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.append(element); return element;
};
proto.createDiv = function (options: any = {}) { return this.createEl('div', options); };
proto.createSpan = function (options: any = {}) { return this.createEl('span', options); };
Object.assign(globalThis, { createDiv: (options: any = {}) => {
  const element = document.createElement('div'); element.className = options.cls ?? ''; return element;
} });

const content = document.querySelector<HTMLElement>('#md')!;
const editorParent = content.createDiv({ cls: 'markdown-source-view' });
editorParent.classList.add('hn-lab-editor');
const compartment = new Compartment();
const view = new EditorView({ parent: editorParent, state: EditorState.create({
  doc: Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行 Markdown — Pencil writing test`).join('\n'),
  extensions: [compartment.of([]), EditorView.lineWrapping, EditorView.theme({ '&': { height: '600px' }, '.cm-scroller': { overflow: 'auto' }, '.cm-content': { padding: '20px', fontSize: '20px' } })],
}) });
// Obsidian's sizer sits inside the scroller, not outside the whole EditorView.
const sizer = document.createElement('div'); sizer.className = 'cm-sizer';
view.contentDOM.before(sizer); sizer.append(view.contentDOM);
const file = { path: 'Notes/Test.md' };
const doc = createDocument({ width: 700, height: 3000, background: defaultBackground('blank') });
const settings = defaultEditorSettings();
const store = { doc, path: 'Notes/Test.md.handnote', readOnly: false, disposed: false, markDirty() {}, async flush() {}, async dispose() { this.disposed = true; } };
const md = { file, contentEl: content, getMode: () => 'source' };
const layer = new MdInkLayer(md as any, view, store as any, {
  version: 'test', settings: () => settings, settingsChanged() {}, exit() { void layer.close(); },
}, compartment);
layer.setDocument(doc, false);
view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => layer.update(update))) });
Object.assign(window, { __md: { layer, view, settings, store, exportMarkdown, embed: { renderEmbedPage, renderPageToCanvas, GeometryCache, registerAssets, registerSources, setDocRenderer, createDocument, defaultBackground } } });
