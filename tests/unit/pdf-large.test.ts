import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IMPORT_HEADER_BYTES, LIMITS, describeBytes, detectFormat, detectHeader, sha256Hex } from '../../src/import/detect';
import { PdfPageLimitError, inspectPdf, openPdf, pdfPageSizes, type PdfDocument, type PdfJsLib } from '../../src/import/pdf';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fakePdf = (numPages: number, cleanup = () => {}): PdfDocument => ({
  numPages,
  getPage: async (n) => ({
    getViewport: () => ({ width: n % 2 ? 595 : 842, height: n % 2 ? 842 : 595 }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    cleanup,
  }),
  destroy() {},
});

test('large PDF: 512 MiB boundary is inclusive, based on bytes rather than extension; Office stays at 200 MiB', async () => {
  const head = new TextEncoder().encode('%PDF-1.7\n');
  for (const n of [LIMITS.maxFile + 1, LIMITS.maxPdfFile]) {
    assert.equal(detectHeader(head, 'misnamed.docx', n)?.kind, 'pdf');
  }
  assert.match(detectHeader(head, 'large.pdf', LIMITS.maxPdfFile + 1)!.problem!, /512 MB/);
  for (const sig of [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]]) {
    assert.equal(detectHeader(new Uint8Array(sig), 'misnamed.pdf', LIMITS.maxFile), null);
    assert.match(detectHeader(new Uint8Array(sig), 'misnamed.pdf', LIMITS.maxFile + 1)!.problem!, /200 MB/);
  }
  assert.match(detectHeader(new TextEncoder().encode('a,b'), 'sheet.csv', LIMITS.maxFile + 1)!.problem!, /200 MB/);
  const prefixed = new Uint8Array(IMPORT_HEADER_BYTES);
  prefixed.set(head, 512);
  assert.equal((await detectFormat(prefixed, 'prefixed.pdf')).kind, 'pdf');
});

test('invalid large PDF: zero/HTML content is explained instead of being masked by the Office size limit', async () => {
  const zero = new Uint8Array(IMPORT_HEADER_BYTES);
  const size = 400 * 1024 * 1024;
  const result = detectHeader(zero, 'test_400mb.pdf', size)!;
  assert.equal(result.kind, 'unknown');
  assert.equal(result.problemCode, 'zero-header');
  assert.doesNotMatch(result.problem!, /200 MB/);
  assert.deepEqual(await detectFormat(zero, 'test.pdf'), result);
  assert.match(describeBytes(zero, 'test_400mb.pdf', size), /419430400 bytes \(first 2048 bytes checked\)/);
  const html = new TextEncoder().encode('<!doctype html><html>Sign in</html>');
  assert.match(detectHeader(html, 'download.pdf', size)!.problem!, /web page/);
  assert.equal(detectHeader(zero, 'empty.pdf', 0)!.problem, 'the file is empty');
});

test('incremental hash: matches native SHA-256 for empty, partial and multi-chunk buffers; source stays intact', async () => {
  const large = new Uint8Array(3 * 1024 * 1024 + 137);
  for (let i = 0; i < large.length; i++) large[i] = i % 251;
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('abc'), large.subarray(13, large.length - 29)]) {
    const expected = createHash('sha256').update(bytes).digest('hex');
    const progress: number[] = [];
    assert.equal(await sha256Hex(bytes, undefined, (n) => progress.push(n)), expected);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    if (bytes.length) assert.equal(progress.at(-1), bytes.length);
    if (bytes.length > 1024 * 1024) assert.ok(progress.length > 1);
  }
  assert.equal(await sha256Hex(large.buffer), createHash('sha256').update(large).digest('hex'));
});

test('incremental hash: supports concurrent digests and cancellation between chunks', async () => {
  const a = new Uint8Array(2 * 1024 * 1024).fill(17);
  const b = new Uint8Array(a.length).fill(93);
  assert.deepEqual(await Promise.all([sha256Hex(a), sha256Hex(b)]), [a, b].map((x) => createHash('sha256').update(x).digest('hex')));
  const ctl = new AbortController();
  let chunks = 0;
  await assert.rejects(sha256Hex(a, ctl.signal, () => { chunks++; ctl.abort(); }), { name: 'AbortError' });
  assert.equal(chunks, 1);
  await assert.rejects(sha256Hex(a, ctl.signal), { name: 'AbortError' });
});

test('large PDF: every page after 2000 survives import and progress uses the true page count', async () => {
  for (const n of [2001, 3000, LIMITS.maxPdfPages]) {
    let cleaned = 0;
    let last: number[] = [];
    const sizes = await pdfPageSizes(fakePdf(n, () => cleaned++), (done, total) => { last = [done, total]; });
    assert.equal(sizes.length, n);
    assert.equal(cleaned, n);
    assert.deepEqual(sizes[2000], { width: 595, height: 842 });
    assert.deepEqual(last, [n, n]);
  }
});

test('large PDF: over the page budget fails before reading any page, never returns a partial document', async () => {
  const doc = fakePdf(LIMITS.maxPdfPages + 1);
  doc.getPage = async () => { throw new Error('must not read pages'); };
  await assert.rejects(pdfPageSizes(doc), (e: unknown) => e instanceof PdfPageLimitError && e.pages === 10001 && /no pages have been imported/.test(e.message));
});

test('PDF ownership: transfers the original buffer and waits for worker teardown before completing inspection', async () => {
  const input = new Uint8Array(1024 * 1024);
  const originalSize = input.byteLength;
  let finishDestroy!: () => void;
  let destroying = false;
  let complete = false;
  const doc = fakePdf(3);
  doc.destroy = () => { destroying = true; return new Promise<void>((r) => { finishDestroy = r; }); };
  const lib: PdfJsLib = { getDocument: (o) => {
    assert.equal(o.data, input, 'no whole-file slice or clone');
    const received = structuredClone(input, { transfer: [input.buffer] });
    assert.equal(received.byteLength, originalSize);
    return { promise: Promise.resolve(doc) };
  } };
  const pending = inspectPdf(lib, input).then((sizes) => { complete = true; return sizes; });
  await tick();
  assert.equal(input.byteLength, 0, 'real worker transfer detaches the buffer');
  assert.equal(destroying, true);
  assert.equal(complete, false, 'storage/rendering must wait for destruction');
  finishDestroy();
  assert.equal((await pending).length, 3);
});

test('PDF cleanup: failed and cancelled loading tasks release their resources', async () => {
  let destroyed = 0;
  const bad: PdfJsLib = { getDocument: () => ({ promise: Promise.reject(Object.assign(new Error('bad file'), { name: 'InvalidPDFException' })), destroy: async () => { await tick(); destroyed++; } }) };
  await assert.rejects(openPdf(bad, new Uint8Array()), /damaged/);
  assert.equal(destroyed, 1);
  const ctl = new AbortController();
  const stuck: PdfJsLib = { getDocument: () => ({ promise: new Promise<PdfDocument>(() => {}), destroy: async () => { await tick(); destroyed++; } }) };
  const pending = openPdf(stuck, new Uint8Array(), ctl.signal);
  ctl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(destroyed, 2);
});

test('PDF cleanup: cancellation during page enumeration and page-limit failure close the document', async () => {
  const ctl = new AbortController();
  let destroyed = 0;
  let cleaned = 0;
  const doc = fakePdf(3000, () => cleaned++);
  doc.destroy = async () => { await tick(); destroyed++; };
  const lib: PdfJsLib = { getDocument: () => ({ promise: Promise.resolve(doc) }) };
  await assert.rejects(inspectPdf(lib, new Uint8Array(), () => ctl.abort(), ctl.signal), { name: 'AbortError' });
  assert.equal(cleaned, 10);
  assert.equal(destroyed, 1);
  doc.numPages = 10001;
  await assert.rejects(inspectPdf(lib, new Uint8Array()), PdfPageLimitError);
  assert.equal(destroyed, 2);
});

test('PDF cleanup: cancelling a stalled getPage destroys the worker without waiting for that page', async () => {
  const ctl = new AbortController();
  const doc = fakePdf(3);
  let destroying = 0;
  doc.getPage = () => new Promise(() => {});
  doc.destroy = async () => { await tick(); destroying++; };
  const pending = inspectPdf({ getDocument: () => ({ promise: Promise.resolve(doc) }) }, new Uint8Array(), undefined, ctl.signal);
  await tick();
  ctl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(destroying, 1);
});
