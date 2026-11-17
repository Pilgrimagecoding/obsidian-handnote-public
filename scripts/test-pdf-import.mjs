// Exercises the real DocumentImporter with an in-memory vault and a transferring PDF worker.
// Does not open or modify the user's Obsidian vault. Run: node scripts/test-pdf-import.mjs
import esbuild from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.window = globalThis;
const stub = `
class El { setText(text){globalThis.__pdfTest.messages.push(text)} empty(){} addEventListener(){} createEl(tag,opts){if(opts?.text)this.setText(opts.text);return new El()} createDiv(){return new El()} }
export class Modal { constructor(){this.contentEl=new El();this.titleEl=new El()} open(){this.onOpen?.()} close(){this.onClose?.()} }
export class FuzzySuggestModal extends Modal {}
export class Notice { constructor(text){globalThis.__pdfTest.notices.push(text)} }
export class TFile { constructor(path,data){this.path=path;this.name=path.split('/').pop();this.extension=path.split('.').pop();this.stat={size:data.byteLength};this.data=data;} }
export const Platform={isMobile:true};
export const normalizePath=(s)=>s;
export const loadPdfJs=async()=>globalThis.__pdfTest.lib;
`;
mkdirSync('build/pdf-flow', { recursive: true });
await esbuild.build({
  stdin: { contents: "export { DocumentImporter } from './src/plugin/import'; export { TFile } from 'obsidian';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, outfile: 'build/pdf-flow/importer.mjs', format: 'esm', platform: 'browser', define: { __HN_PRIVATE__: 'false' },
  plugins: [{ name: 'fake-obsidian', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'fake' }));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: stub }));
  } }],
});
const { DocumentImporter, TFile } = await import(pathToFileURL(path.resolve('build/pdf-flow/importer.mjs')).href);
const original = new Uint8Array(readFileSync('tests/fixtures/import/sample-3pages.pdf'));

function setup({ pages = 3, failNote = false, failPdf = false } = {}) {
  const files = new Map();
  const state = { notices: [], messages: [], writes: 0, reads: 0, destroyed: 0, active: 0, maxActive: 0, notes: [], trashed: [] };
  globalThis.__pdfTest = state;
  state.lib = { getDocument: ({ data }) => {
    const transferred = structuredClone(data, { transfer: [data.buffer] });
    assert.deepEqual(transferred, original);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const destroy = async () => { await new Promise((r) => setTimeout(r, 2)); state.destroyed++; state.active--; };
    const pdf = {
      numPages: pages, destroy,
      getPage: async () => ({ getViewport: () => ({ width: 595, height: 842 }), cleanup() {} }),
    };
    return { promise: failPdf ? Promise.reject(Object.assign(new Error('bad PDF'), { name: 'InvalidPDFException' })) : Promise.resolve(pdf), destroy };
  } };
  const vault = {
    on() {}, getFiles: () => [...files.values()], getAbstractFileByPath: (p) => files.get(p),
    readBinary: async (f) => { state.reads++; return f.data.slice().buffer; },
    createBinary: async (p, data) => {
      assert.equal(state.active, 0, 'PDF inspection worker must already be released');
      assert.deepEqual(new Uint8Array(data), original, 'stored bytes survived the original buffer transfer');
      const f = new TFile(p, new Uint8Array(data.slice(0)));
      files.set(p, f); state.writes++; return f;
    },
    create: async (p, text) => {
      if (failNote) throw new Error('simulated disk failure');
      state.notes.push(JSON.parse(text)); return { path: p };
    },
  };
  const app = {
    vault,
    fileManager: {
      getAvailablePathForAttachment: async (name) => name,
      trashFile: async (f) => { state.trashed.push(f.path); files.delete(f.path); },
    },
    workspace: { getLeaf: () => ({ openFile: async () => { assert.equal(state.active, 0); } }) },
  };
  const plugin = { app, settings: { deviceId: 'test', importFolder: '' }, register() {}, registerEvent() {}, views: () => [], ensureFolderOf: async () => {}, newNotePath: (n) => `${n}.handnote` };
  return { importer: new DocumentImporter(plugin), state, files };
}
const picked = () => ({ file: new File([original], 'sample.pdf') });

test('400 MiB placeholder: reads only 2 KiB, explains empty header, never loads PDF.js or writes files', async () => {
  const { importer, state } = setup();
  const slices = [];
  const file = { name: 'test_400mb.pdf', size: 400 * 1024 * 1024, slice(start, end) {
    slices.push([start, end]);
    assert.ok(end <= 2048, 'must reject before reading the whole placeholder');
    return new Blob([new Uint8Array(end - start)]);
  } };
  assert.equal(await importer.run({ file }, null), null);
  assert.deepEqual(slices, [[0, 2048]]);
  assert.match(state.messages.join('\n'), /zero bytes|空数据/);
  assert.match(state.messages.join('\n'), /419430400 bytes \(first 2048 bytes checked\)/);
  assert.doesNotMatch(state.messages.join('\n'), /200 MB/);
  assert.equal(state.writes, 0);
  assert.equal(state.notes.length, 0);
  assert.equal(state.maxActive, 0);
});

test('header preflight preserves PDF content detection regardless of filename', async () => {
  const { importer, state } = setup();
  assert.equal((await importer.run({ file: new File([original], 'misnamed.docx') }, null)).count, 3);
  assert.equal(state.notes[0].sources[0].path, 'misnamed.pdf');
});

test('incomplete header read reports a read failure without loading or storing the source', async () => {
  const { importer, state } = setup();
  const slices = [];
  const file = { name: 'download.pdf', size: 400 * 1024 * 1024, slice(start, end) {
    slices.push([start, end]);
    return new Blob([new Uint8Array(10)]);
  } };
  assert.equal(await importer.run({ file }, null), null);
  assert.deepEqual(slices, [[0, 2048]]);
  assert.match(state.messages.join('\n'), /incomplete file read/);
  assert.doesNotMatch(state.messages.join('\n'), /zero bytes|空数据/);
  assert.equal(state.writes, 0);
  assert.equal(state.maxActive, 0);
});

test('device PDF: transfer → destroy → reread/store, preserving size/hash and every one of 2001 pages', async () => {
  const { importer, state } = setup({ pages: 2001 });
  assert.equal((await importer.run(picked(), null)).count, 2001);
  assert.equal(state.writes, 1);
  assert.equal(state.destroyed, 1);
  const note = state.notes[0];
  assert.equal(note.pages.length, 2001);
  assert.equal(note.pages.at(-1).doc.n, 2001);
  assert.equal(note.sources[0].size, original.byteLength);
  assert.equal(note.sources[0].sha256, createHash('sha256').update(original).digest('hex'));
});

test('vault and duplicate device PDFs reuse the existing original without writing an empty transferred buffer', async () => {
  const { importer, state, files } = setup();
  const f = new TFile('original.pdf', original);
  files.set(f.path, f);
  assert.equal((await importer.run({ vault: f }, null)).count, 3);
  assert.equal((await importer.run(picked(), null)).count, 3);
  assert.equal(state.writes, 0);
  assert.equal(state.notes[1].sources[0].path, f.path);
  assert.equal(f.data.byteLength, original.byteLength);
});

test('page overflow and invalid PDFs fail before creating a stored original or note', async () => {
  for (const opts of [{ pages: 10001 }, { failPdf: true }]) {
    const { importer, state } = setup(opts);
    assert.equal(await importer.run(picked(), null), null);
    assert.equal(state.writes, 0);
    assert.equal(state.notes.length, 0);
    assert.equal(state.destroyed, 1);
  }
});

test('failure after storing rolls back only the new copy', async () => {
  const { importer, state, files } = setup({ failNote: true });
  const keep = new TFile('unrelated.pdf', new Uint8Array([1]));
  files.set(keep.path, keep);
  assert.equal(await importer.run(picked(), null), null);
  assert.deepEqual(state.trashed, ['sample.pdf']);
  assert.ok(files.has(keep.path));
});

test('simultaneous import commands are serialized', async () => {
  const { importer, state } = setup();
  await Promise.all([importer.run(picked(), null), importer.run(picked(), null)]);
  assert.equal(state.maxActive, 1);
  assert.equal(state.notes.length, 2);
  assert.equal(state.writes, 1);
});
