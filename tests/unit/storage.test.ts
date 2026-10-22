import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictCopyPath, decideExternalChange, decideSave } from '../../src/storage/sync-guard';
import { serializeDocument } from '../../src/document/codec';
import { createDocument } from '../../src/document/model';
import { sanitizeEditorSettings, defaultEditorSettings } from '../../src/editor/settings';
import { sanitizePluginSettings } from '../../src/plugin/plugin-settings';

test('save decision: write only over the revision we loaded', () => {
  const doc = createDocument();
  doc.revision = 5;
  const disk = serializeDocument(doc);
  assert.deepEqual(decideSave(disk, { docId: doc.id, revision: 5 }), { action: 'write' });
  // another device saved revision 6 meanwhile (arrived via Remotely Save)
  const other = serializeDocument({ ...doc, revision: 6, device: 'ipad' });
  const d = decideSave(other, { docId: doc.id, revision: 5 });
  assert.equal(d.action, 'conflict');
  // sync rolled the file back to an older revision: also never overwrite silently
  assert.equal(decideSave(serializeDocument({ ...doc, revision: 3 }), { docId: doc.id, revision: 5 }).action, 'conflict');
  // file replaced by a different note with the same name
  assert.equal(decideSave(serializeDocument(createDocument()), { docId: doc.id, revision: 5 }).action, 'conflict');
  // unreadable on-disk content
  assert.equal(decideSave('garbage', { docId: doc.id, revision: 5 }).action, 'conflict');
  // deleted
  assert.equal(decideSave(null, { docId: doc.id, revision: 5 }).action, 'missing');
  // empty new file
  assert.equal(decideSave('', { docId: doc.id, revision: 0 }).action, 'write');
});

test('external change decision', () => {
  const doc = createDocument();
  doc.revision = 7;
  const own = serializeDocument(doc);
  assert.equal(decideExternalChange(own, { lastWrittenRevision: 7, docId: doc.id, dirty: false }), 'ignore-own-write');
  const theirs = serializeDocument({ ...doc, revision: 8 });
  assert.equal(decideExternalChange(theirs, { lastWrittenRevision: 7, docId: doc.id, dirty: false }), 'reload');
  assert.equal(decideExternalChange(theirs, { lastWrittenRevision: 7, docId: doc.id, dirty: true }), 'keep-local-and-resolve-on-save');
});

test('conflict copy names are unique and keep the extension', () => {
  const date = new Date(2026, 9, 18, 15, 32);
  const taken = new Set(['Notes/视觉伺服 (conflict 2026-10-18 1532).handnote']);
  const p = conflictCopyPath('Notes/视觉伺服.handnote', date, (x) => taken.has(x));
  assert.equal(p, 'Notes/视觉伺服 (conflict 2026-10-18 1532 2).handnote');
  assert.equal(conflictCopyPath('a.handnote', date, () => false), 'a (conflict 2026-10-18 1532).handnote');
  assert.ok(!p.split('/').pop()!.startsWith('_'), 'never starts with "_" (Remotely Save would skip it)');
});

test('settings are sanitized and defaults are complete', () => {
  const d = defaultEditorSettings();
  assert.deepEqual(sanitizeEditorSettings(undefined), d);
  const s = sanitizeEditorSettings({ tool: 'flamethrower', pens: { fountain: { color: 'red', params: { width: -3 } } }, eraserRadius: 1000 });
  assert.equal(s.tool, 'fountain');
  assert.equal(s.pens.fountain.color, d.pens.fountain.color);
  assert.ok(s.pens.fountain.params.width >= 0.1);
  assert.equal(s.eraserRadius, 60);
  const ps = sanitizePluginSettings({ embedMaxPages: -1, deviceId: 'dev-abc123' });
  assert.equal(ps.embedMaxPages, 3);
  assert.equal(ps.deviceId, 'dev-abc123');
  assert.ok(sanitizePluginSettings(null).deviceId.startsWith('dev-'));
});
