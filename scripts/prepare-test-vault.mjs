// Creates (or refreshes) an ISOLATED test vault with the freshly built plugin installed.
//   node scripts/prepare-test-vault.mjs [path]     (default: ./test-vault)
// Never pass your real vault path.
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'test-vault');
if (/Obsidian Vault/i.test(target)) {
  console.error(`Refusing to use ${target}: this looks like a real vault.`);
  process.exit(1);
}
const pluginDir = path.join(target, '.obsidian', 'plugins', 'handnote');
mkdirSync(pluginDir, { recursive: true });
for (const f of ['manifest.json', 'main.js', 'styles.css']) {
  if (!existsSync(f)) {
    console.error(`${f} missing: run npm run build first`);
    process.exit(1);
  }
  copyFileSync(f, path.join(pluginDir, f));
}
const cp = path.join(target, '.obsidian', 'community-plugins.json');
const list = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')) : [];
if (!list.includes('handnote')) list.push('handnote');
writeFileSync(cp, JSON.stringify(list));
const readme = path.join(target, 'README (test vault).md');
if (!existsSync(readme)) {
  writeFileSync(
    readme,
    '# HandNote test vault\n\nThis vault is for testing only.\n\n- Command palette → "HandNote: New handwritten note"\n- Or embed: `![[My note.handnote]]`\n',
  );
}
console.log(`Test vault ready: ${target}\nOpen it in Obsidian ("Open folder as vault"), trust the author, and enable HandNote.`);
