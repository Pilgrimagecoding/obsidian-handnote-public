// 0.9 end-to-end tests in a REAL Obsidian desktop app: finger long press + paste, and PDF import
// with Obsidian's own PDF.js (loadPdfJs). Run after /home/claude/obs/start.sh (fresh test vault):
//   node tests/obsidian-e2e/import.mjs
// NEVER point this at a real vault: it creates, renames and deletes files.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
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
const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${process.env.OBSIDIAN_CDP ?? '9333'}`);
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('app://obsidian.md'));
if (!page) throw new Error('Obsidian window not found');
guardEvaluate(page);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && /handnote|HandNote/.test(m.text())) errors.push(m.text());
});
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('step timed out after 120 s')), 120000))]);
    results.push({ name, pass: true });
    console.log(`PASS ${name}${info ? ' — ' + info : ''} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, pass: false });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => page.waitForTimeout(ms);
const PDF = 'tests/fixtures/import/sample-3pages.pdf';
const pdfB64 = (await readFile(PDF)).toString('base64');

/** Scene pixel (RGBA) at a page-local point of the active view. */
const pixel = (x, y, pageIndex = 0) =>
  page.evaluate(
    ({ x, y, pageIndex }) => {
      const view = app.workspace.activeLeaf.view;
      const c = view.editor.pageToClient(pageIndex, x, y);
      const canvas = view.contentEl.querySelector('.hn-scene');
      const r = canvas.getBoundingClientRect();
      const d = canvas.getContext('2d').getImageData(Math.round(((c.x - r.left) / r.width) * canvas.width), Math.round(((c.y - r.top) / r.height) * canvas.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { x, y, pageIndex },
  );
const isRed = (p) => p[0] > 170 && p[1] < 90 && p[2] < 90;
/** Wait until the red box of PDF page 1 (60 mm from the top, 20 mm from the left) is painted. */
async function waitRed(x = 100, y = 210, pageIndex = 0, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (isRed(await pixel(x, y, pageIndex))) return true;
    await sleep(250);
  }
  return false;
}
async function draw(samples, pageIndex = 0) {
  await page.evaluate(
    async ({ samples, pageIndex }) => {
      const view = app.workspace.activeLeaf.view;
      const ed = view.editor;
      const v = view.contentEl.querySelector('.hn-viewport');
      const mk = (type, s) => {
        const c = ed.pageToClient(pageIndex, s[0], s[1]);
        return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'pen', isPrimary: true, clientX: c.x, clientY: c.y, pressure: 0.4, buttons: type === 'pointerup' ? 0 : 1 });
      };
      v.dispatchEvent(mk('pointerdown', samples[0]));
      for (let i = 1; i < samples.length; i++) {
        v.dispatchEvent(mk('pointermove', samples[i]));
        if (i % 3 === 0) await new Promise((r) => requestAnimationFrame(r));
      }
      v.dispatchEvent(mk('pointerup', samples[samples.length - 1]));
      await new Promise((r) => requestAnimationFrame(r));
    },
    { samples, pageIndex },
  );
}
const line = (x0, y0, x1, y1, n = 30) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

await step('plugin loads in the test vault', async () => {
  const ok = await page.evaluate(async () => {
    document.querySelectorAll('.modal-container').forEach((m) => m.remove());
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.plugins.handnote) await app.plugins.enablePluginAndSave('handnote');
    return !!app.plugins.plugins.handnote?.importer && app.vault.getName();
  });
  assert(ok && /test-vault/.test(ok), `HandNote with the importer, vault ${ok}`);
  await page.evaluate(() => document.querySelectorAll('.modal-container').forEach((m) => m.remove()));
});

await step('long press with a finger opens the context menu in Obsidian; Paste from clipboard pastes text (Electron clipboard)', async () => {
  await page.evaluate(async () => {
    await app.vault.create('Paste test.handnote', '');
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('Paste test.handnote'));
  });
  await sleep(1200);
  await page.evaluate(() => navigator.clipboard.writeText('Copied in another app'));
  await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const v = view.contentEl.querySelector('.hn-viewport');
    const c = view.editor.pageToClient(0, 200, 300);
    const mk = (type) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'touch', isPrimary: true, clientX: c.x, clientY: c.y, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1, width: 40, height: 40 });
    v.dispatchEvent(mk('pointerdown'));
    await new Promise((r) => setTimeout(r, 750));
    v.dispatchEvent(mk('pointerup'));
  });
  const labels = await page.$$eval('.hn-ctx-menu .hn-ctx-label', (els) => els.map((e) => e.textContent));
  assert(labels.length >= 3, `menu with ${labels.join(' | ')}`);
  const items = await page.$$('.hn-ctx-menu .hn-ctx-item');
  await items[labels.findIndex((l) => /clipboard|剪贴板/.test(l))].click();
  await sleep(800);
  const texts = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].items.filter((i) => i.type === 'text').map((i) => i.text));
  assert(texts.includes('Copied in another app'), `pasted text: ${JSON.stringify(texts)}`);
  return labels.join(' | ');
});

await step('PDF in the vault → "Annotate in HandNote": a v6 note, one page per PDF page in its own size, PDF painted by Obsidian\'s PDF.js', async () => {
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createFolder('Docs').catch(() => undefined);
    await app.vault.createBinary('Docs/Lecture slides.pdf', bin.buffer);
  }, pdfB64);
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Lecture slides.pdf')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Lecture slides.handnote', null, { timeout: 30000 });
  await sleep(800);
  const info = await page.evaluate(() => {
    const d = app.workspace.activeLeaf.view.getDocument();
    return { pages: d.pages.map((p) => [Math.round(p.width), Math.round(p.height), p.doc?.n]), sources: Object.values(d.sources ?? {}).map((s) => [s.path, s.pages, s.sha256.length, s.kind]) };
  });
  assert(JSON.stringify(info.pages) === JSON.stringify([[595, 842, 1], [842, 595, 2], [595, 842, 3]]), `pages ${JSON.stringify(info.pages)}`);
  assert(info.sources.length === 1 && info.sources[0][0] === 'Docs/Lecture slides.pdf' && info.sources[0][2] === 64, `source ${JSON.stringify(info.sources)}`);
  const disk = await page.evaluate(() => app.vault.adapter.read(app.workspace.activeLeaf.view.file.path));
  assert(/"version":6/.test(disk.split('\n')[0]) && /"sources"/.test(disk.split('\n')[0]), 'written as format v6 with sources in the header');
  assert(!/%PDF|JVBERi0/.test(disk), 'no PDF bytes inside the note');
  assert(await waitRed(), 'the red box of PDF page 1 is painted at its place');
  const white = await pixel(400, 600);
  assert(white[0] > 230 && white[1] > 230 && white[2] > 230, `white elsewhere (${white})`);
  return JSON.stringify(info.pages);
});

await step('ink on the PDF page stays on the same PDF content after zoom, save and reopen', async () => {
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  await draw(line(60, 250, 230, 250));
  const before = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes[0].samples.map((s) => [s.x, s.y]));
  await page.evaluate(() => {
    const ed = app.workspace.activeLeaf.view.editor;
    ed.zoomBy(2);
  });
  await sleep(600);
  assert(await waitRed(100, 210), 'PDF still under the right place after zooming in');
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const path = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(500);
  await page.evaluate(async (p) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p)), path);
  await sleep(1200);
  const after = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes[0].samples.map((s) => [s.x, s.y]));
  const dev = Math.max(...after.map((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1])));
  assert(after.length === before.length && dev < 0.01, `stroke unchanged in PDF points (max deviation ${dev})`);
  assert(await waitRed(), 'PDF page shown again after reopening');
  return `deviation ${dev}`;
});

await step('renaming the PDF updates the open note; moving it while the note is closed is found again by SHA-256', async () => {
  await page.evaluate(() => app.fileManager.renameFile(app.vault.getAbstractFileByPath('Docs/Lecture slides.pdf'), 'Docs/Renamed slides.pdf'));
  await sleep(1500);
  let p = await page.evaluate(() => Object.values(app.workspace.activeLeaf.view.getDocument().sources)[0].path);
  assert(p === 'Docs/Renamed slides.pdf', `open note follows the rename (${p})`);
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const note = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(400);
  // moved behind the plugin's back: adapter-level rename (as a sync tool would do)
  await page.evaluate(async () => {
    await app.vault.createFolder('Elsewhere').catch(() => undefined);
    await app.vault.adapter.rename('Docs/Renamed slides.pdf', 'Elsewhere/moved.pdf');
  });
  await sleep(1500);
  await page.evaluate(async (n) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(n)), note);
  assert(await waitRed(), 'PDF found again and painted');
  p = await page.evaluate(() => Object.values(app.workspace.activeLeaf.view.getDocument().sources)[0].path);
  assert(p === 'Elsewhere/moved.pdf', `reference updated (${p})`);
  return p;
});

await step('a missing PDF keeps the annotations and says so; the PDF coming back shows again', async () => {
  const note = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  // the file disappears while the note is closed (deleted on another device and synced)
  const bytes = await page.evaluate(async () => {
    const f = app.vault.getAbstractFileByPath('Elsewhere/moved.pdf');
    const b = new Uint8Array(await app.vault.readBinary(f));
    await app.vault.adapter.remove('Elsewhere/moved.pdf');
    return Array.from(b);
  });
  await sleep(1000);
  await page.evaluate(async (n) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(n)), note);
  await sleep(3000);
  const px = await pixel(100, 210);
  assert(!isRed(px), `no stale PDF pixels when the file is missing (${px})`);
  const strokes = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes.length);
  assert(strokes === 1, 'annotations kept');
  // the file comes back (synced again)
  await page.evaluate(async (b) => app.vault.createBinary('Elsewhere/moved.pdf', new Uint8Array(b).buffer), bytes);
  assert(await waitRed(100, 210, 0, 20000), 'shown again after the file came back');
});

await step('PNG export and the Markdown embed include the PDF page', async () => {
  const view = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.plugins.plugins.handnote.exportPage(app.workspace.activeLeaf.view, 'png', 0));
  await sleep(2500);
  const red = await page.evaluate(async (base) => {
    const f = app.vault.getFiles().find((x) => x.extension === 'png' && x.basename.startsWith(base));
    if (!f) return 'no png';
    const url = URL.createObjectURL(new Blob([await app.vault.readBinary(f)], { type: 'image/png' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const k = img.width / 595;
    const d = g.getImageData(Math.round(100 * k), Math.round(210 * k), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, view.split('/').pop().replace('.handnote', ''));
  assert(Array.isArray(red) && isRed(red), `exported PNG has the PDF page (${red})`);
  await page.evaluate(async (p) => {
    await app.vault.create('Embed import.md', `# Embed\n\n![[${p}]]\n`);
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('Embed import.md'), { state: { mode: 'preview' } });
  }, view);
  let er = null;
  for (let i = 0; i < 40 && !(er && isRed(er)); i++) {
    await sleep(300);
    er = await page.evaluate(() => {
      const c = document.querySelector('.workspace-leaf.mod-active canvas.hn-embed-page');
      if (!c || !c.width) return null;
      const k = c.width / 595;
      const d = c.getContext('2d').getImageData(Math.round(100 * k), Math.round(210 * k), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }
  assert(er && isRed(er), `embed shows the PDF page (${er})`);
});

await step('import into an existing note inserts the pages after the current page (one undo step); the same file is not copied twice', async () => {
  await page.evaluate(async () => {
    await app.vault.create('Mixed.handnote', '');
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('Mixed.handnote'));
  });
  await sleep(1000);
  await draw(line(80, 120, 300, 120));
  const pdfsBefore = await page.evaluate(() => app.vault.getFiles().filter((f) => f.extension === 'pdf').length);
  // "from this device": a File with the same bytes as the PDF already in the vault
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const view = app.workspace.activeLeaf.view;
    await app.plugins.plugins.handnote.importer.run({ file: new File([bin], 'Lecture slides.pdf', { type: 'application/pdf' }) }, view);
  }, pdfB64);
  await sleep(800);
  const pages = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.map((p) => (p.doc ? `pdf${p.doc.n}` : `ink${p.strokes.length}`)));
  assert(JSON.stringify(pages) === JSON.stringify(['ink1', 'pdf1', 'pdf2', 'pdf3']), `pages ${JSON.stringify(pages)}`);
  const pdfsAfter = await page.evaluate(() => app.vault.getFiles().filter((f) => f.extension === 'pdf').length);
  assert(pdfsAfter === pdfsBefore, `no second copy (${pdfsBefore} → ${pdfsAfter} PDFs)`);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.undo());
  const n = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.length);
  assert(n === 1, `undo removes the imported pages (${n})`);
});

await step('refused files say exactly why and where (failure dialog): a web page named .docx, a DOCX without a body, a text file named .pdf, an empty cloud file; a failure after storing rolls back the stored copy', async () => {
  const files0 = await page.evaluate(() => app.vault.getFiles().length);
  // a minimal DOCX: [Content_Types].xml + word/document.xml (stored ZIP)
  const msgs = await page.evaluate(async () => {
    const seen = [];
    const orig = window.Notice;
    // failures open a dialog (stays until closed); read it and close it
    const notices = () => {
      const m = [...document.querySelectorAll('.modal-container .modal')].map((n) => n.textContent).join(' / ');
      document.querySelectorAll('.modal-container').forEach((n) => n.remove());
      return m;
    };
    const zipStored = (files) => {
      const enc = new TextEncoder();
      const parts = [];
      const central = [];
      let off = 0;
      const crc = (b) => {
        let c = ~0;
        for (const x of b) {
          c ^= x;
          for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
        return ~c >>> 0;
      };
      for (const [name, text] of files) {
        const n = enc.encode(name);
        const d = enc.encode(text);
        const lh = new Uint8Array(30 + n.length);
        const lv = new DataView(lh.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint32(14, crc(d), true);
        lv.setUint32(18, d.length, true);
        lv.setUint32(22, d.length, true);
        lv.setUint16(26, n.length, true);
        lh.set(n, 30);
        const ch = new Uint8Array(46 + n.length);
        const cv = new DataView(ch.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint32(16, crc(d), true);
        cv.setUint32(20, d.length, true);
        cv.setUint32(24, d.length, true);
        cv.setUint16(28, n.length, true);
        cv.setUint32(42, off, true);
        ch.set(n, 46);
        parts.push(lh, d);
        central.push(ch);
        off += lh.length + d.length;
      }
      const cd = central.reduce((a, b) => a + b.length, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, central.length, true);
      ev.setUint16(10, central.length, true);
      ev.setUint32(12, cd, true);
      ev.setUint32(16, off, true);
      return new Blob([...parts, ...central, end]);
    };
    const xlsx = zipStored([
      ['[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
      ['xl/workbook.xml', '<workbook/>'],
    ]);
    const docx = zipStored([
      ['[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
      ['word/document.xml', '<w:document/>'],
    ]);
    const imp = app.plugins.plugins.handnote.importer;
    void xlsx;
    await imp.run({ file: new File(['<!DOCTYPE html><html><body>Sign in to Google Drive</body></html>'], 'Report.docx') }, null);
    seen.push(notices());
    await imp.run({ file: new File([docx], 'Report.docx') }, null);
    seen.push(notices());
    await imp.run({ file: new File(['not a pdf at all'], 'fake.pdf') }, null);
    seen.push(notices());
    await imp.run({ file: new File([], 'cloud.pdf') }, null);
    seen.push(notices());
    void orig;
    return seen;
  });
  assert(/web page \(HTML\)/.test(msgs[0]) && /identifying the file type|识别文件类型/.test(msgs[0]) && /starts with 3c 21 44 4f/.test(msgs[0]), `HTML named .docx explained with stage and bytes (${msgs[0]})`);
  assert(/no body/.test(msgs[1]) && /laying out|排版/.test(msgs[1]), `empty DOCX refused at layout (${msgs[1]})`);
  assert(/plain text file/.test(msgs[2]), `text named .pdf explained (${msgs[2]})`);
  assert(/0 bytes|0 字节/.test(msgs[3]) && /reading the file|读取文件/.test(msgs[3]), `empty cloud file explained (${msgs[3]})`);
  // failure after the copy was stored: creating the note fails → the stored copy goes to the trash
  const rolled = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    bin[bin.length - 20] ^= 0x01; // a different file (other SHA-256), still a valid PDF trailer region
    const create = app.vault.create.bind(app.vault);
    app.vault.create = async (p, d) => {
      if (p.endsWith('.handnote')) throw new Error('disk full (simulated)');
      return create(p, d);
    };
    try {
      await app.plugins.plugins.handnote.importer.run({ file: new File([bin], 'Other slides.pdf', { type: 'application/pdf' }) }, null);
    } finally {
      app.vault.create = create;
    }
    return app.vault.getFiles().filter((f) => f.name.startsWith('Other slides')).map((f) => f.path);
  }, pdfB64);
  assert(rolled.length === 0, `stored copy rolled back (${rolled})`);
  const files1 = await page.evaluate(() => app.vault.getFiles().length);
  assert(files1 === files0, `no files left behind (${files0} → ${files1})`);
});


const DOCX = 'tests/fixtures/import/sample.docx';
const docxB64 = (await readFile(DOCX)).toString('base64');
const isBlue = (p) => p[2] > 170 && p[0] < 90 && p[1] > 80 && p[1] < 160;
/** Find the page and page-local centre of the picture op in the stored layout of the active note. */
async function picturePlace() {
  return page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const src = Object.values(view.getDocument().sources)[0];
    const dl = JSON.parse(await app.vault.adapter.read(src.layout));
    for (const [i, p] of dl.pages.entries()) {
      const op = p.ops.find((o) => o.k === 'img');
      if (op) return { page: i, x: op.x + op.w / 2, y: op.y + op.h / 2 };
    }
    return null;
  });
}
async function waitPixel(test, x, y, pageIndex, ms = 15000) {
  const t0 = Date.now();
  let px;
  while (Date.now() - t0 < ms) {
    px = await pixel(x, y, pageIndex);
    if (test(px)) return px;
    await sleep(250);
  }
  return null;
}

await step('Word (.docx) in the vault → "Annotate in HandNote": fixed pages from a stored layout next to the original', async () => {
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Report.docx', bin.buffer);
  }, docxB64);
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Report.docx')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Report.handnote', null, { timeout: 30000 });
  await sleep(800);
  const info = await page.evaluate(async () => {
    const d = app.workspace.activeLeaf.view.getDocument();
    const s = Object.values(d.sources)[0];
    const lay = await app.vault.adapter.read(s.layout);
    return { pages: d.pages.map((p) => [Math.round(p.width), Math.round(p.height), p.doc?.n]), kind: s.kind, layout: s.layout, layoutBytes: lay.length, sha: JSON.parse(lay).sha256 === s.sha256 };
  });
  assert(info.kind === 'docx', `kind ${info.kind}`);
  assert(info.layout === 'Docs/Report.docx.handnote-layout.json', `layout stored next to the original (${info.layout})`);
  assert(info.sha, 'layout records the SHA-256 of the original');
  assert(info.pages.length >= 3 && info.pages[0][0] === 612 && info.pages[0][1] === 792, `Letter pages ${JSON.stringify(info.pages)}`);
  const last = info.pages[info.pages.length - 1];
  assert(last[0] === 792 && last[1] === 612, `landscape section is a landscape page (${last})`);
  const disk = await page.evaluate(() => app.vault.adapter.read(app.workspace.activeLeaf.view.file.path));
  assert(/"version":6/.test(disk.split('\n')[0]), 'note is format v6');
  assert(!/"ops"|UEsDB|word\/document/.test(disk), 'no Word bytes or layout inside the note');
  // text is painted where the layout says: the title baseline area is dark
  const dark = await page.evaluate(async () => {
    const view = app.workspace.activeLeaf.view;
    const src = Object.values(view.getDocument().sources)[0];
    const dl = JSON.parse(await app.vault.adapter.read(src.layout));
    return dl.pages[0].ops.find((o) => o.k === 't');
  });
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    await sleep(250);
    for (let dx = 2; dx < 120 && !found; dx += 3) {
      const p = await pixel(dark.x + dx, dark.y - dark.z * 0.3, 0);
      if (p[0] + p[1] + p[2] < 450) found = true;
    }
  }
  assert(found, 'title text painted at its layout position');
  const pic = await picturePlace();
  assert(pic, 'layout has the picture');
  await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), pic.page);
  const blue = await waitPixel(isBlue, pic.x, pic.y, pic.page);
  assert(blue, `the picture is decoded from the original .docx and painted (${await pixel(pic.x, pic.y, pic.page)})`);
  return `${info.pages.length} pages, layout ${info.layoutBytes} bytes`;
});

await step('ink on a Word page survives save / reopen at the same layout position; layout is not rewritten', async () => {
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.gotoPage(0));
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  await draw(line(90, 260, 300, 262));
  const before = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes[0].samples.map((s) => [s.x, s.y]));
  const mt0 = await page.evaluate(() => app.vault.adapter.stat('Docs/Report.docx.handnote-layout.json').then((s) => s.mtime));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const note = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(500);
  await page.evaluate(async (p) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p)), note);
  await sleep(1200);
  const after = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes[0].samples.map((s) => [s.x, s.y]));
  const dev = Math.max(...after.map((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1])));
  assert(dev < 0.01, `stroke unchanged (${dev})`);
  const mt1 = await page.evaluate(() => app.vault.adapter.stat('Docs/Report.docx.handnote-layout.json').then((s) => s.mtime));
  assert(mt0 === mt1, 'layout file untouched by opening / saving');
  return `deviation ${dev}`;
});

await step('the same .docx imported again (from the device) reuses the original and its layout: identical pages', async () => {
  const before = await page.evaluate(() => app.vault.getFiles().filter((f) => /Report/.test(f.name)).map((f) => f.path).sort());
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.plugins.plugins.handnote.importer.run({ file: new File([bin], 'Report copy.docx') }, null);
  }, docxB64);
  await page.waitForFunction(() => /Report copy/.test(app.workspace.activeLeaf?.view?.file?.name ?? ''), null, { timeout: 30000 });
  await sleep(500);
  const after = await page.evaluate(() => app.vault.getFiles().filter((f) => /Report/.test(f.name) && !f.name.endsWith('.handnote')).map((f) => f.path).sort());
  const src = await page.evaluate(() => Object.values(app.workspace.activeLeaf.view.getDocument().sources)[0]);
  assert(src.path === 'Docs/Report.docx' && src.layout === 'Docs/Report.docx.handnote-layout.json', `reused ${src.path} / ${src.layout}`);
  assert(JSON.stringify(after) === JSON.stringify(before.filter((p) => !p.endsWith('.handnote'))), `no new copies (${after})`);
});

await step('renaming the .docx keeps the pages; a deleted layout is computed again from the original (with a notice)', async () => {
  await page.evaluate(() => app.fileManager.renameFile(app.vault.getAbstractFileByPath('Docs/Report.docx'), 'Docs/Report final.docx'));
  await sleep(1200);
  let src = await page.evaluate(() => Object.values(app.workspace.activeLeaf.view.getDocument().sources)[0]);
  assert(src.path === 'Docs/Report final.docx', `follows the rename (${src.path})`);
  const pic = await picturePlace();
  await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), pic.page);
  assert(await waitPixel(isBlue, pic.x, pic.y, pic.page), 'still painted after the rename');
  // the layout disappears (deleted on another device) while the note is closed
  const note = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  const oldLayout = await page.evaluate(() => app.vault.adapter.read('Docs/Report.docx.handnote-layout.json'));
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await page.evaluate(() => app.vault.adapter.remove('Docs/Report.docx.handnote-layout.json'));
  await sleep(800);
  await page.evaluate(async (n) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(n)), note);
  await sleep(500);
  await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), pic.page);
  assert(await waitPixel(isBlue, pic.x, pic.y, pic.page, 20000), 'page painted from the recomputed layout');
  src = await page.evaluate(() => Object.values(app.workspace.activeLeaf.view.getDocument().sources)[0]);
  assert(src.layout === 'Docs/Report final.docx.handnote-layout.json', `new layout next to the renamed original (${src.layout})`);
  const fresh = await page.evaluate((p) => app.vault.adapter.read(p), src.layout);
  const strip = (t) => JSON.stringify(JSON.parse(t).pages);
  assert(strip(fresh) === strip(oldLayout), 'recomputed layout is identical on the same device');
  const noticed = await page.evaluate(() => [...document.querySelectorAll('.notice')].some((n) => /layout|排版/.test(n.textContent)));
  assert(noticed, 'the user is told the layout was recomputed');
});

await step('PNG export of a Word page includes the page content', async () => {
  const pic = await picturePlace();
  await page.evaluate((i) => app.plugins.plugins.handnote.exportPage(app.workspace.activeLeaf.view, 'png', i), pic.page);
  await sleep(2500);
  const px = await page.evaluate(
    async ({ base, pic }) => {
      const f = app.vault.getFiles().filter((x) => x.extension === 'png' && x.basename.startsWith(base)).pop();
      if (!f) return 'no png';
      const url = URL.createObjectURL(new Blob([await app.vault.readBinary(f)], { type: 'image/png' }));
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const k = img.width / 612;
      const d = g.getImageData(Math.round(pic.x * k), Math.round(pic.y * k), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { base: (await page.evaluate(() => app.workspace.activeLeaf.view.file.basename)), pic },
  );
  assert(Array.isArray(px) && isBlue(px), `exported PNG shows the picture (${px})`);
});



const PPTX = 'tests/fixtures/import/sample.pptx';
const pptxB64 = (await readFile(PPTX)).toString('base64');
const near = (p, rgb, tol = 40) => Math.abs(p[0] - rgb[0]) < tol && Math.abs(p[1] - rgb[1]) < tol && Math.abs(p[2] - rgb[2]) < tol;

await step('PowerPoint (.pptx) → one 16:9 page per slide: background, picture and shapes painted where the slide has them', async () => {
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Lecture deck.pptx', bin.buffer);
  }, pptxB64);
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Lecture deck.pptx')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Lecture deck.handnote', null, { timeout: 30000 });
  await sleep(800);
  const info = await page.evaluate(() => {
    const d = app.workspace.activeLeaf.view.getDocument();
    const s = Object.values(d.sources)[0];
    return { pages: d.pages.map((p) => [Math.round(p.width), Math.round(p.height), p.doc?.n]), kind: s.kind, layout: s.layout };
  });
  assert(info.kind === 'pptx' && info.layout === 'Docs/Lecture deck.pptx.handnote-layout.json', `source ${JSON.stringify(info)}`);
  assert(JSON.stringify(info.pages) === JSON.stringify([[960, 540, 1], [960, 540, 2], [960, 540, 3], [960, 540, 4]]), `pages ${JSON.stringify(info.pages)}`);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.gotoPage(2));
  // slide 3: cream background, blue picture at (216, 144), red rectangle at (540, 100), green ellipse at (792, 144)
  assert(await waitPixel((p) => near(p, [0xff, 0xf4, 0xd6], 12), 400, 500, 2), 'slide background colour');
  assert(await waitPixel((p) => near(p, [30, 120, 220]), 216, 144, 2), 'picture from the .pptx');
  assert(await waitPixel((p) => near(p, [0xc0, 0x10, 0x10]), 540, 100, 2), 'red rectangle');
  assert(await waitPixel((p) => near(p, [0x10, 0xa0, 0x40]), 792, 144, 2), 'green ellipse');
  // slide 4: the header row of the table in accent blue
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.gotoPage(3));
  assert(await waitPixel((p) => near(p, [0x4f, 0x81, 0xbd], 30), 250, 150, 3), 'table header row');
  return JSON.stringify(info.pages[0]);
});

await step('ink on a slide survives save / reopen; page thumbnails show the slides', async () => {
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.gotoPage(1));
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  await draw(line(100, 420, 600, 430), 1);
  const before = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[1].strokes[0].samples.map((s) => [s.x, s.y]));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const note = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(400);
  await page.evaluate(async (p) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p)), note);
  await sleep(1200);
  const after = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[1].strokes[0].samples.map((s) => [s.x, s.y]));
  const dev = Math.max(...after.map((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1])));
  assert(dev < 0.01, `stroke unchanged (${dev})`);
  // page navigator: the thumbnail of slide 3 turns from a placeholder into the slide (cream background)
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.openPagesPanel());
  let px = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    px = await page.evaluate(() => {
      const cv = document.querySelectorAll('.workspace-leaf.mod-active .hn-ps-cell')[2]?.querySelector('canvas');
      if (!cv || !cv.width) return null;
      const d = cv.getContext('2d').getImageData(Math.round(cv.width * 0.45), Math.round(cv.height * 0.9), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    if (px && near(px, [0xff, 0xf4, 0xd6], 14)) break;
  }
  assert(px && near(px, [0xff, 0xf4, 0xd6], 14), `slide thumbnail rendered (${px})`);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.openPagesPanel());
  return `deviation ${dev}`;
});


await step('“From this device”: the dialog closes and the system picker opens from an input in the page body that accepts any file (iPad: nothing greyed out)', async () => {
  const r = await page.evaluate(async () => {
    const clicked = [];
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      clicked.push({ inBody: this.parentElement === document.body, accept: this.accept, type: this.type, multiple: this.multiple });
    };
    document.querySelectorAll('.modal-container').forEach((m) => m.remove());
    try {
      app.plugins.plugins.handnote.importer.open(null);
      await new Promise((res) => setTimeout(res, 300));
      const btn = [...document.querySelectorAll('.modal-container button')].find((b) => /device|设备/.test(b.textContent));
      btn.click();
      await new Promise((res) => setTimeout(res, 300));
      return { clicked, modals: document.querySelectorAll('.modal-container').length, inputs: document.querySelectorAll('body > input.hn-import-input').length };
    } finally {
      HTMLInputElement.prototype.click = orig;
      document.querySelectorAll('body > input.hn-import-input').forEach((x) => x.remove());
    }
  });
  assert(r.clicked.length === 1 && r.clicked[0].inBody && r.clicked[0].type === 'file', `picker input in the body (${JSON.stringify(r.clicked)})`);
  assert(/application\/octet-stream/.test(r.clicked[0].accept) && /\.doc\b/.test(r.clicked[0].accept), 'broad accept list');
  assert(r.clicked[0].multiple === true, 'selection mode (iPadOS shows a circle on each file and an Open button)');
  assert(r.modals === 0, 'import dialog closed when the picker opens');
});

const XLSX = 'tests/fixtures/import/sample.xlsx';
const xlsxB64 = (await readFile(XLSX)).toString('base64');

await step('Excel (.xlsx) → sheet pages with headings; header fill painted at its cell; points map to cells; ink survives reopen', async () => {
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Grades.xlsx', bin.buffer);
  }, xlsxB64);
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Grades.xlsx')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Grades.handnote', null, { timeout: 30000 });
  await sleep(800);
  const info = await page.evaluate(async () => {
    const d = app.workspace.activeLeaf.view.getDocument();
    const s = Object.values(d.sources)[0];
    const dl = JSON.parse(await app.vault.adapter.read(s.layout));
    return { kind: s.kind, n: d.pages.length, grid: dl.pages[0].grid, sheets: dl.pages.map((p) => p.grid.sheet), notes: dl.notes };
  });
  assert(info.kind === 'xlsx' && info.n >= 3, `pages ${info.n}`);
  const dims = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.map((p) => [Math.round(p.width), Math.round(p.height)]));
  assert(dims.every(([w, h]) => (w === 595 && h === 842) || (w === 842 && h === 595)), `A4 pages ${JSON.stringify(dims)}`);
  assert(info.sheets[0] === '成绩表' && info.sheets.includes('Data') && !info.sheets.includes('Secret'), `sheets ${info.sheets}`);
  // cell B2 ("数学" header): blue fill
  const g = info.grid;
  const bx = g.x + g.widths[0] + g.widths[1] / 2;
  const by = g.y + g.heights[0] + g.heights[1] / 2;
  assert(await waitPixel((p) => near(p, [0x44, 0x72, 0xc4], 30), bx - 15, by, 0), 'header fill at B2');
  const ref = await page.evaluate(
    ({ x, y }) => {
      const v = app.workspace.activeLeaf.view;
      const s = Object.values(v.getDocument().sources)[0];
      return app.plugins.plugins.handnote.importer.cellAt(s, 1, x, y);
    },
    { x: bx, y: by },
  );
  assert(ref === "'成绩表'!B2", `cell under the point: ${ref}`);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.setTool('fountain'));
  await draw(line(bx - 20, by + 30, bx + 60, by + 32), 0);
  const before = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes[0].samples.map((s) => [s.x, s.y]));
  await page.evaluate(() => app.workspace.activeLeaf.view.flush());
  const note = await page.evaluate(() => app.workspace.activeLeaf.view.file.path);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await sleep(400);
  await page.evaluate(async (p) => app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(p)), note);
  await sleep(1200);
  const after = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages[0].strokes[0].samples.map((s) => [s.x, s.y]));
  const dev = Math.max(...after.map((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1])));
  assert(dev < 0.01, `stroke unchanged (${dev})`);
  return `${info.n} pages; notes: ${info.notes.join(', ')}`;
});

await step('pinch-style zooming on slides: the page never falls back to the grey placeholder (no flicker)', async () => {
  await page.evaluate(async () => {
    const f = app.vault.getAbstractFileByPath('Docs/Lecture deck.handnote');
    await app.workspace.getLeaf(true).openFile(f);
  });
  await sleep(1000);
  await page.evaluate(() => app.workspace.activeLeaf.view.editor.gotoPage(2));
  assert(await waitPixel((p) => near(p, [0xff, 0xf4, 0xd6], 12), 400, 500, 2), 'slide shown before zooming');
  let bad = 0;
  let frames = 0;
  for (let i = 0; i < 24; i++) {
    const res = await page.evaluate(async (i) => {
      const ed = app.workspace.activeLeaf.view.editor;
      ed.zoomBy(i < 12 ? 1.18 : 1 / 1.18);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const view = app.workspace.activeLeaf.view;
      const canvas = view.contentEl.querySelector('.hn-scene');
      const r = canvas.getBoundingClientRect();
      const c = ed.pageToClient(2, 400, 500);
      if (c.x < r.left || c.x > r.right || c.y < r.top || c.y > r.bottom) return null;
      const d = canvas.getContext('2d').getImageData(Math.round(((c.x - r.left) / r.width) * canvas.width), Math.round(((c.y - r.top) / r.height) * canvas.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    }, i);
    if (!res) continue;
    frames++;
    if (!near(res, [0xff, 0xf4, 0xd6], 14)) bad++;
  }
  assert(frames >= 10, `frames checked ${frames}`);
  assert(bad === 0, `${bad} of ${frames} frames without the slide`);
  return `${frames} frames, all showing the slide`;
});


const DOC = 'tests/fixtures/import/sample.doc';
const docB64 = (await readFile(DOC)).toString('base64');

await step('old Word (.doc) → pages with text, headings and the table; the import notice says the format is simplified', async () => {
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Form.doc', bin.buffer);
  }, docB64);
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Form.doc')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Form.handnote', null, { timeout: 30000 });
  await sleep(800);
  const info = await page.evaluate(async () => {
    const d = app.workspace.activeLeaf.view.getDocument();
    const s = Object.values(d.sources)[0];
    const dl = JSON.parse(await app.vault.adapter.read(s.layout));
    return { kind: s.kind, n: d.pages.length, texts: dl.pages.flatMap((p) => p.ops.filter((o) => o.k === 't').map((o) => o.s)), notes: dl.notes, first: dl.pages[0].ops.find((o) => o.k === 't') };
  });
  assert(info.kind === 'doc' && info.n >= 2, `doc pages ${info.n}`);
  for (const s of ['1. Headings and paragraphs', 'R1C1', 'merged R3C1-2']) assert(info.texts.includes(s), `text ${s}`);
  assert(info.notes.includes('doc-simplified'), `notes ${info.notes}`);
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    await sleep(250);
    for (let dx = 2; dx < 120 && !found; dx += 3) {
      const p = await pixel(info.first.x + dx, info.first.y - info.first.z * 0.3, 0);
      if (p[0] + p[1] + p[2] < 450) found = true;
    }
  }
  assert(found, 'text painted');
  return `${info.n} pages; notes: ${info.notes.join(', ')}`;
});

await step('several files picked at once: each imported in order (into this note: one after another); originals go to the import folder', async () => {
  await page.evaluate(async () => {
    await app.vault.create('Multi.handnote', '');
    await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('Multi.handnote'));
  });
  await sleep(1000);
  await draw(line(80, 120, 300, 120));
  await page.evaluate(
    async ({ pdf, docx }) => {
      const a = new File([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], 'First (copy).pdf');
      const b = new File([Uint8Array.from(atob(docx), (c) => c.charCodeAt(0))], 'Second.docx');
      await app.plugins.plugins.handnote.importer.runMany({ files: [a, b] }, app.workspace.activeLeaf.view);
    },
    { pdf: pdfB64, docx: docxB64 },
  );
  await sleep(800);
  const order = await page.evaluate(() => {
    const d = app.workspace.activeLeaf.view.getDocument();
    return d.pages.map((p) => (p.doc ? d.sources[p.doc.src].kind + p.doc.n : 'ink'));
  });
  assert(order[0] === 'ink' && order[1] === 'pdf1' && order[3] === 'pdf3' && order[4] === 'docx1', `order ${JSON.stringify(order)}`);
  // both files were already in the vault (same bytes): reused, no copies anywhere
  const copies = await page.evaluate(() => app.vault.getFiles().filter((f) => /First \(copy\)|^Second/.test(f.name)).map((f) => f.path));
  assert(copies.length === 0, `no duplicate originals (${copies})`);
  // a new file picked from the device is stored in the import folder
  const stored = await page.evaluate(async (pdf) => {
    const bin = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
    bin[bin.length - 30] ^= 1; // another file
    await app.plugins.plugins.handnote.importer.runMany({ files: [new File([bin], 'Handout.pdf')] }, null);
    return app.vault.getFiles().filter((f) => f.name.startsWith('Handout')).map((f) => f.path);
  }, pdfB64);
  const folder = await page.evaluate(() => app.plugins.plugins.handnote.settings.importFolder);
  assert(stored.some((p) => p === `${folder}/Handout.pdf`), `original in the import folder (${stored})`);
  return JSON.stringify(order);
});

await step('large Word document (~270 pages, tables, pictures): layout time, stored layout size, pictures within their budget', async () => {
  const big = process.env.HN_BIG_DOCX ?? '/home/claude/big-word.docx';
  let b64;
  try {
    b64 = (await readFile(big)).toString('base64');
  } catch {
    return 'NOT RUN (no large .docx at ' + big + ')';
  }
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Big Word.docx', bin.buffer);
  }, b64);
  const t0 = Date.now();
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Big Word.docx')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Big Word.handnote' && app.workspace.activeLeaf.view.getDocument()?.pages?.length, null, { timeout: 120000 });
  const importMs = Date.now() - t0;
  const n = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.length);
  assert(n > 200, `pages ${n}`);
  const lpath = await page.evaluate(() => Object.values(app.workspace.activeLeaf.view.getDocument().sources)[0].layout);
  assert(/\.handnote-layout\.json\.gz$/.test(lpath), `a layout above 1 MB is stored compressed (${lpath})`);
  const lsize = await page.evaluate((p) => app.vault.adapter.stat(p).then((s) => s.size), lpath);
  let pics = 0;
  let maxPic = 0;
  const imgPages = await page.evaluate(async (p) => {
    const bin = await app.vault.adapter.readBinary(p);
    const dl = JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    return dl.pages.map((p, i) => (p.ops.some((o) => o.k === 'img') ? i : -1)).filter((i) => i >= 0);
  }, lpath);
  for (const i of imgPages) {
    await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), i);
    await sleep(400);
    const st = await page.evaluate(() => app.plugins.plugins.handnote.importer.officeStats());
    pics = Math.max(pics, st.pictures);
    maxPic = Math.max(maxPic, st.picturePx);
  }
  const st = await page.evaluate(() => app.plugins.plugins.handnote.importer.cacheStats());
  assert(st.pixels <= st.budget, 'page cache within budget');
  assert(maxPic <= 24_000_000, `pictures within budget (${maxPic})`);
  return `import + layout ${importMs} ms, ${n} pages, layout file ${(lsize / 1024).toFixed(0)} KB, ${imgPages.length} picture pages, decoded pictures ≤ ${(maxPic / 1e6).toFixed(1)} MP`;
});


await step('large PowerPoint deck (150 slides, full-HD pictures): import time, slides rendered on demand, memory within budget', async () => {
  const big = process.env.HN_BIG_PPTX ?? '/home/claude/big-deck.pptx';
  let b64;
  try {
    b64 = (await readFile(big)).toString('base64');
  } catch {
    return 'NOT RUN (no large .pptx at ' + big + ')';
  }
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Big deck.pptx', bin.buffer);
  }, b64);
  const t0 = Date.now();
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Big deck.pptx')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Big deck.handnote' && app.workspace.activeLeaf.view.getDocument()?.pages?.length, null, { timeout: 120000 });
  const importMs = Date.now() - t0;
  const n = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.length);
  assert(n === 150, `slides ${n}`);
  let maxPic = 0;
  for (let i = 0; i < 150; i += 6) {
    await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), i);
    await sleep(300);
    maxPic = Math.max(maxPic, (await page.evaluate(() => app.plugins.plugins.handnote.importer.officeStats())).picturePx);
  }
  const st = await page.evaluate(() => app.plugins.plugins.handnote.importer.cacheStats());
  assert(st.pixels <= st.budget, 'page cache within budget');
  assert(maxPic <= 24_000_000, `pictures within budget (${maxPic})`);
  const lsize = await page.evaluate(() => app.vault.adapter.stat('Docs/Big deck.pptx.handnote-layout.json').then((s) => s.size));
  return `import + layout ${importMs} ms, layout file ${(lsize / 1024).toFixed(0)} KB, decoded pictures ≤ ${(maxPic / 1e6).toFixed(1)} MP, page cache ${(st.pixels / 1e6).toFixed(1)} of ${(st.budget / 1e6).toFixed(0)} MP`;
});


await step('large Excel sheet (20 000 rows × 10 columns): layout time, compressed layout file, pages rendered on demand', async () => {
  const big = process.env.HN_BIG_XLSX ?? '/home/claude/big-sheet.xlsx';
  let b64;
  try {
    b64 = (await readFile(big)).toString('base64');
  } catch {
    return 'NOT RUN (no large .xlsx at ' + big + ')';
  }
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Big sheet.xlsx', bin.buffer);
  }, b64);
  const t0 = Date.now();
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Big sheet.xlsx')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Big sheet.handnote' && app.workspace.activeLeaf.view.getDocument()?.pages?.length, null, { timeout: 180000 });
  const importMs = Date.now() - t0;
  const info = await page.evaluate(async () => {
    const d = app.workspace.activeLeaf.view.getDocument();
    const s = Object.values(d.sources)[0];
    return { n: d.pages.length, layout: s.layout, size: (await app.vault.adapter.stat(s.layout)).size };
  });
  assert(info.layout.endsWith('.handnote-layout.json.gz'), `compressed layout (${info.layout})`);
  assert(info.n > 100, `pages ${info.n}`);
  for (const i of [0, Math.floor(info.n / 2), info.n - 1]) {
    await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), i);
    // the row-number column (light grey) of the first row on the page
    assert(await waitPixel((p) => near(p, [0xf3, 0xf3, 0xf3], 6), 40, 80, i, 15000), `page ${i + 1} rendered`);
  }
  const st = await page.evaluate(() => app.plugins.plugins.handnote.importer.cacheStats());
  assert(st.pixels <= st.budget, 'page cache within budget');
  return `import + layout ${importMs} ms, ${info.n} pages, layout file ${(info.size / 1024 / 1024).toFixed(1)} MB (gzip)`;
});

await step('large PDF (300 pages): import time, pages rendered on demand, cache stays within its budget while scrolling', async () => {
  const big = process.env.HN_BIG_PDF ?? '/home/claude/big-300.pdf';
  let b64;
  try {
    b64 = (await readFile(big)).toString('base64');
  } catch {
    return 'NOT RUN (no large PDF at ' + big + ')';
  }
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.vault.createBinary('Docs/Big 300.pdf', bin.buffer);
  }, b64);
  const t0 = Date.now();
  await page.evaluate(() => app.plugins.plugins.handnote.importer.annotate(app.vault.getAbstractFileByPath('Docs/Big 300.pdf')));
  await page.waitForFunction(() => app.workspace.activeLeaf?.view?.file?.name === 'Big 300.handnote' && app.workspace.activeLeaf.view.getDocument()?.pages?.length, null, { timeout: 90000 });
  const importMs = Date.now() - t0;
  const n = await page.evaluate(() => app.workspace.activeLeaf.view.getDocument().pages.length);
  assert(n === 300, `300 pages (${n})`);
  const heap0 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  let maxPix = 0;
  let budget = 0;
  for (let i = 0; i < 300; i += 15) {
    await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), i);
    await sleep(350);
    const st = await page.evaluate(() => app.plugins.plugins.handnote.importer.cacheStats());
    maxPix = Math.max(maxPix, st.pixels);
    budget = st.budget;
  }
  await page.evaluate((i) => app.workspace.activeLeaf.view.editor.gotoPage(i), 299);
  assert(await waitRed(100, 210, 299, 20000), 'last page rendered when reached');
  const heap1 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  assert(maxPix <= budget, `cache ${maxPix} px ≤ budget ${budget}`);
  const size = await page.evaluate(() => app.vault.adapter.stat(app.workspace.activeLeaf.view.file.path).then((s) => s.size));
  return `import ${importMs} ms; note file ${size} bytes; cache max ${(maxPix / 1e6).toFixed(1)} MP of ${(budget / 1e6).toFixed(0)} MP; JS heap ${(heap0 / 1e6).toFixed(0)} → ${(heap1 / 1e6).toFixed(0)} MB`;
});

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} import / paste E2E steps passed`);
if (errors.length) console.log(`page errors (${errors.length}):\n${errors.map((e) => '  ' + e.slice(0, 300)).join('\n')}`);
await browser.close().catch(() => undefined);
process.exit(failed || errors.length ? 1 : 0);
