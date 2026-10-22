// Lifecycle regression tests against a REAL Obsidian desktop app (R16: settings → new note →
// write → new note crashed Electron on the Linux test machine).
//
//   1. npm run build && node scripts/prepare-test-vault.mjs <TEST VAULT>
//   2. Obsidian --remote-debugging-port=9333 (Linux: --no-sandbox under Xvfb), on that vault
//   3. node tests/obsidian-e2e/lifecycle.mjs            (HN_LC_ONLY=<regex> runs some steps)
//
// NEVER point this at your real vault. Each step is guarded by a timeout, and the run checks after
// every step that the renderer still answers: a native crash shows up as "renderer gone".
import { createRequire } from 'node:module';
import { toSamples } from '../browser/handwriting.mjs';
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
let gone = false;
page.on('crash', () => (gone = true));
page.on('close', () => (gone = true));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (process.env.HN_LC_VERBOSE && (m.type() === 'error' || m.type() === 'warning')) console.log(`      [console.${m.type()}] ${m.text().slice(0, 200)}`);
  if (m.type() === 'error' && /handnote|HandNote/.test(m.text())) errors.push(m.text());
});

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function alive() {
  if (gone) return false;
  return Promise.race([page.evaluate(() => 1).then(() => true, () => false), sleep(10000).then(() => false)]);
}
async function step(name, fn, timeoutMs = 90000) {
  if (process.env.HN_LC_ONLY && !new RegExp(process.env.HN_LC_ONLY).test(name) && !/^setup/.test(name)) return;
  if (gone) {
    results.push({ name, pass: false, info: 'skipped: renderer gone' });
    console.log(`SKIP ${name}: renderer gone`);
    return;
  }
  const t0 = Date.now();
  try {
    const info = await Promise.race([fn(), sleep(timeoutMs).then(() => Promise.reject(new Error(`timed out after ${timeoutMs / 1000} s`)))]);
    if (!(await alive())) throw new Error('renderer gone after the step (native crash)');
    results.push({ name, pass: true, info: info ?? '' });
    console.log(`PASS ${name}${info ? ' — ' + info : ''} (${Date.now() - t0} ms)`);
  } catch (e) {
    const dead = !(await alive());
    results.push({ name, pass: false, info: e.message + (dead ? ' [renderer gone]' : '') });
    console.log(`FAIL ${name}: ${e.message}${dead ? ' [renderer gone]' : ''}`);
  }
}

async function draw(n = 3) {
  for (let i = 0; i < n; i++) {
    const samples = toSamples([[0, 0], [60, 20]], { x0: 80 + (i % 6) * 70, y0: 200 + Math.floor(i / 6) * 60, scale: 1.5, speed: 200 });
    await page.evaluate(async (samples) => {
      const view = app.workspace.activeLeaf.view;
      const ed = view.editor;
      const v = view.contentEl.querySelector('.hn-viewport');
      const mk = (type, s) => {
        const c = ed.pageToClient(0, s.x, s.y);
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
    }, samples);
  }
}
async function newNote(path) {
  await page.evaluate(async (path) => {
    const f = await app.vault.create(path, '');
    await app.workspace.getLeaf(true).openFile(f);
  }, path);
  await sleep(700);
  return page.evaluate(() => app.workspace.activeLeaf.view.getViewType());
}
async function strokesIn(path) {
  return page.evaluate(async (path) => {
    const d = JSON.parse(await app.vault.adapter.read(path));
    return d.pages.reduce((n, p) => n + p.strokes.length, 0);
  }, path);
}
async function openSettings(ms = 500) {
  await page.evaluate(async (ms) => {
    app.setting.open();
    app.setting.openTabById('handnote');
    const el = app.setting.activeTab?.containerEl;
    if (el) el.scrollTop = el.scrollHeight; // "scroll through it"
    await new Promise((r) => setTimeout(r, ms));
    app.setting.close();
  }, ms);
}
const counts = () =>
  page.evaluate(() => ({
    views: app.workspace.getLeavesOfType('handnote-view').length,
    canvases: document.querySelectorAll('canvas').length,
    workers: app.plugins.plugins.handnote?.local?.engineState?.() ?? null,
    settingsEls: document.querySelectorAll('.hn-ai-section').length,
  }));

// ------------------------------------------------------------------------------------------------
await step('setup: plugin enabled in the test vault', async () => {
  const v = await page.evaluate(async () => {
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.plugins.handnote) await app.plugins.enablePluginAndSave('handnote');
    return { vault: app.vault.getName(), ok: !!app.plugins.plugins.handnote?._loaded };
  });
  assert(v.vault === 'test-vault', `vault is ${v.vault}`);
  assert(v.ok, 'plugin not loaded');
  await page.evaluate(() => app.vault.createFolder('lc').catch(() => undefined));
  return 'test-vault';
});

await step('R16: settings → new note → write → new note', async () => {
  await openSettings();
  assert((await newNote('lc/r16-a.handnote')) === 'handnote-view', 'not a HandNote view');
  await draw(3);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(2000);
  assert((await newNote('lc/r16-b.handnote')) === 'handnote-view', 'second note not opened');
  await sleep(1500);
  const n = await strokesIn('lc/r16-a.handnote');
  assert(n === 3, `first note has ${n} strokes`);
  return '3 strokes saved, second note open';
});

await step('settings opened and closed 10 times', async () => {
  for (let i = 0; i < 10; i++) await openSettings(150);
  const c = await counts();
  assert(c.settingsEls === 0, `${c.settingsEls} settings sections left in the DOM`);
  return JSON.stringify(c);
});

await step('settings open while notes are created and written', async () => {
  await page.evaluate(() => {
    app.setting.open();
    app.setting.openTabById('handnote');
  });
  await sleep(300);
  await page.evaluate(() => app.setting.close());
  for (let i = 0; i < 4; i++) {
    await newNote(`lc/many-${i}.handnote`);
    await draw(2);
    if (i % 2) await openSettings(100);
  }
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(800);
  const n = await strokesIn('lc/many-3.handnote');
  assert(n === 2, `many-3 has ${n} strokes`);
  return `4 notes, ${JSON.stringify(await counts())}`;
});

await step('switching between 8 HandNote tabs while writing', async () => {
  const leaves = await page.evaluate(() => app.workspace.getLeavesOfType('handnote-view').length);
  for (let k = 0; k < 16; k++) {
    await page.evaluate((k) => {
      const ls = app.workspace.getLeavesOfType('handnote-view');
      app.workspace.setActiveLeaf(ls[k % ls.length], { focus: true });
    }, k);
    await sleep(120);
    if (k % 4 === 0) await draw(1);
  }
  return `${leaves} tabs`;
});

await step('disable and enable HandNote 5 times with a note open; nothing is lost', async () => {
  await newNote('lc/toggle.handnote');
  await draw(2);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(600);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(async () => {
      await app.plugins.disablePlugin('handnote');
      await app.plugins.enablePlugin('handnote');
    });
    await sleep(400);
  }
  const n = await strokesIn('lc/toggle.handnote');
  assert(n === 2, `toggle note has ${n} strokes`);
  const open = await page.evaluate(() => app.workspace.getLeavesOfType('handnote-view').length);
  return `strokes kept; ${open} HandNote tabs after re-enable`;
});

await step('close every tab while a save is pending; the strokes are on disk', async () => {
  await newNote('lc/close-pending.handnote');
  await draw(3);
  await page.evaluate(() => {
    for (const l of app.workspace.getLeavesOfType('handnote-view')) l.detach();
  });
  await sleep(1500);
  const n = await strokesIn('lc/close-pending.handnote');
  assert(n === 3, `close-pending has ${n} strokes`);
  return '3 strokes saved on close';
});

await step('many strokes (120) in one note, then reopen', async () => {
  await newNote('lc/many-strokes.handnote');
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    ed.setTool('fountain');
  });
  for (let i = 0; i < 20; i++) await draw(6);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(1000);
  const n = await strokesIn('lc/many-strokes.handnote');
  assert(n === 120, `${n} strokes`);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(300);
  await page.evaluate(() => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('lc/many-strokes.handnote')));
  await sleep(1200);
  return `120 strokes, reopened (${JSON.stringify(await counts())})`;
}, 240000);

await step('settings → new → write → new, repeated 5 times', async () => {
  for (let i = 0; i < 5; i++) {
    await openSettings(200);
    await newNote(`lc/rep-${i}-a.handnote`);
    await draw(2);
    await page.evaluate(() => app.workspace.activeLeaf.view.flush());
    await sleep(400);
    await newNote(`lc/rep-${i}-b.handnote`);
  }
  return JSON.stringify(await counts());
});

await step('the same note in two tabs: writing in both loses nothing', async () => {
  await newNote('lc/two-tabs.handnote');
  await draw(1);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  await sleep(400);
  // second tab on the same file
  await page.evaluate(() => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('lc/two-tabs.handnote')));
  await sleep(800);
  const leaves = () =>
    page.evaluate(() => app.workspace.getLeavesOfType('handnote-view').filter((l) => l.view.file?.path === 'lc/two-tabs.handnote').length);
  assert((await leaves()) === 2, 'two tabs on the note');
  const activate = (i) =>
    page.evaluate((i) => {
      const ls = app.workspace.getLeavesOfType('handnote-view').filter((l) => l.view.file?.path === 'lc/two-tabs.handnote');
      app.workspace.setActiveLeaf(ls[i], { focus: true });
    }, i);
  // write in B without saving, then in A, then save both
  await activate(1);
  await draw(2);
  await activate(0);
  await sleep(300);
  await draw(3);
  await page.evaluate(async () => {
    for (const l of app.workspace.getLeavesOfType('handnote-view')) await l.view.flush?.();
  });
  await sleep(1500);
  const r = await page.evaluate(async () => {
    const count = async (p) => {
      const d = JSON.parse(await app.vault.adapter.read(p));
      return d.pages.reduce((n, pg) => n + pg.strokes.length, 0);
    };
    const copies = app.vault.getFiles().filter((f) => f.path.startsWith('lc/two-tabs (conflict'));
    return { main: await count('lc/two-tabs.handnote'), copies: await Promise.all(copies.map((f) => count(f.path))) };
  });
  // 1 saved stroke + 2 (tab B) + 3 (tab A): every stroke must be on disk, in the note or a copy
  // either one file with all 6, or the note + conflict copies that together hold all 6 (the first
  // stroke is in each of them)
  const total = r.main + r.copies.reduce((a, b) => a + b, 0);
  assert(r.main === 6 || (r.copies.length >= 1 && total >= 6 + r.copies.length), `strokes on disk: note ${r.main}, conflict copies ${JSON.stringify(r.copies)}`);
  return `note ${r.main} strokes, conflict copies ${JSON.stringify(r.copies)}`;
});

await step('a large note (40 pages, 4 000 strokes) opens, takes a stroke and saves completely', async () => {
  const made = await page.evaluate(async () => {
    const t = await app.vault.adapter.read('lc/many-strokes.handnote');
    const d = JSON.parse(t);
    const src = d.pages[0];
    const pages = [];
    for (let p = 0; p < 40; p++) {
      const strokes = [];
      for (let i = 0; i < 100; i++) {
        const s = src.strokes[i % src.strokes.length];
        strokes.push({ ...s, id: `p${p}s${i}` });
      }
      pages.push({ ...src, id: `page-${p}`, strokes });
    }
    d.pages = pages;
    d.id = 'large-note-test';
    d.revision = 1;
    const text = JSON.stringify(d);
    const f = await app.vault.create('lc/large.handnote', text);
    await app.workspace.getLeaf(true).openFile(f);
    return text.length;
  });
  await sleep(2500);
  await draw(1);
  const t0 = Date.now();
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const ms = Date.now() - t0;
  await sleep(500);
  const r = await page.evaluate(async () => {
    const d = JSON.parse(await app.vault.adapter.read('lc/large.handnote'));
    return { pages: d.pages.length, strokes: d.pages.reduce((n, pg) => n + pg.strokes.length, 0) };
  });
  assert(r.pages === 40 && r.strokes === 4001, `on disk: ${JSON.stringify(r)}`);
  return `${(made / 1048576).toFixed(1)} MB file, 4 001 strokes saved, flush ${ms} ms`;
}, 180000);

await step('performance (this machine): pen processing, stroke render, note open, save, settings open — p50 / p95', async () => {
  const q = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return `p50 ${at(0.5).toFixed(1)} / p95 ${at(0.95).toFixed(1)} ms (n=${s.length})`;
  };
  await newNote('lc/perf.handnote');
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.perf.reset());
  await draw(30);
  const pen = await page.evaluate(() => {
    const s = app.workspace.activeLeaf.view.editor.perf.snapshot();
    return { proc: [s.processing.p50, s.processing.p95], render: [s.render.p50, s.render.p95] };
  });
  const open = [];
  const save = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await page.evaluate(async (i) => {
      const f = await app.vault.create(`lc/perf-open-${i}.handnote`, await app.vault.adapter.read('lc/many-strokes.handnote'));
      await app.workspace.getLeaf(true).openFile(f);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, i);
    open.push(Date.now() - t0);
    await draw(1);
    const t1 = Date.now();
    await page.evaluate(() => app.workspace.activeLeaf.view.flush());
    save.push(Date.now() - t1);
    await page.evaluate(() => app.workspace.activeLeaf.detach());
  }
  const settings = [];
  for (let i = 0; i < 10; i++) {
    settings.push(
      await page.evaluate(async () => {
        const t0 = performance.now();
        app.setting.open();
        app.setting.openTabById('handnote');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ms = performance.now() - t0;
        app.setting.close();
        return ms;
      }),
    );
  }
  return `pen event processing p50 ${pen.proc[0].toFixed(2)} / p95 ${pen.proc[1].toFixed(2)} ms; live stroke render p50 ${pen.render[0].toFixed(2)} / p95 ${pen.render[1].toFixed(2)} ms; open a 120-stroke note ${q(open)}; save ${q(save)}; settings tab ${q(settings)}`;
}, 240000);

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} passed${errors.length ? `; page errors: ${errors.slice(0, 5).join(' | ')}` : ''}`);
await browser.close().catch(() => undefined);
process.exit(pass === results.length && !errors.length ? 0 : 1);
