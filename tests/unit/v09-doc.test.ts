// 0.9: Word 97–2003 (.doc) import — compound file reader, binary Word text / paragraphs / tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cfb, CfbError } from '../../src/import/cfb';
import { convertDoc, DocFormatError, sprms } from '../../src/import/doc';
import { layoutDocx } from '../../src/import/docx';
import { detectFormat } from '../../src/import/detect';
import type { DLOp, DisplayList } from '../../src/import/display-list';
import { fixedMeasurer, writeCfb } from './ooxml-helpers';

type T = Extract<DLOp, { k: 't' }>;
const texts = (dl: DisplayList) => dl.pages.flatMap((p) => p.ops).filter((o): o is T => o.k === 't');
const fixture = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/import/${n}`));
const lay = (b: Uint8Array) => {
  const c = convertDoc(b);
  return layoutDocx(c.parts, { measure: fixedMeasurer }, 'doc').then((dl) => ({ dl, notes: c.notes }));
};

test('cfb: streams of a compound file; damaged chains are refused', () => {
  const a = new Uint8Array(5000).map((_, i) => i % 251);
  const f = new Cfb(writeCfb({ WordDocument: a, '1Table': new Uint8Array([1, 2, 3]) }));
  assert.ok(f.has('WordDocument'));
  assert.deepEqual(f.stream('WordDocument'), a);
  assert.equal(f.stream('1Table')?.length, 4096);
  assert.equal(f.stream('missing'), null);
  assert.throws(() => new Cfb(new Uint8Array(100)), CfbError);
  const looped = new Cfb(writeCfb({ WordDocument: new Uint8Array(9000) }, { loopFirstStream: true }));
  assert.throws(() => looped.stream('WordDocument'), /loop/);
  const truncated = writeCfb({ WordDocument: new Uint8Array(9000) }).slice(0, 2048);
  assert.throws(() => new Cfb(truncated).stream('WordDocument'), CfbError);
});

test('detect: what a compound file holds decides (.doc, .ppt, .xls, encrypted), not its name', async () => {
  const kind = async (streams: Record<string, Uint8Array>, name: string) => detectFormat(writeCfb(streams), name);
  assert.equal((await kind({ WordDocument: new Uint8Array(10), '1Table': new Uint8Array(1) }, 'x.doc')).kind, 'doc');
  assert.equal((await kind({ WordDocument: new Uint8Array(10) }, 'renamed.bin')).kind, 'doc');
  assert.match((await kind({ 'PowerPoint Document': new Uint8Array(10) }, 'a.ppt')).problem ?? '', /PowerPoint 97–2003.*\.pptx/);
  assert.match((await kind({ Workbook: new Uint8Array(10) }, 'a.xls')).problem ?? '', /Excel 97–2003.*\.xlsx/);
  assert.match((await kind({ EncryptionInfo: new Uint8Array(10), EncryptedPackage: new Uint8Array(10) }, 'a.docx')).problem ?? '', /password-protected/);
  assert.equal((await detectFormat(fixture('sample.doc'), 'sample.doc')).kind, 'doc');
});

test('doc: the sample (LibreOffice "Word 97") keeps text, styles, formatting, page breaks and the table', async () => {
  const { dl, notes } = await lay(fixture('sample.doc'));
  assert.equal(dl.kind, 'doc');
  assert.deepEqual([dl.pages[0].w, dl.pages[0].h], [612, 792], 'Letter, from the section properties');
  const t = texts(dl);
  const at = (s: string) => t.find((o) => o.s === s) as T;
  for (const s of ['HandNote import test', '1. Headings and paragraphs', 'bold', 'R1C1', 'R3C3', 'merged R3C1-2', 'Right aligned paragraph.']) assert.ok(at(s), `text ${s}`);
  assert.ok(t.some((o) => o.s.startsWith('中文段落')), 'UTF-16 text');
  assert.equal(at('bold').b, 1);
  assert.ok(at('1. Headings and paragraphs').b === 1 && at('1. Headings and paragraphs').z > 11, 'heading style from the stylesheet');
  assert.ok(at('HandNote import test').z > 20, 'title style size');
  assert.ok(at('Centered paragraph.').x > 200, 'centred');
  // the merged cell spans two grid columns: R3C3 sits under R1C3
  assert.ok(Math.abs(at('R3C3').x - at('R1C3').x) < 0.5);
  // the manual page break
  const p5 = dl.pages.findIndex((p) => p.ops.some((o) => o.k === 't' && o.s === '5. Second page'));
  assert.ok(p5 >= 1, 'page break kept');
  assert.ok(notes.includes('pictures'));
});

test('doc: a Chinese document (LibreOffice) — A4, headings, table cells, mixed scripts', async () => {
  const { dl } = await lay(fixture('sample-zh.doc'));
  assert.ok(Math.abs(dl.pages[0].w - 595.3) < 0.2 && Math.abs(dl.pages[0].h - 841.9) < 0.2, 'A4');
  const t = texts(dl).map((o) => o.s).join('');
  for (const s of ['第一章 线性代数复习', '1.1 定义', '向量空间', '行阶梯形非', '对角线元素', '例 1. 求矩阵的秩并说明理由。']) assert.ok(t.includes(s), `text ${s}`);
});

test('doc: encrypted, Word 95 and damaged files are refused with a reason', () => {
  const fib = (nFib: number, flags: number) => {
    const wd = new Uint8Array(1024);
    wd[0] = 0xec;
    wd[1] = 0xa5;
    wd[2] = nFib & 0xff;
    wd[3] = nFib >> 8;
    wd[0x0a] = flags & 0xff;
    wd[0x0b] = flags >> 8;
    return writeCfb({ WordDocument: wd, '0Table': new Uint8Array(16), '1Table': new Uint8Array(16) });
  };
  assert.throws(() => convertDoc(fib(0xc1, 0x0100)), /password-protected/);
  assert.throws(() => convertDoc(fib(0x65, 0)), /Word 95 or older/);
  assert.throws(() => convertDoc(fib(0xc1, 0)), DocFormatError);
  assert.throws(() => convertDoc(writeCfb({ Workbook: new Uint8Array(10) })), /not a Word document/);
  assert.throws(() => convertDoc(new Uint8Array(600)), /damaged \.doc/);
});

test('doc: property modifiers (sprms) of each operand size are read without running past the end', () => {
  // bold (1 byte), size (2 bytes), colour (4 bytes), a variable one, then a truncated one
  const b = new Uint8Array([0x35, 0x08, 1, 0x43, 0x4a, 24, 0, 0x70, 0x68, 255, 0, 0, 0, 0x46, 0xc6, 2, 9, 9, 0x43, 0x4a, 1]);
  const s = sprms(b, 0, b.length);
  assert.deepEqual(s.map((x) => x.op), [0x0835, 0x4a43, 0x6870, 0xc646]);
  assert.equal(s[1].arg[0], 24);
});
