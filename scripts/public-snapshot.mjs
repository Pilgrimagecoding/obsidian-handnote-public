// Dry run for a clean public repository (docs/PUBLIC_REPOSITORY_RELEASE_PLAN.md).
//
//   node scripts/public-snapshot.mjs --out <empty folder outside this repository> [--name "Real Name"]
//
// Copies the tracked files that belong in a public source snapshot (no Git history) into --out and
// scans the copy for personal or internal data. It never creates a repository, never commits,
// never pushes and never changes this repository. Exit code 1 when anything is found.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = arg('--out');
if (!out) {
  console.error('usage: node scripts/public-snapshot.mjs --out <empty folder> [--name "Real Name"]');
  process.exit(2);
}
const root = process.cwd();
const target = path.resolve(out);
if (target.startsWith(root + path.sep) || target === root) {
  console.error('--out must be outside this repository');
  process.exit(2);
}
if (existsSync(target) && readdirSync(target).length) {
  console.error(`${target} is not empty`);
  process.exit(2);
}

// Files that stay in the private repository: internal notes, device reports, audits and drafts,
// competitor research, benchmark fixtures with personal sample text, build output.
const EXCLUDE = [
  /^STATUS\.md$/,
  /^main\.js$/, // build output: published as a release asset, rebuilt by the scanner
  /^docs\/device-reports\//,
  /^docs\/release-notes\/(?!0\.8\.0\.md$)/, // private beta notes; the public release notes (0.8.0) are kept
  /^docs\/(DEVELOPMENT_REPORT|IPAD_DEPLOYMENT|IPAD_MINIMAL_TEST|IPAD_TEST_CHECKLIST|IPAD_TEST_DEPLOYMENT_REPORT|SYNC_TEST_PLAN|V0\.2_RELEASE_NOTES)\.md$/,
  /^docs\/(GOODNOTES_REVERSE_ENGINEERING_REPORT|MYSCRIPT_XMIND_RESEARCH)\.md$/,
  /^docs\/(RELEASE_READINESS_AUDIT|PRODUCTION_READINESS_REPORT|SECURITY_AND_PRIVACY_AUDIT|PUBLIC_REPO_OPTIONS|PUBLIC_RELEASE_CHECKLIST|PUBLIC_REPOSITORY_RELEASE_PLAN|RELEASE_CANDIDATE_PLAN|COMER_LICENSE_REQUEST|OBSIDIAN_POLICY_INQUIRY|MAINTENANCE_PLAN|AI_BENCHMARK)\.md$/,
  /^tests\/fixtures\/rec-bench\//,
  /^tests\/bench\//,
  /^scripts\/(gen-rec-fixtures|rec-benchmark|ai-benchmark)\.mjs$/,
  /^tests\/obsidian-e2e\/r16-harness-repro\.mjs$/,
  // PRIVATE EDITION: the local math model (pack, worker code, dev helpers) and what only it uses
  // (docs/PUBLIC_PRIVATE_RELEASE_STRATEGY.md)
  /^src\/private\//,
  /^tests\/fixtures\/edition\//, // a note made with the private build (unit test skips without it)
  /^tests\/obsidian-e2e\/(edition-switch|runtime-compare)\.mjs$/,
  /^docs\/(PUBLIC_PRIVATE_RELEASE_STRATEGY|PUBLIC_LICENSE_AUDIT|WASM_BUNDLING_FEASIBILITY|LOCAL_RECOGNITION|PRIVATE_EDITION|LICENSE_PROPOSAL|DEVICE_TEST_GUIDE|DEVICE_ACCEPTANCE)\.md$/,
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const kept = files.filter((f) => !EXCLUDE.some((r) => r.test(f)));
for (const f of kept) {
  const to = path.join(target, f);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(f, to);
}

const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
const authors = [...new Set(execFileSync('git', ['log', '--format=%ae'], { encoding: 'utf8' }).split('\n').filter(Boolean))].filter((a) => !/noreply/.test(a));
const PATTERNS = [
  ['personal e-mail', new RegExp([email, ...authors].filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)', 'i')],
  ['Windows path', /\b[A-Z]:\\(?:Users\\(?!<you>)|Projects|Obsidian)|\b[DE]:\\[^\s`"]*/],
  ['home path', /\/(?:Users|home)\/(?!claude\b)[a-z][\w.-]+\//],
  ['real vault', /Obsidian Vault(?!\/i\.test)/], // the guard in prepare-test-vault.mjs is fine
  ['key file', /密钥\.txt|key-file\s+"?[A-Z]:/],
  ['local proxy', /127\.0\.0\.1:7897/],
  ['internal session link', /claude\.ai\/code\/session_/],
];
// The public source must not contain the private local math model: its weights' sources, pinned
// hashes, file names or inference code (scripts/check-edition.mjs lists the markers). The model's
// name alone may appear in the change history only.
const { COMER_MARKERS } = await import('./check-edition.mjs');
const NAME_ONLY = new Set([String(/\bCoMER\b/i), String(/ink-on/i)]);
const NAME_ALLOWED = /^CHANGELOG\.md$/;
for (const re of COMER_MARKERS) PATTERNS.push([`private math model (${re})`, re, NAME_ONLY.has(String(re)) ? NAME_ALLOWED : null]);
const name = arg('--name');
if (name) PATTERNS.push(['real name', new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))]);

const findings = [];
// the two files that define the patterns are not scanned for them
const SELF = /^scripts\/(public-snapshot|check-edition)\.mjs$/;
for (const f of kept) {
  if (/\.(png|jpe?g|woff2?|ttf|onnx|wasm)$/i.test(f) || SELF.test(f)) continue;
  const text = readFileSync(path.join(target, f), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [what, re, allowIn] of PATTERNS) if (re.test(line) && !(allowIn && allowIn.test(f))) findings.push(`${f}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
  });
}
console.log(`public snapshot: ${kept.length} of ${files.length} tracked files copied to ${target}`);
console.log(`excluded: ${files.length - kept.length} (${files.filter((f) => EXCLUDE.some((r) => r.test(f))).join(', ')})`);
if (findings.length) {
  console.log(`\n${findings.length} finding(s) to clean before anything is published:`);
  for (const l of findings) console.log('  ' + l);
  process.exit(1);
}
console.log('no personal or internal data found by the patterns');
