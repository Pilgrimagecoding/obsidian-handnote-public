import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEditorSettings, defaultEditorSettings } from '../../src/editor/settings';
import { EXPERIMENTAL_FOUNTAIN } from '../../src/ink/presets';
import { calibration } from '../../src/ui/panels';
import { InputDiagnostics } from '../../src/input/diagnostics';

test('v0.2 settings get the v0.3 pen model once (colours kept, palette and presets added)', () => {
  // the parameters from the first iPad report (saved by 0.2.0-beta.1)
  const beta1 = { width: 2.4, pressureSensitivity: 0.85, smoothing: 0.5, tapering: 0.45, opacity: 1, velocityThinning: 0.12, nibFlatness: 0.12, nibAngle: -35, pressureCurve: 0, minWidthRatio: 0.2, maxWidthRatio: 4, pressureSmoothing: 0.7, typicalPressure: 0.06 };
  const s = sanitizeEditorSettings({ fountainVariant: 'experimental', experimental: beta1, pens: { fountain: { color: '#123456', params: {} } }, tool: 'ballpoint' });
  assert.deepEqual(s.experimental, EXPERIMENTAL_FOUNTAIN);
  assert.equal(s.pens.fountain.color, '#123456');
  assert.equal(s.penModel, 3);
  assert.equal(s.tool, 'fountain', 'ballpoint is no longer offered');
  assert.equal(s.widthPresets.fountain.length, 3);
  // once migrated, the user's own values are kept
  const again = sanitizeEditorSettings({ ...s, experimental: { ...s.experimental, width: 3.1 } });
  assert.equal(again.experimental.width, 3.1);
});

test('palette: new colours go to the front; duplicates move to the front instead of repeating', async () => {
  const { addPaletteColor } = await import('../../src/editor/settings');
  const p = ['#1a1a1a', '#c62828', '#1f6fe5'];
  assert.deepEqual(addPaletteColor(p, '#00FF00'), ['#00ff00', '#1a1a1a', '#c62828', '#1f6fe5']);
  assert.deepEqual(addPaletteColor(p, '#1F6FE5'), ['#1f6fe5', '#1a1a1a', '#c62828']);
  assert.deepEqual(addPaletteColor(p, 'red'), p, 'invalid colours are ignored');
});

test('fresh install and v0.1 settings get the data-based defaults', () => {
  for (const s of [defaultEditorSettings(), sanitizeEditorSettings({}), sanitizeEditorSettings({ tool: 'fountain', usePrediction: true })]) {
    assert.equal(s.experimental.typicalPressure, EXPERIMENTAL_FOUNTAIN.typicalPressure);
    assert.equal(s.experimental.heavyPressure, EXPERIMENTAL_FOUNTAIN.heavyPressure);
  }
});

test('calibrate from my writing: typical = median, heavy = p99 kept above typical', () => {
  assert.deepEqual(calibration(0.123, 0.43), { typical: 0.12, heavy: 0.43 });
  assert.deepEqual(calibration(0.3, 0.32), { typical: 0.3, heavy: 0.54 }); // heavy at least 1.8 × typical
  assert.deepEqual(calibration(0.01, 0.02), { typical: 0.05, heavy: 0.15 });
  assert.deepEqual(calibration(0.9, 1.2), { typical: 0.8, heavy: 1 });
});

test('diagnostics report suggests a calibration and states the collection period', () => {
  const d = new InputDiagnostics();
  d.setEnabled(true);
  d.strokeBegin('pen', 0, 0.1);
  for (let i = 1; i < 400; i++) d.sample(i * 4, 0.05 + 0.3 * ((i * 37) % 100) / 100, 'pen');
  d.strokeEnd(1600, null);
  const r = d.report();
  assert.match(r, /suggested calibration: typical 0\.\d\d · heavy 0\.\d\d/);
  assert.match(r, /collection: ON since \d{4}-/);
});
