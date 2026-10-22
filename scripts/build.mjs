// Build script: `node scripts/build.mjs production|watch|lab [--private]`
// Default: PUBLIC edition (no local math model). `--private` (or HN_EDITION=private): private edition.
import esbuild from 'esbuild';

if (process.argv.includes('--private')) process.env.HN_EDITION = 'private';
const { labConfig, pluginConfig } = await import('./build-config.mjs');
const { buildWorker } = await import('./build-worker.mjs');
const { buildEmbeddedOrt } = await import('./build-embedded-ort.mjs');
const { EDITION } = await import('./edition.mjs');
console.log(`HandNote ${EDITION} edition`);

await buildWorker();
console.log(buildEmbeddedOrt().info);

const mode = process.argv[2] ?? 'production';
if (mode === 'production') {
  await esbuild.build(pluginConfig);
} else if (mode === 'watch') {
  const ctx = await esbuild.context({ ...pluginConfig, sourcemap: 'inline' });
  await ctx.watch();
} else if (mode === 'lab') {
  await esbuild.build(labConfig);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(1);
}
