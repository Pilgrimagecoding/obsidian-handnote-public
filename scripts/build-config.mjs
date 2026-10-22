// Shared esbuild configuration (used by build.mjs and check-release.mjs).
import { readFileSync } from 'node:fs';
import { EDITION, editionOptions } from './edition.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
export const banner =
  EDITION === 'private'
    ? `/* HandNote v${pkg.version} — PRIVATE EDITION (includes the local math recognition model; not for public distribution). Bundled with esbuild. */`
    : `/* HandNote v${pkg.version} — Copyright (c) 2026 Yanzhe Shao, MIT License. Third-party parts below keep their own licences (THIRD_PARTY_NOTICES.md). Bundled with esbuild. */`;
const edition = editionOptions();

export const pluginConfig = {
  entryPoints: ['src/plugin/main.ts'],
  bundle: true,
  ...edition,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: 'main.js',
  // Provided by the Obsidian app at runtime; everything else must be bundled.
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  banner: { js: banner },
  logLevel: 'info',
  treeShaking: true,
  legalComments: 'inline',
  minify: false,
  sourcemap: false,
};

export const labConfig = {
  entryPoints: ['experiments/ink-lab/main.ts'],
  bundle: true,
  ...edition,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'experiments/ink-lab/lab.js',
  logLevel: 'info',
  sourcemap: 'inline',
};
