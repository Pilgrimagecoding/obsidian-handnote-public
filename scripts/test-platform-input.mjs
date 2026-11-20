// Run input routing regressions on each desktop OS without unrelated renderer fixtures.
import esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('build/platform-input', { recursive: true });
await esbuild.build({
  entryPoints: ['tests/unit/input-router.test.ts'],
  outfile: 'build/platform-input/input-router.test.mjs',
  bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['node:*'],
});
const result = spawnSync(process.execPath, ['--test', 'build/platform-input/input-router.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
