// Obsidian mobile layout (app.emulateMobile): the finger long-press menu's rows are left-aligned
// (iPad round 3: the rows sat at different horizontal offsets). Run after /home/claude/obs/start.sh:
//   node tests/obsidian-e2e/mobile-menu.mjs [screenshot.png]
// NEVER point this at a real vault.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
for (const id of ['playwright-core', '/opt/npm-tools/node_modules/playwright-core']) {
  try {
    pw = require(id);
    break;
  } catch {
    /* next */
  }
}
const b = await pw.chromium.connectOverCDP(`http://127.0.0.1:${process.env.OBSIDIAN_CDP ?? '9333'}`);
let page = b.contexts()[0].pages().find((p) => p.url().startsWith('app://obsidian.md'));
await page.evaluate(async () => {
  document.querySelectorAll('.modal-container').forEach((m) => m.remove());
  if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
  if (!app.plugins.plugins.handnote) await app.plugins.enablePluginAndSave('handnote');
  if (!app.vault.getAbstractFileByPath('Menu.handnote')) await app.vault.create('Menu.handnote', '');
  setTimeout(() => app.emulateMobile(true), 50);
}).catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
page = b.contexts()[0].pages().find((p) => p.url().startsWith('app://obsidian.md'));
await page.waitForFunction(() => window.app?.workspace?.layoutReady && app.plugins?.plugins?.handnote, null, { timeout: 30000 });
const r = await page.evaluate(async () => {
  document.querySelectorAll('.modal-container').forEach((m) => m.remove());
  await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('Menu.handnote'));
  await new Promise((r) => setTimeout(r, 1500));
  const view = app.workspace.activeLeaf.view;
  const v = view.contentEl.querySelector('.hn-viewport');
  const rc = v.getBoundingClientRect();
  v.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rc.left + 150, clientY: rc.top + 200, button: 2 }));
  await new Promise((r) => setTimeout(r, 300));
  const ics = [...document.querySelectorAll('.hn-ctx-item .hn-ic')].map((e) => Math.round(e.getBoundingClientRect().left));
  const labels = [...document.querySelectorAll('.hn-ctx-label')].map((e) => Math.round(e.getBoundingClientRect().left));
  return { ics, labels, mobile: document.body.classList.contains('is-mobile') };
});
const el = await page.$('.hn-ctx-menu');
if (el && process.argv[2]) await el.screenshot({ path: process.argv[2] });
const ok = r.mobile && r.ics.length >= 3 && new Set(r.ics).size === 1 && new Set(r.labels).size === 1;
console.log(`${ok ? 'PASS' : 'FAIL'} mobile long-press menu rows aligned — icons ${r.ics.join(', ')}; labels ${r.labels.join(', ')}`);
await page.evaluate(() => setTimeout(() => app.emulateMobile(false), 50)).catch(() => {});
await new Promise((r) => setTimeout(r, 5000));
await b.close();
process.exit(ok ? 0 : 1);
