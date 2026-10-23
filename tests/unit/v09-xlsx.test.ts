// 0.9 Phase 5: Excel (.xlsx) import — sheets cut into fixed pages with their cell grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ZipArchive } from '../../src/import/zip';
import { cellAt, colName, layoutXlsx, parseRef, XLSX_PAGE } from '../../src/import/xlsx';
import { detectFormat } from '../../src/import/detect';
import { parseDisplayList, type DLOp, type DisplayList } from '../../src/import/display-list';
import { fixedMeasurer, writeZip } from './ooxml-helpers';

type T = Extract<DLOp, { k: 't' }>;
const lay = (b: Uint8Array, o: { maxPages?: number; maxCells?: number } = {}) => layoutXlsx(new ZipArchive(b), { measure: fixedMeasurer, ...o });
const texts = (dl: DisplayList, p: number) => dl.pages[p].ops.filter((o): o is T => o.k === 't');
const at = (dl: DisplayList, p: number, s: string) => texts(dl, p).find((o) => o.s === s) as T;
const fixture = () => new Uint8Array(readFileSync('tests/fixtures/import/sample.xlsx'));

/** A minimal workbook: sheets given as sheetData inner XML (plus optional extra worksheet XML). */
function xlsx(sheets: { name: string; data: string; extra?: string; state?: string }[], parts: Record<string, string> = {}): Uint8Array {
  const rel = (rels: [string, string, string][]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([i, t, g]) => `<Relationship Id="${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}" Target="${g}"/>`).join('')}</Relationships>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': rel([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rS${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rel(sheets.map((_, i) => [`rS${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`] as [string, string, string])),
    ...parts,
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${s.extra ?? ''}<sheetData>${s.data}</sheetData>${s.extra?.includes('mergeCells') ? '' : ''}</worksheet>`;
  });
  return writeZip(files);
}
const row = (r: number, cells: string, attrs = '') => `<row r="${r}"${attrs}>${cells}</row>`;
const num = (ref: string, v: number | string, s?: number) => `<c r="${ref}"${s !== undefined ? ` s="${s}"` : ''}><v>${v}</v></c>`;
const str = (ref: string, t: string, s?: number) => `<c r="${ref}" t="inlineStr"${s !== undefined ? ` s="${s}"` : ''}><is><t>${t}</t></is></c>`;

test('xlsx: references and column letters', () => {
  assert.equal(colName(1), 'A');
  assert.equal(colName(26), 'Z');
  assert.equal(colName(27), 'AA');
  assert.equal(colName(16384), 'XFD');
  assert.deepEqual(parseRef('B12'), [12, 2]);
  assert.deepEqual(parseRef('$AA$3'), [3, 27]);
  assert.equal(parseRef('12B'), null);
});

test('xlsx: the sample workbook (openpyxl + LibreOffice) — sheet pages, values as Excel shows them', async () => {
  const bytes = fixture();
  const det = await detectFormat(bytes, 'sample.xlsx', async (e) => (await new ZipArchive(bytes).text(e.name)) ?? '');
  assert.equal(det.kind, 'xlsx');
  const dl = await lay(bytes);
  assert.equal(dl.kind, 'xlsx');
  // sheet 1 on one page, "Data" (150 rows) on more pages, the hidden sheet not at all
  const sheetsOf = dl.pages.map((p) => p.grid?.sheet);
  assert.equal(sheetsOf[0], '成绩表');
  assert.ok(sheetsOf.filter((s) => s === 'Data').length >= 2);
  assert.ok(!sheetsOf.includes('Secret'));
  assert.ok(dl.notes.includes('hidden-sheets'));
  assert.ok(dl.notes.includes('formulas-cached'));
  // title and headings
  assert.equal(texts(dl, 0)[0].s, '成绩表 · A1:H11');
  assert.ok(at(dl, 0, 'A') && at(dl, 0, 'E') && at(dl, 0, '11'), 'column letters and row numbers');
  // values: formula results stored in the file, number formats applied
  assert.ok(at(dl, 0, '177'), 'cached formula result');
  assert.ok(at(dl, 0, '169.5'));
  assert.ok(at(dl, 0, '34.7%'), 'percent format');
  assert.ok(at(dl, 0, '2024-10-23'), 'date format');
  assert.ok(at(dl, 0, '¥1,234,567.89'), 'currency format');
  assert.ok(texts(dl, 0).some((o) => /^#+$/.test(o.s)), 'a number too wide for its column shows ###');
  // styles: header row white bold on blue, title merged and centred over A1:E1
  const head = at(dl, 0, '姓名');
  assert.equal(head.b, 1);
  assert.equal(head.c, '#ffffff');
  assert.ok(dl.pages[0].ops.some((o) => o.k === 'r' && o.fill === '#4472c4'));
  const title = at(dl, 0, '期中成绩统计');
  const g = dl.pages[0].grid!;
  const spanW = g.widths.slice(0, 5).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(title.x + (title.w ?? 0) / 2 - (g.x + spanW / 2)) < 1, 'merged title centred over A1:E1');
  assert.equal(title.z, 16);
  // numbers right-aligned, text left-aligned in their cells
  const n92 = at(dl, 0, '92');
  const xB = g.x + g.widths[0];
  assert.ok(Math.abs(n92.x + (n92.w ?? 0) - (xB + g.widths[1] - 2)) < 0.5, 'number at the right edge');
  assert.equal(at(dl, 0, '张三').x, g.x + 2);
  // overflow into empty neighbours; wrapped text on several lines
  assert.ok(at(dl, 0, 'This long text runs over the empty cells to its right'));
  assert.ok(texts(dl, 0).filter((o) => /Wrapped|inside|narrow/.test(o.s)).length >= 2);
  // the picture: LibreOffice stored its anchor as G2 + 130680 EMU (10.29 pt) down
  const img = dl.pages[0].ops.find((o) => o.k === 'img') as Extract<DLOp, { k: 'img' }>;
  assert.equal(img.part, 'xl/media/image1.png');
  assert.equal(cellAt(dl.pages[0], img.x + 1, img.y + 1)?.ref, "'成绩表'!G2");
  assert.ok(Math.abs(img.y - (g.y + g.heights[0] + 130680 / 12700)) < 0.02, 'offset inside the anchor cell');
  assert.ok(Math.abs(img.x - (g.x + g.widths.slice(0, 6).reduce((a, b) => a + b, 0))) < 0.02);
});

test('xlsx: every page maps points back to cells (annotations anchored to cells)', async () => {
  const dl = await lay(fixture());
  const p0 = dl.pages[0];
  const g = p0.grid!;
  assert.equal(cellAt(p0, g.x + 1, g.y + 1)?.ref, "'成绩表'!A1");
  const pData = dl.pages.findIndex((p) => p.grid?.sheet === 'Data');
  const pd = dl.pages[pData];
  const gd = pd.grid!;
  // a point in the fourth column, tenth row of the first Data page
  const x = gd.x + gd.widths.slice(0, 3).reduce((a, b) => a + b, 0) + 2;
  const y = gd.y + gd.heights.slice(0, 9).reduce((a, b) => a + b, 0) + 2;
  assert.deepEqual(cellAt(pd, x, y), { sheet: 'Data', row: 10, col: 4, ref: 'Data!D10' });
  assert.equal(cellAt(pd, 2, 2), null, 'outside the cells');
  // pages: down, then across; every page within the page size limits
  const second = dl.pages[pData + 1].grid!;
  assert.equal(second.cols[0], gd.cols[0], 'next page continues downwards');
  assert.equal(second.rows[0], gd.rows[gd.rows.length - 1] + 1);
  // every page is a sheet of A4 paper with the cells inside its margins
  for (const p of dl.pages) {
    const gg = p.grid!;
    const a4 = [XLSX_PAGE.portrait, XLSX_PAGE.landscape].some(([w, h]) => Math.abs(p.w - w) < 0.02 && Math.abs(p.h - h) < 0.02);
    assert.ok(a4, `A4 page (${p.w} × ${p.h})`);
    assert.ok(gg.x + gg.widths.reduce((a, b) => a + b, 0) <= p.w - XLSX_PAGE.margin + 0.01);
    assert.ok(gg.y + gg.heights.reduce((a, b) => a + b, 0) <= p.h - XLSX_PAGE.margin + 0.01);
  }
  // the stored layout keeps the grid
  const back = parseDisplayList(JSON.stringify(dl));
  assert.deepEqual(back.pages[pData].grid, gd);
});

test('xlsx: shared strings, booleans, errors, hidden rows and columns, styles from styles.xml', async () => {
  const sst = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>plain</t></si><si><r><t>rich </t></r><r><t>text</t></r><rPh><t>ignored</t></rPh></si></sst>';
  const styles = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color theme="4" tint="-0.5"/><name val="Arial"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders><border/><border><left style="thin"><color indexed="10"/></left><bottom style="medium"/></border></borders><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="1" fillId="2" borderId="1" applyNumberFormat="1"><alignment horizontal="center"/></xf></cellXfs></styleSheet>`;
  const data =
    row(1, `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>`) +
    row(2, `<c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#DIV/0!</v></c>`) +
    row(3, num('A3', 3.14159, 1) + str('C3', 'hidden col')) +
    row(4, str('A4', 'hidden row'), ' hidden="1"') +
    row(5, str('A5', 'after'));
  const dl = await lay(xlsx([{ name: 'S', data, extra: '<cols><col min="3" max="3" width="9" hidden="1"/></cols>' }], { 'xl/sharedStrings.xml': sst, 'xl/styles.xml': styles }));
  const t = texts(dl, 0).map((o) => o.s);
  for (const s of ['plain', 'rich text', 'TRUE', '#DIV/0!', '3.142', 'after']) assert.ok(t.includes(s), `shows ${s}`);
  assert.ok(!t.includes('hidden col') && !t.includes('hidden row') && !t.includes('ignored'));
  assert.ok(!t.includes('C') && !t.includes('4'), 'hidden column / row have no headings either');
  const styled = at(dl, 0, '3.142');
  assert.equal(styled.b, 1);
  assert.equal(styled.i, 1);
  assert.equal(styled.z, 14);
  assert.ok(styled.c && styled.c !== '#4472c4', 'theme colour with tint (darker)');
  assert.ok(dl.pages[0].ops.some((o) => o.k === 'r' && o.fill === '#ffff00'), 'solid fill');
  assert.ok(dl.pages[0].ops.some((o) => o.k === 'l' && o.stroke === '#ff0000'), 'indexed border colour');
  assert.ok(dl.pages[0].ops.some((o) => o.k === 'l' && o.lw === 1.5), 'medium border');
  // TRUE centred, error centred
  const tr = at(dl, 0, 'TRUE');
  const g = dl.pages[0].grid!;
  assert.ok(Math.abs(tr.x + (tr.w ?? 0) / 2 - (g.x + g.widths[0] / 2)) < 0.5);
});

test('xlsx: formulas without a stored result are noted, never computed', async () => {
  const dl = await lay(xlsx([{ name: 'F', data: row(1, num('A1', 2) + num('A2', 3)) + row(2, '<c r="B1"><f>A1*A2</f></c>') }]));
  assert.ok(dl.notes.includes('formulas-no-value'));
  assert.ok(!texts(dl, 0).some((o) => o.s === '6'), 'no invented result');
});

test('xlsx: limits — page count, cell count; empty and hidden-only workbooks', async () => {
  const many = Array.from({ length: 400 }, (_, i) => row(i + 1, num(`A${i + 1}`, i))).join('');
  await assert.rejects(lay(xlsx([{ name: 'L', data: many }]), { maxPages: 2 }), /more than 2 pages/);
  await assert.rejects(lay(xlsx([{ name: 'L', data: many }]), { maxCells: 100 }), /more than 100 filled cells/);
  await assert.rejects(lay(xlsx([{ name: 'E', data: '' }])), /no visible cells/);
  await assert.rejects(lay(xlsx([{ name: 'H', data: row(1, num('A1', 1)), state: 'hidden' }])), /no visible cells/);
});

test('xlsx: a DOCTYPE in a worksheet is refused; external links are not read', async () => {
  const bad = writeZip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rS1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rS1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rX" Type="x/externalLink" Target="https://evil.example/book.xlsx" TargetMode="External"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "a">]><worksheet/>',
  });
  await assert.rejects(lay(bad), /DOCTYPE/);
  const ok = await lay(
    xlsx([{ name: 'S', data: row(1, num('A1', 1)) }], {
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://evil.example/book.xlsx" TargetMode="External"/></Relationships>',
    }),
  );
  assert.ok(ok.notes.includes('external-links'));
  assert.ok(!JSON.stringify(ok).includes('evil.example'));
});

test('xlsx: a tiny sheet is a normal A4 page with the cells at their real size in the top-left corner (OneNote-style)', async () => {
  const styles = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts><font><sz val="11"/><name val="Calibri"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="lightGrid"><fgColor rgb="FF00FF00"/></patternFill></fill></fills><borders><border/></borders><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`;
  const dl = await lay(xlsx([{ name: 'Sheet1', data: row(1, num('A1', 1)) }], { 'xl/styles.xml': styles }));
  assert.equal(dl.pages.length, 1);
  const p = dl.pages[0];
  assert.deepEqual([p.w, p.h], [595.28, 841.89], 'A4 portrait');
  const one = texts(dl, 0).find((o) => o.s === '1' && o.z === 11) as T;
  assert.ok(one && one.z === 11, 'cell text at its real size (11 pt)');
  assert.ok(p.grid!.x < 80 && p.grid!.y < 80, 'cells start at the top-left margin');
  assert.ok(!dl.notes.includes('patterns'), 'an unused patterned fill in styles.xml is not reported');
  // wide sheets go landscape
  const wide = await lay(xlsx([{ name: 'W', data: row(1, Array.from({ length: 12 }, (_, i) => num(`${colName(i + 1)}1`, i)).join('')) }]));
  assert.deepEqual([wide.pages[0].w, wide.pages[0].h], [841.89, 595.28], 'A4 landscape');
});
