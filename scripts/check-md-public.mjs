// Public 0.12.4: approved beta.9 sources, commit da8451c.
// Intentional MD changes must explicitly update the baseline and its regression tests.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const baseline = {
  "src/inkmd/md-ink-layer.ts": "3cfa3a10f6c901437a59f1c5e2f8987e3af31319f4b8d77fc9d11ca7606f837e",
  "src/inkmd/anchor.ts": "44f333d893004dfb9eb4ed3ec4c93ec6e0142663ce1a0cd860eee6392e0f686c",
  "src/input/input-router.ts": "1f474b5f1d1cdb2876ea9b62f6909adc49ea73f8407380a2ee7aca23a1bb4e84"
};
for (const [file, expected] of Object.entries(baseline)) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/ MD_(?:EXPORT|DIAGNOSTICS)_EXTENSION_BEGIN\n[\s\S]*?^[ \t]*\/\/ MD_(?:EXPORT|DIAGNOSTICS)_EXTENSION_END\n/gm, '').replace(/\n{3,}/g, '\n\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), expected, file + ' must match approved public 0.12.4 baseline');
  console.log('Public MD baseline verified:', file);
}
