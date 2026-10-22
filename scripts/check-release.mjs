// Release gate: `node scripts/check-release.mjs [tag] [--stable] [--private]`
// Default: PUBLIC edition (main.js must not contain the private local math model). --private / HN_EDITION=private: the
// private edition (main.js must contain it and carry the PRIVATE EDITION banner).
// Verifies manifest/versions/package consistency, that release/handnote/ holds exactly the files
// Obsidian/BRAT need, that main.js is reproducible from the current sources, and that main.js has
// no runtime dependency other than the `obsidian` module provided by the app.
import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

if (process.argv.includes('--private')) process.env.HN_EDITION = 'private';
const { pluginConfig } = await import('./build-config.mjs');
const { buildEmbeddedOrt } = await import('./build-embedded-ort.mjs');
const { buildWorker } = await import('./build-worker.mjs');
const { EDITION } = await import('./edition.mjs');
const { checkEdition } = await import('./check-edition.mjs');

buildEmbeddedOrt();
await buildWorker();

const problems = [];
const ok = [];
const check = (cond, msg) => (cond ? ok.push(msg) : problems.push(msg));
const read = (p) => readFileSync(p, 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const versions = JSON.parse(read('versions.json'));
const pkg = JSON.parse(read('package.json'));
const args = process.argv.slice(2);
const stable = args.includes('--stable');
const tag = args.find((a) => !a.startsWith('--'));

check(manifest.id === 'handnote', `manifest.id = "${manifest.id}" (expected "handnote")`);
check(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(manifest.version), `manifest.version "${manifest.version}" is semver (x.y.z or x.y.z-pre)`);
check(manifest.isDesktopOnly === false, `manifest.isDesktopOnly = ${manifest.isDesktopOnly}`);
check(/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion ?? ''), `manifest.minAppVersion "${manifest.minAppVersion}"`);
check(!!manifest.name && !!manifest.description && !!manifest.author, 'manifest has name/description/author');
check(!/obsidian/i.test(manifest.id), 'manifest.id does not contain "obsidian"');
check(versions[manifest.version] === manifest.minAppVersion, `versions.json["${manifest.version}"] = "${versions[manifest.version]}"`);
check(pkg.version === manifest.version, `package.json version ${pkg.version} = manifest version`);
// a public candidate built in the private repository is tagged "<version>-public" (public edition only)
const candidate = !!tag && tag === `${manifest.version}-public`;
if (tag) check(tag === manifest.version || candidate, `git tag "${tag}" = manifest version (no "v" prefix)${candidate ? ' + "-public"' : ''}`);
if (candidate) check(EDITION === 'public', `a "-public" tag is built as the PUBLIC edition (built: ${EDITION})`);
// Obsidian's community directory supports only x.y.z: a tag without a pre-release part is a stable
// release and must be x.y.z (also when --stable is given without a tag)
if (stable || (tag && !tag.includes('-'))) check(/^\d+\.\d+\.\d+$/.test(manifest.version), `stable release: version "${manifest.version}" is x.y.z`);
const lock = existsSync('package-lock.json') ? JSON.parse(read('package-lock.json')) : null;
if (lock) check(lock.version === manifest.version && (lock.packages?.['']?.version ?? manifest.version) === manifest.version, `package-lock.json version ${lock.version} = manifest version`);
check(typeof manifest.description === 'string' && manifest.description.length <= 250 && /\.$/.test(manifest.description) && !/^this is a plugin/i.test(manifest.description) && !/[\u2010-\u2015\u{1F300}-\u{1FAFF}]/u.test(manifest.description), 'manifest.description: ≤ 250 characters, ends with a period, no dashes / emoji');
check(!('fundingUrl' in manifest) || !!manifest.fundingUrl, 'manifest.fundingUrl absent or set');

for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  const rel = `release/handnote/${f}`;
  check(existsSync(rel), `${rel} exists`);
  if (!existsSync(rel)) continue;
  if (f === 'manifest.json' && candidate) check(read(rel) === JSON.stringify({ ...manifest, version: tag }, null, 2) + '\n', `${rel} = ./manifest.json with version "${tag}"`);
  else check(read(rel) === read(f), `${rel} identical to ./${f}`);
}

const main = read('main.js');
const requires = [...new Set([...main.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]))];
check(requires.length === 1 && requires[0] === 'obsidian', `main.js requires only "obsidian" (found: ${requires.join(', ') || 'none'})`);
check(!/\bimport\(/.test(main), 'main.js has no dynamic import()');
check(!/process\.versions|__dirname|child_process/.test(main), 'main.js uses no Node/Electron-only APIs');
try {
  new vm.Script(main, { filename: 'main.js' });
  ok.push('main.js parses as JavaScript');
} catch (e) {
  problems.push(`main.js syntax error: ${e.message}`);
}
// 0.6 embeds the offline Chinese stroke templates (~0.63 MB base64, APL) — see vendor/hanzi-mmah
// ONNX Runtime Web (gzip + base64, ~4.2 MB) is inside main.js since 0.8.0-beta.3
const maxMain = process.env.HN_EMBED_ORT === '0' ? 2_500_000 : 7_000_000;
check(main.length < maxMain, `main.js size ${(main.length / 1024).toFixed(1)} KB (limit ${(maxMain / 1048576).toFixed(1)} MB)`);

// Edition: a public build never contains the private math model; a private build always says so in its banner
const ed = checkEdition(main, EDITION);
check(!ed.problems.length, `${EDITION} edition: ${ed.problems.length ? ed.problems.join('; ') : EDITION === 'public' ? 'no private math model (weights, sources, hashes, inference code)' : 'private math model included, PRIVATE EDITION banner'}`);

// Reproducibility: rebuild in memory with the shared config and compare byte-for-byte.
const r = await esbuild.build({ ...pluginConfig, write: false, logLevel: 'silent' });
const rebuilt = r.outputFiles[0].text;
check(rebuilt === main, 'main.js is byte-identical to a fresh build of the current sources');

const css = read('styles.css');
check(css.length > 0 && !/@import|url\(\s*["']?https?:/i.test(css), 'styles.css has no external imports');

// SHA-256 of the files a release carries (also written to release/handnote/SHA256SUMS.txt)
const sums = ['main.js', 'manifest.json', 'styles.css'].filter((f) => existsSync(`release/handnote/${f}`)).map((f) => `${createHash('sha256').update(readFileSync(`release/handnote/${f}`)).digest('hex')}  ${f}`);
if (sums.length === 3) writeFileSync('release/handnote/SHA256SUMS.txt', sums.join('\n') + '\n');
for (const m of ok) console.log(`  ok   ${m}`);
for (const l of sums) console.log(`  sha256 ${l}`);
for (const m of problems) console.log(`  FAIL ${m}`);
console.log(problems.length ? `\nRELEASE CHECK: FAIL (${problems.length})` : `\nRELEASE CHECK: PASS (${ok.length} checks)`);
process.exit(problems.length ? 1 : 0);
