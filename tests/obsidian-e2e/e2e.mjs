// End-to-end tests against a REAL Obsidian desktop app (not a mock).
//
// Usage:
//   1. Build the plugin (npm run build) and copy manifest.json/main.js/styles.css into
//      <TEST VAULT>/.obsidian/plugins/handnote/ (scripts/prepare-test-vault.mjs does this).
//   2. Start Obsidian on that vault with remote debugging:
//        Obsidian --remote-debugging-port=9333     (Linux: add --no-sandbox under xvfb-run)
//   3. node tests/obsidian-e2e/e2e.mjs
//
// NEVER point this at your real vault: the tests create, modify and delete files.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { YONG, toSamples } from '../browser/handwriting.mjs';
import { guardEvaluate } from './safe-evaluate.mjs';

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
const port = process.env.OBSIDIAN_CDP ?? '9333';
const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('app://obsidian.md'));
if (!page) throw new Error('Obsidian window not found');
guardEvaluate(page); // never let Playwright serialise Obsidian objects (R16)
await mkdir('test-output', { recursive: true });
// trace mode: when a step hangs, pause the renderer and print where it is stuck
let cdp = null;
if (process.env.HN_E2E_TRACE) {
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
}
async function dumpStack() {
  if (!cdp) return;
  const got = new Promise((res) => cdp.once('Debugger.paused', (e) => res(e)));
  await cdp.send('Debugger.pause').catch(() => undefined);
  const e = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 5000))]);
  if (e) console.log('      STACK\n' + e.callFrames.slice(0, 40).map((f) => `        ${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.location.lineNumber}:${f.location.columnNumber}`).join('\n'));
  else console.log('      STACK: renderer did not pause');
  await cdp.send('Debugger.resume').catch(() => undefined);
}

const results = [];
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (process.env.HN_E2E_TRACE && (m.type() === 'error' || m.type() === 'warning')) console.log(`      [console.${m.type()}] ${m.text().slice(0, 200)}`);
  // the disk-full fault step injects ENOSPC on purpose: that error is expected
  if (m.type() === 'error' && /handnote|HandNote/.test(m.text()) && !/ENOSPC: no space left on device/.test(m.text())) errors.push(m.text());
});
async function step(name, fn) {
  if (process.env.HN_E2E_ONLY && !new RegExp(process.env.HN_E2E_ONLY).test(name) && !/^(Obsidian is running|plugin loads|create a handwritten note)/.test(name)) return;
  const t0 = Date.now();
  try {
    // a hanging step fails (with its name) instead of stalling the whole run
    const info = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => void dumpStack().then(() => rej(new Error('step timed out after 120 s'))), 120000))]);
    results.push({ name, pass: true, info: info ?? '' });
    console.log(`PASS ${name}${info ? ' — ' + info : ''} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, pass: false, info: e.message });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => page.waitForTimeout(ms);

/** Draw page-local samples into the active HandNote view with synthetic pen PointerEvents. */
async function draw(samples, pageIndex = 0) {
  await page.evaluate(
    async ({ samples, pageIndex }) => {
      const view = app.workspace.activeLeaf.view;
      const ed = view.editor;
      const v = view.contentEl.querySelector('.hn-viewport');
      const mk = (type, s) => {
        const c = ed.pageToClient(pageIndex, s.x, s.y);
        return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: s.p, buttons: type === 'pointerup' ? 0 : 1 });
      };
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      v.dispatchEvent(mk('pointerdown', samples[0]));
      for (let i = 1; i < samples.length; i++) {
        v.dispatchEvent(mk('pointermove', samples[i]));
        if (i % 4 === 0) await frame();
      }
      v.dispatchEvent(mk('pointerup', samples[samples.length - 1]));
      await frame();
    },
    { samples, pageIndex },
  );
}

/** Click a button inside the ACTIVE HandNote view (other tabs may hold hidden editors). */
async function click(selector) {
  await page.evaluate((sel) => {
    const b = app.workspace.activeLeaf.view.contentEl.querySelector(sel);
    if (!b) throw new Error('not found: ' + sel);
    b.click();
  }, selector);
}

async function readStrokes(path) {
  return page.evaluate(async (path) => {
    const t = await app.vault.adapter.read(path);
    const d = JSON.parse(t);
    return { pages: d.pages.length, strokes: d.pages.reduce((n, p) => n + p.strokes.length, 0), revision: d.revision, id: d.id };
  }, path);
}

// ------------------------------------------------------------------------------------------------
await step('Obsidian is running the test vault', async () => {
  const info = await page.evaluate(() => ({ vault: app.vault.getName(), version: navigator.userAgent.match(/obsidian\/([\d.]+)/i)?.[1] }));
  assert(info.vault === 'test-vault', `vault is ${info.vault}`);
  return `Obsidian ${info.version}, vault "${info.vault}"`;
});

await step('plugin loads (community plugins enabled in the TEST vault only)', async () => {
  await page.evaluate(async () => {
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.plugins.handnote) await app.plugins.enablePluginAndSave('handnote');
  });
  await sleep(500);
  const ok = await page.evaluate(() => !!app.plugins.plugins.handnote && app.plugins.plugins.handnote._loaded);
  assert(ok, 'handnote plugin not loaded');
  const cmds = await page.evaluate(() => Object.keys(app.commands.commands).filter((c) => c.startsWith('handnote:')));
  return `commands: ${cmds.join(', ')}`;
});

let notePath = '';
await step('create a handwritten note (command) opens the HandNote editor', async () => {
  await page.evaluate(() => app.commands.executeCommandById('handnote:create'));
  await sleep(800);
  const r = await page.evaluate(() => ({ type: app.workspace.activeLeaf?.view?.getViewType(), path: app.workspace.getActiveFile()?.path }));
  assert(r.type === 'handnote-view', `active view ${r.type}`);
  assert(r.path && r.path.endsWith('.handnote'), `file ${r.path}`);
  notePath = r.path;
  const s = await readStrokes(notePath);
  assert(s.strokes === 0 && s.pages === 1, 'new file has one empty page');
  return notePath;
});

await step('write with fountain pen, pencil and highlighter (two-tier toolbar); autosave writes the file', async () => {
  for (const poly of YONG) await draw(toSamples(poly, { x0: 60, y0: 100, scale: 2, speed: 160 }));
  await click('.hn-subbar button[data-kind="pencil"]');
  await draw(toSamples([[0, 0], [100, 10]], { x0: 300, y0: 150, scale: 2, speed: 250 }));
  await click('.hn-subbar button[data-kind="highlighter"]');
  await draw(toSamples([[0, 0], [100, 0]], { x0: 300, y0: 160, scale: 2, speed: 250 }));
  await click('.hn-subbar button[data-kind="fountain"]');
  await sleep(2000);
  const s = await readStrokes(notePath);
  assert(s.strokes === 7, `file has ${s.strokes} strokes`);
  const status = await page.evaluate(() => document.querySelector('.hn-status')?.dataset.status);
  assert(status === 'saved', `status ${status}`);
  await page.screenshot({ path: 'test-output/obsidian-editor.png' });
  return `7 strokes saved, revision ${s.revision}`;
});

await step('eraser + undo/redo work inside Obsidian', async () => {
  await click('.hn-toolbar .hn-tool[data-group="eraser"]');
  await click('.hn-subbar .hn-eraser-type');
  await click('.hn-tile[data-mode="stroke"]');
  await page.keyboard.press('Escape');
  await draw(toSamples([[0, 0], [0, 30]], { x0: 400, y0: 140, scale: 1, speed: 200 }));
  await click('.hn-toolbar .hn-tool[data-group="pen"]');
  const after = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes.length);
  assert(after < 7, `erase removed strokes (${after})`);
  await click('.hn-toolbar button[aria-label="Undo"]');
  const undone = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes.length);
  assert(undone === 7, `undo restored (${undone})`);
  await click('.hn-toolbar button[aria-label="Redo"]');
  await click('.hn-toolbar button[aria-label="Undo"]');
  return `erase removed ${7 - after}, undo/redo ok`;
});

await step('add a page, write on page 2', async () => {
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.addPageAfterCurrent());
  await sleep(300);
  await draw(toSamples([[0, 0], [60, 40]], { x0: 100, y0: 100, scale: 2, speed: 200 }), 1);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const s = await readStrokes(notePath);
  assert(s.pages === 2 && s.strokes === 8, `pages ${s.pages}, strokes ${s.strokes}`);
  return '2 pages, 8 strokes on disk';
});

await step('close and reopen: strokes restored, writing continues', async () => {
  await page.evaluate(async () => {
    app.workspace.activeLeaf.detach();
  });
  await sleep(500);
  await page.evaluate(async (p) => {
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p));
  }, notePath);
  await sleep(800);
  const n = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.reduce((n, p) => n + p.strokes.length, 0));
  assert(n === 8, `reopened with ${n} strokes`);
  await draw(toSamples([[0, 0], [80, 0]], { x0: 80, y0: 400, scale: 2, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const s = await readStrokes(notePath);
  assert(s.strokes === 9, `now ${s.strokes}`);
  return 'reopen ok, 9 strokes';
});

await step('Markdown embed renders in Reading view and Live Preview; click opens editor', async () => {
  const base = notePath.split('/').pop();
  await page.evaluate(async (base) => {
    await app.vault.create('视觉伺服.md', `# 视觉伺服\n\n## 手写推导\n\n![[${base}]]\n\n## 文字笔记\n\nText.\n`);
  }, base);
  await page.evaluate(async () => {
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(app.vault.getAbstractFileByPath('视觉伺服.md'), { state: { mode: 'preview' } });
  });
  await sleep(1500);
  const reading = await page.evaluate(() => {
    const v = app.workspace.activeLeaf.view;
    return v.containerEl.querySelectorAll('.markdown-reading-view .hn-embed canvas.hn-embed-page').length;
  });
  assert(reading >= 1, `reading view embed canvases: ${reading}`);
  await page.screenshot({ path: 'test-output/obsidian-embed-reading.png' });
  await page.evaluate(async () => {
    const v = app.workspace.activeLeaf.view;
    await v.setState({ ...v.getState(), mode: 'source', source: false }, { history: false });
  });
  await sleep(1500);
  const live = await page.evaluate(() => {
    const v = app.workspace.activeLeaf.view;
    return v.containerEl.querySelectorAll('.markdown-source-view .hn-embed canvas.hn-embed-page').length;
  });
  assert(live >= 1, `live preview embed canvases: ${live}`);
  await page.screenshot({ path: 'test-output/obsidian-embed-livepreview.png' });
  await page.evaluate(() => app.workspace.activeLeaf.view.containerEl.querySelector('.markdown-source-view .hn-embed').click());
  await sleep(800);
  const t = await page.evaluate(() => app.workspace.activeLeaf.view.getViewType());
  assert(t === 'handnote-view', `click opened ${t}`);
  return `reading: ${reading} page canvas(es), live preview: ${live}, click -> editor`;
});

await step('sync conflict: external newer revision while dirty is preserved as a conflict copy', async () => {
  const before = await readStrokes(notePath);
  // simulate Remotely Save delivering a version from the iPad (revision+5, different device)
  await page.evaluate(async ({ p, rev }) => {
    const t = await app.vault.adapter.read(p);
    const ext = t.replace(/"revision":\d+/, `"revision":${rev}`).replace(/"device":"[^"]*"/, '"device":"dev-ipad-sim"');
    // make the view dirty first, then change the file underneath it
    const view = app.workspace.activeLeaf.view;
    view.editor.addPageAfterCurrent();
    await app.vault.adapter.write(p, ext);
  }, { p: notePath, rev: before.revision + 5 });
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(500);
  const files = await page.evaluate(() => app.vault.getFiles().map((f) => f.path).filter((p) => p.includes('(conflict')));
  assert(files.length === 1, `conflict copies: ${JSON.stringify(files)}`);
  const copy = await readStrokes(files[0]);
  const main = await readStrokes(notePath);
  assert(copy.revision === before.revision + 5, 'copy holds the external version');
  assert(main.revision === before.revision + 6, `main written on top (rev ${main.revision})`);
  return `kept "${files[0]}"`;
});

await step('external change while NOT dirty reloads the view (no conflict copy)', async () => {
  const before = await readStrokes(notePath);
  await page.evaluate(async ({ p, rev }) => {
    const t = await app.vault.adapter.read(p);
    await app.vault.modify(app.vault.getAbstractFileByPath(p), t.replace(/"revision":\d+/, `"revision":${rev}`));
  }, { p: notePath, rev: before.revision + 1 });
  await sleep(800);
  const r = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().revision);
  const copies = await page.evaluate(() => app.vault.getFiles().filter((f) => f.path.includes('(conflict')).length);
  assert(r === before.revision + 1, `view revision ${r}`);
  assert(copies === 1, 'no new conflict copy');
  return `reloaded to revision ${r}`;
});

await step('export current page as SVG and PNG', async () => {
  await page.evaluate(() => app.commands.executeCommandById('handnote:export-svg'));
  await page.evaluate(() => app.commands.executeCommandById('handnote:export-png'));
  await sleep(1200);
  const files = await page.evaluate(() => app.vault.getFiles().map((f) => `${f.path} (${f.stat.size} B)`).filter((p) => /\.(svg|png) /.test(p)));
  assert(files.length === 2, JSON.stringify(files));
  return files.join(', ');
});

await step('plugin disable/enable cycle keeps working (no stale state)', async () => {
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('handnote');
    await app.plugins.enablePlugin('handnote');
  });
  await sleep(800);
  await page.evaluate(async (p) => {
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p));
  }, notePath);
  await sleep(800);
  const t = await page.evaluate(() => app.workspace.activeLeaf.view.getViewType());
  assert(t === 'handnote-view', `view after re-enable: ${t}`);
  await draw(toSamples([[0, 0], [50, 0]], { x0: 80, y0: 450, scale: 2, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  return 'ok';
});

await step('background tab releases canvas memory and restores on return', async () => {
  const leafInfo = await page.evaluate(async () => {
    const hn = app.workspace.activeLeaf;
    const md = app.workspace.getLeaf('tab');
    await md.openFile(app.vault.getAbstractFileByPath('视觉伺服.md'));
    app.workspace.setActiveLeaf(md, { focus: true });
    await new Promise((r) => setTimeout(r, 500));
    const hidden = hn.view.contentEl.querySelector('.hn-scene').width;
    app.workspace.setActiveLeaf(hn, { focus: true });
    await new Promise((r) => setTimeout(r, 600));
    return { hidden, shown: hn.view.contentEl.querySelector('.hn-scene').width };
  });
  assert(leafInfo.hidden === 0, `hidden tab canvas width ${leafInfo.hidden}`);
  assert(leafInfo.shown > 0, `restored canvas width ${leafInfo.shown}`);
  return `hidden 0 px → shown ${leafInfo.shown} px`;
});

await step('v0.2: a file written by v0.1.0 opens, and re-saves byte-identical when untouched', async () => {
  const v01 = await (await import('node:fs/promises')).readFile('tests/fixtures/v0.1-sample.handnote', 'utf8');
  await page.evaluate(async (txt) => {
    await app.vault.create('v01-sample.handnote', txt);
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('v01-sample.handnote'));
  }, v01);
  await sleep(800);
  const n = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.reduce((a, p) => a + p.strokes.length, 0));
  assert(n === 4, `strokes ${n}`);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const after = await page.evaluate(() => app.vault.adapter.read('v01-sample.handnote'));
  assert(after === v01, 'untouched v0.1 file not rewritten');
  return '4 strokes, file unchanged';
});

await step('v0.2/0.3: Baseline stroke keeps format version 1; the default pen (engine 2, natural curve) writes version 3', async () => {
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    ed.updateSettings({ ...ed.getSettings(), tool: 'fountain', fountainVariant: 'baseline' });
  });
  await draw(toSamples([[0, 0], [60, 0]], { x0: 80, y0: 600, scale: 1, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const v1 = await page.evaluate(() => app.vault.adapter.read('v01-sample.handnote'));
  assert(/"version":1,/.test(v1), 'still version 1 (v0.1 can keep editing it)');
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    ed.updateSettings({ ...ed.getSettings(), fountainVariant: 'experimental' });
  });
  await draw(toSamples([[0, 0], [60, 0]], { x0: 80, y0: 650, scale: 1, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const v2 = await page.evaluate(() => app.vault.adapter.read('v01-sample.handnote'));
  assert(/"version":3,/.test(v2) && /"engine":2,/.test(v2) && /"pressureCurve":4/.test(v2), 'version 3 with an engine-2 natural-curve stroke');
  return 'v1 → v3 only when needed';
});

await step('v0.3: image becomes a vault attachment; text box and shape saved; reopen restores them; PNG export includes the image', async () => {
  const res = await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const ed = view.editor;
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 60;
    const g = c.getContext('2d');
    g.fillStyle = '#c62828';
    g.fillRect(0, 0, 120, 60);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    // v0.4 default is "inside the note"; this step checks the attachment mode
    const prev = ed.getSettings().imageStorage;
    ed.getSettings().imageStorage = 'attachment';
    await ed.insertImageFile(new File([blob], 'red.png', { type: 'image/png' }));
    ed.getSettings().imageStorage = prev;
    const page0 = view.getDocument().pages[ed.currentPageIndex()];
    const img = page0.items.find((i) => i.type === 'image');
    return { src: img?.src, exists: !!app.vault.getAbstractFileByPath(img?.src ?? '') };
  });
  assert(res.src && !res.src.startsWith('data:') && res.exists, `attachment ${JSON.stringify(res)}`);
  // text box + shape via the toolbar
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.gotoPage(0));
  await sleep(200);
  await click('.hn-toolbar .hn-tool[data-group="text"]');
  const tc = await page.evaluate(() => app.workspace.activeLeaf.view.editor.pageToClient(0, 60, 330));
  await page.mouse.click(tc.x, tc.y);
  await page.keyboard.type('Obsidian 文本框');
  await click('.hn-toolbar .hn-tool[data-group="shape"]');
  await page.evaluate(async () => {
    const ed = app.workspace.activeLeaf.view.editor;
    const v = app.workspace.activeLeaf.view.contentEl.querySelector('.hn-viewport');
    const ev = (type, x, y) => { const c = ed.pageToClient(0, x, y); v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: 0.3, buttons: type === 'pointerup' ? 0 : 1 })); };
    ev('pointerdown', 300, 300);
    for (let i = 1; i <= 10; i++) ev('pointermove', 300 + i * 10, 300 + i * 6);
    ev('pointerup', 400, 360);
  });
  await click('.hn-toolbar .hn-tool[data-group="pen"]');
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const txt = await page.evaluate(() => app.vault.adapter.read('v01-sample.handnote'));
  assert(/"type":"image"/.test(txt) && /"type":"text"/.test(txt) && /"type":"shape"/.test(txt), `file contains image, text and shape items (${['image', 'text', 'shape'].filter((k) => txt.includes(`"type":"${k}"`))})`);
  assert(txt.includes('Obsidian 文本框'), 'text content saved');
  // reopen
  await page.evaluate(async () => {
    const f = app.vault.getAbstractFileByPath('v01-sample.handnote');
    app.workspace.activeLeaf.detach();
    await new Promise((r) => setTimeout(r, 300));
    await app.workspace.getLeaf(true).openFile(f);
  });
  await sleep(800);
  const items = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.flatMap((p) => p.items.map((i) => i.type)));
  assert(items.includes('image') && items.includes('text') && items.includes('shape'), `restored items ${items}`);
  await page.evaluate(() => app.commands.executeCommandById('handnote:export-png'));
  await sleep(1500);
  const pngs = await page.evaluate(() => app.vault.getFiles().filter((f) => f.path.startsWith('v01-sample') && f.extension === 'png').map((f) => f.path));
  assert(pngs.length >= 1, `png exported ${pngs}`);
  const red = await page.evaluate(async (p) => {
    const buf = await app.vault.adapter.readBinary(p);
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] > 180 && d[i + 1] < 70 && d[i + 2] < 70) n++;
    return n;
  }, pngs[pngs.length - 1]);
  assert(red > 500, `exported PNG contains the red image (${red} samples)`);
  return `${res.src}; items ${items.join(',')}; PNG red samples ${red}`;
});

await step('v0.4: embedded image is stored inside the .handnote file; reopen and PNG export show it', async () => {
  await page.evaluate(() => app.commands.executeCommandById('handnote:create'));
  await sleep(800);
  const path = await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const c = document.createElement('canvas');
    c.width = 100;
    c.height = 50;
    const g = c.getContext('2d');
    g.fillStyle = '#1565c0';
    g.fillRect(0, 0, 100, 50);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await view.editor.insertImageFile(new File([blob], 'blue.png', { type: 'image/png' }));
    await view.flush();
    return view.file.path;
  });
  const txt = await page.evaluate((p) => app.vault.adapter.read(p), path);
  assert(txt.includes('"src":"asset:') && txt.includes('],"assets":[') && txt.includes('"version":4'), 'image embedded in the file (format 4)');
  const attachments = await page.evaluate(() => app.vault.getFiles().filter((f) => f.name.startsWith('blue')).length);
  assert(attachments === 0, 'no attachment file created');
  await page.evaluate(async (p) => {
    app.workspace.activeLeaf.detach();
    await new Promise((r) => setTimeout(r, 300));
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p));
  }, path);
  await sleep(800);
  await page.evaluate(() => app.commands.executeCommandById('handnote:export-png'));
  await sleep(1500);
  const blue = await page.evaluate(async (base) => {
    const f = app.vault.getFiles().filter((x) => x.path.startsWith(base) && x.extension === 'png').pop();
    if (!f) return -1;
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([await app.vault.adapter.readBinary(f.path)], { type: 'image/png' }));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i + 2] > 150 && d[i] < 60) n++;
    return n;
  }, path.replace(/\.handnote$/, ''));
  assert(blue > 300, `exported PNG contains the embedded image (${blue})`);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain')); // inserting an image selects the image tool
  return `${path}; blue samples ${blue}`;
});

await step('v0.4: file explorer menu offers "New HandNote" on a folder and on the blank area (official file-menu event)', async () => {
  await page.evaluate(async () => {
    if (!app.vault.getAbstractFileByPath('E2E Folder')) await app.vault.createFolder('E2E Folder');
    app.workspace.leftSplit.expand();
    await app.commands.executeCommandById('file-explorer:open');
  });
  await sleep(600);
  const title = page.locator('.nav-folder-title[data-path="E2E Folder"]');
  await title.click({ button: 'right' });
  await sleep(300);
  const items = await page.$$eval('.menu .menu-item-title', (els) => els.map((e) => e.textContent));
  assert(items.some((x) => /New HandNote|新建 HandNote/.test(x)), `folder menu: ${items.join(' | ')}`);
  const near = items.findIndex((x) => /New HandNote|新建 HandNote/.test(x));
  await page.locator('.menu .menu-item', { hasText: /New HandNote|新建 HandNote/ }).first().click();
  await sleep(900);
  const created = await page.evaluate(() => ({ path: app.workspace.getActiveFile()?.path, type: app.workspace.activeLeaf?.view?.getViewType() }));
  assert(created.path?.startsWith('E2E Folder/') && created.type === 'handnote-view', `created ${JSON.stringify(created)}`);
  // blank area below the file list = vault root
  const box = await page.locator('.nav-files-container').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8, { button: 'right' });
  await sleep(300);
  const rootItems = await page.$$eval('.menu .menu-item-title', (els) => els.map((e) => e.textContent));
  await page.keyboard.press('Escape');
  const blank = rootItems.some((x) => /New HandNote|新建 HandNote/.test(x));
  return `folder menu position ${near} of ${items.length}: ${items.slice(0, 4).join(' | ')}…; blank-area menu ${blank ? 'has' : 'does NOT have'} the entry (${rootItems.slice(0, 4).join(' | ')})`;
});

await step('v0.4: AI key lives in Obsidian secret storage — data.json holds only the secret name; mock conversion works in Obsidian', async () => {
  const info = await page.evaluate(async () => {
    const p = app.plugins.plugins.handnote;
    const supported = !!app.secretStorage && typeof app.secretStorage.getSecret === 'function';
    if (supported) app.secretStorage.setSecret('handnote-e2e-key', 'sk-e2e-DO-NOT-STORE-0000');
    const ai = p.settings.ai;
    p.settings.ai = { ...ai, enabled: true, profiles: ai.profiles.map((x) => (x.id === 'openai' ? { ...x, secretName: 'handnote-e2e-key' } : x)), defaultModel: 'gpt-5.4-mini' };
    await p.saveData(p.settings);
    const status = p.ai.status();
    const raw = await app.vault.adapter.read(`${app.vault.configDir}/plugins/handnote/data.json`);
    // settings tab: provider list with key status; the edit dialog renders the secret picker
    app.setting.open();
    app.setting.openTabById('handnote');
    await new Promise((r) => setTimeout(r, 400));
    const tab = app.setting.activeTab?.containerEl;
    const rows = [...tab.querySelectorAll('.hn-ai-card .setting-item')].map((e) => e.textContent);
    const openaiRow = [...tab.querySelectorAll('.hn-ai-card .setting-item')].find((e) => e.querySelector('.setting-item-name')?.textContent === 'OpenAI');
    let modal = null;
    for (let i = 0; i < 5 && !modal; i++) {
      openaiRow?.querySelector('.extra-setting-button')?.click();
      await new Promise((r) => setTimeout(r, 400));
      modal = tab.ownerDocument.querySelector('.modal .hn-ai-modal')?.closest('.modal') ?? null; // settings may be a popout window
    }
    const modalNames = modal ? [...modal.querySelectorAll('.setting-item-name')].map((e) => e.textContent) : [...tab.ownerDocument.querySelectorAll('.modal')].map((m) => m.className);
    const hasKeySetting = !!modal && modalNames.includes('API key');
    modal?.querySelector('.modal-close-button')?.click();
    await new Promise((r) => setTimeout(r, 200));
    // toggling a setting in the AI section must not jump the page to the top
    const section = tab.querySelector('.hn-ai-section');
    const toggle = section.querySelector('.checkbox-container');
    // the toggle itself must be on screen (clicking an off-screen control scrolls to it)
    toggle.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 100));
    const before = tab.scrollTop;
    toggle.click();
    await new Promise((r) => setTimeout(r, 200));
    toggle.isConnected ? toggle.click() : section.querySelector('.checkbox-container').click();
    await new Promise((r) => setTimeout(r, 300));
    const after = tab.scrollTop;
    app.setting.close();
    return { supported, status, leaked: raw.includes('sk-e2e'), nameStored: raw.includes('handnote-e2e-key'), hasKeySetting, modalNames, rows: rows.length, openaiConfigured: !!openaiRow?.querySelector('.hn-ai-ok'), before, after, enabled: p.settings.ai.enabled };
  });
  assert(info.supported, 'secret storage available in this Obsidian');
  assert(!info.leaked && info.nameStored, 'data.json has the secret name, not the key');
  assert(info.status.ready, `AI ready (${JSON.stringify(info.status)})`);
  assert(info.rows >= 8 && info.openaiConfigured, `provider list with key status (${info.rows} rows)`);
  assert(info.hasKeySetting, `provider dialog shows the API key picker (${JSON.stringify(info.modalNames)})`);
  assert(info.enabled && Math.abs(info.after - info.before) < 5 && info.before > 200, `settings page keeps its scroll position (${info.before} → ${info.after})`);
  await page.evaluate(async () => {
    app.setting.open();
    app.setting.openTabById('handnote');
    await new Promise((r) => setTimeout(r, 300));
    app.setting.activeTab.containerEl.querySelector('.hn-ai-section')?.scrollIntoView();
  });
  await sleep(300);
  await page.screenshot({ path: 'test-output/obsidian-ai-settings.png' });
  await page.evaluate(() => app.setting.close());
  // switch to the offline mock provider and run a conversion through the real editor UI
  await page.evaluate(async () => {
    const p = app.plugins.plugins.handnote;
    // 0.4/0.5 steps exercise the vision-model pipeline (mock) explicitly; 0.6 Convert defaults to ink engines
    p.settings.ai = { ...p.settings.ai, defaultModel: 'mock-1', recognition: { ...p.settings.ai.recognition, engine: 'vision' } };
    await app.commands.executeCommandById('handnote:create');
  });
  await sleep(800);
  await draw(toSamples(YONG[1], { x0: 80, y0: 150, scale: 2, speed: 200 }));
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    const pg = ed.getDocument().pages[0];
    ed.setTool('lasso');
    ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
    void ed.runAI('handwriting');
  });
  await sleep(300);
  await page.screenshot({ path: 'test-output/obsidian-ai-consent.png' });
  await click('.hn-ai-send');
  await sleep(500);
  await page.screenshot({ path: 'test-output/obsidian-ai-preview.png' });
  await click('.hn-ai-keep');
  const items = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].items.map((i) => i.type));
  assert(items.includes('text'), `converted items ${items}`);
  return `secret storage ok; mock conversion inserted ${items.length} item(s)`;
});

await step('v0.5: formulas render with Obsidian MathJax on the canvas; mind map + flowchart conversion in the real app', async () => {
  const info = await page.evaluate(async () => {
    const p = app.plugins.plugins.handnote;
    const ok = await p.formulaInfo('\\frac{a+b}{2} \\geq \\sqrt{ab} + \\sum_{i=1}^{n} x_i^2');
    const bad = await p.formulaInfo('\\frac{a}{');
    return { ok, bad };
  });
  assert(info.ok.math && info.ok.glyphs >= 10 && info.ok.rules >= 2 && !info.ok.error, `MathJax snapshot ${JSON.stringify(info.ok)}`);
  assert(info.bad.error, `a LaTeX error is reported, not thrown (${JSON.stringify(info.bad)})`);
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    const pg = ed.getDocument().pages[0];
    ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
    void ed.convert('math');
  });
  await sleep(300);
  if (await page.evaluate(() => !!app.workspace.activeLeaf.view.contentEl.querySelector('.hn-ai-send'))) await click('.hn-ai-send');
  await sleep(1200);
  await page.screenshot({ path: 'test-output/obsidian-formula-preview.png' });
  await click('.hn-ai-keep');
  await sleep(800);
  const conv = async (task) => {
    await page.evaluate((task) => {
      const ed = app.workspace.activeLeaf.view.editor;
      const pg = ed.getDocument().pages[0];
      ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
      void ed.convert(task);
    }, task);
    await sleep(300);
    if (await page.evaluate(() => !!app.workspace.activeLeaf.view.contentEl.querySelector('.hn-ai-send'))) await click('.hn-ai-send');
    await sleep(600);
    await click('.hn-ai-keep');
    await sleep(300);
  };
  await conv('mindmap');
  await conv('diagram');
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.fitPage(0));
  await sleep(600);
  await page.screenshot({ path: 'test-output/obsidian-v05-objects.png' });
  const types = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].items.map((i) => i.type));
  assert(types.includes('formula') && types.includes('mindmap') && types.filter((t) => t === 'shape').length >= 10, `items ${types}`);
  await page.evaluate(async () => {
    await app.workspace.activeLeaf.view.flush?.();
  });
  await sleep(1200);
  const saved = await page.evaluate(async () => {
    const f = app.workspace.activeLeaf.view.file;
    return (await app.vault.read(f)).includes('"version":5');
  });
  assert(saved, 'saved as format 5');
  const rec = await page.evaluate(async () => {
    app.setting.open();
    app.setting.openTabById('handnote');
    await new Promise((r) => setTimeout(r, 400));
    const el = app.setting.activeTab.containerEl.querySelector('.hn-rec-section');
    el?.scrollIntoView();
    return el ? el.textContent : '';
  });
  await sleep(300);
  await page.screenshot({ path: 'test-output/obsidian-rec-settings.png' });
  await page.evaluate(() => app.setting.close());
  assert(/MyScript/.test(rec) && /LXGW|霞鹜/.test(rec), 'recognition settings: engine, MyScript BYOK and the optional font');
  return `formula glyphs ${info.ok.glyphs}, rules ${info.ok.rules}; items ${types.length}`;
});

await step('v0.6 beta.4: Convert → Text converts in place with the offline ink engine (no dialog, no upload); Restore ink; Math without MyScript explains', async () => {
  await page.evaluate(async () => {
    const p = app.plugins.plugins.handnote;
    p.settings.ai = { ...p.settings.ai, recognition: { ...p.settings.ai.recognition, engine: 'auto', offlineZh: true, visionFallback: false } };
    // 0.7: the on-device math model is not installed yet in this step
    await app.commands.executeCommandById('handnote:create');
  });
  await sleep(800);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  for (const [i, g] of YONG.entries()) await draw(toSamples(g, { x0: 80, y0: 150, scale: 1, speed: 160, t0: i * 300 }));
  const before = await page.evaluate(() => app.plugins.plugins.handnote.settings.ai.usage.totalRequests);
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    const pg = ed.getDocument().pages[0];
    ed.setTool('lasso');
    ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
    void ed.convert('text');
  });
  await page.waitForFunction(() => !!app.workspace.activeLeaf.view.contentEl.querySelector('.hn-conv-result'), null, { timeout: 30000 });
  const consent = await page.evaluate(() => !!app.workspace.activeLeaf.view.contentEl.querySelector('.hn-ai-consent, .hn-modal'));
  const facts = await page.evaluate(() => app.workspace.activeLeaf.view.contentEl.querySelector('.hn-conv-rinfo').textContent);
  await page.screenshot({ path: 'test-output/obsidian-offline-text.png' });
  const conv = await page.evaluate(() => {
    const pg = app.workspace.activeLeaf.view.getDocument().pages[0];
    return { texts: pg.items.filter((i) => i.type === 'text').map((i) => i.text), strokes: pg.strokes.length };
  });
  const texts = conv.texts;
  const val = texts[0];
  await click('.hn-conv-restore');
  await sleep(300);
  const restored = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes.length);
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    const pg = ed.getDocument().pages[0];
    ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
    void ed.convert('math');
  });
  await sleep(300);
  const missing = await page.evaluate(() => app.workspace.activeLeaf.view.contentEl.querySelector('.hn-conv-missing')?.getAttribute('data-reason'));
  await page.evaluate(() => app.workspace.activeLeaf.view.contentEl.querySelector('.hn-conv-missing .hn-action:not(.is-primary)')?.click());
  const after = await page.evaluate(() => app.plugins.plugins.handnote.settings.ai.usage.totalRequests);
  assert(!consent, 'no consent dialog for offline recognition');
  assert(val === '永' && texts.includes('永'), `recognised "${val}" → items ${texts}`);
  assert(/离线|Offline/.test(facts), `engine named (${facts})`);
  assert(conv.strokes === 0 && restored === YONG.length, `ink replaced in place (${conv.strokes} left), restored (${restored})`);
  // private edition: the on-device model is offered; public edition: it is not included (Type LaTeX)
  const priv = await page.evaluate(() => app.plugins.plugins.handnote.local.includesMath());
  assert(missing === (priv ? 'local-math-missing' : 'local-math-not-included'), `math: ${priv ? 'offers the on-device model' : 'explains it is not included'} (${missing})`);
  assert(after === before, 'no AI request');
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  return `offline "${val}", ${facts}`;
});

await step('v0.4: lasso moves ink, page navigator and laser work inside Obsidian', async () => {
  const r = await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const ed = view.editor;
    const pg = ed.getDocument().pages[0];
    const x0 = pg.strokes[0].samples[0].x;
    ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
    await new Promise((r) => requestAnimationFrame(r));
    const box = view.contentEl.querySelector('.hn-lasso-sel').getBoundingClientRect();
    const ev = (type, x, y) => view.contentEl.querySelector('.hn-lasso-sel').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 21, pointerType: 'pen', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    ev('pointerdown', cx, cy);
    for (let i = 1; i <= 6; i++) ev('pointermove', cx + i * 10, cy);
    ev('pointerup', cx + 60, cy);
    const x1 = ed.getDocument().pages[0].strokes[0].samples[0].x;
    view.contentEl.querySelector('.hn-pages-btn').click();
    await new Promise((r) => setTimeout(r, 200));
    const thumbs = view.contentEl.querySelectorAll('.hn-ps-cell[data-index]').length;
    ed.closePagesSidebar();
    ed.setTool('laser');
    return { moved: x1 - x0, thumbs, laser: !!view.contentEl.querySelector('canvas.hn-laser') };
  });
  assert(r.moved > 10, `lasso moved the ink (${r.moved})`);
  assert(r.thumbs >= 1 && r.laser, JSON.stringify(r));
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  return JSON.stringify(r);
});

await step('v0.2: a realistic finger contact (52 px) pans the page in Obsidian and never draws', async () => {
  const before = await page.evaluate(() => ({ cam: app.workspace.activeLeaf.view.editor.camera, n: app.workspace.activeLeaf.view.getDocument().pages.reduce((a, p) => a + p.strokes.length, 0) }));
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const v = view.contentEl.querySelector('.hn-viewport');
    const r = v.getBoundingClientRect();
    const ev = (type, x, y) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 91, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    ev('pointerdown', 300, 500);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 300, 500 - i * 12); await frame(); }
    ev('pointerup', 300, 380);
    await new Promise((res) => setTimeout(res, 600));
  });
  const after = await page.evaluate(() => ({ cam: app.workspace.activeLeaf.view.editor.camera, n: app.workspace.activeLeaf.view.getDocument().pages.reduce((a, p) => a + p.strokes.length, 0) }));
  assert(after.cam.y > before.cam.y + 30, `camera y ${before.cam.y.toFixed(1)} → ${after.cam.y.toFixed(1)}`);
  assert(after.n === before.n, 'no stroke from the finger');
  return `panned ${(after.cam.y - before.cam.y).toFixed(0)} units`;
});

await step('recovery journal: unsaved strokes offered after an unclean close', async () => {
  // write a stroke, then simulate a crash: journal is written (400 ms) but the file save is skipped
  const res = await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    view.saveNow = async () => {}; // simulate: process killed before the debounced save
    return view.getDocument().id;
  });
  await draw(toSamples([[0, 0], [50, 30]], { x0: 80, y0: 500, scale: 2, speed: 200 }));
  await sleep(900);
  const journal = await page.evaluate(async (id) => app.vault.adapter.exists(`.obsidian/plugins/handnote/journal/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`), res);
  assert(journal, 'journal written');
  // reopen in a fresh leaf (the in-memory view is discarded without saving)
  await page.evaluate(async () => {
    const leaf = app.workspace.activeLeaf;
    const p = leaf.view.file.path; // reopen the very file whose unsaved state was journaled
    leaf.view.dirty = false; // pretend the process died: nothing flushed
    leaf.detach();
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p));
  });
  await sleep(1000);
  const modal = await page.evaluate(() => document.querySelector('.modal-container .modal h3')?.textContent ?? '');
  assert(modal.includes('Unsaved handwriting'), `modal: "${modal}"`);
  await page.screenshot({ path: 'test-output/obsidian-recovery-modal.png' });
  await page.evaluate(() => [...document.querySelectorAll('.modal-container button')].find((b) => b.textContent.includes('Restore')).click());
  await sleep(300);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  return 'journal restored';
});

if (errors.length) console.log('Console/page errors:\n  ' + errors.join('\n  '));
await writeFile('test-output/obsidian-e2e-report.json', JSON.stringify({ date: new Date().toISOString(), results, errors }, null, 2));
// Edition of the build under test: the public edition has no local math model
// (docs/PUBLIC_PRIVATE_RELEASE_STRATEGY.md); the private one adds it (npm run build:private).
const PRIVATE_EDITION = await page.evaluate(() => app.plugins.plugins.handnote.local.includesMath());
const privAssets = PRIVATE_EDITION ? await import('../../src/private/dev/assets.mjs') : null;
console.log(`  edition under test: ${PRIVATE_EDITION ? 'PRIVATE (local math model)' : 'PUBLIC (no local math model)'}`);

await step(`v0.7: on-device recognition inside Obsidian — model files imported (verified), ONNX Runtime in a worker, self-test, ${PRIVATE_EDITION ? 'Convert → Math in place' : 'Chinese text; Convert → Math offers typing LaTeX (public edition)'}`, async () => {
  const { existsSync } = await import('node:fs');
  if (!existsSync('local-assets/ort/dist/ort-wasm-simd-threaded.wasm')) return 'SKIPPED: local-assets missing';
  const esbuild = (await import('esbuild')).default;
  const out = 'build/e2e-synthetic-math.mjs';
  await esbuild.build({ entryPoints: ['src/local/synthetic-math.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'warning' });
  const { MATH_CASES, mathInk } = await import('../../' + out);
  const model = PRIVATE_EDITION ? privAssets.MATH_ASSET_FILES : ['ppocrv5-mobile-rec/inference.onnx', 'ppocrv5-mobile-rec/ppocrv5_dict.txt'];
  const files = ['ort/dist/ort.wasm.bundle.min.mjs', 'ort/dist/ort-wasm-simd-threaded.wasm', ...model].map((f) => process.cwd() + '/local-assets/' + f);
  const imported = await page.evaluate(async (files) => {
    const fs = window.require('fs');
    const p = app.plugins.plugins.handnote;
    const list = files.map((f) => {
      const b = fs.readFileSync(f);
      return { name: f.split('/').pop(), data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    });
    const r = await p.local.importFiles(list);
    p.recognition.clearCache();
    return r;
  }, files);
  assert(imported.accepted.length === files.length && !imported.rejected.length, `files accepted by hash (${JSON.stringify(imported)})`);
  const report = await page.evaluate(() => app.plugins.plugins.handnote.runLocalSelfTest());
  console.log(report.split('\n').map((l) => '      ' + l).join('\n'));
  assert(/ONNX Runtime start: .*mode worker/.test(report), 'module worker from a blob URL works in Obsidian');
  assert(new RegExp(`Edition: ${PRIVATE_EDITION ? 'private' : 'public'}`).test(report), 'self-test names the edition');
  if (PRIVATE_EDITION) assert(/✔ Math recognition/.test(report), 'synthetic formulas recognised in Obsidian');
  else {
    assert(/✔ Text recognition/.test(report), 'Chinese text model recognises in Obsidian (public edition)');
    assert(/math not in this edition/.test(report) && !/Math model load|Math recognition/.test(report), 'self-test: no math model in the public edition');
  }
  // Convert → Math through the real editor
  await page.evaluate(async () => {
    await app.commands.executeCommandById('handnote:create');
  });
  await sleep(800);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  const strokes = mathInk(MATH_CASES[0].node, { x: 80, y: 140, size: 30, seed: 5, jitter: 0.6 });
  for (const [k, st] of strokes.entries()) await draw(st.map(([x, y], j) => ({ x, y, p: 0.5, t: k * 400 + j * 6 })));
  const t0 = Date.now();
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    const pg = ed.getDocument().pages[0];
    ed.setTool('lasso');
    ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
    void ed.convert('math');
  });
  if (!PRIVATE_EDITION) {
    // public edition: the dialog says the model is not included and offers typing LaTeX
    await page.waitForFunction(() => !!document.querySelector('.hn-conv-missing'), null, { timeout: 15000 });
    const d = await page.evaluate(() => {
      const m = document.querySelector('.hn-conv-missing');
      return { reason: m?.dataset.reason, install: !!document.querySelector('.hn-conv-install'), typeLatex: !!document.querySelector('.hn-conv-type-latex'), text: m?.textContent ?? '' };
    });
    assert(d.reason === 'local-math-not-included' && !d.install && d.typeLatex, `not-included dialog with "Type LaTeX" (${JSON.stringify(d)})`);
    assert(/LaTeX/.test(d.text) && /MyScript/.test(d.text), 'explains typing LaTeX and MyScript');
    await page.screenshot({ path: 'test-output/obsidian-public-math.png' });
    await page.evaluate(() => document.querySelector('.hn-conv-type-latex').click());
    await page.waitForFunction(() => !!document.querySelector('.hn-conv-math textarea.hn-conv-latex'), null, { timeout: 10000 });
    await page.evaluate(() => {
      const ta = document.querySelector('.hn-conv-math textarea.hn-conv-latex');
      ta.value = 'x^{2}+y^{2}';
      ta.dispatchEvent(new Event('input'));
    });
    await sleep(400);
    await page.evaluate(() => document.querySelector('.hn-conv-math .hn-ai-keep').click());
    await sleep(600);
    const r = await page.evaluate(() => {
      const v = app.workspace.activeLeaf.view;
      v.flush();
      const pg = v.getDocument().pages[0];
      return { latex: pg.items.find((i) => i.type === 'formula')?.latex, strokes: pg.strokes.length };
    });
    assert(r.latex === 'x^{2}+y^{2}', `typed formula inserted (${r.latex})`);
    assert(r.strokes === strokes.length, 'ink kept beside it (the user chose Keep)');
    await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
    return `public edition: not-included dialog, typed ${r.latex}, ink kept`;
  }
  await page.waitForFunction(() => !!app.workspace.activeLeaf.view.contentEl.querySelector('.hn-conv-result, .hn-conv-math'), null, { timeout: 60000 });
  const ms = Date.now() - t0;
  await sleep(600);
  await page.screenshot({ path: 'test-output/obsidian-local-math.png' });
  const r = await page.evaluate(() => {
    const pg = app.workspace.activeLeaf.view.getDocument().pages[0];
    const f = pg.items.find((i) => i.type === 'formula');
    return { latex: f?.latex, strokes: pg.strokes.length, info: app.workspace.activeLeaf.view.contentEl.querySelector('.hn-conv-rinfo')?.textContent ?? '' };
  });
  assert(r.latex === 'x^{2}+y^{2}', `formula ${r.latex}`);
  assert(r.strokes === 0, 'converted in place');
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  return `${r.latex} in ${ms} ms (${r.info})`;
});

await step('lifecycle: closing a note, switching tabs and disabling HandNote while on-device recognition runs', async () => {
  const { existsSync } = await import('node:fs');
  if (!existsSync('local-assets/ort/dist/ort-wasm-simd-threaded.wasm')) return 'SKIPPED: local-assets missing';
  const { MATH_CASES, mathInk } = await import('../../build/e2e-synthetic-math.mjs');
  const ink = mathInk(MATH_CASES[0].node, { x: 80, y: 140, size: 30, seed: 5, jitter: 0.6 });
  const writeMath = async (path) => {
    await page.evaluate(async (path) => {
      const f = await app.vault.create(path, '');
      await app.workspace.getLeaf(true).openFile(f);
    }, path);
    await sleep(700);
    await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
    for (const [k, st] of ink.entries()) await draw(st.map(([x, y], j) => ({ x, y, p: 0.5, t: k * 400 + j * 6 })));
    await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  };
  // public edition: the same ink is read as text (Chinese model), so a recognition is in flight too
  const TASK = PRIVATE_EDITION ? 'math' : 'text';
  const startConvert = () =>
    page.evaluate((task) => {
      const ed = app.workspace.activeLeaf.view.editor;
      const pg = ed.getDocument().pages[0];
      ed.setTool('lasso');
      ed.lasso.setSelection({ pageId: pg.id, strokeIds: new Set(pg.strokes.map((s) => s.id)), itemIds: new Set() });
      void ed.convert(task);
    }, TASK);
  const onDisk = (path) =>
    page.evaluate(async (path) => {
      const t = await app.vault.adapter.read(path);
      if (!t.trim()) return { strokes: 0, formulas: 0, empty: true };
      const d = JSON.parse(t);
      // converted items: formulas (math) or text boxes (text)
      return { strokes: d.pages[0].strokes.length, formulas: (d.pages[0].items ?? []).filter((i) => i.type === 'formula' || i.type === 'text').length };
    }, path);
  const errs0 = errors.length;
  // 1. close the note while the conversion runs: the ink stays in the file, nothing throws
  await writeMath('Life-close.handnote');
  await startConvert();
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(3000);
  const a = await onDisk('Life-close.handnote');
  assert(a.strokes === ink.length && a.formulas === 0, `closed during recognition: ${JSON.stringify(a)}`);
  // 2. switch to another note while the conversion runs, then come back
  await writeMath('Life-switch.handnote');
  await startConvert();
  await page.evaluate(async () => {
    const f = await app.vault.create('Life-other.handnote', '');
    await app.workspace.getLeaf(true).openFile(f);
  });
  await sleep(3000);
  const other = await onDisk('Life-other.handnote');
  assert(other.strokes === 0 && other.formulas === 0, `the other note is untouched (${JSON.stringify(other)})`);
  await page.evaluate(() => {
    const l = app.workspace.getLeavesOfType('handnote-view').find((x) => x.view.file?.path === 'Life-switch.handnote');
    app.workspace.setActiveLeaf(l, { focus: true });
  });
  await sleep(500);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(400);
  const b = await onDisk('Life-switch.handnote');
  assert((b.formulas === 1 && b.strokes === 0) || (b.formulas === 0 && b.strokes === ink.length), `switched note is either converted or untouched (${JSON.stringify(b)})`);
  // 3. disable HandNote while a conversion runs: the recognition worker is terminated
  const w0 = page.workers().length;
  await writeMath('Life-disable.handnote');
  await startConvert();
  await sleep(150);
  const wRun = page.workers().length;
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('handnote');
  });
  await sleep(1500);
  const wOff = page.workers().length;
  await page.evaluate(async () => {
    await app.plugins.enablePlugin('handnote');
  });
  await sleep(1200);
  const c = await onDisk('Life-disable.handnote');
  assert(c.strokes === ink.length, `ink kept when HandNote was disabled mid-conversion (${JSON.stringify(c)})`);
  assert(wOff <= w0, `recognition worker terminated on disable (workers: before ${w0}, running ${wRun}, after disable ${wOff})`);
  const newErr = errors.slice(errs0);
  assert(!newErr.length, `no HandNote errors: ${newErr.join(' | ').slice(0, 300)}`);
  return `close: ink kept; switch: ${b.formulas ? 'converted' : 'untouched'}, other note untouched; disable: workers ${w0} → ${wRun} → ${wOff}`;
});

// ------------------------------------------------------------------------------------------------
// Fault injection (release-readiness audit): damaged files, failing writes, newer formats, damaged
// sync deliveries. The rule: a note is never silently replaced by less than it had.
// ------------------------------------------------------------------------------------------------

async function openPath(path) {
  await page.evaluate(async (path) => {
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(path));
  }, path);
  await sleep(900);
}

const trace = (m) => process.env.HN_E2E_TRACE && console.log(`      · ${m}`);
async function makeNote(path, strokes = 3) {
  trace(`makeNote ${path}: create`);
  await page.evaluate(async (path) => {
    await app.vault.create(path, '');
  }, path);
  trace('open');
  await openPath(path);
  trace('setTool');
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  trace('draw');
  for (let i = 0; i < strokes; i++) await draw(toSamples([[0, 0], [60, 20]], { x0: 80 + i * 70, y0: 200, scale: 1.5, speed: 200 }));
  trace('flush');
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(500);
  trace('read');
  return page.evaluate((path) => app.vault.adapter.read(path), path);
}

await step('UI: every popover lays out correctly under Obsidian\'s own button styles (nothing spills out of a button, no blocks overlap)', async () => {
  const sweep = async () => {
  await page.evaluate(() => app.commands.executeCommandById('handnote:create'));
  await sleep(800);
  return page.evaluate(async () => {
    const ed = app.workspace.activeLeaf.view.editor;
    const anchor = app.workspace.activeLeaf.view.contentEl.querySelector('.hn-toolbar button, button');
    const openers = {
      template: () => ed.openTemplate(anchor),
      more: () => ed.openMoreMenu(anchor),
      pen: () => ed.openPenPanel('fountain', anchor),
      width: () => ed.openWidthPanel('fountain', 0, anchor),
      shapeStyle: () => ed.openShapeStyle(anchor),
      shapeColor: () => ed.openShapeColor(anchor),
      textColor: () => ed.openTextColor(anchor),
      lassoColor: () => ed.openLassoColor(anchor),
      convert: () => ed.openConvertMenu(anchor),
      ai: () => ed.openAIMenu(anchor),
    };
    const out = {};
    for (const [name, open] of Object.entries(openers)) {
      ed.closePopover();
      try {
        open();
      } catch (e) {
        out[name] = 'open failed: ' + String(e).slice(0, 80);
        continue;
      }
      await new Promise((res) => setTimeout(res, 250));
      const pop = document.querySelector('.hn-popover');
      if (!pop) {
        out[name] = 'not opened';
        continue;
      }
      const bad = [];
      for (const b of pop.querySelectorAll('button')) {
        const br = b.getBoundingClientRect();
        if (!br.height) continue;
        for (const c of b.querySelectorAll('*')) {
          const k = c.getBoundingClientRect();
          if (k.height && (k.top < br.top - 1 || k.bottom > br.bottom + 1)) bad.push(`button ${b.className || b.textContent.slice(0, 12)} > ${c.tagName.toLowerCase()}.${c.className}`);
        }
      }
      const blocks = [...pop.children].filter((e) => e.getBoundingClientRect().height);
      for (let i = 1; i < blocks.length; i++) {
        const a = blocks[i - 1].getBoundingClientRect();
        const b = blocks[i].getBoundingClientRect();
        // blocks that sit side by side (same row) are fine; stacked blocks must not overlap
        if (b.top < a.bottom - 1 && b.left < a.right - 1 && a.left < b.right - 1) bad.push(`overlap ${blocks[i - 1].className} / ${blocks[i].className}`);
      }
      out[name] = bad.length ? bad.slice(0, 4).join('; ') : 'ok';
    }
    ed.closePopover();
    return out;
  });
  };
  const en = await sweep();
  // the same panels in Chinese (longer and differently wrapped labels): HandNote reads the
  // language when it loads
  await page.evaluate(async () => {
    window.localStorage.setItem('language', 'zh');
    await app.plugins.disablePlugin('handnote');
    await app.plugins.enablePlugin('handnote');
  });
  await sleep(600);
  const zh = await sweep();
  await page.evaluate(async () => {
    window.localStorage.removeItem('language');
    await app.plugins.disablePlugin('handnote');
    await app.plugins.enablePlugin('handnote');
  });
  await sleep(600);
  const bad = [...Object.entries(en).map(([k, v]) => ['en ' + k, v]), ...Object.entries(zh).map(([k, v]) => ['zh ' + k, v])].filter(([, v]) => v !== 'ok' && v !== 'not opened');
  assert(!bad.length, JSON.stringify(Object.fromEntries(bad)));
  return `en + zh: ${Object.keys(en).length} popovers each, all laid out correctly`;
});

await step('memory before the fault steps (open HandNote views, canvas pixels)', async () => {
  const m = await page.evaluate(() => {
    const leaves = app.workspace.getLeavesOfType('handnote-view');
    let px = 0;
    let n = 0;
    for (const c of document.querySelectorAll('canvas')) {
      px += c.width * c.height;
      n++;
    }
    const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
    return { leaves: leaves.length, canvases: n, mpx: Math.round(px / 1e6), heap };
  });
  return JSON.stringify(m);
});

await step('fault setup: close the tabs of the earlier steps', async () => {
  const n = await page.evaluate(async () => {
    const leaves = [...app.workspace.getLeavesOfType('handnote-view'), ...app.workspace.getLeavesOfType('markdown')];
    for (const l of leaves) {
      await l.view.flush?.();
      l.detach();
    }
    return leaves.length;
  });
  await sleep(1000);
  return `${n} tabs closed`;
});

await step('fault: a damaged (truncated) note opens read-only, is never written, and its strokes can be saved as a copy', async () => {
  const good = await makeNote('Fault-source.handnote', 4);
  const damaged = good.slice(0, Math.floor(good.length * 0.8));
  trace('create damaged');
  await page.evaluate(async (t) => app.vault.create('Fault-damaged.handnote', t), damaged);
  trace('open damaged');
  await openPath('Fault-damaged.handnote');
  trace('state');
  const st = await page.evaluate(() => {
    const v = app.workspace.activeLeaf.view;
    return { ro: v.readOnly, banner: !!v.contentEl.querySelector('.hn-recovered-banner'), strokes: v.getDocument()?.pages.reduce((n, p) => n + p.strokes.length, 0) };
  });
  assert(st.ro && st.banner, `read-only with the banner (${JSON.stringify(st)})`);
  trace('draw on read-only');
  await draw(toSamples([[0, 0], [60, 20]], { x0: 80, y0: 400, scale: 1.5, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(1600);
  trace('read back');
  const after = await page.evaluate(() => app.vault.adapter.read('Fault-damaged.handnote'));
  assert(after === damaged, 'the damaged file is byte-identical (never overwritten)');
  const copy = await page.evaluate(() => app.workspace.activeLeaf.view.saveRecoveredCopy());
  await sleep(800);
  const text = await page.evaluate((p) => app.vault.adapter.read(p), copy);
  const n = (text.match(/"pts":/g) ?? []).length;
  assert(n >= 1 && n === st.strokes, `recovered copy "${copy}" holds the ${st.strokes} recovered strokes (${n})`);
  return `${st.strokes} of 4 strokes recovered into "${copy.split('/').pop()}"`;
});

await step('fault: a failing write (disk full) keeps the file intact and the strokes in memory + journal; the next save succeeds', async () => {
  const before = await makeNote('Fault-diskfull.handnote', 2);
  await page.evaluate(() => {
    const v = app.vault;
    window.__hnProcess = v.process;
    v.process = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
  });
  await draw(toSamples([[0, 0], [60, 20]], { x0: 80, y0: 420, scale: 1.5, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(1200);
  const st = await page.evaluate(async () => {
    const v = app.workspace.activeLeaf.view;
    const id = v.getDocument().id.replace(/[^A-Za-z0-9_-]/g, '_');
    return { dirty: v.dirty, journal: await app.vault.adapter.exists(`${app.vault.configDir}/plugins/handnote/journal/${id}.json`), disk: await app.vault.adapter.read('Fault-diskfull.handnote') };
  });
  assert(st.disk === before, 'file unchanged by the failed write');
  assert(st.dirty && st.journal, `still dirty, journal kept (${st.dirty}, ${st.journal})`);
  await page.evaluate(() => (app.vault.process = window.__hnProcess));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(800);
  const disk = await page.evaluate(() => app.vault.adapter.read('Fault-diskfull.handnote'));
  const n = (disk.match(/"pts":/g) ?? []).length;
  assert(n === 3, `saved after the disk recovered (${n} strokes)`);
});

await step('fault: a note from a newer HandNote version opens read-only and is not written', async () => {
  const good = await makeNote('Fault-newer-src.handnote', 1);
  const newer = good.replace(/"version":\d+/, '"version":99');
  await page.evaluate(async (t) => app.vault.create('Fault-newer.handnote', t), newer);
  await openPath('Fault-newer.handnote');
  await draw(toSamples([[0, 0], [60, 20]], { x0: 80, y0: 420, scale: 1.5, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(1500);
  const st = await page.evaluate(async () => ({ ro: app.workspace.activeLeaf.view.readOnly, disk: await app.vault.adapter.read('Fault-newer.handnote') }));
  assert(st.ro && st.disk === newer, 'read-only, file unchanged');
});

await step('fault: a damaged version arriving by sync is not loaded over the open note; the next save keeps it as a conflict copy', async () => {
  const good = await makeNote('Fault-sync.handnote', 3);
  await page.evaluate(async (t) => app.vault.adapter.write('Fault-sync.handnote', t), good.slice(0, Math.floor(good.length * 0.6)).replace(/"revision":\d+/, '"revision":999'));
  await page.evaluate(() => app.vault.trigger('modify', app.vault.getAbstractFileByPath('Fault-sync.handnote')));
  await sleep(800);
  const open = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes.length);
  assert(open === 3, `the open note keeps its 3 strokes (${open})`);
  await draw(toSamples([[0, 0], [60, 20]], { x0: 80, y0: 420, scale: 1.5, speed: 200 }));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(1000);
  const files = await page.evaluate(() => app.vault.getFiles().filter((f) => f.path.startsWith('Fault-sync')).map((f) => f.path));
  const disk = await page.evaluate(() => app.vault.adapter.read('Fault-sync.handnote'));
  assert(files.some((f) => f.includes('conflict')), `damaged version kept as a conflict copy (${files})`);
  assert((disk.match(/"pts":/g) ?? []).length === 4, 'our 4 strokes written');
});

await step('stress: 12 open handwritten notes, writing in each, then creating a note — everything stays responsive', async () => {
  for (let i = 0; i < 12; i++) {
    await page.evaluate(async (i) => {
      await app.vault.create(`Stress-${i}.handnote`, '');
      await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(`Stress-${i}.handnote`));
    }, i);
    await sleep(400);
    await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
    await draw(toSamples([[0, 0], [80, 30], [160, 0]], { x0: 80, y0: 200, scale: 1.5, speed: 250 }));
  }
  const t0 = Date.now();
  const r = await Promise.race([
    page.evaluate(async () => {
      for (const v of app.workspace.getLeavesOfType('handnote-view')) await v.view.flush?.();
      await app.vault.create('Stress-after.handnote', '');
      return app.workspace.getLeavesOfType('handnote-view').length;
    }),
    new Promise((res) => setTimeout(() => res('HANG'), 30000)),
  ]);
  assert(r !== 'HANG', 'responsive after 12 open notes');
  return `${r} open notes; create + flush took ${Date.now() - t0} ms`;
});

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} Obsidian E2E steps passed`);
if (errors.length) console.log(`page errors (${errors.length}):\n${errors.map((e) => '  ' + e.slice(0, 300)).join('\n')}`);
await browser.close().catch(() => undefined);
process.exit(failed || errors.length ? 1 : 0);
