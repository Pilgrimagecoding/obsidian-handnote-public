// Unit tests: bundle tests/unit/*.test.ts with esbuild, then run them with node's built-in test runner.
// No test framework dependency is needed (works offline after `npm install`).
import esbuild from 'esbuild';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.argv.includes('--private')) process.env.HN_EDITION = 'private';
const { buildEmbeddedOrt } = await import('./build-embedded-ort.mjs');
const { buildWorker } = await import('./build-worker.mjs');
const { EDITION, editionOptions } = await import('./edition.mjs');

buildEmbeddedOrt();
await buildWorker();
console.log(`unit tests, ${EDITION} edition`);

const dir = 'tests/unit';
const out = 'build/tests';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
await esbuild.build({
  entryPoints: files.map((f) => path.join(dir, f)),
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outExtension: { '.js': '.mjs' },
  external: ['node:*'],
  logLevel: 'warning',
  ...editionOptions(),
});
const testFiles = readdirSync(out).filter((f) => f.endsWith('.mjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...testFiles], { stdio: 'inherit' });
process.exit(r.status ?? 1);
