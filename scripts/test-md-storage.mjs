// Real annotation storage/rename code, with only Obsidian's filesystem and view shell replaced.
import esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
await mkdir('build/md-storage', { recursive: true });
const obsidian = `
export class TFile { constructor(path) { this.path = path; } }
export class TFolder { constructor(path) { this.path = path; } }
export class FileView {}
export class MarkdownView {}
export class Notice { constructor(message) {} }
export const editorInfoField = {};
`;
await esbuild.build({ stdin: { contents: `
export { InkFileStore } from './src/inkmd/ink-file';
export { MdInkManager } from './src/inkmd/md-ink-manager';
export { createDocument } from './src/document/model';
export { serializeDocument, parseDocument } from './src/document/codec';
export { TFile, TFolder, MarkdownView } from 'obsidian';`, resolveDir: process.cwd() },
  outfile: 'build/md-storage/module.mjs', bundle: true, format: 'esm', platform: 'node',
  plugins: [{ name: 'host-shell', setup(build) {
    build.onResolve({ filter: /plugin\/md-export$/ }, () => ({ path: 'export', namespace: 'export-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'export-stub' }, () => ({ contents: 'export function openMarkdownExport() {}' }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
    build.onResolve({ filter: /(?:plugin\/view|\.\/md-ink-layer)$/ }, () => ({ path: 'view', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === 'obsidian' ? obsidian : `
export class MdInkLayer {
 constructor(md,view,store){this.md=md;this.view=view;this.store=store;this.file=md.file;}
 setDocument(doc,ro){this.doc=doc;this.ro=ro;} setStatus(){} refreshAnchors(){}
 get hasUnsavedChanges(){return this.store.hasUnsavedChanges;}
 async flush(){await this.store.flush();} async close(){await this.store.dispose();}
} export class RecoveryModal { open() {} }
export const countStrokes = d => d.pages.reduce((n,p) => n+p.strokes.length,0);
export const peekRevision = s => s ? JSON.parse(s.split('\\n')[0].replace(/,\\s*$/, '') + '}').revision ?? 0 : 0;` }));
  } }], logLevel: 'silent' });
const { InkFileStore, MdInkManager, createDocument, serializeDocument, parseDocument, TFile, TFolder, MarkdownView } = await import('../build/md-storage/module.mjs');
globalThis.window = globalThis;

function fixture() {
  const files = new Map(), text = new Map(), events = new Map();
  const vault = {
    getAbstractFileByPath: path => files.get(path) ?? null,
    getFiles: () => [...files.values()].filter(f => f instanceof TFile),
    on(name, fn) { events.set(name, [...(events.get(name) ?? []), fn]); return {}; },
    async create(path, data) { assert.ok(!files.has(path), `must not overwrite ${path}`); const f = new TFile(path); files.set(path, f); text.set(path, data); return f; },
    async createFolder(path) { assert.ok(!files.has(path)); const f = new TFolder(path); files.set(path, f); return f; },
    async process(file, fn) { text.set(file.path, fn(text.get(file.path))); },
    async rename(file, to) {
      assert.ok(!files.has(to), `must not overwrite ${to}`);
      const old = file.path;
      for (const [path, f] of [...files]) if (path === old || (file instanceof TFolder && path.startsWith(old + '/'))) {
        const next = to + path.slice(old.length); files.delete(path); f.path = next; files.set(next, f);
        if (text.has(path)) { text.set(next, text.get(path)); text.delete(path); }
      }
      for (const fn of events.get('rename') ?? []) fn(file, old);
    },
  };
  vault.adapter = { exists: async p => files.has(p), read: async p => { if (!text.has(p)) throw Error('missing'); return text.get(p); }, rename: async (a,b) => vault.rename(files.get(a),b) };
  const app = { vault, workspace: { onLayoutReady() {}, on() {}, getLeavesOfType: () => [] } };
  const recovery = { async backup() {}, async clearJournal() {}, async readJournal() { return null; }, async writeJournal() {} };
  const store = md => new InkFileStore(app, recovery, () => 'test-device', md, { status() {}, beforeSave() {}, reloaded() {} });
  const manager = new MdInkManager({ app, recovery, settings: { deviceId: 'test', editor: {} }, manifest: { version: 'test' }, registerEditorExtension() {}, registerEvent() {}, addTranslatedCommand() {}, registerView() {}, register() {} });
  manager.start();
  return { files, text, vault, store, manager };
}
function ink(md) { const doc = createDocument(); doc.annotates = md; return serializeDocument(doc); }

test('new annotations are beside Markdown and do not change Markdown text', async () => {
  const f = fixture(); await f.vault.create('Notes/a.md', '# Original');
  const s = f.store('Notes/a.md'); await s.load(); s.markDirty(); await s.flush();
  assert.ok(f.files.has('Notes/a.md.handnote')); assert.equal(f.text.get('Notes/a.md'), '# Original');
  assert.equal(parseDocument(f.text.get(s.path)).doc.annotates, 'Notes/a.md'); await s.dispose();
});
test('legacy annotations migrate byte-for-byte on first open', async () => {
  const f = fixture(), content = ink('Notes/a.md'); await f.vault.create('Notes/a.md', '# Original');
  await f.vault.create('HandNote annotations/Notes/a.handnote', content);
  const s = f.store('Notes/a.md'); assert.ok(await s.load());
  assert.equal(s.path, 'Notes/a.md.handnote'); assert.equal(f.text.get(s.path), content);
  assert.ok(!f.files.has('HandNote annotations/Notes/a.handnote')); await s.dispose();
});
test('a normal HandNote at the destination is never opened as Markdown ink or overwritten', async () => {
  const f = fixture(), ordinary = serializeDocument(createDocument());
  await f.vault.create('a.md.handnote', ordinary); await f.vault.create('HandNote annotations/a.handnote', ink('a.md'));
  assert.equal(await f.store('a.md').load(), null); assert.equal(f.text.get('a.md.handnote'), ordinary);
  assert.ok(f.files.has('HandNote annotations/a.handnote'));
});
test('Markdown file rename moves annotations and updates only the header', async () => {
  const f = fixture(), content = ink('a.md'); const md = await f.vault.create('a.md', 'original');
  await f.vault.create('a.md.handnote', content); await f.vault.rename(md, 'b.md'); await f.manager.renameQueue;
  assert.ok(!f.files.has('a.md.handnote')); const result = f.text.get('b.md.handnote');
  assert.equal(parseDocument(result).doc.annotates, 'b.md'); assert.equal(result.slice(result.indexOf('\n')), content.slice(content.indexOf('\n')));
});
test('folder rename keeps colocated annotations and follows legacy annotations', async () => {
  const f = fixture(); const folder = await f.vault.createFolder('Old');
  await f.vault.create('Old/a.md', 'a'); await f.vault.create('Old/a.md.handnote', ink('Old/a.md'));
  await f.vault.create('Old/b.md', 'b'); await f.vault.create('HandNote annotations/Old/b.handnote', ink('Old/b.md'));
  await f.vault.rename(folder, 'New'); await f.manager.renameQueue;
  for (const name of ['a','b']) assert.equal(parseDocument(f.text.get(`New/${name}.md.handnote`)).doc.annotates, `New/${name}.md`);
  assert.ok(![...f.files.keys()].some(p => p.startsWith('Old/')));
});
test('open dirty annotations follow a folder rename without recreating its old path', async () => {
  const f = fixture(), folder = await f.vault.createFolder('Old'), md = await f.vault.create('Old/a.md', 'a');
  await f.vault.create('Old/a.md.handnote', ink('Old/a.md')); const s = f.store('Old/a.md'); await s.load(); s.markDirty();
  f.manager.layers.set({}, { file: md, get storePath() { return s.path; }, moved: (md,p) => s.moved(md,p), flush: () => s.flush() });
  await f.vault.rename(folder, 'New'); await f.manager.renameQueue;
  assert.equal(s.path, 'New/a.md.handnote'); assert.equal(parseDocument(f.text.get(s.path)).doc.annotates, 'New/a.md');
  assert.ok(![...f.files.keys()].some(p => p === 'Old' || p.startsWith('Old/'))); await s.dispose();
});
test('rename collision keeps both annotation files intact', async () => {
  const f = fixture(), old = ink('a.md'), other = ink('b.md');
  const md = await f.vault.create('a.md', 'a'); await f.vault.create('a.md.handnote', old); await f.vault.create('b.md.handnote', other);
  await f.vault.rename(md, 'b.md'); await f.manager.renameQueue;
  assert.equal(f.text.get('a.md.handnote'), old); assert.equal(f.text.get('b.md.handnote'), other);
});


test('public MD tab ownership: first tab keeps writing, second tab is read-only',async()=>{
  const f=fixture();const file=await f.vault.create('Notes/shared.md','# original');
  const md=()=>Object.assign(new MarkdownView(),{file,getMode:()=> 'source'});
  const a=md(),b=md(),ea={},eb={};f.manager.editorViewOf=v=>v===a?ea:eb;
  await f.manager.toggle(a);const first=f.manager.layers.get(ea);first.store.doc.pages[0].width=812;first.store.markDirty();
  await first.flush();await f.manager.toggle(b);assert.equal(f.manager.layers.size,2);assert.equal(first.ro,false);
  const second=f.manager.layers.get(eb);assert.equal(second.ro,true);assert.equal(second.doc.pages[0].width,812);
  assert.equal(a.file,file);assert.equal(b.file,file);assert.equal(f.text.get(file.path),'# original');await f.manager.close(eb);await f.manager.close(ea);
});

test('simultaneous annotation opens are serialized into one writer',async()=>{
  const f=fixture();const file=await f.vault.create('a.md','text');
  const a=Object.assign(new MarkdownView(),{file,getMode:()=> 'source'}),b=Object.assign(new MarkdownView(),{file,getMode:()=> 'source'});
  const ea={},eb={};f.manager.editorViewOf=v=>v===a?ea:eb;
  await Promise.all([f.manager.toggle(a),f.manager.toggle(b)]);assert.equal(f.manager.layers.size,2);assert.equal(f.manager.layers.get(ea).ro,false);assert.equal(f.manager.layers.get(eb).ro,true);await f.manager.close(eb);await f.manager.close(ea);
});
