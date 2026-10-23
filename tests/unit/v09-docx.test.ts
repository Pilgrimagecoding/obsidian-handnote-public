// 0.9 Phase 3: Word (.docx) import — XML reader, ZIP entries, line breaking, page layout, stored layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { XmlError, attr, decodeEntities, find, kid, parseXml } from '../../src/import/xml';
import { ZipArchive, relsOf, resolvePart } from '../../src/import/zip';
import { flowLines, type Run, type RunStyle } from '../../src/import/flow';
import { cssFamily, parseDisplayList, type DLOp, type DisplayList } from '../../src/import/display-list';
import { layoutDocx } from '../../src/import/docx';
import { rasterKind } from '../../src/import/office-render';
import { detectFormat } from '../../src/import/detect';
import { parseDocument, serializeDocument, validateSource } from '../../src/document/codec';
import { createDocument } from '../../src/document/model';
import { documentPages, makeSource } from '../../src/import/pages';
import { docx, fixedMeasurer, para, sect, writeCfb, writeZip } from './ooxml-helpers';

const FIXTURE = 'tests/fixtures/import/sample.docx';
const lay = (bytes: Uint8Array, maxPages?: number) => layoutDocx(new ZipArchive(bytes), { measure: fixedMeasurer, ...(maxPages ? { maxPages } : {}) });
const texts = (dl: DisplayList, page?: number) => (page === undefined ? dl.pages.flatMap((p) => p.ops) : dl.pages[page].ops).filter((o): o is Extract<DLOp, { k: 't' }> => o.k === 't');

// ---------------------------------------------------------------- XML reader
test('0.9 docx: XML reader parses elements, attributes, entities and CDATA', () => {
  const x = parseXml('<?xml version="1.0"?><!-- c --><a:r x="1 &amp; 2" y=\'q\'><b>t&lt;&#x4e2d;&#25991;</b><c/><![CDATA[<raw>]]></a:r>');
  assert.equal(x.name, 'a:r');
  assert.equal(attr(x, 'x'), '1 & 2');
  assert.equal(attr(x, 'y'), 'q');
  assert.equal(kid(x, 'b')?.text, 't<中文');
  assert.ok(kid(x, 'c'));
  assert.equal(x.text, '<raw>');
  assert.equal(decodeEntities('&#0;&#xD800;&unknown;'), '&unknown;');
});

test('0.9 docx: XML reader refuses DTDs / entity declarations and malformed input', () => {
  assert.throws(() => parseXml('<!DOCTYPE lolz [<!ENTITY lol "lol">]><a>&lol;</a>'), XmlError);
  assert.throws(() => parseXml('<a><b></a>'), XmlError);
  assert.throws(() => parseXml('<a>'), XmlError);
  assert.throws(() => parseXml(''), XmlError);
  assert.throws(() => parseXml('<a' + '<b>'.repeat(10)), XmlError);
  assert.throws(() => parseXml('<x>'.repeat(300) + '</x>'.repeat(300)), /deeply/);
});

// ---------------------------------------------------------------- ZIP
test('0.9 docx: ZipArchive reads stored and deflated entries, caps sizes, resolves parts', async () => {
  for (const deflate of [false, true]) {
    const z = new ZipArchive(writeZip({ 'a/b.xml': '<x>hello</x>', 'bin.dat': new Uint8Array([1, 2, 3]) }, { deflate }));
    assert.equal(await z.text('a/b.xml'), '<x>hello</x>');
    assert.deepEqual([...((await z.bytesOf('bin.dat')) as Uint8Array)], [1, 2, 3]);
    assert.equal(await z.text('missing.xml'), null);
    await assert.rejects(z.bytesOf('a/b.xml', 4), /too large/);
  }
  // an entry that inflates to more than its declared size is stopped
  const big = 'x'.repeat(100000);
  const lying = new ZipArchive(writeZip({ 'bomb.xml': big }, { deflate: true, lieSize: { 'bomb.xml': 1000 } }));
  await assert.rejects(lying.text('bomb.xml'), /more than declared/);
  assert.equal(resolvePart('word/document.xml', 'media/image1.png'), 'word/media/image1.png');
  assert.equal(resolvePart('ppt/slides/slide1.xml', '../media/a.png'), 'ppt/media/a.png');
  assert.equal(resolvePart('word/document.xml', '/word/media/x.png'), 'word/media/x.png');
  assert.equal(relsOf('word/document.xml'), 'word/_rels/document.xml.rels');
});

// ---------------------------------------------------------------- line breaking
const st: RunStyle = { font: 0, size: 10 };
const flow = (runs: Run[], width: number, first = 0) => flowLines(runs, width, first, fixedMeasurer, ['sans-serif'], (s) => s * 1.2);
const lineText = (l: ReturnType<typeof flow>[number]) => l.pieces.map((p) => p.text ?? '').join('');

test('0.9 docx: Latin text wraps at spaces and never exceeds the width', () => {
  const lines = flow([{ kind: 'text', text: 'aaaa bbbb cccc dddd eeee', style: st }], 50); // 10 chars per line
  assert.deepEqual(lines.map((l) => lineText(l).trim()), ['aaaa bbbb', 'cccc dddd', 'eeee']);
  for (const l of lines) assert.ok(l.width <= 50.01, `width ${l.width}`);
  assert.equal(lines[2].last, true);
  assert.equal(lines[0].last, false);
});

test('0.9 docx: a word longer than the line is split; first-line indent is applied', () => {
  const lines = flow([{ kind: 'text', text: 'x'.repeat(25), style: st }], 50);
  assert.deepEqual(lines.map(lineText), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  const ind = flow([{ kind: 'text', text: 'aaaa bbbb cccc', style: st }], 50, 20);
  assert.equal(ind[0].pieces[0].x, 20);
  assert.equal(lineText(ind[0]).trim(), 'aaaa');
});

test('0.9 docx: CJK breaks between characters, closing punctuation never starts a line', () => {
  // 5 CJK chars per line (10 px each); the 6th character is a full stop: it stays on the line before
  const lines = flow([{ kind: 'text', text: '一二三四五。六七八九十', style: st }], 50);
  for (const l of lines) assert.ok(!/^[，。、；：！？）》」』】]/.test(lineText(l)), `line starts with punctuation: ${lineText(l)}`);
  assert.equal(lineText(lines[0]).length, 4);
  assert.equal(lineText(lines[1]).startsWith('五。'), true);
});

test('0.9 docx: tabs jump to stops, manual breaks end lines, pictures size the line', () => {
  const lines = flow(
    [
      { kind: 'text', text: 'ab', style: st },
      { kind: 'tab', style: st },
      { kind: 'text', text: 'c', style: st },
      { kind: 'br', style: st },
      { kind: 'image', part: 'word/media/p.png', w: 30, h: 40 },
    ],
    200,
  );
  assert.equal(lines.length, 2);
  const c = lines[0].pieces.find((p) => p.text === 'c');
  assert.equal(c?.x, 36);
  assert.equal(lines[0].last, true);
  assert.ok(lines[1].height >= 40);
  assert.ok(lines[1].ascent >= 40);
  assert.equal(lines[1].pieces[0].image?.part, 'word/media/p.png');
});

// ---------------------------------------------------------------- page layout of a real Word file
test('0.9 docx: the sample document lays out on pages of its sections (python-docx fixture)', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const det = await detectFormat(bytes, 'sample.docx', async (e) => (await new ZipArchive(bytes).text(e.name)) ?? '');
  assert.equal(det.kind, 'docx');
  const dl = await lay(bytes);
  assert.equal(dl.kind, 'docx');
  // like LibreOffice: page 1 up to the picture, the manual page break, then the landscape section
  assert.equal(dl.pages.length, 3);
  // US Letter portrait (python-docx default), landscape last section
  assert.deepEqual([dl.pages[0].w, dl.pages[0].h], [612, 792]);
  assert.deepEqual([dl.pages[2].w, dl.pages[2].h], [792, 612]);
  const all = texts(dl).map((o) => o.s);
  for (const s of ['HandNote import test', '1. Headings and paragraphs', 'bold', 'R1C1', 'merged R3C1-2', 'This page is landscape.']) assert.ok(all.includes(s), `missing text ${s}`);
  // runs keep their formatting
  const bold = texts(dl).find((o) => o.s === 'bold');
  assert.equal(bold?.b, 1);
  assert.equal(texts(dl).find((o) => o.s === 'red')?.c, '#c01010');
  // bullets and numbers
  assert.equal(all.filter((s) => s === '•').length, 3);
  for (const n of ['1.', '2.', '3.']) assert.ok(all.includes(n), `missing list number ${n}`);
  // headings are bigger than body text
  const h1 = texts(dl).find((o) => o.s === '2. Lists');
  assert.ok(h1 && h1.z > 11 && h1.b === 1);
  // the picture is on the same page as its heading (keep with next) and comes from the original file
  const picPage = dl.pages.findIndex((p) => p.ops.some((o) => o.k === 'img'));
  assert.ok(picPage >= 0);
  assert.ok(texts(dl, picPage).some((o) => o.s === '4. Picture'));
  const img = dl.pages[picPage].ops.find((o) => o.k === 'img') as Extract<DLOp, { k: 'img' }>;
  assert.equal(img.part, 'word/media/image1.png');
  assert.ok(Math.abs(img.w - 144) < 0.5 && Math.abs(img.h - 72) < 0.5, `picture ${img.w}×${img.h}`);
  // the table has grid lines; table style "Table Grid" makes its cells compact (no paragraph spacing)
  assert.ok(dl.pages.some((p) => p.ops.filter((o) => o.k === 'l').length >= 12));
  const r1 = texts(dl).find((o) => o.s === 'R1C1') as Extract<DLOp, { k: 't' }>;
  const r2 = texts(dl).find((o) => o.s === 'R2C1') as Extract<DLOp, { k: 't' }>;
  assert.ok(r2.y - r1.y < 16, `compact table rows (${r2.y - r1.y})`);
  // list items of one style have no space between them (contextual spacing)
  const b1 = texts(dl).find((o) => o.s === 'First bullet') as Extract<DLOp, { k: 't' }>;
  const b2 = texts(dl).find((o) => o.s === 'Second bullet') as Extract<DLOp, { k: 't' }>;
  assert.ok(b2.y - b1.y < 16, `list items close together (${b2.y - b1.y})`);
  // the manual page break: "5. Second page" starts a page
  const p5 = dl.pages.findIndex((p) => texts({ ...dl, pages: [p] }, 0).some((o) => o.s === '5. Second page'));
  assert.equal(texts(dl, p5)[0].s, '5. Second page');
  // everything stays on its page, text stays inside the margins
  for (const p of dl.pages)
    for (const o of p.ops) {
      if (o.k === 't') {
        assert.ok(o.x >= 0 && o.y > 0 && o.y <= p.h, `text outside the page: ${o.s}`);
        assert.ok(o.x + (o.w ?? 0) <= p.w - 72 + 0.5, `text beyond the right margin: ${o.s} ${o.x}+${o.w}`);
      }
      if (o.k === 'img') assert.ok(o.y >= 0 && o.y + o.h <= p.h);
    }
});

test('0.9 docx: the layout is deterministic and survives storing (sidecar JSON)', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const a = await lay(bytes);
  const b = await lay(bytes);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const stored = parseDisplayList(JSON.stringify({ ...a, sha256: 'a'.repeat(64), by: 'handnote-0.9' }));
  assert.equal(stored.pages.length, a.pages.length);
  assert.deepEqual(stored.pages, a.pages);
  assert.equal(stored.sha256, 'a'.repeat(64));
});

test('0.9 docx: a stored layout is untrusted data (bad ops, colours, paths are dropped)', () => {
  const dl = parseDisplayList(
    JSON.stringify({
      v: 1,
      kind: 'docx',
      fonts: ['sans-serif'],
      notes: ['x', 3],
      pages: [
        {
          w: 100,
          h: 100,
          bg: 'url(x)',
          ops: [
            { k: 't', x: 1, y: 2, s: 'ok', f: 0, z: 10, c: 'red;x' },
            { k: 't', x: 1, y: 2, s: 'bad font', f: 7, z: 10 },
            { k: 'img', x: 0, y: 0, w: 1, h: 1, part: '../../etc/passwd' },
            { k: 'img', x: 0, y: 0, w: 1, h: 1, part: 'https://evil.example/x.png' },
            { k: 'img', x: 0, y: 0, w: 1, h: 1, part: 'word/media/ok.png' },
            { k: 'r', x: 0, y: 0, w: 1e9, h: 1 },
            { k: 'script', src: 'x' },
          ],
        },
        { w: 'x', h: 1, ops: [] },
      ],
    }),
  );
  assert.equal(dl.pages.length, 1);
  assert.equal(dl.pages[0].bg, undefined);
  assert.deepEqual(
    dl.pages[0].ops.map((o) => (o.k === 'img' ? o.part : o.k)),
    ['t', 'word/media/ok.png'],
  );
  assert.equal((dl.pages[0].ops[0] as { c?: string }).c, undefined);
  assert.deepEqual(dl.notes, ['x']);
  assert.throws(() => parseDisplayList('{"v":2,"pages":[],"fonts":[]}'));
});

test('0.9 docx: remote pictures are never referenced; unknown content is noted, not faked', async () => {
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.example/track.png" TargetMode="External"/></Relationships>';
  const pic = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdX"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const eq = '<w:p><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath></w:p>';
  const dl = await lay(docx(para('before') + pic + eq + para('after') + sect(), { 'word/_rels/document.xml.rels': rels }));
  assert.equal(dl.pages.flatMap((p) => p.ops).filter((o) => o.k === 'img').length, 0);
  assert.ok(!JSON.stringify(dl).includes('evil.example'));
  assert.ok(dl.notes.includes('equations'));
  assert.deepEqual(texts(dl).map((o) => o.s), ['before', 'after']);
});

test('0.9 docx: a DOCTYPE in the document part is refused (no entity expansion)', async () => {
  const bomb = '<!DOCTYPE w:document [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>';
  await assert.rejects(lay(docx(para('&b;') + sect(), {}, { prolog: bomb })), /DOCTYPE/);
});

test('0.9 docx: long documents flow over pages; a page limit stops runaway layouts', async () => {
  const body = Array.from({ length: 400 }, (_, i) => para(`Paragraph ${i + 1} with some words to fill the line.`)).join('') + sect();
  const dl = await lay(docx(body, {}, { deflate: true }));
  assert.ok(dl.pages.length >= 8, `pages ${dl.pages.length}`);
  // reading order is kept across pages and every paragraph appears once
  const seq = texts(dl).map((o) => o.s).filter((s) => s.startsWith('Paragraph'));
  assert.equal(seq.length, 400);
  assert.equal(seq[399].startsWith('Paragraph 400'), true);
  for (const p of dl.pages) for (const o of p.ops) if (o.k === 't') assert.ok(o.y <= p.h - 72 + 1, `text in the bottom margin at ${o.y}`);
  await assert.rejects(lay(docx(body), 3), /longer than 3 pages/);
});

test('0.9 docx: styles, alignment, indents, page size, hidden text, page-break-before', async () => {
  const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Big"><w:name w:val="Big"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style></w:styles>`;
  const body =
    para('Title', '<w:pStyle w:val="Big"/><w:jc w:val="center"/>') +
    para('Indented', '<w:ind w:left="720"/>') +
    para('secret', '', '<w:vanish/>') +
    para('Next page', '<w:pageBreakBefore/>') +
    sect(8391, 11906, 720); // A5, 0.5" margins
  const dl = await lay(docx(body, { 'word/styles.xml': styles }));
  assert.equal(dl.pages.length, 2);
  assert.ok(Math.abs(dl.pages[0].w - 419.55) < 0.1 && Math.abs(dl.pages[0].h - 595.3) < 0.1);
  const [title, ind] = texts(dl, 0);
  assert.equal(title.s, 'Title');
  assert.equal(title.z, 24);
  assert.equal(title.b, 1);
  // centred: equal space left and right inside the margins
  assert.ok(Math.abs(title.x - 36 - (419.55 - 36 - (title.x + (title.w ?? 0)))) < 1);
  assert.equal(ind.s, 'Indented');
  assert.equal(ind.x, 36 + 36);
  assert.equal(ind.z, 12);
  assert.ok(/Times/.test(dl.fonts[ind.f]));
  assert.ok(!texts(dl).some((o) => o.s === 'secret'));
  assert.equal(texts(dl, 1)[0].s, 'Next page');
});

test('0.9 docx: table cells wrap inside their column and rows move to the next page whole', async () => {
  const cell = (t: string, w = 2000) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${para(t)}</w:tc>`;
  const row = (i: number) => `<w:tr>${cell(`row ${i} long text that has to wrap in a narrow column`)}${cell(`B${i}`)}</w:tr>`;
  const tbl = `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/><w:insideH w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${Array.from({ length: 40 }, (_, i) => row(i + 1)).join('')}</w:tbl>`;
  const dl = await lay(docx(tbl + sect()));
  assert.ok(dl.pages.length >= 2);
  // first column is 100 pt wide (2000 twips): its text never crosses into the second column
  for (const o of texts(dl)) if (o.s.startsWith('row') || o.s.includes('wrap') || o.s.includes('column')) assert.ok(o.x + (o.w ?? 0) <= 72 + 100 + 0.5, `${o.s} crosses the column`);
  // a row is never split: "B<i>" sits on the same page as the start of row i
  for (const [pi, p] of dl.pages.entries())
    for (const o of p.ops)
      if (o.k === 't' && /^B\d+$/.test(o.s)) {
        const i = o.s.slice(1);
        assert.ok(texts(dl, pi).some((x) => x.s.startsWith(`row ${i} `) || x.s === `row ${i}`), `row ${i} split across pages`);
      }
});

test('0.9 docx: numbering restarts per list and nests levels', async () => {
  const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const li = (t: string, id: number, lvl = 0) => para(t, `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr>`);
  const dl = await lay(docx(li('a', 1) + li('b', 1) + li('b1', 1, 1) + li('b2', 1, 1) + li('c', 1) + li('r1', 2) + li('r2', 2) + sect(), { 'word/numbering.xml': numbering }));
  const marks = texts(dl).map((o) => o.s).filter((s) => /[.)]$/.test(s));
  assert.deepEqual(marks, ['1.', '2.', '2.a)', '2.b)', '3.', 'I.', 'II.']);
});

test('0.9 docx: fonts map to families present on desktop and iPad', () => {
  assert.match(cssFamily('Calibri'), /PingFang SC/);
  assert.match(cssFamily('宋体'), /Songti SC/);
  assert.match(cssFamily('Times New Roman'), /serif$/);
  assert.match(cssFamily('Consolas'), /monospace$/);
  assert.match(cssFamily(undefined, 'serif'), /serif$/);
});

test('0.9 docx: pictures are decoded only from raster formats (no SVG / EMF)', () => {
  assert.equal(rasterKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(rasterKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(rasterKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(rasterKind(new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0, 0, 0, 0, 0])), null); // EMF header
});

test('0.9 docx: the note stores the layout path with the source (v6), not the layout itself', () => {
  const src = makeSource('docx', 'Docs/report.docx', 1234, 'b'.repeat(64), 2);
  src.layout = 'Docs/report.docx.handnote-layout.json';
  const doc = createDocument({ device: 't' });
  doc.pages = documentPages(src, [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ]);
  doc.sources = { [src.id]: src };
  const text = serializeDocument(doc);
  assert.ok(!text.includes('"ops"'));
  const back = parseDocument(text);
  assert.equal(back.doc.sources?.[src.id].layout, src.layout);
  assert.equal(back.doc.sources?.[src.id].kind, 'docx');
  assert.equal(validateSource({ ...src, layout: 'x'.repeat(2000) }, [])?.layout, undefined);
  assert.equal(validateSource({ ...src, layout: 5 }, [])?.layout, undefined);
});

test('0.9 docx: section page sizes come from sectPr (paragraph-level sections too)', async () => {
  const body = para('portrait') + `<w:p><w:pPr>${sect(11906, 16838)}</w:pPr></w:p>` + para('landscape') + `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
  const dl = await lay(docx(body));
  assert.equal(dl.pages.length, 2);
  assert.ok(dl.pages[0].h > dl.pages[0].w);
  assert.ok(dl.pages[1].w > dl.pages[1].h);
  assert.equal(texts(dl, 1)[0].s, 'landscape');
  const x = parseXml('<a><b><c n="1"/></b><c n="2"/></a>');
  assert.equal(find(x, 'c').length, 2);
});

test('0.9 docx: cell borders (tcBorders) and vertically merged cells', async () => {
  const bd = '<w:tcBorders><w:top w:val="single" w:sz="8" w:color="FF0000"/><w:left w:val="single"/><w:bottom w:val="single"/><w:right w:val="single"/></w:tcBorders>';
  const tc = (t: string, extra = '') => `<w:tc><w:tcPr>${bd}${extra}</w:tcPr>${para(t)}</w:tc>`;
  const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${tc('merged', '<w:vMerge w:val="restart"/>')}${tc('A')}</w:tr><w:tr>${tc('', '<w:vMerge/>')}${tc('B')}</w:tr></w:tbl>`;
  const dl = await lay(docx(tbl + sect()));
  const lines = dl.pages[0].ops.filter((o): o is Extract<DLOp, { k: 'l' }> => o.k === 'l');
  const horiz = lines.filter((l) => l.y1 === l.y2);
  // first column (x 72..172): a top line and a bottom line, nothing in between (merged)
  const col1 = horiz.filter((l) => l.x1 === 72).map((l) => l.y1).sort((a, b) => a - b);
  const col2 = horiz.filter((l) => l.x1 === 172).map((l) => l.y1).sort((a, b) => a - b);
  assert.equal(col1.length, 2, `merged column lines ${col1}`);
  assert.equal(col2.length, 3, `second column lines ${col2}`);
  assert.equal(col1[1], col2[2]);
  // the cell's own colour and width
  const top = horiz.find((l) => l.x1 === 72 && l.y1 === col1[0]);
  assert.equal(top?.stroke, '#ff0000');
  assert.equal(top?.lw, 1);
  // a table with no borders anywhere draws no lines
  const plain = await lay(docx(`<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${para('x')}</w:tc></w:tr></w:tbl>` + sect()));
  assert.equal(plain.pages[0].ops.filter((o) => o.k === 'l').length, 0);
});

test('0.9 docx: password-protected files and embedded HTML / OLE objects are explained, never rendered', async () => {
  const ole = writeCfb({ EncryptionInfo: new Uint8Array(64), EncryptedPackage: new Uint8Array(64) });
  const d = await detectFormat(ole, 'Secret.docx', async () => '');
  assert.equal(d.kind, 'legacy-office');
  assert.match(d.problem ?? '', /password/);
  const dl = await lay(docx(para('x') + '<w:altChunk r:id="rIdHtml"/>' + '<w:p><w:r><w:object><v:shape xmlns:v="urn:schemas-microsoft-com:vml"/></w:object></w:r></w:p>' + sect()));
  assert.ok(dl.notes.includes('embedded-objects'));
  assert.deepEqual(texts(dl).map((o) => o.s), ['x']);
});
