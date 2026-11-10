// 0.12 Ink on Markdown: where annotations are kept and the `annotates` header field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANNOTATION_FOLDER, annotationPath, isMarkdownPath, parentFolder } from '../../src/document/annotation-path';
import { anchorText, pickAnchorLine, relocateLine, sampleBounds, type DocLines } from '../../src/inkmd/anchor';
import { createDocument, defaultBackground, FORMAT_VERSION } from '../../src/document/model';
import { parseDocument, recoverDocument, requiredVersion, serializeDocument } from '../../src/document/codec';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';

test('md-ink: annotations mirror the note path in a visible folder', () => {
  assert.equal(annotationPath('Courses/ML/Lecture 3.md'), `${ANNOTATION_FOLDER}/Courses/ML/Lecture 3.handnote`);
  assert.equal(annotationPath('Daily.MD'), `${ANNOTATION_FOLDER}/Daily.handnote`);
  assert.equal(annotationPath('a.b.md'), `${ANNOTATION_FOLDER}/a.b.handnote`);
  assert.ok(!ANNOTATION_FOLDER.startsWith('.'), 'not a hidden folder (sync plugins skip those)');
  assert.equal(parentFolder(annotationPath('x.md')), ANNOTATION_FOLDER);
  assert.equal(parentFolder('x.md'), '');
  assert.ok(isMarkdownPath('n.md') && isMarkdownPath('n.MD') && !isMarkdownPath('n.handnote'));
});

test('md-ink: the note link is an optional header field and does not raise the format version', () => {
  const doc = createDocument({ width: 700, height: 1500, background: defaultBackground('blank') });
  const before = requiredVersion(doc);
  doc.annotates = 'Courses/ML/Lecture 3.md';
  assert.equal(requiredVersion(doc), before);
  const text = serializeDocument(doc);
  assert.ok(text.split('\n')[0].includes('"annotates":"Courses/ML/Lecture 3.md"'));
  const back = parseDocument(text);
  assert.equal(back.doc.annotates, 'Courses/ML/Lecture 3.md');
  assert.equal(back.readOnly, false);
  assert.ok(requiredVersion(back.doc) <= FORMAT_VERSION);
  assert.equal(back.doc.pages[0].width, 700);
});

test('md-ink: only a Markdown path is accepted; a note without it has none', () => {
  const doc = createDocument();
  assert.ok(!serializeDocument(doc).includes('annotates'));
  doc.annotates = 'x.md';
  const bad = serializeDocument(doc).replace('"annotates":"x.md"', '"annotates":"../../etc/passwd"');
  assert.equal(parseDocument(bad).doc.annotates, undefined);
});

test('md-ink: the link survives line-based recovery of a damaged file', () => {
  const doc = createDocument({ width: 700, height: 900, background: defaultBackground('blank') });
  doc.annotates = 'Notes/a.md';
  const lines = serializeDocument(doc).split('\n');
  const r = recoverDocument(lines.slice(0, -1).join('\n'));
  assert.equal(r?.doc.annotates, 'Notes/a.md');
});

function docOf(lines: string[]): DocLines {
  const froms: number[] = [];
  let at = 0;
  for (const l of lines) {
    froms.push(at);
    at += l.length + 1;
  }
  return { lines: lines.length, line: (n: number) => ({ from: froms[n - 1], text: lines[n - 1] }) };
}

test('md-ink: a stroke anchor is found again after lines were added or removed while the note was closed', () => {
  const before = ['# 监督学习', '', '逻辑回归是一种分类算法。', '', '损失函数：交叉熵。'];
  const a = { line: 5, text: anchorText(before[4]), top: 120 };
  // three lines added above
  const after = ['# 监督学习', '', '新的一段', '', '又一段', '', '逻辑回归是一种分类算法。', '', '损失函数：交叉熵。'];
  assert.equal(relocateLine(a, docOf(after)), 9);
  // lines removed above
  assert.equal(relocateLine(a, docOf(['损失函数：交叉熵。'])), 1);
  // the line itself was changed: the stroke stays at its line number (never dropped)
  assert.equal(relocateLine(a, docOf(['a', 'b', 'c', 'd', 'e', 'f'])), 5);
  // fewer lines than the number: last line
  assert.equal(relocateLine(a, docOf(['a', 'b'])), 2);
  // the nearest of two identical lines
  assert.equal(relocateLine({ line: 4, text: 'x', top: 0 }, docOf(['x', 'a', 'b', 'c', 'd', 'x'])), 6);
});

test('md-ink: strokes are anchored to a line with text near their centre', () => {
  const d = docOf(['标题', '', '', '正文', '']);
  assert.equal(pickAnchorLine(2, d), 1);
  assert.equal(pickAnchorLine(3, d), 4);
  assert.equal(pickAnchorLine(4, d), 4);
  assert.equal(pickAnchorLine(99, d), 4);
  assert.equal(anchorText('   ## 正则化   '), '## 正则化');
  assert.equal(anchorText('x'.repeat(100)).length, 48);
  const b = sampleBounds([{ x: -20, y: 5 }, { x: 30, y: 9 }], 4);
  assert.deepEqual(b, { x0: -24, y0: 1, x1: 34, y1: 13 });
});

test('md-ink: the stroke anchor is stored with the stroke; strokes in the left margin (x < 0) survive', () => {
  const doc = createDocument({ width: 700, height: 900, background: defaultBackground('blank') });
  doc.pages[0].strokes.push({
    id: 's1',
    tool: 'fountain',
    color: '#d32f2f',
    params: { ...DEFAULT_PEN_PARAMS.fountain },
    zoom: 1,
    hasPressure: true,
    engine: 1,
    created: 1,
    samples: [
      { x: -40.5, y: 100, p: 0.3, t: 0 },
      { x: -10.25, y: 130.5, p: 0.4, t: 8 },
    ],
    anchor: { line: 27, text: '## 正则化', top: 612.37 },
  });
  const back = parseDocument(serializeDocument(doc)).doc.pages[0].strokes[0];
  assert.deepEqual(back.anchor, { line: 27, text: '## 正则化', top: 612.37 });
  assert.ok(Math.abs(back.samples[0].x + 40.5) < 0.01);
  const bad = serializeDocument(doc).replace('"a":{"l":27', '"a":{"l":-3');
  assert.equal(parseDocument(bad).doc.pages[0].strokes[0].anchor, undefined);
});

test('md-ink: text boxes, images and shapes keep their line anchor; a bad anchor is dropped', () => {
  const doc = createDocument({ width: 700, height: 900, background: defaultBackground('blank') });
  doc.annotates = 'n.md';
  doc.pages[0].items.push({ id: 'i1', type: 'text', x: -120, y: 300, w: 80, h: 30, created: 1, text: '旁注', size: 16, color: '#1a1a1a', font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true, anchor: { line: 12, text: '损失函数', top: 288.5 } });
  const text = serializeDocument(doc);
  const back = parseDocument(text).doc.pages[0].items[0];
  assert.deepEqual(back.anchor, { line: 12, text: '损失函数', top: 288.5 });
  assert.equal(back.x, -120, 'items may sit in the margin left of the text');
  assert.equal(requiredVersion(parseDocument(text).doc), requiredVersion(doc));
  const bad = text.replace('"line":12', '"line":-4');
  assert.equal(parseDocument(bad).doc.pages[0].items[0].anchor, undefined);
  assert.equal(parseDocument(bad).doc.pages[0].items[0].type, 'text', 'the item itself is kept');
});

test('md-ink: a highlighter laid on text keeps its characters; a bad span is dropped, the stroke kept', () => {
  const doc = createDocument({ width: 700, height: 900, background: defaultBackground('blank') });
  doc.pages[0].strokes.push({
    id: 's1',
    tool: 'highlighter',
    color: '#ffd54f',
    params: { ...DEFAULT_PEN_PARAMS.highlighter },
    zoom: 1,
    hasPressure: false,
    engine: 1,
    created: 1,
    samples: [
      { x: 10, y: 100, p: 0.5, t: 0 },
      { x: 60, y: 100, p: 0.5, t: 8 },
    ],
    anchor: { line: 5, text: '损失函数：交叉熵。', top: 96 },
    span: { s: 5, e: 8, t: '交叉熵', oy: -1.25, h: 26.7 },
  });
  const text = serializeDocument(doc);
  const back = parseDocument(text).doc.pages[0].strokes[0];
  assert.deepEqual(back.span, { s: 5, e: 8, t: '交叉熵', oy: -1.25, h: 26.7 });
  assert.equal(requiredVersion(parseDocument(text).doc), requiredVersion(doc), 'no format version bump');
  const bad = parseDocument(text.replace('"e":8', '"e":2')).doc.pages[0].strokes[0];
  assert.equal(bad.span, undefined);
  assert.equal(bad.tool, 'highlighter');
});
