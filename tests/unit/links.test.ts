// [[links]] in text boxes: parsing, matching a renamed file, rewriting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentLinks, findLinks, linkNames, retargetDocument, retargetLinks } from '../../src/document/links';
import { createDocument, defaultBackground } from '../../src/document/model';
import type { TextItem } from '../../src/document/items';

const box = (text: string, id = 't1'): TextItem => ({ id, type: 'text', x: 0, y: 0, w: 40, h: 20, created: 0, text, size: 16, color: '#000', font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true });

test('links: wikilinks with heading, block and alias', () => {
  const s = 'see [[Note]] and [[Folder/Other#Part 2|that part]], [[x#^b1]], [[ ]] [[bad';
  const l = findLinks(s);
  assert.deepEqual(l.map((k) => [k.target, k.subpath, k.alias]), [['Note', '', null], ['Folder/Other', '#Part 2', 'that part'], ['x', '#^b1', null]]);
  assert.equal(s.slice(l[0].start, l[0].end), '[[Note]]');
  assert.deepEqual(findLinks('no links'), []);
});

test('links: a link names a file by its whole path or its end, .md optional, any case', () => {
  assert.ok(linkNames('Note', 'Note.md'));
  assert.ok(linkNames('note', 'A/B/Note.md'));
  assert.ok(linkNames('B/Note', 'A/B/Note.md'));
  assert.ok(linkNames('Note.md', 'A/Note.md'));
  assert.ok(linkNames('Sketch.handnote', 'Sketch.handnote'));
  assert.ok(!linkNames('Sketch', 'Sketch.handnote'), 'only Markdown drops its extension');
  assert.ok(!linkNames('ote', 'Note.md'));
  assert.ok(!linkNames('C/Note', 'A/B/Note.md'));
});

test('links: rename rewrites the target, keeps heading and alias, leaves other links', () => {
  const s = 'a [[Old]] b [[Old#H|shown]] c [[Other]]';
  assert.equal(retargetLinks(s, (t) => linkNames(t, 'Old.md'), 'New'), 'a [[New]] b [[New#H|shown]] c [[Other]]');
  assert.equal(retargetLinks('nothing', () => true, 'X'), 'nothing');
});

test('links: whole document — every page, only text boxes, fitted, unchanged pages untouched', () => {
  const doc = createDocument({ width: 600, height: 800, background: defaultBackground('blank') });
  const p0 = doc.pages[0];
  p0.items = [box('[[Old]]'), box('plain', 't2')];
  doc.pages.push({ ...p0, id: 'p2', items: [box('x', 't3')] });
  const untouched = doc.pages[1].items;
  assert.deepEqual(documentLinks(doc).map((l) => l.target), ['Old']);
  const fitted: string[] = [];
  const changed = retargetDocument(doc, (t) => linkNames(t, 'Old.md'), 'Renamed', (it) => (fitted.push(it.text), { ...it, w: 99 }));
  assert.ok(changed);
  assert.equal((doc.pages[0].items[0] as TextItem).text, '[[Renamed]]');
  assert.equal(doc.pages[0].items[0].w, 99);
  assert.deepEqual(fitted, ['[[Renamed]]']);
  assert.equal(doc.pages[1].items, untouched);
  assert.ok(!retargetDocument(doc, (t) => linkNames(t, 'Old.md'), 'Again'));
});
