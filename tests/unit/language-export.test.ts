import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePluginSettings } from '../../src/plugin/plugin-settings';
import { onLanguageChange, setLanguage, t } from '../../src/ui/i18n';
import { documentMenuActions } from '../../src/ui/document-actions';
import { pdfExportScale, pagesToPdf } from '../../src/rendering/pdf-export';

test('language preference migrates old settings and persists explicit overrides', () => {
  assert.equal(sanitizePluginSettings({}).language, 'system');
  for (const language of ['zh', 'en', 'system']) assert.equal(sanitizePluginSettings({ language }).language, language);
  assert.equal(sanitizePluginSettings({ language: 'bogus' }).language, 'system');
});

test('existing document actions follow language changes and route distinct operations', () => {
  const calls: string[] = [];
  const actions = documentMenuActions((a) => calls.push(a));
  setLanguage('en');
  let changed = 0;
  const stop = onLanguageChange(() => changed++);
  setLanguage('zh');
  assert.match(actions[0].label, /导出/);
  assert.equal(new Set(actions.map((a) => a.icon)).size, actions.length);
  assert.equal(actions.filter((a) => a.diagnostic).length, 1);
  assert.equal(actions.at(-1)?.label, '复制性能报告');
  for (const a of actions) a.run();
  assert.deepEqual(calls, ['png', 'svg', 'pdf', 'import', 'performance']);
  setLanguage('en');
  assert.match(actions[0].label, /Export/);
  assert.equal(t('New handwritten note'), 'New handwritten note');
  assert.equal(changed, 2);
  stop(); setLanguage('zh'); assert.equal(changed, 2);
  setLanguage('en');
});

test('PDF export bounds both canvas area and sides, including huge whiteboards', () => {
  for (const [w, h] of [[595, 842], [10000, 9000], [300000, 100]]) {
    const scale = pdfExportScale(w, h);
    assert.ok(w * scale <= 8192 && h * scale <= 8192);
    assert.ok(w * h * scale ** 2 <= 16_000_001);
  }
  assert.equal(pdfExportScale(595, 842), 300 / 72, 'A4 reaches 300 DPI instead of the old 144 DPI');
  assert.throws(() => pdfExportScale(0, 100));
});

test('cancelled PDF export fails before canvas allocation', async () => {
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(pagesToPdf([{} as never], { signal: ctl.signal }), { name: 'AbortError' });
  await assert.rejects(pagesToPdf([]), /No pages/);
});
