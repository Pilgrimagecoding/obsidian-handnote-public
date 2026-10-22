// Browser tests: serves the repo over HTTP and drives the Ink Lab page in Chromium/Edge.
// Requires `playwright-core` (optional dev dependency) and a Chromium-family browser:
//   HANDNOTE_CHROME=/path/to/chrome npm run test:browser
// On Windows, installed Edge/Chrome is used automatically.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execSync } from 'node:child_process';

if (process.argv.includes('--private')) process.env.HN_EDITION = 'private';
if (!process.env.HN_SKIP_BUILD) execSync(`node scripts/build.mjs lab${process.env.HN_EDITION === 'private' ? ' --private' : ''}`, { stdio: 'inherit' });

const require = createRequire(import.meta.url);
let pw;
for (const id of ['playwright-core', '/opt/npm-tools/node_modules/playwright-core']) {
  try {
    pw = require(id);
    break;
  } catch {
    /* try next */
  }
}
if (!pw) {
  console.error('playwright-core not found. Install it with: npm i -D playwright-core');
  process.exit(2);
}

const root = path.resolve('.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root)) throw new Error('outside');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const launchOpts = { headless: true };
if (process.env.HANDNOTE_CHROME) launchOpts.executablePath = process.env.HANDNOTE_CHROME;
else if (process.platform === 'win32') launchOpts.channel = 'msedge';
// HANDNOTE_BROWSER=webkit runs the suite in WebKit (Safari's engine; closest to the iPad WebView
// available on a desktop — not a substitute for the iPad itself)
const engine = process.env.HANDNOTE_BROWSER === 'webkit' ? pw.webkit : pw.chromium;
if (engine === pw.webkit) delete launchOpts.channel;
let browser;
try {
  browser = await engine.launch(launchOpts);
} catch (e) {
  if (!process.env.HANDNOTE_CHROME && process.platform !== 'win32') {
    browser = await pw.chromium.launch({ headless: true, channel: 'chrome' }).catch(() => null);
  }
  if (!browser) {
    console.error('Could not launch a Chromium browser:', e.message);
    process.exit(2);
  }
}
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
const { tests: allTests } = await import('../tests/browser/lab.spec.mjs');
// HN_ONLY=<substring> runs a subset
const tests = process.env.HN_ONLY ? allTests.filter((x) => x.name.includes(process.env.HN_ONLY)) : allTests;
await mkdir('test-output', { recursive: true });
const report = [];
let failed = 0;
for (const tc of tests) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const logs = [];
  const ctx = {
    page,
    base,
    log: (s) => logs.push(s),
    assert: (cond, msg) => {
      if (!cond) throw new Error(`assertion failed: ${msg}`);
      logs.push(`ok - ${msg}`);
    },
    shot: async (name) => {
      const f = `test-output/${name}.png`;
      await page.screenshot({ path: f });
      logs.push(`screenshot ${f}`);
    },
  };
  const t0 = Date.now();
  try {
    await tc.fn(ctx);
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    console.log(`PASS ${tc.name} (${Date.now() - t0} ms)`);
    report.push({ name: tc.name, pass: true, logs });
  } catch (e) {
    failed++;
    console.log(`FAIL ${tc.name}: ${e.message}`);
    report.push({ name: tc.name, pass: false, error: e.message, logs });
  }
  for (const l of logs) console.log('    ' + l);
  await page.close();
}
await writeFile('test-output/browser-report.json', JSON.stringify({ browser: browser.version(), date: new Date().toISOString(), report }, null, 2));
await browser.close();
server.close();
console.log(`\n${tests.length - failed}/${tests.length} browser tests passed (${browser.version()})`);
process.exit(failed ? 1 : 0);
