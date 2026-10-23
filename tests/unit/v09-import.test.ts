// 0.9 document import: format detection, the v6 file format, the page renderer cache.
import { test } from 'node:test';
// the page cache schedules its "zoom settled" repaint with window.setTimeout (as in the app)
(globalThis as unknown as { window?: unknown }).window ??= globalThis;
import assert from 'node:assert/strict';
import { LIMITS, describeBytes, detectFormat, sha256Hex, zipEntries } from '../../src/import/detect';
import { documentPages, makeSource } from '../../src/import/pages';
import { openPdf, pdfPageSizes, type PdfJsLib } from '../../src/import/pdf';
import { parseDocument, recoverDocument, requiredVersion, serializeDocument, validateSource } from '../../src/document/codec';
import { writeCfb } from './ooxml-helpers';
import { createDocument, createPage, defaultBackground, type DocSource, type Page } from '../../src/document/model';
import {
  DocError,
  bucketFor,
  clearDocCache,
  docCacheStats,
  docFailure,
  docPageImage,
  ensureDocPage,
  onDocLayerReady,
  registerSources,
  SETTLE_MS,
  setDocCacheBudget,
  setDocRenderer,
  type DocPageRenderer,
} from '../../src/rendering/doc-layer';

// ---- a tiny ZIP writer (stored entries) for the detection tests ----
function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function zip(files: Record<string, string>, opts: { fakeSize?: number } = {}): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = enc.encode(text);
    const crc = crc32(d);
    const lh = new Uint8Array(30 + n.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, d.length, true);
    lv.setUint32(22, d.length, true);
    lv.setUint16(26, n.length, true);
    lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, d.length, true);
    cv.setUint32(24, opts.fakeSize ?? d.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, off, true);
    ch.set(n, 46);
    locals.push(lh, d);
    central.push(ch);
    off += lh.length + d.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, off, true);
  const all = [...locals, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}
const CT = (main: string) => `<?xml version="1.0"?><Types><Override PartName="/x" ContentType="application/vnd.${main}"/></Types>`;
const readStored = (b: Uint8Array) => async (e: { offset: number; compressed: number }) => {
  const dv = new DataView(b.buffer, b.byteOffset);
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  return new TextDecoder().decode(b.subarray(start, start + e.compressed));
};

test('detect: PDF by its header, not by its name', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
  assert.equal((await detectFormat(pdf, 'notes.docx')).kind, 'pdf');
  assert.equal((await detectFormat(new TextEncoder().encode('hello'), 'fake.pdf')).kind, 'unknown');
  assert.match((await detectFormat(new Uint8Array(0), 'x.pdf')).problem ?? '', /empty/);
});

test('detect: DOCX / PPTX / XLSX from the main part and its content type; macros and plain ZIPs refused', async () => {
  const docx = zip({ '[Content_Types].xml': CT('openxmlformats-officedocument.wordprocessingml.document.main+xml'), 'word/document.xml': '<w:document/>' });
  assert.equal((await detectFormat(docx, 'a.bin', readStored(docx))).kind, 'docx');
  const pptx = zip({ '[Content_Types].xml': CT('openxmlformats-officedocument.presentationml.presentation.main+xml'), 'ppt/presentation.xml': '<p/>' });
  assert.equal((await detectFormat(pptx, 'a.pptx', readStored(pptx))).kind, 'pptx');
  const xlsx = zip({ '[Content_Types].xml': CT('openxmlformats-officedocument.spreadsheetml.sheet.main+xml'), 'xl/workbook.xml': '<w/>' });
  assert.equal((await detectFormat(xlsx, 'a.xlsx', readStored(xlsx))).kind, 'xlsx');
  const xlsm = zip({ '[Content_Types].xml': CT('ms-excel.sheet.macroEnabled.main+xml'), 'xl/workbook.xml': '<w/>' });
  const m = await detectFormat(xlsm, 'a.xlsx', readStored(xlsm));
  assert.equal(m.kind, 'macro-office');
  assert.match(m.problem ?? '', /macro/);
  const plain = zip({ 'readme.txt': 'hi' });
  assert.equal((await detectFormat(plain, 'a.docx', readStored(plain))).kind, 'zip');
  // a docx name with the wrong content type is not taken on trust
  const liar = zip({ '[Content_Types].xml': CT('something.else'), 'word/document.xml': '<w/>' });
  assert.equal((await detectFormat(liar, 'a.docx', readStored(liar))).kind, 'zip');
});

test('detect: legacy binary Office is recognised and refused with a way out', async () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
  const d = await detectFormat(ole, 'old.doc');
  assert.equal(d.kind, 'legacy-office');
  assert.match(d.problem ?? '', /PDF/);
});

test('detect: ZIP bombs, damaged directories and oversize files are refused before inflating', async () => {
  const bomb = zip({ '[Content_Types].xml': 'x', 'word/document.xml': 'y' }, { fakeSize: 500 * 1024 * 1024 });
  assert.throws(() => zipEntries(bomb), /ratio|1 GB/);
  const broken = zip({ 'a.txt': 'x' }).slice(0, 40);
  assert.throws(() => zipEntries(broken), /ZIP/);
  const big = { length: LIMITS.maxFile + 1 } as unknown as Uint8Array;
  assert.match((await detectFormat(big, 'big.pdf')).problem ?? '', /larger/);
});

test('sha256Hex matches the reference digest', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

const source = (over: Partial<DocSource> = {}): DocSource => ({ ...makeSource('pdf', 'Attachments/Lecture 3.pdf', 1234, 'a'.repeat(64), 3), ...over });

test('v6 format: document pages and sources round-trip; files without them stay v1–5', () => {
  const doc = createDocument({ pages: 1 });
  assert.ok(requiredVersion(doc) <= 5);
  const s = source();
  doc.pages = documentPages(s, [
    { width: 595, height: 842 },
    { width: 842, height: 595 },
  ]);
  doc.sources = { [s.id]: s, unused: { ...s, id: 'unused' } };
  assert.equal(requiredVersion(doc), 6);
  const text = serializeDocument(doc);
  assert.match(text.split('\n')[0], /"version":6.*"sources"/, 'sources are in the header line');
  assert.ok(!text.includes('"unused"'), 'unreferenced sources are not written');
  const back = parseDocument(text);
  assert.equal(back.readOnly, false);
  assert.deepEqual(back.doc.pages.map((p) => p.doc), [{ src: s.id, n: 1 }, { src: s.id, n: 2 }]);
  assert.equal(back.doc.pages[1].width, 842);
  assert.deepEqual(back.doc.sources?.[s.id], s);
  // the file is damaged after the header: line recovery keeps the pages, their documents and sources
  const lines = text.split('\n');
  const damaged = lines.slice(0, lines.length - 3).join('\n') + '\n{"id":"broken';
  const rec = recoverDocument(damaged);
  assert.ok(rec);
  assert.equal(rec?.doc.pages[0].doc?.src, s.id);
  assert.equal(rec?.doc.sources?.[s.id]?.path, s.path);
});

test('v6 format: hostile or malformed references are dropped, never trusted', () => {
  const w: string[] = [];
  assert.equal(validateSource({ id: '../x', kind: 'pdf', path: 'a.pdf' }, w), null);
  assert.equal(validateSource({ id: 'ok', kind: 'exe', path: 'a.exe' }, w), null);
  assert.equal(validateSource({ id: 'ok', kind: 'pdf', path: '' }, w), null);
  const v = validateSource({ id: 'ok', kind: 'pdf', path: 'a.pdf', sha256: 'NOT-HEX', size: -5 }, w);
  assert.equal(v?.sha256, '');
  assert.equal(v?.size, 0);
  const doc = createDocument({ pages: 1 });
  const text = serializeDocument(doc).replace('"strokes":[', '"doc":{"src":"x","n":-1},"strokes":[');
  assert.equal(parseDocument(text).doc.pages[0].doc, undefined, 'page number < 1 dropped');
});

test('v6 format: a v6 note opens read-only in a version that reads only up to 5 (0.8 behaviour)', () => {
  // 0.8.x has FORMAT_VERSION 5: version > 5 → read-only (simulated with a v7 file here)
  const doc = createDocument({ pages: 1 });
  const s = source();
  doc.pages = documentPages(s, [{ width: 595, height: 842 }]);
  doc.sources = { [s.id]: s };
  const v7 = serializeDocument(doc).replace('"version":6', '"version":7');
  assert.equal(parseDocument(v7).readOnly, true);
});

// ---- page renderer cache ----

class FakeRenderer implements DocPageRenderer {
  calls: string[] = [];
  fail: DocError | null = null;
  async render(src: DocSource, n: number, w: number, h: number) {
    this.calls.push(`${src.id}:${n}:${w}x${h}`);
    if (this.fail) throw this.fail;
    return { image: {} as CanvasImageSource, width: w, height: h };
  }
}
const tickMs = () => new Promise((r) => setTimeout(r, 5));

test('page cache: renders on demand at a zoom bucket, newest first, repaint event, budget eviction', async () => {
  clearDocCache();
  const r = new FakeRenderer();
  setDocRenderer(r);
  setDocCacheBudget(24_000_000);
  const s = source({ id: 'srcA' });
  registerSources({ [s.id]: s });
  let ready = 0;
  const off = onDocLayerReady(() => ready++);
  assert.equal(docPageImage('srcA', 1, 595, 842, 2), null, 'nothing cached yet');
  await tickMs();
  assert.deepEqual(r.calls, ['srcA:1:1190x1684']);
  assert.equal(ready, 1);
  assert.ok(docPageImage('srcA', 1, 595, 842, 2), 'cached now');
  // zooming in asks for a sharper bucket but shows the cached one meanwhile; the sharper one is
  // rendered only once the zoom has settled (the repaint event asks again)
  const ready0 = ready;
  assert.ok(docPageImage('srcA', 1, 595, 842, 3.2));
  await tickMs();
  assert.equal(r.calls.length, 1, 'nothing rendered while the zoom is still changing');
  await new Promise((res) => setTimeout(res, SETTLE_MS + 60));
  assert.ok(ready > ready0, 'a repaint is requested when the zoom settled');
  assert.ok(docPageImage('srcA', 1, 595, 842, 3.2));
  await tickMs();
  assert.equal(r.calls[1], 'srcA:1:2380x3368');
  const st = docCacheStats();
  assert.ok(st.pixels <= st.budget, JSON.stringify(st));
  // a small budget: one page on screen may use at most 60 % of it, so the zoom bucket is capped
  setDocCacheBudget(4_000_000);
  assert.ok(docPageImage('srcA', 1, 595, 842, 3.2));
  await new Promise((res) => setTimeout(res, SETTLE_MS + 60));
  docPageImage('srcA', 1, 595, 842, 3.2);
  await tickMs();
  assert.equal(r.calls.length, 2, 'no 8 MP rendering for a 4 MP budget');
  off();
  setDocRenderer(null);
});

test('page cache: pinch zooming never drops on-screen pages back to the placeholder (no flicker)', async () => {
  clearDocCache();
  const r = new FakeRenderer();
  setDocRenderer(r);
  setDocCacheBudget(24_000_000);
  const s = source({ id: 'srcZ' });
  registerSources({ [s.id]: s });
  // three slides on screen, rendered once
  for (const n of [1, 2, 3]) docPageImage('srcZ', n, 960, 540, 1);
  for (let i = 0; i < 4; i++) await tickMs();
  for (const n of [1, 2, 3]) assert.ok(docPageImage('srcZ', n, 960, 540, 1), `slide ${n} cached`);
  // a pinch: the zoom changes every frame; every frame must still have a picture for every slide
  const calls0 = r.calls.length;
  for (let f = 0; f < 30; f++) {
    const z = 1 + f * 0.25;
    for (const n of [1, 2, 3]) assert.ok(docPageImage('srcZ', n, 960, 540, z), `slide ${n} shown in frame ${f}`);
    await tickMs();
  }
  assert.equal(r.calls.length, calls0, 'no rendering while pinching');
  // settled: sharper renderings come in, still never an empty frame, and the cache stays in budget
  await new Promise((res) => setTimeout(res, SETTLE_MS + 60));
  for (let k = 0; k < 8; k++) {
    for (const n of [1, 2, 3]) assert.ok(docPageImage('srcZ', n, 960, 540, 8.25), `slide ${n} shown after settling`);
    await tickMs();
  }
  assert.ok(r.calls.length > calls0, 'sharper renderings after the zoom settled');
  const st = docCacheStats();
  assert.ok(st.pixels <= st.budget, JSON.stringify(st));
  setDocRenderer(null);
});

test('page cache: a missing file shows its reason on every page and is not retried in a loop', async () => {
  clearDocCache();
  const r = new FakeRenderer();
  r.fail = new DocError('missing', 'Lecture 3.pdf not found');
  setDocRenderer(r);
  const s = source({ id: 'srcB' });
  registerSources({ [s.id]: s });
  docPageImage('srcB', 1, 595, 842, 1);
  await tickMs();
  assert.equal(docFailure('srcB', 2)?.code, 'missing', 'whole file');
  docPageImage('srcB', 2, 595, 842, 1);
  docPageImage('srcB', 3, 595, 842, 1);
  await tickMs();
  assert.equal(r.calls.length, 1, 'no render attempts after the file is known missing');
  // relinking the source (new path) forgets the failure
  registerSources({ srcB: { ...s, path: 'Moved/Lecture 3.pdf' } });
  assert.equal(docFailure('srcB'), undefined);
  setDocRenderer(null);
});

test('ensureDocPage renders synchronously for exports; bucketFor caps the size', async () => {
  clearDocCache();
  const r = new FakeRenderer();
  setDocRenderer(r);
  const s = source({ id: 'srcC' });
  registerSources({ [s.id]: s });
  const page: Page = { ...createPage(595, 842, defaultBackground('blank')), doc: { src: 'srcC', n: 2 } };
  assert.equal(await ensureDocPage(page, 3), true);
  assert.equal(r.calls[0], 'srcC:2:2380x3368');
  assert.equal(bucketFor(1, 595, 842), 1);
  assert.equal(bucketFor(1.01, 595, 842), 2);
  assert.equal(bucketFor(20, 595, 842), 4, 'longest side ≤ 4096 px');
  assert.equal(bucketFor(0.1, 595, 842), 0.5);
  setDocRenderer(null);
});

test('PDF: password / damaged files map to clear errors; page sizes follow rotation and are capped', async () => {
  const lib = (fail?: string): PdfJsLib => ({
    getDocument: () => ({
      promise: fail
        ? Promise.reject(Object.assign(new Error('x'), { name: fail }))
        : Promise.resolve({
            numPages: 3,
            destroy: () => undefined,
            getPage: async (n: number) => ({
              getViewport: () => (n === 2 ? { width: 842, height: 595 } : { width: 595, height: 99999 }),
              render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
            }),
          }),
    }),
  });
  await assert.rejects(openPdf(lib('PasswordException'), new Uint8Array(1)), (e: DocError) => e.code === 'unsupported' && /password/.test(e.message));
  await assert.rejects(openPdf(lib('InvalidPDFException'), new Uint8Array(1)), (e: DocError) => e.code === 'damaged');
  const doc = await openPdf(lib(), new Uint8Array(1));
  const progress: number[] = [];
  const sizes = await pdfPageSizes(doc, (d) => progress.push(d));
  assert.deepEqual(sizes[1], { width: 842, height: 595 });
  assert.equal(sizes[0].height, 14400, 'absurd page sizes capped');
  assert.deepEqual(progress, [3]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(pdfPageSizes(doc, undefined, ac.signal), /cancelled/);
});

test('detect: content that is not a document is named precisely (iPad cloud files, wrong extensions)', async () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const why = async (b: Uint8Array, name: string) => (await detectFormat(b, name, async () => '')).problem ?? '';
  assert.match(await why(enc('<!DOCTYPE html><html><head><title>Sign in</title>'), 'Report.docx'), /web page \(HTML\).*named \.docx/);
  assert.match(await why(enc('﻿  <html>'), 'x.pdf'), /web page/);
  assert.match(await why(enc('{"url": "https://docs.google.com/document/d/abc", "doc_id": "abc"}'), 'Notes.gdoc'), /cloud shortcut/);
  assert.match(await why(enc('{\\rtf1\\ansi hello}'), 'a.doc'), /Rich Text/);
  assert.match(await why(enc('MIME-Version: 1.0\r\nContent-Type: multipart/related'), 'a.doc'), /MHTML/);
  assert.match(await why(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]), 'scan.pdf'), /picture/);
  assert.match(await why(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0]), 'IMG.pdf'), /picture/);
  assert.match(await why(enc('just some notes\nline two'), 'notes.docx'), /plain text/);
  assert.match(await why(new Uint8Array([1, 2, 3, 250, 0, 7]), 'blob.pptx'), /not a PDF, Word.*named \.pptx/);
  assert.match(await why(new Uint8Array(0), 'empty.pdf'), /empty/);
  assert.match(await why(zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<x/>' }), 'a.odt'), /OpenDocument document/);
  assert.match(await why(zip({ 'Index/Document.iwa': 'x', 'Metadata/Properties.plist': 'x' }), 'Talk.key'), /Pages \/ Keynote \/ Numbers/);
  assert.match(await why(writeCfb({ Workbook: new Uint8Array(8) }), 'old.xls'), /Excel 97–2003/);
  assert.match(await why(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'broken.doc'), /damaged Office file/);
  assert.equal(describeBytes(enc('%PDX-1.4 hello'), 'a.pdf'), 'a.pdf: 14 bytes; starts with 25 50 44 58 2d 31 2e 34 20 68 65 6c 6c 6f  "%PDX-1.4 hello"');
});
