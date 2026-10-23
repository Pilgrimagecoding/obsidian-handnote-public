// 0.9 Phase 4: PowerPoint (.pptx) import — slides as fixed pages from masters, layouts and slides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ZipArchive } from '../../src/import/zip';
import { layoutPptx } from '../../src/import/pptx';
import { detectFormat } from '../../src/import/detect';
import { parseDisplayList, type DLOp, type DisplayList } from '../../src/import/display-list';
import { fixedMeasurer, pptx, sp } from './ooxml-helpers';

const lay = (bytes: Uint8Array, maxPages?: number) => layoutPptx(new ZipArchive(bytes), { measure: fixedMeasurer, ...(maxPages ? { maxPages } : {}) });
type T = Extract<DLOp, { k: 't' }>;
const texts = (dl: DisplayList, page: number) => dl.pages[page].ops.filter((o): o is T => o.k === 't');
const opsOf = <K extends DLOp['k']>(dl: DisplayList, page: number, k: K) => dl.pages[page].ops.filter((o): o is Extract<DLOp, { k: K }> => o.k === k);
const fixture = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/import/${n}`));

test('0.9 pptx: the sample deck (python-pptx) becomes one 16:9 page per slide', async () => {
  const bytes = fixture('sample.pptx');
  const det = await detectFormat(bytes, 'sample.pptx', async (e) => (await new ZipArchive(bytes).text(e.name)) ?? '');
  assert.equal(det.kind, 'pptx');
  const dl = await lay(bytes);
  assert.equal(dl.kind, 'pptx');
  assert.equal(dl.pages.length, 4);
  for (const p of dl.pages) assert.deepEqual([Math.round(p.w), Math.round(p.h)], [960, 540]);
  // slide 1: title placeholder centred by the master's title style, subtitle below
  const [title, sub] = texts(dl, 0);
  assert.equal(title.s, 'HandNote slides test');
  assert.equal(title.z, 44);
  // python-pptx keeps the 4:3 template's placeholder boxes on a 16:9 slide: the title box spans
  // 54…666 pt (as PowerPoint and LibreOffice show it), and the title is centred in that box
  assert.ok(Math.abs(title.x + (title.w ?? 0) / 2 - 360) < 2, `title centred in its box (${title.x})`);
  assert.equal(sub.s, 'Subtitle: one page per slide');
  assert.ok(sub.y > title.y);
  // subtitle colour: tx1 tinted 75 % in the layout → a mid grey (Office tints in linear light)
  const grey = parseInt((sub.c ?? '#000000').slice(1, 3), 16);
  assert.ok(grey > 110 && grey < 160, `subtitle grey ${sub.c}`);
});

test('0.9 pptx: bullets and levels follow the master body style', async () => {
  const dl = await lay(fixture('sample.pptx'));
  const t = texts(dl, 1);
  const at = (s: string) => t.find((o) => o.s === s) as T;
  assert.equal(t[0].s, 'Bullets and levels');
  assert.equal(t.filter((o) => o.s === '•').length, 3);
  assert.equal(t.filter((o) => o.s === '–').length, 2);
  assert.ok(at('Sub point A').x > at('First point').x, 'level 2 is indented');
  assert.ok(at('Sub point A').z < at('First point').z, 'level 2 is smaller');
  assert.ok(at('中文要点：幻灯片导入'));
  // a bullet sits left of its text on the same baseline
  const b = t[t.indexOf(at('First point')) - 1];
  assert.equal(b.s, '•');
  assert.equal(b.y, at('First point').y);
  assert.ok(b.x < at('First point').x);
});

test('0.9 pptx: background, picture, shapes, connector and text box (slide 3)', async () => {
  const dl = await lay(fixture('sample.pptx'));
  const p = dl.pages[2];
  assert.equal(p.bg, '#fff4d6');
  const img = opsOf(dl, 2, 'img')[0];
  assert.equal(img.part, 'ppt/media/image1.png');
  assert.deepEqual([img.x, img.y, img.w, img.h], [72, 72, 288, 144]);
  const rect = opsOf(dl, 2, 'r').find((r) => r.fill === '#c01010');
  assert.ok(rect && rect.stroke === '#000000', 'red rectangle with a black line');
  assert.ok(opsOf(dl, 2, 'e').some((e) => e.fill === '#10a040'), 'green ellipse');
  // rounded rectangle from the theme style: accent1 fill, white text (fontRef lt1)
  const rr = opsOf(dl, 2, 'pg').find((g) => g.fill === '#4f81bd');
  assert.ok(rr && rr.c === 1 && rr.pts.length > 20, 'rounded rectangle outline');
  assert.equal(texts(dl, 2).find((o) => o.s === 'Theme-styled shape')?.c, '#ffffff');
  // straight connector, 3 pt
  const line = opsOf(dl, 2, 'pg').find((g) => !g.c && g.stroke);
  assert.ok(line && line.lw === 3 && line.pts.length === 4);
  // right-aligned text box: its text ends at the box's right edge minus the inset
  const tb = texts(dl, 2).find((o) => o.s === 'Text box, right') as T;
  assert.equal(tb.b, 1);
  assert.equal(tb.z, 24);
  assert.ok(Math.abs(tb.x + (tb.w ?? 0) - (9.5 * 72 + 3 * 72 - 7.2)) < 1, `right edge ${tb.x + (tb.w ?? 0)}`);
});

test('0.9 pptx: tables use PowerPoint\'s default table style (header row, banded rows)', async () => {
  const dl = await lay(fixture('sample.pptx'));
  const fills = opsOf(dl, 3, 'r').map((r) => r.fill);
  assert.equal(fills.length, 9);
  assert.deepEqual(fills.slice(0, 3), ['#4f81bd', '#4f81bd', '#4f81bd']);
  assert.ok(fills[3] !== fills[6], 'banded rows differ');
  const head = texts(dl, 3).find((o) => o.s === 'R1C1') as T;
  assert.equal(head.c, '#ffffff');
  assert.equal(head.b, 1);
  assert.equal(texts(dl, 3).find((o) => o.s === 'R2C2')?.b, undefined);
  assert.ok(opsOf(dl, 3, 'l').length >= 12, 'cell borders');
});

test('0.9 pptx: groups, cropped and rotated pictures, CJK text (python-pptx and LibreOffice-written files)', async () => {
  for (const f of ['rich.pptx', 'rich-libreoffice.pptx']) {
    const dl = await lay(fixture(f));
    assert.equal(dl.pages.length, 2, f);
    assert.ok(texts(dl, 0).some((o) => o.s.includes('线性方程组')), `${f}: Chinese title`);
    // six group members inside the slide, left to right
    const shapes = dl.pages[1].ops.filter((o) => (o.k === 'pg' && o.fill) || o.k === 'r');
    assert.ok(shapes.length >= 6, `${f}: group members ${shapes.length}`);
    for (const s of shapes) {
      const xs = s.k === 'pg' ? s.pts.filter((_, i) => i % 2 === 0) : [s.x, s.x + s.w];
      assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= dl.pages[1].w, `${f}: shape inside the slide`);
    }
    const imgs = opsOf(dl, 1, 'img');
    assert.equal(imgs.length, 2, f);
    const cropped = imgs.find((i) => i.crop);
    assert.ok(cropped && Math.abs(cropped.crop![2] - 0.5) < 0.01, `${f}: right half cropped`);
    const rotated = imgs.find((i) => i.rot);
    assert.ok(rotated && Math.abs((rotated.rot ?? 0) - 30) < 0.5, `${f}: rotated 30°`);
    // bottom-anchored text box: the last line ends near the bottom of the box (5.5 in + 1.5 in)
    const tb = texts(dl, 1).filter((o) => !/线性/.test(o.s));
    assert.ok(tb.length >= 2, `${f}: wrapped text box`);
    assert.ok(tb[tb.length - 1].y > 6.4 * 72 && tb[tb.length - 1].y < 7 * 72, `${f}: bottom anchored (${tb[tb.length - 1].y})`);
  }
});

test('0.9 pptx: theme colours through the colour map, modifiers, hyperlinks', async () => {
  const fill = (c: string) => `<a:solidFill>${c}</a:solidFill>`;
  const dl = await lay(
    pptx([
      {
        tree:
          sp({ x: 0, y: 0, w: 1, h: 1, prst: 'rect', fill: fill('<a:schemeClr val="accent2"/>') }) +
          sp({ x: 1, y: 0, w: 1, h: 1, prst: 'rect', fill: fill('<a:schemeClr val="bg1"/>') }) +
          sp({ x: 2, y: 0, w: 1, h: 1, prst: 'rect', fill: fill('<a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr>') }) +
          sp({ x: 3, y: 0, w: 1, h: 1, prst: 'rect', fill: fill('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>') }) +
          sp({ x: 4, y: 0, w: 1, h: 1, prst: 'rect', fill: '<a:noFill/>', ln: '<a:ln w="25400"><a:solidFill><a:prstClr val="black"/></a:solidFill><a:prstDash val="dash"/></a:ln>' }) +
          sp({ x: 0, y: 2, w: 4, h: 1, body: '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:hlinkClick r:id="rIdX"/></a:rPr><a:t>link</a:t></a:r></a:p></p:txBody>' }),
        rels: [['rIdX', 'hyperlink', 'https://example.com/']],
      },
    ]),
  );
  const r = opsOf(dl, 0, 'r');
  assert.equal(r[0].fill, '#c0504d');
  assert.equal(r[1].fill, '#ffffff');
  assert.ok(parseInt(r[2].fill!.slice(5, 7), 16) < 0xbd, 'lumMod darkens');
  assert.equal(r[3].fill, '#ff000080');
  assert.ok(!r[4].fill && r[4].stroke === '#000000' && r[4].lw === 2 && r[4].dash?.length === 2, 'dashed outline, no fill');
  const link = texts(dl, 0)[0];
  assert.equal(link.c, '#0000ff');
  assert.equal(link.u, 1);
  assert.ok(!JSON.stringify(dl).includes('example.com'), 'hyperlink targets are not kept');
});

test('0.9 pptx: placeholders inherit position from the layout and text style from the master', async () => {
  const ph = (type: string) => `<p:ph ${type}/>`;
  const body = (t: string[]) => `<p:txBody><a:bodyPr/><a:lstStyle/>${t.map((s) => `<a:p><a:r><a:t>${s}</a:t></a:r></a:p>`).join('')}</p:txBody>`;
  const dl = await lay(pptx([{ tree: sp({ x: 0, y: 0, w: 0, h: 0, xfrm: false, ph: ph('type="title"'), body: body(['Inherited title']) }) + sp({ x: 0, y: 0, w: 0, h: 0, xfrm: false, ph: ph('idx="1"'), body: body(['one', 'two']) }) }]));
  const [t, b1, one, b2, two] = texts(dl, 0);
  assert.equal(t.s, 'Inherited title');
  assert.equal(t.z, 44);
  assert.ok(t.y > 274638 / 12700 && t.y < (274638 + 1143000) / 12700, 'inside the layout title box');
  assert.ok(Math.abs(t.x + (t.w ?? 0) / 2 - 360) < 2, 'centred by the master title style');
  assert.deepEqual([b1.s, one.s, b2.s, two.s], ['•', 'one', '•', 'two']);
  assert.equal(one.z, 32);
  assert.ok(one.x >= 36 + 27, 'body text after the hanging indent');
  assert.ok(one.y > 1600200 / 12700, 'inside the layout body box');
});

test('0.9 pptx: autofit scale, anchoring, numbering, no wrapping', async () => {
  const tx = (bodyPr: string, paras: string) => `<p:txBody>${bodyPr}<a:lstStyle/>${paras}</p:txBody>`;
  const p = (s: string, pPr = '') => `<a:p>${pPr}<a:r><a:rPr sz="2000"/><a:t>${s}</a:t></a:r></a:p>`;
  const num = '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicParenR"/></a:pPr>';
  const dl = await lay(
    pptx([
      {
        tree:
          sp({ x: 0, y: 0, w: 4, h: 2, body: tx('<a:bodyPr anchor="b"><a:normAutofit fontScale="50000"/></a:bodyPr>', p('scaled')) }) +
          sp({ x: 0, y: 2, w: 4, h: 2, body: tx('<a:bodyPr/>', p('a', num) + p('b', num) + p('c', num)) }) +
          sp({ x: 0, y: 4, w: 0.5, h: 1, body: tx('<a:bodyPr wrap="none"/>', p('this line is not wrapped')) }),
      },
    ]),
  );
  const t = texts(dl, 0);
  const scaled = t.find((o) => o.s === 'scaled') as T;
  assert.equal(scaled.z, 10);
  assert.ok(scaled.y > 1.5 * 72 && scaled.y < 2 * 72, `anchored at the bottom (${scaled.y})`);
  assert.deepEqual(t.filter((o) => /^\d\)$/.test(o.s)).map((o) => o.s), ['1)', '2)', '3)']);
  assert.equal(t.filter((o) => o.s.startsWith('this line')).length, 1);
});

test('0.9 pptx: charts, SmartArt, media and hidden slides are listed, never invented', async () => {
  const frame = (uri: string) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="g"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdC"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const dl = await lay(
    pptx([
      { tree: frame('http://schemas.openxmlformats.org/drawingml/2006/chart') + frame('http://schemas.openxmlformats.org/drawingml/2006/diagram'), attrs: 'show="0"' },
      { tree: '<p:contentPart r:id="rIdI"/>' },
    ]),
  );
  for (const n of ['charts', 'smartart', 'hidden-slides', 'ink']) assert.ok(dl.notes.includes(n), `note ${n}`);
  assert.equal(dl.pages[0].ops.length, 0, 'nothing drawn in place of a chart');
});

test('0.9 pptx: remote pictures are never referenced; a DOCTYPE is refused; slide limit', async () => {
  const pic = '<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdR"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>';
  const dl = await lay(pptx([{ tree: pic, rels: [['rIdR', 'image', 'https://evil.example/track.png']] }]));
  assert.equal(opsOf(dl, 0, 'img').length, 0);
  assert.ok(!JSON.stringify(dl).includes('evil.example'));
  const bomb = pptx([{ tree: '' }], { 'ppt/theme/theme1.xml': '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><a:theme/>' });
  await assert.rejects(lay(bomb), /DOCTYPE/);
  await assert.rejects(lay(pptx([{ tree: '' }, { tree: '' }, { tree: '' }]), 2), /more than 2 slides/);
});

test('0.9 pptx: background picture and the stored layout round trip (new ops validated)', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const bg = '<p:bgPr><a:blipFill><a:blip r:embed="rIdB"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr>';
  const dl = await lay(pptx([{ tree: sp({ x: 1, y: 1, w: 2, h: 1, prst: 'star5', fill: '<a:solidFill><a:srgbClr val="FFC000"/></a:solidFill>', rot: 45 }), bg, rels: [['rIdB', 'image', '../media/bg.png']] }], { 'ppt/media/bg.png': png }));
  const ops = dl.pages[0].ops;
  assert.deepEqual(ops[0], { k: 'img', x: 0, y: 0, w: 720, h: 540, part: 'ppt/media/bg.png' });
  const star = ops.find((o) => o.k === 'pg') as Extract<DLOp, { k: 'pg' }>;
  assert.equal(star.pts.length, 20);
  const back = parseDisplayList(JSON.stringify(dl));
  assert.deepEqual(back.pages, dl.pages);
  const bad = parseDisplayList(JSON.stringify({ v: 1, kind: 'pptx', fonts: [], notes: [], pages: [{ w: 100, h: 100, ops: [{ k: 'pg', pts: [1, 2, 3] }, { k: 'pg', pts: [0, 0, 'x', 1] }, { k: 'e', x: 0, y: 0, w: 1, h: 1, fill: 'javascript:x' }, { k: 'img', x: 0, y: 0, w: 1, h: 1, part: 'a.png', crop: [0, 0, 5, 0] }] }] }));
  assert.deepEqual(bad.pages[0].ops, [{ k: 'e', x: 0, y: 0, w: 1, h: 1 }, { k: 'img', x: 0, y: 0, w: 1, h: 1, part: 'a.png' }]);
});

test('0.9 pptx: arcs and rings are drawn as their outline; unknown shapes are not filled over the slide', async () => {
  const fill = '<a:solidFill><a:srgbClr val="1060C0"/></a:solidFill>';
  const shape = (prst: string, x: number, av = '') => sp({ x, y: 0, w: 2, h: 2, prst, fill }).replace('<a:avLst/>', `<a:avLst>${av}</a:avLst>`);
  const dl = await lay(pptx([{ tree: shape('blockArc', 0, '<a:gd name="adj1" fmla="val 10800000"/><a:gd name="adj2" fmla="val 0"/><a:gd name="adj3" fmla="val 20000"/>') + shape('donut', 2) + shape('pie', 4) + shape('circularArrow', 6) + shape('irregularSeal2', 8) + sp({ x: 8, y: 0, w: 2, h: 2, prst: 'irregularSeal2', fill, text: 'kept' }) }]));
  const pgs = opsOf(dl, 0, 'pg');
  assert.equal(pgs.length, 4, 'four drawn shapes');
  // the block arc (upper half ring, 180° → 0° clockwise): nothing below the centre line, nothing in the hole
  const arc = pgs[0];
  const ys = arc.pts.filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...ys) <= 72 + 0.01, 'upper half only');
  assert.ok(Math.min(...ys) < 1, 'reaches the top');
  // donut: outer and inner ring as two sub-paths (even-odd fill leaves the hole)
  assert.deepEqual(pgs[1].brk, [48]);
  // the unknown shape: no fill drawn, its text still shown, and noted
  assert.ok(!opsOf(dl, 0, 'r').length, 'no rectangle in place of an unknown shape');
  assert.ok(texts(dl, 0).some((o) => o.s === 'kept'));
  assert.ok(dl.notes.includes('shapes'));
});

test('0.9 pptx: text of rotated shapes turns with the shape; vertical CJK text is stacked upright', async () => {
  const tb = (bodyPr: string, t: string, rot = 0, tall = false) => sp({ x: 1, y: 1, w: tall ? 1 : 3, h: tall ? 3 : 1, rot, body: `<p:txBody>${bodyPr}<a:lstStyle/><a:p><a:r><a:rPr sz="2000"/><a:t>${t}</a:t></a:r></a:p></p:txBody>` });
  const dl = await lay(pptx([{ tree: tb('<a:bodyPr/>', 'turned', 30) }, { tree: tb('<a:bodyPr vert="eaVert"/>', '关键要点', 0, true) }]));
  const t = texts(dl, 0)[0];
  assert.equal(t.rot, 30);
  assert.deepEqual([t.ox, t.oy], [2.5 * 72, 1.5 * 72]);
  const v = texts(dl, 1);
  assert.deepEqual(v.map((o) => o.s), ['关', '键', '要', '点']);
  assert.ok(v.every((o) => !o.rot), 'upright');
  assert.ok(v.every((o) => Math.abs(o.x - v[0].x) < 0.01), 'one column');
  assert.ok(v[1].y > v[0].y && v[3].y > v[2].y, 'top to bottom');
  // the stored layout keeps the rotation (validated on read)
  const back = parseDisplayList(JSON.stringify(dl));
  assert.equal((back.pages[0].ops.find((o) => o.k === 't') as T).rot, 30);
});
