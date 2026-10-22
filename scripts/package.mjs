// Copies the three installable files into release/handnote/ (what you copy to .obsidian/plugins/handnote/).
// HN_RELEASE_VERSION=<x.y.z-…-public> (public candidate built in the private repository, see
// docs/PUBLIC_PRIVATE_RELEASE_STRATEGY.md): the packaged manifest.json carries that version, so
// Obsidian shows which edition is installed. Nothing else changes.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
const out = `release/${m.id}`;
mkdirSync(out, { recursive: true });
for (const f of ['main.js', 'styles.css']) copyFileSync(f, `${out}/${f}`);
const ver = process.env.HN_RELEASE_VERSION;
if (ver) {
  if (ver !== `${m.version}-public`) throw new Error(`HN_RELEASE_VERSION must be "${m.version}-public" (got "${ver}")`);
  writeFileSync(`${out}/manifest.json`, JSON.stringify({ ...m, version: ver }, null, 2) + '\n');
} else copyFileSync('manifest.json', `${out}/manifest.json`);
console.log(`Packaged ${m.name} ${ver ?? m.version} -> ${out}/`);
