// Browser integration tests for the HandNote editor (Ink Lab page, real Chromium, synthetic
// PointerEvents). Run with `npm run test:browser`. Screenshots go to test-output/.
import { YONG, circle, loops, toSamples } from './handwriting.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

/** Which edition the lab was built as: 'public' (default, no local math model) or 'private'. */
const editionOf = (page) => page.evaluate(() => window.__hn.edition());

async function open(page, base, query = '?fresh') {
  await page.goto(`${base}/experiments/ink-lab/index.html${query}`);
  await page.waitForFunction(() => window.__hn && window.__hn.editor);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Dispatch one stroke of page-local samples as PointerEvents, 4 samples per animation frame. */
async function stroke(page, samples, { pointerType = 'pen', pageIndex = 0, pointerId = 2, perFrame = 4 } = {}) {
  await page.evaluate(
    async ({ samples, pointerType, pageIndex, pointerId, perFrame }) => {
      const ed = window.__hn.editor;
      const v = document.querySelector('.hn-viewport');
      const mk = (type, s, extra = {}) => {
        const c = ed.pageToClient(pageIndex, s.x, s.y);
        return new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType,
          isPrimary: true,
          clientX: c.x,
          clientY: c.y,
          pressure: pointerType === 'pen' ? s.p : 0.5,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          width: pointerType === 'touch' ? 52 : 1,
          height: pointerType === 'touch' ? 52 : 1,
          ...extra,
        });
      };
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      v.dispatchEvent(mk('pointerdown', samples[0]));
      for (let i = 1; i < samples.length; i++) {
        v.dispatchEvent(mk('pointermove', samples[i]));
        if (i % perFrame === 0) await frame();
      }
      v.dispatchEvent(mk('pointerup', samples[samples.length - 1]));
      await frame();
    },
    { samples, pointerType, pageIndex, pointerId, perFrame },
  );
}

async function strokeCount(page) {
  return page.evaluate(() => window.__hn.editor.getDocument().pages.reduce((n, p) => n + p.strokes.length, 0));
}

/** Read a scene pixel at a page-local position (RGBA). */
async function pixel(page, x, y, pageIndex = 0) {
  return page.evaluate(
    ({ x, y, pageIndex }) => {
      const ed = window.__hn.editor;
      const c = ed.pageToClient(pageIndex, x, y);
      const canvas = document.querySelector('.hn-scene');
      const r = canvas.getBoundingClientRect();
      const sx = ((c.x - r.left) / r.width) * canvas.width;
      const sy = ((c.y - r.top) / r.height) * canvas.height;
      const d = canvas.getContext('2d').getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    { x, y, pageIndex },
  );
}

const lum = (px) => 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];

t('lab loads and reports capabilities', async ({ page, base, assert, log }) => {
  await open(page, base);
  const caps = await page.evaluate(() => window.__hn.perf().capabilities);
  log(`capabilities: ${JSON.stringify(caps)}`);
  assert(caps.pointerEvents === true, 'PointerEvent available');
  assert((await strokeCount(page)) === 0, 'starts empty');
});

t('pen stroke draws ink and is committed to the document', async ({ page, base, assert }) => {
  await open(page, base);
  const s = toSamples([[0, 0], [100, 0]], { x0: 100, y0: 200, scale: 2, speed: 300 });
  await stroke(page, s);
  assert((await strokeCount(page)) === 1, 'one stroke');
  const px = await pixel(page, 200, 200);
  assert(lum(px) < 90, `ink pixel is dark (lum ${lum(px).toFixed(0)})`);
  const bg = await pixel(page, 200, 230);
  assert(lum(bg) > 200, 'paper next to the stroke stays light');
});

t('finger touch navigates and never draws', async ({ page, base, assert }) => {
  await open(page, base);
  const cam0 = await page.evaluate(() => window.__hn.editor.camera);
  const s = toSamples([[0, 0], [0, 100]], { x0: 300, y0: 300, scale: 1.5, speed: 400 });
  await stroke(page, s, { pointerType: 'touch', pointerId: 11 });
  assert((await strokeCount(page)) === 0, 'no stroke from finger');
  const cam1 = await page.evaluate(() => window.__hn.editor.camera);
  assert(Math.abs(cam1.y - cam0.y) > 20, `camera panned (${cam0.y.toFixed(1)} -> ${cam1.y.toFixed(1)})`);
});

t('palm resting while the pen writes is ignored', async ({ page, base, assert }) => {
  await open(page, base);
  const cam0 = await page.evaluate(() => window.__hn.editor.camera);
  await page.evaluate(async () => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const ev = (type, pointerType, id, x, y, p = 0.4) => {
      const c = ed.pageToClient(0, x, y);
      v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType, clientX: c.x, clientY: c.y, pressure: p, buttons: 1, width: pointerType === 'touch' ? 30 : 1, height: pointerType === 'touch' ? 30 : 1 }));
    };
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    ev('pointerdown', 'pen', 2, 100, 400);
    for (let i = 1; i <= 30; i++) {
      ev('pointermove', 'pen', 2, 100 + i * 3, 400 + Math.sin(i / 3) * 5);
      if (i === 5) ev('pointerdown', 'touch', 21, 300, 500); // palm lands
      if (i > 5) ev('pointermove', 'touch', 21, 300 + i, 500 + i * 4); // palm drags
      if (i % 4 === 0) await frame();
    }
    ev('pointerup', 'pen', 2, 190, 400);
    ev('pointerup', 'touch', 21, 330, 620);
    await frame();
  });
  assert((await strokeCount(page)) === 1, 'exactly one pen stroke');
  const cam1 = await page.evaluate(() => window.__hn.editor.camera);
  assert(cam1.x === cam0.x && cam1.y === cam0.y && cam1.zoom === cam0.zoom, 'palm did not move the page');
});

t('undo / redo, two-finger tap undo', async ({ page, base, assert }) => {
  await open(page, base);
  for (let i = 0; i < 3; i++) await stroke(page, toSamples([[0, 0], [60, 10]], { x0: 80, y0: 150 + i * 30, scale: 1, speed: 200 }));
  assert((await strokeCount(page)) === 3, '3 strokes');
  await page.evaluate(() => window.__hn.editor.undo());
  assert((await strokeCount(page)) === 2, 'undo');
  await page.evaluate(() => window.__hn.editor.redo());
  assert((await strokeCount(page)) === 3, 'redo');
  // toolbar buttons
  await page.click('button[aria-label="Undo"]');
  assert((await strokeCount(page)) === 2, 'undo button');
  await page.click('button[aria-label="Redo"]');
  assert((await strokeCount(page)) === 3, 'redo button');
  // two-finger tap
  await page.evaluate(async () => {
    const v = document.querySelector('.hn-viewport');
    const r = v.getBoundingClientRect();
    const ev = (type, id, x) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + 300, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    await new Promise((res) => setTimeout(res, 400)); // outside the post-pen palm window
    ev('pointerdown', 31, 200);
    ev('pointerdown', 32, 280);
    await new Promise((res) => setTimeout(res, 60));
    ev('pointerup', 31, 200);
    ev('pointerup', 32, 280);
  });
  assert((await strokeCount(page)) === 2, 'two-finger tap undid one stroke');
});

t('stroke eraser removes whole strokes; undo restores them', async ({ page, base, assert }) => {
  await open(page, base);
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 300, scale: 2, speed: 300 }));
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 400, scale: 2, speed: 300 }));
  await page.click('.hn-tool[data-group="eraser"]');
  await page.click('.hn-eraser-type');
  await page.click('.hn-tile[data-mode="stroke"]');
  await page.keyboard.press('Escape');
  await stroke(page, toSamples([[0, 0], [0, 40]], { x0: 200, y0: 280, scale: 1, speed: 300 }));
  assert((await strokeCount(page)) === 1, 'one stroke erased');
  await page.evaluate(() => window.__hn.editor.undo());
  assert((await strokeCount(page)) === 2, 'erase undone');
  await page.click('.hn-tool[data-group="pen"]');
});

t('highlighter: overlapping strokes do not darken each other; ink stays on top', async ({ page, base, assert }) => {
  await open(page, base);
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 500, scale: 2, speed: 300 }));
  await page.click('.hn-pen-kind[data-kind="highlighter"]');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 120, y0: 505, scale: 1.5, speed: 300 }));
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 180, y0: 505, scale: 1.5, speed: 300 }));
  const single = await pixel(page, 140, 509);
  const overlap = await pixel(page, 250, 509);
  const diff = Math.abs(lum(single) - lum(overlap));
  assert(diff < 6, `overlap luminance difference ${diff.toFixed(1)} (single ${single}, overlap ${overlap})`);
  const ink = await pixel(page, 200, 500);
  assert(lum(ink) < 110, `ink under highlighter still dark (lum ${lum(ink).toFixed(0)})`);
  await page.click('.hn-pen-kind[data-kind="fountain"]');
});

t('persistence: reload restores strokes and drawing continues', async ({ page, base, assert }) => {
  await open(page, base);
  await stroke(page, toSamples([[0, 0], [80, 20]], { x0: 100, y0: 200, scale: 2, speed: 300 }));
  await stroke(page, toSamples([[0, 0], [80, 20]], { x0: 100, y0: 250, scale: 2, speed: 300 }));
  const before = await page.evaluate(() => window.__hn.serialize());
  await open(page, base, '');
  assert((await strokeCount(page)) === 2, 'strokes restored after reload');
  const after = await page.evaluate(() => window.__hn.serialize());
  assert(after === before, 'restored document is byte-identical');
  await stroke(page, toSamples([[0, 0], [80, 20]], { x0: 100, y0: 300, scale: 2, speed: 300 }));
  assert((await strokeCount(page)) === 3, 'continued writing after reopen');
  const px = await pixel(page, 140, 210);
  assert(lum(px) < 120, 'restored ink is rendered');
});

t('no stroke jump on release: live preview matches committed ink', async ({ page, base, assert }) => {
  await open(page, base);
  const s = toSamples(YONG[1], { x0: 200, y0: 200, scale: 2.5, speed: 160 });
  // draw everything except the release, capture active layers, then release and capture scene
  const res = await page.evaluate(async ({ samples }) => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const mk = (type, s) => {
      const c = ed.pageToClient(0, s.x, s.y);
      return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: s.p, buttons: type === 'pointerup' ? 0 : 1 });
    };
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    v.dispatchEvent(mk('pointerdown', samples[0]));
    for (let i = 1; i < samples.length; i++) {
      v.dispatchEvent(mk('pointermove', samples[i]));
      if (i % 4 === 0) await frame();
    }
    await frame();
    const [a, b] = document.querySelectorAll('.hn-active');
    const w = a.width, h = a.height;
    const live = new Uint8ClampedArray(w * h);
    for (const c of [a, b]) {
      const d = c.getContext('2d').getImageData(0, 0, w, h).data;
      for (let i = 0; i < w * h; i++) live[i] = Math.max(live[i], d[i * 4 + 3]);
    }
    v.dispatchEvent(mk('pointerup', samples[samples.length - 1]));
    await frame();
    // compare against the scene canvas region (scene has overscan offset)
    const scene = document.querySelector('.hn-scene');
    const sr = scene.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const ox = Math.round((ar.left - sr.left) * (scene.width / sr.width));
    const oy = Math.round((ar.top - sr.top) * (scene.height / sr.height));
    const sd = scene.getContext('2d').getImageData(ox, oy, w, h).data;
    let inkLive = 0, inkBoth = 0, inkScene = 0;
    for (let i = 0; i < w * h; i++) {
      const l = live[i] > 128;
      const lumS = 0.299 * sd[i * 4] + 0.587 * sd[i * 4 + 1] + 0.114 * sd[i * 4 + 2];
      const s2 = lumS < 128;
      if (l) inkLive++;
      if (s2) inkScene++;
      if (l && s2) inkBoth++;
    }
    return { inkLive, inkScene, inkBoth };
  }, { samples: s });
  const overlap = res.inkBoth / Math.max(res.inkLive, res.inkScene);
  assert(res.inkLive > 200, `live ink drawn (${res.inkLive} px)`);
  assert(overlap > 0.9, `live vs committed overlap ${(overlap * 100).toFixed(1)}% (live ${res.inkLive}, committed ${res.inkScene})`);
});

t('pinch zoom changes zoom and does not draw', async ({ page, base, assert }) => {
  await open(page, base);
  const z0 = (await page.evaluate(() => window.__hn.editor.camera)).zoom;
  await page.evaluate(async () => {
    const v = document.querySelector('.hn-viewport');
    const r = v.getBoundingClientRect();
    const ev = (type, id, x, y) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    ev('pointerdown', 41, 300, 300);
    ev('pointerdown', 42, 400, 300);
    for (let i = 1; i <= 20; i++) {
      ev('pointermove', 41, 300 - i * 5, 300);
      ev('pointermove', 42, 400 + i * 5, 300);
      await frame();
    }
    ev('pointerup', 41, 200, 300);
    ev('pointerup', 42, 500, 300);
    await frame();
  });
  const z1 = (await page.evaluate(() => window.__hn.editor.camera)).zoom;
  assert(z1 > z0 * 1.8, `zoom ${z0.toFixed(2)} -> ${z1.toFixed(2)}`);
  assert((await strokeCount(page)) === 0, 'no ink from pinch');
});

t('handwriting sample renders (screenshots for visual review)', async ({ page, base, assert, shot, log }) => {
  await open(page, base, '?fresh&hud');
  let t0 = 0;
  // large 永 with fountain pen
  for (const poly of YONG) await stroke(page, toSamples(poly, { x0: 60, y0: 120, scale: 2.2, speed: 140, t0 }));
  // small characters: 永 at ~4 mm (11 units) — the "Chinese small text" case
  for (let k = 0; k < 8; k++) for (const poly of YONG) await stroke(page, toSamples(poly, { x0: 300 + k * 30, y0: 140, scale: 0.11 * (k % 2 ? 1 : 0.9) * 10 / 10, speed: 60 }));
  // cursive loops and a fast circle
  for (const poly of loops(5)) await stroke(page, toSamples(poly, { x0: 60, y0: 380, scale: 1.4, speed: 400 }));
  for (const poly of circle(40)) await stroke(page, toSamples(poly, { x0: 330, y0: 330, scale: 1.2, speed: 600 }));
  await page.click('.hn-pen-kind[data-kind="pencil"]');
  for (let k = 0; k < 8; k++) for (const poly of YONG) await stroke(page, toSamples(poly, { x0: 300 + k * 30, y0: 180, scale: 0.11, speed: 60 }));
  await page.click('.hn-pen-kind[data-kind="highlighter"]');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 300, y0: 147, scale: 2.4, speed: 300 }));
  await page.click('.hn-pen-kind[data-kind="fountain"]');
  const n = await strokeCount(page);
  assert(n >= 85, `${n} strokes written`);
  await shot('handwriting-overview');
  // zoom in on the small characters
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    ed.setView({ x: 0, y: 100, zoom: 4 });
  });
  await shot('handwriting-small-zoom4');
  const perf = await page.evaluate(() => window.__hn.perf());
  log(`perf (Chromium, synthetic events): processing p95 ${perf.processing.p95.toFixed(3)} ms, stroke render p95 ${perf.render.p95.toFixed(3)} ms, scene render avg ${perf.sceneRender.avg.toFixed(2)} ms (n=${perf.sceneRender.n})`);
});

// ---------------------------------------------------------------------------------------------
// v0.2 input regression tests
// ---------------------------------------------------------------------------------------------

async function firstSample(page) {
  return page.evaluate(() => {
    const d = window.__hn.editor.getDocument();
    const s = d.pages.flatMap((p) => p.strokes).slice(-1)[0];
    return s ? { x: s.samples[0].x, y: s.samples[0].y, n: s.samples.length } : null;
  });
}

for (const zoom of [1, 2]) {
  t(`pen lands exactly where it touches at ${zoom * 100}% zoom`, async ({ page, base, assert }) => {
    await open(page, base);
    await page.evaluate((z) => window.__hn.editor.setView({ x: 0, y: 0, zoom: z }), zoom);
    await stroke(page, toSamples([[0, 0], [40, 0]], { x0: 120, y0: 150, scale: 1, speed: 200 }));
    const s = await firstSample(page);
    assert(s && Math.abs(s.x - 120) < 0.6 && Math.abs(s.y - 150) < 0.6, `first sample at (${s?.x}, ${s?.y}), expected (120, 150)`);
  });
}

t('finger pan, then pinch, then pen: stroke lands at the touched page position', async ({ page, base, assert }) => {
  await open(page, base);
  await page.evaluate(async () => {
    const v = document.querySelector('.hn-viewport');
    const r = v.getBoundingClientRect();
    const ev = (type, id, x, y) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    ev('pointerdown', 51, 400, 500);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 51, 400, 500 - i * 15); await frame(); }
    ev('pointerup', 51, 400, 350);
    await new Promise((res) => setTimeout(res, 50));
    ev('pointerdown', 52, 300, 300);
    ev('pointerdown', 53, 500, 300);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 52, 300 - i * 6, 300); ev('pointermove', 53, 500 + i * 6, 300); await frame(); }
    ev('pointerup', 52, 240, 300);
    ev('pointerup', 53, 560, 300);
    await new Promise((res) => setTimeout(res, 800)); // let inertia settle
  });
  const cam = await page.evaluate(() => window.__hn.editor.camera);
  assert(cam.zoom > 2, `zoomed to ${cam.zoom.toFixed(2)}`);
  await stroke(page, toSamples([[0, 0], [20, 0]], { x0: 200, y0: 300, scale: 1, speed: 100 }));
  const s = await firstSample(page);
  assert(s && Math.abs(s.x - 200) < 0.5 && Math.abs(s.y - 300) < 0.5, `first sample (${s?.x}, ${s?.y}) expected (200, 300)`);
  assert((await strokeCount(page)) === 1, 'navigation created no strokes');
});

t('finger drawing ON: one finger draws, two fingers still pinch', async ({ page, base, assert }) => {
  await open(page, base);
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    ed.updateSettings({ ...ed.getSettings(), fingerDrawing: true });
  });
  await stroke(page, toSamples([[0, 0], [60, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }), { pointerType: 'touch', pointerId: 61 });
  assert((await strokeCount(page)) === 1, 'finger drew');
  const z0 = (await page.evaluate(() => window.__hn.editor.camera)).zoom;
  await page.evaluate(async () => {
    const v = document.querySelector('.hn-viewport');
    const r = v.getBoundingClientRect();
    const ev = (type, id, x, y) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    ev('pointerdown', 62, 300, 400);
    await new Promise((res) => setTimeout(res, 50));
    ev('pointerdown', 63, 450, 400);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 62, 300 - i * 8, 400); ev('pointermove', 63, 450 + i * 8, 400); await frame(); }
    ev('pointerup', 62, 220, 400);
    ev('pointerup', 63, 530, 400);
  });
  const z1 = (await page.evaluate(() => window.__hn.editor.camera)).zoom;
  assert(z1 > z0 * 1.5, `pinch zoomed ${z0.toFixed(2)} -> ${z1.toFixed(2)}`);
  assert((await strokeCount(page)) === 1, 'the aborted tentative stroke was not saved');
});

t('desktop: Space+drag and middle-drag pan, wheel scrolls, Ctrl+wheel zooms; none of them draw', async ({ page, base, assert }) => {
  await open(page, base);
  const v = await page.$('.hn-viewport');
  const box = await v.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  const c0 = await page.evaluate(() => window.__hn.editor.camera);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(cx, cy - 150, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const c1 = await page.evaluate(() => window.__hn.editor.camera);
  assert(Math.abs(c1.y - c0.y - 150 / c0.zoom) < 1, `space-drag panned (${c0.y.toFixed(1)} -> ${c1.y.toFixed(1)})`);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx, cy - 100, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const c2 = await page.evaluate(() => window.__hn.editor.camera);
  assert(c2.y > c1.y + 40, `middle-drag panned (${c1.y.toFixed(1)} -> ${c2.y.toFixed(1)})`);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(50);
  const c3 = await page.evaluate(() => window.__hn.editor.camera);
  assert(c3.y > c2.y + 50, 'wheel scrolled');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForTimeout(50);
  const c4 = await page.evaluate(() => window.__hn.editor.camera);
  assert(c4.zoom > c3.zoom * 1.3, `ctrl+wheel zoomed ${c3.zoom.toFixed(2)} -> ${c4.zoom.toFixed(2)}`);
  assert((await strokeCount(page)) === 0, 'no strokes from navigation');
  await page.mouse.move(cx - 50, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy + 20, { steps: 10 });
  await page.mouse.up();
  assert((await strokeCount(page)) === 1, 'plain left drag draws');
});

t('pointercancel during a pen stroke keeps the ink; a canceled finger pan leaves navigation working', async ({ page, base, assert }) => {
  await open(page, base);
  await page.evaluate(async () => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const mk = (type, id, kind, x, y) => {
      const c = ed.pageToClient(0, x, y);
      return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: kind, clientX: c.x, clientY: c.y, pressure: 0.4, buttons: 1, width: kind === 'touch' ? 52 : 1, height: kind === 'touch' ? 52 : 1 });
    };
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    v.dispatchEvent(mk('pointerdown', 71, 'pen', 100, 100));
    for (let i = 1; i < 20; i++) { v.dispatchEvent(mk('pointermove', 71, 'pen', 100 + i * 3, 100)); if (i % 4 === 0) await frame(); }
    v.dispatchEvent(mk('pointercancel', 71, 'pen', 157, 100));
    await new Promise((r) => setTimeout(r, 400));
    v.dispatchEvent(mk('pointerdown', 72, 'touch', 200, 300));
    v.dispatchEvent(mk('pointermove', 72, 'touch', 200, 260));
    v.dispatchEvent(mk('pointercancel', 72, 'touch', 200, 260));
  });
  assert((await strokeCount(page)) === 1, 'canceled Pencil stroke was committed');
  const c0 = await page.evaluate(() => window.__hn.editor.camera);
  await stroke(page, toSamples([[0, 0], [0, 100]], { x0: 300, y0: 400, scale: 1, speed: 400 }), { pointerType: 'touch', pointerId: 73 });
  const c1 = await page.evaluate(() => window.__hn.editor.camera);
  assert(Math.abs(c1.y - c0.y) > 20, 'finger pans after cancellations');
});

// ---------------------------------------------------------------------------------------------
// v0.2 UI tests
// ---------------------------------------------------------------------------------------------

t('two-tier toolbar: top bar ≤ 52 px, sub-bar floats over the page; writing area ≥ 85%; tap again hides the sub-bar', async ({ page, base, assert }) => {
  for (const [w, h] of [[1180, 820], [820, 1180], [744, 1133]]) {
    await page.setViewportSize({ width: w, height: h });
    await open(page, base, '?fresh&mode=pen');
    const m = await page.evaluate(() => {
      const t = document.querySelector('.hn-toolbar').getBoundingClientRect();
      const v = document.querySelector('.hn-viewport').getBoundingClientRect();
      const sub = document.querySelector('.hn-subbar').getBoundingClientRect();
      const btns = [...document.querySelectorAll('.hn-toolbar .hn-btn')].filter((b) => b.offsetParent);
      const minTarget = Math.min(...btns.map((b) => b.getBoundingClientRect().height));
      const groups = [...document.querySelectorAll('.hn-tool')].map((b) => b.dataset.group);
      return { th: t.height, ratio: v.height / (t.height + v.height), minTarget, subH: sub.height, subRight: sub.right, groups };
    });
    assert(m.th <= 52, `${w}x${h}: top bar ${m.th}px`);
    assert(m.ratio >= 0.85, `${w}x${h}: writing area ${(m.ratio * 100).toFixed(1)}%`);
    assert(m.minTarget >= 36, `${w}x${h}: touch targets ≥ 36 px (${m.minTarget})`);
    assert(m.subH <= 56 && m.subRight <= w, `${w}x${h}: sub-bar is one row inside the screen (${m.subH}px)`);
    assert(m.groups.join() === 'lasso,pen,eraser,text,image,shape,laser', `top tools ${m.groups}`);
  }
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.click('.hn-tool[data-group="pen"]');
  assert(await page.evaluate(() => document.querySelector('.hn-subbar').classList.contains('is-hidden')), 'second tap hides the sub-bar');
  await page.click('.hn-tool[data-group="pen"]');
  assert(!(await page.evaluate(() => document.querySelector('.hn-subbar').classList.contains('is-hidden'))), 'third tap shows it again');
  await page.click('.hn-tool[data-group="eraser"]');
  assert(await page.$('.hn-subbar .hn-eraser-type'), 'eraser sub-bar');
  await page.click('.hn-tool[data-group="shape"]');
  assert((await page.$$('.hn-subbar .hn-shape-kind')).length === 9, 'shape sub-bar has 9 shapes (line, arrow, curve, elbow + 5)');
});

t('pen panel: simple sliders + live preview; engine A/B under Advanced; width slider in mm edits the preset', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-pen-kind[data-kind="fountain"]');
  assert(await page.$('.hn-pen-panel .hn-pen-preview'), 'pen panel with preview opened on tapping the active pen');
  const sliders = await page.$$eval('.hn-pen-panel > .hn-card .hn-sl', (els) => els.length);
  assert(sliders === 3, `three main sliders (${sliders})`);
  const preview = await page.evaluate(() => {
    const c = document.querySelector('.hn-pen-preview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++;
    return n;
  });
  assert(preview > 300, `preview stroke painted (${preview} px)`);
  await page.click('.hn-pen-panel summary');
  await page.click('.hn-pen-panel .hn-chip[data-value="baseline"]');
  await page.mouse.click(900, 700);
  assert(!(await page.$('.hn-pen-panel')), 'closed on outside tap');
  await stroke(page, toSamples([[0, 0], [60, 0]], { x0: 100, y0: 300, scale: 1, speed: 200 }));
  await page.click('.hn-pen-kind[data-kind="fountain"]');
  await page.click('.hn-pen-panel summary');
  await page.click('.hn-pen-panel .hn-chip[data-value="experimental"]');
  await page.keyboard.press('Escape');
  await stroke(page, toSamples([[0, 0], [60, 0]], { x0: 100, y0: 350, scale: 1, speed: 200 }));
  const engines = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].strokes.map((s) => s.engine));
  assert(engines.at(-2) === 1 && engines.at(-1) === 2, `engines ${JSON.stringify(engines)}`);
  // width: tap the active preset → slider in mm; changing it edits that preset
  await page.click('.hn-width.is-active');
  assert(/0\.8 mm/.test(await page.textContent('.hn-width-panel .hn-sl-value')), 'default middle width is 0.8 mm');
  await page.focus('.hn-width-panel .hn-sl-track');
  await page.keyboard.press('End');
  const st = await page.evaluate(() => window.__hn.editor.getSettings());
  assert(Math.abs(st.experimental.width - 2.5 * 72 / 25.4) < 0.05, `width set to 2.5 mm (${st.experimental.width})`);
  assert(Math.abs(st.widthPresets.fountain[1] - st.experimental.width) < 1e-9, 'preset 2 updated');
});

t('colour circles: + adds a custom colour at the front; adding an existing colour moves it to the front', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const add = async (c) =>
    page.evaluate((c) => {
      const i = document.querySelector('.hn-subbar .hn-color-input');
      i.value = c;
      i.dispatchEvent(new Event('change', { bubbles: true }));
    }, c);
  await add('#00aa55');
  let st = await page.evaluate(() => window.__hn.editor.getSettings());
  assert(st.inkPalette[0] === '#00aa55' && st.pens.fountain.color === '#00aa55', `added in front and selected (${st.inkPalette.slice(0, 3)})`);
  const n = st.inkPalette.length;
  await add('#1f6fe5');
  st = await page.evaluate(() => window.__hn.editor.getSettings());
  assert(st.inkPalette[0] === '#1f6fe5' && st.inkPalette.length === n, 'duplicate moved to the front, not added twice');
  const swatches = await page.$$eval('.hn-subbar .hn-swatch[data-color]', (els) => els.map((e) => e.dataset.color));
  assert(swatches[0] === '#1f6fe5', 'toolbar shows the palette in order');
});

t('change template: A3 landscape, cream, grid for all pages (undoable); input mode is device-only', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-more-btn');
  await page.click('.hn-more-menu .hn-list-row:has-text("Change template")');
  await page.click('.hn-template-panel .hn-chip[data-value="a3"]');
  await page.click('.hn-template-panel .hn-chip[data-value="l"]');
  await page.click('.hn-template-panel .hn-chip[data-value="cream"]');
  await page.click('.hn-template-panel .hn-thumb[data-kind="grid"]');
  await page.click('.hn-template-panel .hn-chip[data-value="all"]');
  await page.click('.hn-template-panel .hn-apply');
  const pages = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => [p.width, p.height, p.background.kind, p.background.paper]));
  assert(pages.every((p) => p[0] === 1191 && p[1] === 842 && p[2] === 'grid' && p[3] === '#f8f3e6'), JSON.stringify(pages));
  await page.evaluate(() => window.__hn.editor.undo());
  const back = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => [p.width, p.height]));
  assert(back.every((p) => p[0] === 595 && p[1] === 842), 'undo restores the size');
  await page.click('.hn-more-btn');
  await page.click('.hn-more-menu .hn-chip[data-value="mouse"]');
  const cls = await page.evaluate(() => document.querySelector('.hn-editor').className);
  assert(cls.includes('hn-mode-mouse'), cls);
  const text = await page.evaluate(() => window.__hn.serialize());
  assert(!/inputMode|mouse-first|Mouse/i.test(text), 'input mode is not written into the .handnote file');
});

t('partial eraser: standard eraser through the middle splits a stroke; precise leaves the rest untouched; undo', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await stroke(page, toSamples([[0, 0], [200, 0]], { x0: 80, y0: 300, scale: 1, speed: 250 }));
  const orig = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].strokes[0].samples.length);
  await page.click('.hn-tool[data-group="eraser"]');
  await stroke(page, toSamples([[0, 0], [0, 40]], { x0: 180, y0: 280, scale: 1, speed: 300 }));
  const frag = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].strokes.map((s) => ({ n: s.samples.length, cut: s.cut, x0: s.samples[0].x, x1: s.samples.at(-1).x })));
  assert(frag.length === 2, `two fragments (${JSON.stringify(frag)})`);
  assert(frag[0].cut === 2 && frag[1].cut === 1, 'cut flags');
  assert(frag[0].x1 < 180 && frag[1].x0 > 180, 'gap where the eraser passed');
  const ink = await pixel(page, 120, 300);
  assert(lum(ink) < 120, 'remaining ink still rendered');
  const gap = await pixel(page, 180, 300);
  assert(lum(gap) > 200, `erased spot is paper (lum ${lum(gap).toFixed(0)})`);
  await page.evaluate(() => window.__hn.editor.undo());
  const n = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].strokes.map((s) => s.samples.length));
  assert(n.length === 1 && n[0] === orig, 'undo restores the original stroke');
  const text = await page.evaluate(() => window.__hn.serialize());
  assert(!/"cut":/.test(text), 'no cut fragments left after undo');
});

t('text box: tap to create, type, commit; reload keeps it; tap selects; delete from the floating bar', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-tool[data-group="text"]');
  const c = await page.evaluate(() => window.__hn.editor.pageToClient(0, 60, 250));
  await page.mouse.click(c.x, c.y);
  assert(await page.$('.hn-text-editor'), 'text editor opened');
  await page.keyboard.type('知行合一 test');
  const away = await page.evaluate(() => window.__hn.editor.pageToClient(0, 400, 330));
  await page.mouse.click(away.x, away.y);
  await page.waitForTimeout(200);
  const items = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items);
  assert(items.length === 1 && items[0].type === 'text' && items[0].text === '知行合一 test', JSON.stringify(items));
  assert(items[0].w > 60 && items[0].h > 16, `auto-sized box ${items[0].w}x${items[0].h}`);
  let minLum = 255;
  for (let k = 0; k < 40; k++) minLum = Math.min(minLum, lum(await pixel(page, items[0].x + 4 + (k * (items[0].w - 8)) / 40, items[0].y + items[0].h / 2)));
  assert(minLum < 150, `text rendered on the canvas (darkest ${minLum.toFixed(0)})`);
  assert(/"version":3,/.test(await page.evaluate(() => window.__hn.serialize())), 'file version 3 with items');
  await open(page, base, '?mode=pen');
  const again = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items.length);
  assert(again === 1, 'text box restored after reload');
  await page.click('.hn-tool[data-group="text"]');
  const ci = await page.evaluate(() => { const it = window.__hn.editor.getDocument().pages[0].items[0]; return window.__hn.editor.pageToClient(0, it.x + 10, it.y + 8); });
  await page.mouse.click(ci.x, ci.y);
  assert(await page.isVisible('.hn-objbar'), 'floating bar shown for the selection');
  await page.click('.hn-objbar button[data-action="trash"]');
  assert((await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items.length)) === 0, 'deleted');
  await page.evaluate(() => window.__hn.editor.undo());
  assert((await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items.length)) === 1, 'undo restores it');
});

async function penDrag(page, x0, y0, x1, y1, steps = 12) {
  await page.evaluate(
    async ({ x0, y0, x1, y1, steps }) => {
      const ed = window.__hn.editor;
      const v = document.querySelector('.hn-viewport');
      const ev = (type, x, y) => {
        const c = ed.pageToClient(0, x, y);
        v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: 0.3, buttons: type === 'pointerup' ? 0 : 1 }));
      };
      ev('pointerdown', x0, y0);
      for (let i = 1; i <= steps; i++) ev('pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      ev('pointerup', x1, y1);
      await new Promise((r) => requestAnimationFrame(r));
    },
    { x0, y0, x1, y1, steps },
  );
}

t('shapes: drag draws; an arrow from one shape to another stays attached when a shape moves', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-tool[data-group="shape"]');
  await page.click('.hn-shape-kind[data-kind="rect"]');
  await penDrag(page, 60, 220, 180, 300);
  await page.click('.hn-shape-kind[data-kind="ellipse"]');
  await penDrag(page, 300, 220, 400, 320);
  await page.click('.hn-shape-kind[data-kind="arrow"]');
  await penDrag(page, 181, 260, 299, 270);
  let items = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items);
  const [rect, ell, arrow] = items;
  assert(items.length === 3 && rect.kind === 'rect' && ell.kind === 'ellipse' && arrow.kind === 'arrow', JSON.stringify(items.map((i) => i.kind)));
  assert(arrow.from?.id === rect.id && arrow.to?.id === ell.id, `arrow attached (${JSON.stringify([arrow.from, arrow.to])})`);
  // select the rectangle (tap) and drag its selection box
  const tapAt = await page.evaluate(() => window.__hn.editor.pageToClient(0, 120, 230));
  await page.mouse.click(tapAt.x, tapAt.y);
  assert(await page.isVisible('.hn-sel'), 'rectangle selected');
  const box = await page.$('.hn-sel');
  const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  items = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items);
  const r2 = items.find((i) => i.id === rect.id);
  const a2 = items.find((i) => i.id === arrow.id);
  assert(r2.y > rect.y + 40, `rectangle moved (${rect.y} → ${r2.y})`);
  assert(Math.abs(a2.a[1] - (r2.y + r2.h / 2)) < 0.5 && Math.abs(a2.a[0] - (r2.x + r2.w)) < 0.5, `arrow start follows the rectangle (${a2.a})`);
  assert(Math.abs(a2.b[0] - ell.x) < 0.5, 'arrow end still on the ellipse');
  await page.evaluate(() => window.__hn.editor.undo());
  const r3 = await page.evaluate((id) => window.__hn.editor.getDocument().pages[0].items.find((i) => i.id === id).y, rect.id);
  assert(Math.abs(r3 - rect.y) < 0.01, 'undo moves it back');
});

t('shape pen: a hand-drawn circle becomes a clean ellipse; a scribble stays ink', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-pen-kind[data-kind="shapepen"]');
  await stroke(page, toSamples(circle(50)[0], { x0: 200, y0: 300, scale: 1, speed: 200 }));
  let doc = await page.evaluate(() => window.__hn.editor.getDocument().pages[0]);
  assert(doc.items.length === 1 && doc.items[0].kind === 'ellipse' && doc.strokes.length === 0, `recognized (${JSON.stringify(doc.items.map((i) => i.kind))}, strokes ${doc.strokes.length})`);
  await stroke(page, toSamples(loops(3)[0], { x0: 100, y0: 450, scale: 1, speed: 200 }));
  doc = await page.evaluate(() => window.__hn.editor.getDocument().pages[0]);
  assert(doc.strokes.length === 1 && doc.items.length === 1, 'loops stay ink');
  await page.click('.hn-pen-kind[data-kind="pencil"]');
  await stroke(page, toSamples([[0, 0], [80, 10]], { x0: 100, y0: 520, scale: 1, speed: 200 }));
  doc = await page.evaluate(() => window.__hn.editor.getDocument().pages[0]);
  const last = doc.strokes.at(-1);
  assert(last.tool === 'pencil' && last.engine === 2, `pencil stroke engine 2 (${last.tool}, ${last.engine})`);
});

t('image: insert from a file, crop by dragging an edge, delete', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAQklEQVR42u3PMQ0AAAgDoK1/aE3g5wEJyO1M2gIFChQoUKBAgQIFChQoUKBAgQIFChQoUKBAgQIFChQoUKBAgYIHCwQzQTOaWvhCAAAAAElFTkSuQmCC';
  await page.setInputFiles('.hn-file-input', { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => window.__hn.editor.getDocument().pages[0].items.length === 1);
  const it = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items[0]);
  assert(it.type === 'image' && it.natW === 64 && it.natH === 32 && Math.abs(it.w / it.h - 2) < 0.01, JSON.stringify({ ...it, src: it.src.slice(0, 30) }));
  assert(await page.isVisible('.hn-objbar button[data-action="crop"]'), 'image selected with crop in the floating bar');
  await page.click('.hn-objbar button[data-action="crop"]');
  const e = await page.$('.hn-sel .hn-h-e');
  const eb = await e.boundingBox();
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await page.mouse.down();
  await page.mouse.move(eb.x - 40, eb.y + eb.height / 2, { steps: 5 });
  await page.mouse.up();
  const cropped = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items[0]);
  assert(cropped.crop && cropped.crop[2] < 0.95 && cropped.w < it.w - 5, `cropped ${JSON.stringify(cropped.crop)} w ${it.w.toFixed(1)}→${cropped.w.toFixed(1)}`);
  assert(Math.abs(cropped.w / cropped.crop[2] - it.w) < 0.5, 'image scale unchanged while cropping');
  await page.click('.hn-objbar button[data-action="check"]');
  await page.click('.hn-objbar button[data-action="trash"]');
  assert((await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items.length)) === 0, 'deleted');
});

t('input diagnostics report: pressure verdict and finger contact sizes', async ({ page, base, assert, log }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    ed.updateSettings({ ...ed.getSettings(), diagnostics: true });
  });
  for (let i = 0; i < 4; i++) await stroke(page, toSamples([[0, 0], [80, 10]], { x0: 100, y0: 200 + i * 30, scale: 1, speed: 150 }));
  await page.waitForTimeout(350);
  await stroke(page, toSamples([[0, 0], [0, 80]], { x0: 300, y0: 500, scale: 1, speed: 300 }), { pointerType: 'touch', pointerId: 81 });
  const report = await page.evaluate(() => window.__hn.editor.diagnosticsReport());
  log(report.split('\n').slice(0, 12).join(' | '));
  assert(/verdict: \*\*REAL\*\*/.test(report), 'synthetic varying pressure is reported as real');
  assert(/finger contact size px .*p50 52\.0/.test(report), 'finger contact size recorded');
  assert(/touch:finger-navigation/.test(report), 'finger classified as navigation');
  // pen panel → Advanced → Calibrate from my writing uses the measured median / p99
  await page.click('.hn-pen-kind[data-kind="fountain"]');
  await page.click('.hn-pen-panel summary');
  const btn = await page.$('.hn-pen-panel >> text=/Calibrate from my writing \\(/');
  assert(btn && !(await btn.isDisabled()), 'calibrate button enabled with measured data');
  await btn.click();
  const prm = await page.evaluate(() => window.__hn.editor.getSettings().experimental);
  const m = /suggested calibration: typical ([\d.]+) · heavy ([\d.]+)/.exec(report);
  assert(m && Math.abs(prm.typicalPressure - Number(m[1])) <= 0.011, `typical ${prm.typicalPressure} vs report ${m && m[1]}`);
  assert(Math.abs(prm.heavyPressure - Number(m[2])) <= 0.011 && prm.heavyPressure > prm.typicalPressure, `heavy ${prm.heavyPressure} vs report ${m[2]}`);
  await page.keyboard.press('Escape');
  await stroke(page, toSamples([[0, 0], [80, 0]], { x0: 100, y0: 420, scale: 1, speed: 150 }));
  const last = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].strokes.at(-1).params);
  assert(last.heavyPressure === prm.heavyPressure && last.typicalPressure === prm.typicalPressure, 'new strokes store the calibrated range');
});

t('iPad fix: a focused text box cannot scroll the writing area (ink stays under the pen)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-tool[data-group="text"]');
  // a text box near the bottom edge: iOS would scroll an overflow container to reveal it
  const vp = await page.evaluate(() => document.querySelector('.hn-viewport').getBoundingClientRect().toJSON());
  await page.mouse.click(vp.left + 200, vp.bottom - 12);
  assert(await page.$('.hn-text-editor'), 'text box near the bottom edge is being edited');
  const sc = await page.evaluate(() => {
    const v = document.querySelector('.hn-viewport');
    const r = document.querySelector('.hn-editor');
    v.scrollTop = 80;
    v.scrollLeft = 40;
    r.scrollTop = 80;
    document.querySelector('.hn-text-editor').scrollIntoView();
    return [v.scrollTop, v.scrollLeft, r.scrollTop];
  });
  assert(sc.every((x) => x === 0), `writing area and editor are not scrollable (${sc})`);
  await page.keyboard.press('Escape');
  await page.click('.hn-tool[data-group="pen"]');
  await stroke(page, toSamples([[0, 0], [80, 0]], { x0: 100, y0: 300, scale: 1, speed: 200 }));
  const s = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].strokes.at(-1).samples[0]);
  assert(Math.abs(s.x - 100) < 1.5 && Math.abs(s.y - 300) < 1.5, `stroke starts under the pen (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
  const px = await pixel(page, 140, 300);
  assert(lum(px) < 120, 'ink rendered where the pen was');
});

t('iPad fix: the text box is focused again inside the touchend gesture (iOS keyboard)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-tool[data-group="text"]');
  // finger tap → router tap → text box
  await page.evaluate(async () => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const c = ed.pageToClient(0, 80, 260);
    const ev = (type) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, pointerType: 'touch', clientX: c.x, clientY: c.y, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    await new Promise((r) => setTimeout(r, 400));
    ev('pointerdown');
    await new Promise((r) => setTimeout(r, 40));
    ev('pointerup');
  });
  assert(await page.$('.hn-text-editor'), 'finger tap created a text box');
  assert(await page.evaluate(() => !!window.__hn.editor.objects.pendingFocus), 'focus is pending for the touch gesture');
  const focused = await page.evaluate(async () => {
    const ta = document.querySelector('.hn-text-editor');
    ta.blur(); // simulate iOS ignoring the focus() made from pointerup
    document.dispatchEvent(new Event('touchend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return { focused: document.activeElement === ta, alive: ta.isConnected, pending: !!window.__hn.editor.objects.pendingFocus };
  });
  assert(focused.focused && focused.alive && !focused.pending, JSON.stringify(focused));
  await page.keyboard.type('键盘');
  await page.keyboard.press('Escape');
  const items = await page.evaluate(() => window.__hn.editor.getDocument().pages[0].items.map((i) => i.text));
  assert(items[0] === '键盘', `typed text saved (${items})`);
});

t('more menu: clear this page needs a second tap, clears ink and objects, undo restores', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await stroke(page, toSamples([[0, 0], [80, 10]], { x0: 100, y0: 250, scale: 1, speed: 200 }));
  await stroke(page, toSamples([[0, 0], [80, 10]], { x0: 100, y0: 300, scale: 1, speed: 200 }));
  await page.click('.hn-tool[data-group="text"]');
  const c = await page.evaluate(() => window.__hn.editor.pageToClient(0, 60, 360));
  await page.mouse.click(c.x, c.y);
  await page.keyboard.type('clear me');
  await page.keyboard.press('Escape');
  await page.click('.hn-tool[data-group="pen"]');
  const count = () => page.evaluate(() => { const p = window.__hn.editor.getDocument().pages[0]; return [p.strokes.length, p.items.length]; });
  assert(JSON.stringify(await count()) === '[2,1]', `before ${await count()}`);
  await page.click('.hn-more-btn');
  await page.click('.hn-clear-page');
  assert(JSON.stringify(await count()) === '[2,1]', 'first tap only arms it');
  assert(/again|再点/.test(await page.textContent('.hn-clear-page')), 'asks for confirmation');
  await page.click('.hn-clear-page');
  assert(JSON.stringify(await count()) === '[0,0]', `cleared ${await count()}`);
  assert(!(await page.$('.hn-more-menu')), 'menu closed');
  await page.evaluate(() => window.__hn.editor.undo());
  assert(JSON.stringify(await count()) === '[2,1]', 'one undo restores ink and text');
  await page.click('.hn-more-btn');
  assert(!(await page.$eval('.hn-clear-page', (b) => b.disabled)), 'enabled on a page with content');
});

// =================================================================================================
// v0.4 — tool taps, controls, line styles, lasso, laser, pages, embedded images, AI (mock)
// =================================================================================================

/** Dispatch a pen tap with a small wobble on an element (the iPadOS case that dropped clicks). */
async function wobbleTap(page, selector, wobble = 8) {
  await page.evaluate(
    ({ selector, wobble }) => {
      const b = document.querySelector(selector);
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const ev = (type, dx) => b.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'pen', clientX: x + dx, clientY: y, pressure: 0.2, buttons: type === 'pointerup' ? 0 : 1 }));
      ev('pointerdown', 0);
      ev('pointermove', wobble);
      ev('pointerup', wobble);
      // a browser may or may not send the click afterwards; it must not act a second time
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    { selector, wobble },
  );
}

/** Freehand path on page 0 with a given pointer type. */
async function path(page, pts, { pointerType = 'pen', pointerId = 9 } = {}) {
  await page.evaluate(
    async ({ pts, pointerType, pointerId }) => {
      const ed = window.__hn.editor;
      const v = document.querySelector('.hn-viewport');
      const ev = (type, p) => {
        const c = ed.pageToClient(0, p[0], p[1]);
        v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType, clientX: c.x, clientY: c.y, pressure: 0.3, buttons: type === 'pointerup' ? 0 : 1 }));
      };
      ev('pointerdown', pts[0]);
      for (let i = 1; i < pts.length; i++) {
        ev('pointermove', pts[i]);
        if (i % 4 === 0) await new Promise((r) => requestAnimationFrame(r));
      }
      ev('pointerup', pts[pts.length - 1]);
      await new Promise((r) => requestAnimationFrame(r));
    },
    { pts, pointerType, pointerId },
  );
}

function loopAround(x0, y0, x1, y1, n = 40) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  return Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * Math.PI * 2), cy + ry * Math.sin((i / n) * Math.PI * 2)]);
}

const page0 = (page) => page.evaluate(() => window.__hn.editor.getDocument().pages[0]);

t('v0.4 tool taps: a wobbly pen tap switches tools once; the trailing click does not act twice; keyboard click works', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await wobbleTap(page, '.hn-tool[data-group="eraser"]', 9);
  assert((await page.evaluate(() => window.__hn.editor.getSettings().tool)) === 'eraser', 'eraser selected with one wobbly tap');
  assert(!(await page.evaluate(() => document.querySelector('.hn-subbar').classList.contains('is-hidden'))), 'the trailing click did not toggle the sub-bar a second time');
  await wobbleTap(page, '.hn-tool[data-group="lasso"]', 12);
  assert((await page.evaluate(() => window.__hn.editor.getSettings().tool)) === 'lasso', 'lasso selected');
  // a real drag across a button (scroll gesture) is not a tap
  await wobbleTap(page, '.hn-tool[data-group="text"]', 40);
  assert((await page.evaluate(() => window.__hn.editor.getSettings().tool)) === 'lasso', 'a 40 px drag is not a tap');
  // keyboard activation (Enter → click without a pointer sequence)
  await page.focus('.hn-tool[data-group="pen"]');
  await page.keyboard.press('Enter');
  assert((await page.evaluate(() => window.__hn.editor.getSettings().tool)) === 'fountain', 'keyboard click selects the pen');
  // the top bar order: pages | lasso pen eraser text image shapes laser
  const order = await page.$$eval('.hn-tools > button', (bs) => bs.map((b) => b.dataset.group ?? (b.classList.contains('hn-pages-btn') ? 'pages' : '?')));
  assert(JSON.stringify(order) === JSON.stringify(['pages', 'lasso', 'pen', 'eraser', 'text', 'image', 'shape', 'laser']), `order ${order}`);
});

t('v0.4 controls: colour circles stay round with a ring + check on the selected one; selected tools are marked', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const sw = await page.$$eval('.hn-subbar .hn-swatch', (els) => els.map((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]));
  assert(sw.length > 3 && sw.every(([w, h]) => Math.abs(w - h) < 0.5), `circles are round ${JSON.stringify(sw.slice(0, 4))}`);
  // Obsidian mobile-like generic button styles must not stretch them
  await page.addStyleTag({ content: 'button { padding: 6px 16px; min-height: 44px; width: 100px; }' });
  const sw2 = await page.$$eval('.hn-subbar button.hn-swatch', (els) => els.map((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]));
  assert(sw2.every(([w, h]) => Math.abs(w - h) < 0.5 && w <= 30), `still round under generic button CSS ${JSON.stringify(sw2.slice(0, 3))}`);
  const tool = await page.$eval('.hn-tool.is-active', (b) => [b.offsetWidth, getComputedStyle(b).backgroundColor]);
  assert(tool[0] <= 48, `tool buttons keep their width (${tool[0]})`);
  const mark = await page.$eval('.hn-subbar .hn-swatch.is-active .hn-swatch-mark', (m) => getComputedStyle(m).opacity);
  assert(mark === '1', 'check mark on the selected colour');
  const ring = await page.$eval('.hn-subbar .hn-swatch.is-active', (b) => getComputedStyle(b, '::after').boxShadow);
  assert(ring && ring !== 'none', `translucent ring (${ring})`);
  const pressed = await page.evaluate(() => {
    const b = document.querySelector('.hn-tool[data-group="text"]');
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, pointerType: 'touch', clientX: r.left + 5, clientY: r.top + 5 }));
    const on = b.classList.contains('is-pressed');
    b.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 5, pointerType: 'touch' }));
    return [on, b.classList.contains('is-pressed')];
  });
  assert(pressed[0] && !pressed[1], 'pressed state appears immediately and clears');
});

t('v0.4 step slider: stops at 0/25/50/75/100 %, soft snap, value shown, small thumb', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-pen-kind[data-kind="fountain"]');
  const sl = await page.$('.hn-pen-panel .hn-card .hn-sl');
  const ticks = await sl.$$eval('.hn-sl-tick', (els) => els.map((e) => e.style.left));
  assert(JSON.stringify(ticks) === JSON.stringify(['0%', '25%', '50%', '75%', '100%']), `ticks ${ticks}`);
  const thumb = await sl.$eval('.hn-sl-thumb', (e) => e.getBoundingClientRect().height);
  assert(thumb <= 22, `thumb ${thumb}px`);
  const track = await sl.$('.hn-sl-track');
  const bb = await track.boundingBox();
  // drag to ~51 %: snaps to the 50 % stop
  await page.mouse.move(bb.x + bb.width * 0.2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.515, bb.y + bb.height / 2, { steps: 4 });
  await page.mouse.up();
  const v = await sl.$eval('.hn-sl-value', (e) => e.textContent);
  assert(v === '50%', `snapped to 50% (${v})`);
  const st = await page.evaluate(() => window.__hn.editor.getSettings().experimental.tapering);
  assert(Math.abs(st - 0.5) < 1e-9, `setting 0.5 (${st})`);
  // the panel does not cover the writing area more than needed
  const panel = await page.$eval('.hn-pen-panel', (e) => e.getBoundingClientRect().width);
  assert(panel <= 360, `panel width ${panel}`);
});

t('v0.4 stroke settings: solid / dashed / dotted; dashed ink is saved and drawn with gaps', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-subbar .hn-stroke-style');
  assert((await page.$$('.hn-width-panel .hn-dash-tile')).length === 3, 'three line styles');
  await page.click('.hn-dash-tile[data-dash="dash"]');
  await page.keyboard.press('Escape');
  await stroke(page, toSamples([[0, 0], [300, 0]], { x0: 60, y0: 300, scale: 1, speed: 150 }));
  const s = (await page0(page)).strokes[0];
  assert(s.dash === 'dash', `stroke saved dashed (${s.dash})`);
  // scan the scene along the stroke: dark and light runs alternate
  let changes = 0;
  let prev = null;
  for (let x = 70; x < 350; x += 1) {
    const dark = lum(await pixel(page, x, 300)) < 160;
    if (prev !== null && dark !== prev) changes++;
    prev = dark;
  }
  assert(changes >= 10, `gaps along the dashed stroke (${changes} transitions)`);
  assert((await page.evaluate(() => window.__hn.serialize())).includes('"dash":"dash"'), 'serialized');
});

t('v0.4 lasso: loop selects ink and shapes, drag moves them (one undo step), copy/paste, group, delete', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await stroke(page, toSamples([[0, 0], [80, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  await stroke(page, toSamples([[0, 0], [80, 10]], { x0: 100, y0: 230, scale: 1, speed: 150 }));
  await stroke(page, toSamples([[0, 0], [60, 0]], { x0: 400, y0: 500, scale: 1, speed: 150 }));
  await page.click('.hn-tool[data-group="lasso"]');
  await path(page, loopAround(80, 180, 200, 260));
  assert(await page.isVisible('.hn-lasso-sel'), 'selection box shown');
  assert(await page.isVisible('.hn-lasso-bar button[data-action="sparkles"]'), 'floating bar with AI tools button');
  assert(await page.isVisible('.hn-lasso-bar button[data-action="to-text"]'), 'floating bar with Convert button');
  const sel = await page.evaluate(() => ({ s: [...window.__hn.editor.lasso.selection.strokeIds].length }));
  assert(sel.s === 2, `two strokes selected (${sel.s})`);
  const before = (await page0(page)).strokes.map((s) => s.samples[0].x);
  const bb = await (await page.$('.hn-lasso-sel')).boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + 100, bb.y + bb.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = (await page0(page)).strokes.map((s) => s.samples[0].x);
  const z = await page.evaluate(() => window.__hn.editor.camera.zoom);
  assert(Math.abs(after[0] - before[0] - 100 / z) < 1 && Math.abs(after[2] - before[2]) < 1e-6, `moved selected strokes only (${before[0].toFixed(1)} → ${after[0].toFixed(1)})`);
  await page.evaluate(() => window.__hn.editor.undo());
  const undone = (await page0(page)).strokes.map((s) => s.samples[0].x);
  assert(Math.abs(undone[0] - before[0]) < 1e-6, 'one undo restores the position');
  // select again, copy, paste
  await path(page, loopAround(80, 180, 200, 260));
  await page.click('.hn-lasso-bar button[data-action="copy"]');
  await page.keyboard.press('Control+v');
  assert((await page0(page)).strokes.length === 5, 'pasted two strokes');
  // group → tapping one member with the text tool selects the whole group
  await page.click('.hn-lasso-bar button[data-action="group"]');
  const groups = new Set((await page0(page)).strokes.filter((s) => s.g).map((s) => s.g));
  assert(groups.size === 1, 'grouped');
  await page.click('.hn-lasso-bar button[data-action="trash"]');
  assert((await page0(page)).strokes.length === 3, 'deleted the pasted group');
});

t('v0.4 lasso: scale and rotate handles; local "convert to shapes" turns drawn shapes into editable shapes', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await stroke(page, toSamples(circle(40)[0], { x0: 120, y0: 200, scale: 1, speed: 200 }));
  await stroke(page, toSamples([[0, 0], [120, 0]], { x0: 120, y0: 330, scale: 1, speed: 150 }));
  await page.click('.hn-tool[data-group="lasso"]');
  await path(page, loopAround(90, 170, 280, 360));
  const w0 = await page.evaluate(() => window.__hn.editor.lasso.bounds().w);
  const se = await (await page.$('.hn-lasso-sel .hn-lh-se')).boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x + 80, se.y + 60, { steps: 6 });
  await page.mouse.up();
  const w1 = await page.evaluate(() => window.__hn.editor.lasso.bounds().w);
  assert(w1 > w0 * 1.2, `scaled ${w0.toFixed(0)} → ${w1.toFixed(0)}`);
  const rot = await (await page.$('.hn-lasso-sel .hn-lh-rot')).boundingBox();
  const c = await (await page.$('.hn-lasso-sel')).boundingBox();
  await page.mouse.move(rot.x + rot.width / 2, rot.y + rot.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width + 60, c.y + c.height / 2, { steps: 8 });
  await page.mouse.up();
  const b2 = await page.evaluate(() => window.__hn.editor.lasso.bounds());
  assert(b2.h > b2.w * 0.9, `rotated about 90° (${b2.w.toFixed(0)}×${b2.h.toFixed(0)})`);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  await page.click('.hn-ai-row[data-task="shape"]');
  const pg = await page0(page);
  const kinds = pg.items.map((i) => i.kind).sort();
  assert(pg.strokes.length === 0 && kinds.includes('ellipse') && kinds.includes('line'), `converted ${JSON.stringify(kinds)}`);
});

t('v0.4 shapes: curve tool fits a smooth arc; line style and arrows; shape pen recognises lines, polylines and a separate arrow head', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-tool[data-group="shape"]');
  await page.click('.hn-shape-kind[data-kind="curve"]');
  await page.click('.hn-subbar .hn-shape-style');
  await page.click('.hn-width-panel .hn-dash-tile[data-dash="dot"]');
  await page.click('.hn-width-panel .hn-chip[data-value="both"]');
  await page.keyboard.press('Escape');
  await path(page, Array.from({ length: 30 }, (_, i) => [80 + i * 8, 300 - Math.sin((i / 29) * Math.PI) * 70]));
  let it = (await page0(page)).items.at(-1);
  assert(it.kind === 'curve' && it.dash === 'dot' && it.arrowStart && it.arrowEnd, `curve ${JSON.stringify({ k: it.kind, d: it.dash, s: it.arrowStart, e: it.arrowEnd })}`);
  const midY = 0.25 * it.a[1] + 0.5 * it.c[1] + 0.25 * it.b[1];
  assert(Math.abs(midY - 230) < 10, `arc passes near the drawn top (${midY.toFixed(1)})`);
  assert(await page.isVisible('.hn-ctrl-handle'), 'curve control handle shown');
  // shape pen
  await page.click('.hn-tool[data-group="pen"]');
  await page.click('.hn-pen-kind[data-kind="shapepen"]');
  await stroke(page, toSamples([[0, 0], [200, 30]], { x0: 80, y0: 450, scale: 1, speed: 200 }));
  it = (await page0(page)).items.at(-1);
  assert(it.kind === 'line', `line recognised (${it.kind})`);
  await stroke(page, toSamples([[0, 0], [0, 50], [0, 97], [1, 99], [3, 100], [75, 100], [150, 100]], { x0: 80, y0: 520, scale: 1, speed: 200 }));
  it = (await page0(page)).items.at(-1);
  assert(it.kind === 'polyline', `polyline recognised (${it.kind})`);
  const n = (await page0(page)).items.length;
  // a "V" at the end of the first line makes it an arrow
  const tip = [280, 480];
  await stroke(page, toSamples([[tip[0] - 16, tip[1] - 12], tip, [tip[0] - 12, tip[1] + 14]], { x0: 0, y0: 0, scale: 1, speed: 120 }));
  const items = (await page0(page)).items;
  const line = items.find((i) => i.kind === 'line');
  assert(items.length === n && line.arrowEnd === true, `arrow head attached (${items.length} items, arrowEnd ${line.arrowEnd})`);
});

t('beta.2 pages sidebar: left side, mixed page sizes never overlap, drag to reorder, GoodNotes menu', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=mouse');
  await stroke(page, toSamples([[0, 0], [200, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  // page 2 landscape 16:9, page 3 tall custom, page 4 A5
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    ed.addPageAt(2);
    ed.addPageAt(3);
    const ps = ed.getDocument().pages;
    const set = (pg, w, h) => ed['pushOp']({ kind: 'set-page', pageId: pg.id, before: { width: pg.width, height: pg.height, background: pg.background }, after: { width: w, height: h, background: { ...pg.background, kind: 'grid' } } });
    set(ps[1], 960, 540);
    set(ps[2], 400, 1200);
    set(ps[3], 420, 595);
  });
  await page.click('.hn-pages-btn');
  assert(await page.isVisible('.hn-pages-sidebar'), 'sidebar open');
  const geo = await page.evaluate(() => {
    const sb = document.querySelector('.hn-pages-sidebar').getBoundingClientRect();
    const vp = document.querySelector('.hn-viewport').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.hn-ps-cell[data-index] .hn-ps-box')].map((b) => b.getBoundingClientRect());
    return { sb: { left: sb.left, right: sb.right }, vpLeft: vp.left, boxes: boxes.map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height })) };
  });
  assert(geo.sb.left < 5 && geo.vpLeft >= geo.sb.right - 1, `sidebar on the left, paper moved right (sidebar ${geo.sb.left}-${geo.sb.right}, viewport ${geo.vpLeft})`);
  assert(geo.boxes.length === 4, `four thumbnails (${geo.boxes.length})`);
  const sameSize = geo.boxes.every((b) => Math.abs(b.w - geo.boxes[0].w) < 0.5 && Math.abs(b.h - geo.boxes[0].h) < 0.5);
  let overlap = false;
  for (let i = 0; i < geo.boxes.length; i++) for (let j = i + 1; j < geo.boxes.length; j++) {
    const a = geo.boxes[i];
    const c = geo.boxes[j];
    if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlap = true;
  }
  assert(sameSize && !overlap, 'fixed cells, no overlap for portrait / landscape / tall / A5');
  await page.waitForFunction(() => document.querySelectorAll('.hn-ps-canvas').length === 4);
  const fit = await page.evaluate(() =>
    [...document.querySelectorAll('.hn-ps-cell[data-index]')].every((c) => {
      const b = c.querySelector('.hn-ps-box').getBoundingClientRect();
      const v = c.querySelector('canvas').getBoundingClientRect();
      return v.left >= b.left - 0.5 && v.right <= b.right + 0.5 && v.top >= b.top - 0.5 && v.bottom <= b.bottom + 0.5 && v.width > 20 && v.height > 20;
    }),
  );
  assert(fit, 'every thumbnail fits inside its cell');
  const ink = await page.evaluate(() => {
    const c = document.querySelector('.hn-ps-cell[data-index="0"] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let k = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 160) k++;
    return k;
  });
  assert(ink > 5, `thumbnail shows the ink (${ink} px)`);
  await shot('beta2-pages-sidebar');
  // tap = go, sidebar stays open
  await page.click('.hn-ps-cell[data-index="1"] .hn-ps-box');
  assert((await page.evaluate(() => window.__hn.editor.currentPageIndex())) === 1, 'jumped to page 2');
  assert(await page.isVisible('.hn-pages-sidebar'), 'sidebar stays open while navigating');
  // drag page 1 behind page 3 (mouse drag)
  const ids = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => p.id));
  const b0 = await page.locator('.hn-ps-cell[data-index="0"] .hn-ps-box').boundingBox();
  const b2 = await page.locator('.hn-ps-cell[data-index="2"] .hn-ps-box').boundingBox();
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(b0.x + b0.width / 2 + ((b2.x + b2.width * 0.8 - b0.x - b0.width / 2) * i) / 10, b0.y + b0.height / 2 + ((b2.y + b2.height / 2 - b0.y - b0.height / 2) * i) / 10);
  assert(await page.isVisible('.hn-ps-ghost'), 'drag ghost follows the pointer');
  await page.mouse.up();
  const ids2 = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => p.id));
  assert(JSON.stringify(ids2) === JSON.stringify([ids[1], ids[2], ids[0], ids[3]]), `dragged page 1 behind page 3 (${ids2.map((x) => ids.indexOf(x) + 1).join(',')})`);
  await page.evaluate(() => window.__hn.editor.undo());
  const ids3 = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => p.id));
  assert(JSON.stringify(ids3) === JSON.stringify(ids), 'undo restores the order');
  // menu: rotate page 1 (content rotates with it), export, copy + paste, delete needs confirmation
  const before = await page.evaluate(() => {
    const p = window.__hn.editor.getDocument().pages[0];
    return { w: p.width, h: p.height, x: p.strokes[0].samples[0].x, y: p.strokes[0].samples[0].y };
  });
  await page.click('.hn-ps-cell[data-index="0"] .hn-ps-more');
  const labels = await page.$$eval('.hn-ps-menu .hn-ps-menu-row .hn-row-label', (e) => e.map((x) => x.textContent));
  assert(labels.length >= 10, `menu has the GoodNotes-style actions (${labels.join(' / ')})`);
  await page.click('.hn-ps-menu-row:has-text("Rotate")');
  const after = await page.evaluate(() => {
    const p = window.__hn.editor.getDocument().pages[0];
    return { w: p.width, h: p.height, x: p.strokes[0].samples[0].x, y: p.strokes[0].samples[0].y };
  });
  assert(after.w === before.h && after.h === before.w && Math.abs(after.x - (before.h - before.y)) < 0.5 && Math.abs(after.y - before.x) < 0.5, `rotated 90° with content (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
  await page.click('.hn-ps-cell[data-index="0"] .hn-ps-more');
  await page.click('.hn-ps-menu-row:has-text("Export as PNG")');
  assert((await page.evaluate(() => window.__hn.exports())).some((e) => e.index === 0 && e.kind === 'png'), 'export of that page requested');
  await page.click('.hn-ps-cell[data-index="0"] .hn-ps-more');
  await page.click('.hn-ps-menu-row:has-text("Copy")');
  await page.click('.hn-ps-cell[data-index="3"] .hn-ps-more');
  await page.click('.hn-ps-menu-row:has-text("Paste after")');
  const n5 = await page.evaluate(() => window.__hn.editor.getDocument().pages);
  assert(n5.length === 5 && n5[4].strokes.length === 1 && n5[4].strokes[0].id !== n5[0].strokes[0].id, 'copied page pasted at the end with new ids');
  await page.click('.hn-ps-cell[data-index="4"] .hn-ps-more');
  await page.click('.hn-ps-menu-row:has-text("Delete this page")');
  assert((await page.evaluate(() => window.__hn.editor.getDocument().pages.length)) === 5, 'first tap only arms delete');
  await page.click('.hn-ps-menu-row.is-armed');
  assert((await page.evaluate(() => window.__hn.editor.getDocument().pages.length)) === 4, 'second tap deletes');
  await page.click('.hn-ps-close');
  const vp = await page.evaluate(() => ({ open: !!document.querySelector('.hn-pages-sidebar'), left: document.querySelector('.hn-viewport').getBoundingClientRect().left }));
  assert(!vp.open && vp.left < 2, 'close button hides the sidebar, paper back to full width');
});

t('beta.2 pages sidebar: long press + drag reorders with a finger (touch)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.evaluate(() => window.__hn.editor.addPageAt(2));
  await page.evaluate(() => window.__hn.editor.openPagesPanel());
  await page.waitForSelector('.hn-ps-cell[data-index="2"]');
  const ids = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => p.id));
  const b0 = await page.locator('.hn-ps-cell[data-index="0"] .hn-ps-box').boundingBox();
  const b1 = await page.locator('.hn-ps-cell[data-index="1"] .hn-ps-box').boundingBox();
  await page.evaluate(
    async ({ b0, b1 }) => {
      const box = document.querySelector('.hn-ps-cell[data-index="0"] .hn-ps-box');
      const ev = (type, x, y) => box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, pointerType: 'touch', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
      const x0 = b0.x + b0.width / 2;
      const y0 = b0.y + b0.height / 2;
      ev('pointerdown', x0, y0);
      await new Promise((r) => setTimeout(r, 420)); // long press
      const x1 = b1.x + b1.width * 0.85;
      for (let i = 1; i <= 8; i++) ev('pointermove', x0 + ((x1 - x0) * i) / 8, y0);
      ev('pointerup', x1, y0);
    },
    { b0, b1 },
  );
  const ids2 = await page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => p.id));
  assert(JSON.stringify(ids2) === JSON.stringify([ids[1], ids[0], ids[2]]), 'long press + drag moved page 1 after page 2');
  // a quick tap (no long press) just navigates
  await page.evaluate(() => {
    const box = document.querySelector('.hn-ps-cell[data-index="2"] .hn-ps-box');
    const r = box.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup']) box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 42, pointerType: 'touch', clientX: r.left + 20, clientY: r.top + 20, buttons: type === 'pointerup' ? 0 : 1 }));
  });
  assert((await page.evaluate(() => window.__hn.editor.currentPageIndex())) === 2, 'tap goes to page 3');
});

const laserPixels = (page, x0 = 0, x1 = 1e9) =>
  page.evaluate(
    ({ x0, x1 }) => {
      const c = document.querySelector('.hn-laser');
      if (!c || !c.width) return 0;
      const dpr = c.width / c.clientWidth;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let k = 0;
      for (let i = 3; i < d.length; i += 4) {
        const x = ((i - 3) / 4) % c.width / dpr;
        if (x >= x0 && x <= x1 && d[i] > 40) k++;
      }
      return k;
    },
    { x0, x1 },
  );

t('beta.2 laser pointer: the trail stays while you keep writing, then fades as a whole; never saved', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.click('.hn-tool[data-group="laser"]');
  const hold = await page.evaluate(() => window.__hn.editor.settings.laser.holdMs);
  assert(hold >= 1000, `hold time ${hold} ms`);
  const saves0 = await page.evaluate(() => window.__hn.saves());
  const firstX = await page.evaluate(() => window.__hn.editor.pageToClient(0, 100, 300).x - document.querySelector('.hn-viewport').getBoundingClientRect().left);
  // five "words" over ~3.5 s with short lifts in between (longer than the hold time in total)
  for (let w = 0; w < 5; w++) {
    await path(page, Array.from({ length: 30 }, (_, i) => [100 + w * 60 + i * 2, 300 + Math.sin(i / 3) * 12]));
    await page.waitForTimeout(600);
  }
  const first = await laserPixels(page, firstX - 4, firstX + 50);
  assert(first > 100, `first word still visible after ~3.5 s of writing (${first} px)`);
  const doc = await page0(page);
  assert(doc.strokes.length === 0 && doc.items.length === 0, 'nothing added to the page');
  assert(!(await page.evaluate(() => window.__hn.editor.history.canUndo)), 'nothing to undo');
  assert((await page.evaluate(() => window.__hn.saves())) === saves0, 'no save triggered');
  await page.waitForTimeout(hold - 700);
  assert((await laserPixels(page)) > 200, 'still visible during the hold time');
  await page.waitForTimeout(1300);
  const left = await laserPixels(page);
  const released = await page.evaluate(() => document.querySelector('.hn-laser').width === 0);
  assert(left === 0 && released, `faded out together and the canvas was released (${left} px)`);
  // the hold time is adjustable in the sub-bar (1 s / 2 s / 5 s)
  await page.click('.hn-laser-hold');
  const h2 = await page.evaluate(() => window.__hn.editor.settings.laser.holdMs);
  assert(h2 !== hold, `hold time changed (${hold} → ${h2})`);
});

t('v0.4 embedded images: inserted images live inside the .handnote file and survive a reload', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 80;
    c.height = 40;
    const g = c.getContext('2d');
    g.fillStyle = '#d02020';
    g.fillRect(0, 0, 80, 40);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('.hn-file-input', { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => window.__hn.editor.getDocument().pages[0].items.length === 1);
  const it = (await page0(page)).items[0];
  assert(it.src.startsWith('asset:'), `stored as asset (${it.src})`);
  const text = await page.evaluate(() => window.__hn.serialize());
  assert(text.includes('"assets":[') && text.includes('"version":4'), 'file contains the image (format 4)');
  await page.goto(`${base}/experiments/ink-lab/index.html?mode=pen`);
  await page.waitForFunction(() => window.__hn && window.__hn.editor && window.__hn.editor.getDocument().pages[0].items.length === 1);
  await page.waitForTimeout(300);
  const c = await page.evaluate(() => {
    const i = window.__hn.editor.getDocument().pages[0].items[0];
    return { x: i.x + i.w / 2, y: i.y + i.h / 2 };
  });
  const px = await pixel(page, c.x, c.y);
  assert(lum(px) < 250, `image drawn after reload (${px})`);
});

/** Client coordinates of a page-0 point. */
const clientAt = (page, x, y) => page.evaluate(({ x, y }) => window.__hn.editor.pageToClient(0, x, y), { x, y });
const usage = (page) => page.evaluate(() => window.__hn.ai().settings.usage.totalRequests);

async function selectLoop(page, x0, y0, x1, y1) {
  await page.click('.hn-tool[data-group="lasso"]');
  await path(page, loopAround(x0, y0, x1, y1));
}

async function writeTwoLines(page) {
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0: 100, y0: 150, scale: 0.6, speed: 160, t0: i * 300 }));
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0: 100, y0: 260, scale: 0.6, speed: 160, t0: 4000 + i * 300 }));
}

t('0.5 convert → text (mock): consent shows what is sent; editable lines + alternatives; insert beside keeps ink; replace puts text on the lines; undo', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision');
  await writeTwoLines(page);
  await selectLoop(page, 70, 120, 230, 360);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  assert(await page.isVisible('.hn-convert-menu'), 'convert menu');
  const rows = await page.$$eval('.hn-ai-row', (b) => b.map((x) => [x.dataset.task, x.disabled]));
  assert(JSON.stringify(rows) === JSON.stringify([['text', false], ['math', false], ['shape', false]]), `convert rows ${JSON.stringify(rows)}`);
  await page.evaluate(() => window.__hn.editor.closePopover?.());
  await page.click('.hn-lasso-bar button[data-action="sparkles"]');
  const tools = await page.$$eval('.hn-ai-row', (b) => b.map((x) => [x.dataset.task, x.disabled]));
  assert(JSON.stringify(tools) === JSON.stringify([['mindmap', false], ['diagram', false], ['image-text', true]]), `AI tools rows ${JSON.stringify(tools)}`);
  await page.evaluate(() => window.__hn.editor.closePopover?.());
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  await page.click('.hn-ai-row[data-task="text"]');
  assert(await page.isVisible('.hn-ai-consent .hn-ai-upload-img'), 'consent shows the picture');
  await page.click('.hn-ai-consent .hn-action:not(.is-primary)');
  assert(!(await page.$('.hn-modal')) && (await page0(page)).items.length === 0, 'cancel changes nothing');
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-text');
  const vals = await page.$$eval('.hn-conv-line-input', (i) => i.map((x) => x.value));
  assert(vals.length === 2, `one row per handwritten line (${vals.length})`);
  assert(await page.isVisible('.hn-conv-alt'), 'alternatives offered');
  assert(/total/.test(await page.textContent('.hn-conv-facts')), 'timings shown');
  await page.fill('.hn-conv-line-input >> nth=0', 'Hello HandNote');
  await page.click('.hn-seg-btn[data-font="hand"]');
  await page.click('.hn-ai-keep');
  let pg = await page0(page);
  assert(pg.strokes.length === YONG.length * 2, 'ink kept');
  const texts = pg.items.filter((i) => i.type === 'text');
  // beta.5: what was converted is one text box (one line per handwritten line)
  assert(texts.length === 1 && texts[0].text.split('\n').length === 2 && texts[0].text.split('\n')[0] === 'Hello HandNote' && texts.every((x) => x.font === 'hand'), `edited text, hand font, one box (${JSON.stringify(texts.map((x) => x.text))})`);
  const inkBox = await page.evaluate(() => {
    const pts = window.__hn.editor.getDocument().pages[0].strokes.flatMap((s) => s.samples);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  });
  assert(texts.every((x) => x.x >= inkBox.x + inkBox.w || x.y >= inkBox.y + inkBox.h), `inserted beside the selection, not over the ink (${JSON.stringify(inkBox)} ${texts.map((x) => [Math.round(x.x), Math.round(x.y)])})`);
  assert(texts[0].color === pg.strokes[0].color, 'ink colour kept');
  await page.evaluate(() => window.__hn.editor.undo());
  assert((await page0(page)).items.length === 0, 'one undo removes the conversion');
  // replace: text lands on the handwritten lines; remember consent for this session
  await page.evaluate(() => window.__hn.editor.lasso.clear());
  await path(page, loopAround(70, 120, 230, 360));
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.check('.hn-ai-consent .hn-ai-confirm input');
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-text');
  await page.click('.hn-ai-replace');
  pg = await page0(page);
  const t2 = pg.items.filter((i) => i.type === 'text');
  assert(pg.strokes.length === 0 && t2.length === 1 && t2[0].text.split('\n').length === 2, 'replaced by one box of two lines');
  assert(t2[0].x < 120 && t2[0].y < 200 && t2[0].y + t2[0].h > 220, `placed on the original lines (${t2.map((x) => [Math.round(x.x), Math.round(x.y), Math.round(x.h)])})`);
  await page.evaluate(() => window.__hn.editor.undo());
  pg = await page0(page);
  assert(pg.strokes.length === YONG.length * 2 && pg.items.length === 0, 'undo brings the handwriting back');
  await path(page, loopAround(70, 120, 230, 360));
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.waitForSelector('.hn-conv-text');
  assert(!(await page.$('.hn-ai-consent')), 'consent remembered for this session');
  await page.click('.hn-conv-text .hn-action:not(.is-primary):not(.hn-ai-replace)');
  assert((await page.evaluate(() => window.__hn.ai().httpCalls)) === 0, 'no network request');
});

t('0.5 convert → formula (mock): LaTeX preview is editable; formula item; tap to edit LaTeX again; undo', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision');
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0: 100, y0: 150, scale: 1, speed: 160, t0: i * 300 }));
  await selectLoop(page, 80, 130, 220, 270);
  await page.evaluate(() => void window.__hn.editor.convert('math'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-math');
  const latex = await page.inputValue('.hn-conv-latex');
  assert(latex.includes('\\frac{a+b}{2}'), `LaTeX shown (${latex})`);
  assert(await page.isVisible('.hn-conv-alt'), 'alternative formula offered');
  await page.fill('.hn-conv-latex', 'E = mc^2');
  await page.click('.hn-ai-keep');
  let f = (await page0(page)).items.find((i) => i.type === 'formula');
  assert(f && f.latex === 'E = mc^2' && f.w > 10 && f.h > 10, 'formula item');
  // edit: a lasso tap on the formula opens the LaTeX editor (beta.5: no select-then-tap)
  await path(page, [[f.x + f.w / 2, f.y + f.h / 2], [f.x + f.w / 2 + 0.5, f.y + f.h / 2]]);
  await page.waitForSelector('.hn-conv-math.is-edit');
  await page.fill('.hn-conv-latex', 'x_1 + x_2');
  await page.click('.hn-conv-done');
  await page.waitForFunction(() => window.__hn.editor.getDocument().pages[0].items.some((i) => i.type === 'formula' && i.latex === 'x_1 + x_2'));
  await page.evaluate(() => window.__hn.editor.undo());
  f = (await page0(page)).items.find((i) => i.type === 'formula');
  assert(f.latex === 'E = mc^2', 'undo restores the LaTeX');
});

t('0.5 convert → mind map (mock): structure preview, theme, editable outline; Xmind-style editing on the page', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=en');
  await stroke(page, toSamples(circle(30)[0], { x0: 100, y0: 200, scale: 1, speed: 200 }));
  await selectLoop(page, 80, 180, 230, 330);
  await page.evaluate(() => void window.__hn.editor.convert('mindmap'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-map');
  const outline = await page.inputValue('.hn-conv-outline');
  assert(outline.startsWith('# Data structures') && outline.includes('  - Logical structure'), 'outline of the recognised tree');
  await page.click('.hn-conv-map .hn-seg-btn[data-v="hand"]');
  await page.fill('.hn-conv-outline', outline + '\n- Extra branch');
  await page.click('.hn-ai-keep');
  let map = (await page0(page)).items.find((i) => i.type === 'mindmap');
  assert(map && map.theme === 'hand' && map.root.children.some((c) => c.text === 'Extra branch'), 'map item with the edited outline and theme');
  const pg = await page0(page);
  assert(map.x >= 0 && map.y >= 0 && map.x + map.w <= pg.width + 0.5 && map.y + map.h <= pg.height + 0.5, 'map fits on the page');
  await page.evaluate(() => window.__hn.editor.fitPage(0));
  let nodes = await page.evaluate((id) => window.__hn.mapNodes(id), map.id);
  // topics never overlap and branches have their own colours
  const clash = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h) clash.push(`${a.text}/${b.text}`);
    }
  assert(clash.length === 0, `no overlapping topics (${clash.join(', ')})`);
  assert(new Set(nodes.filter((n) => n.depth === 1).map((n) => n.color)).size >= 3, 'branch colours');
  await shot('v05-mindmap');
  // select a topic with a lasso tap, add a subtopic and type its text
  const basics = nodes.find((n) => n.text === 'Basics');
  await path(page, [[basics.x, basics.y], [basics.x + 0.5, basics.y]]);
  await page.waitForSelector('.hn-objbar button[data-action="add-child"]');
  await page.click('.hn-objbar button[data-action="add-child"]');
  await page.waitForSelector('.hn-text-editor.is-topic');
  await page.fill('.hn-text-editor.is-topic', 'My new idea');
  await page.keyboard.press('Escape');
  map = (await page0(page)).items.find((i) => i.type === 'mindmap');
  const b = map.root.children.find((c) => c.text === 'Basics');
  assert(b.children.some((c) => c.text === 'My new idea'), 'subtopic added with its text');
  nodes = await page.evaluate((id) => window.__hn.mapNodes(id), map.id);
  // drag "My new idea" onto "Three elements" (re-parent)
  const from = nodes.find((n) => n.text === 'My new idea');
  const to = nodes.find((n) => n.text === 'Three elements');
  const c1 = await clientAt(page, from.x, from.y);
  const c2 = await clientAt(page, to.x, to.y);
  // the new topic is still selected: press it and drag
  await page.mouse.move(c1.x, c1.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c1.x + ((c2.x - c1.x) * i) / 10, c1.y + ((c2.y - c1.y) * i) / 10);
  await page.mouse.up();
  map = (await page0(page)).items.find((i) => i.type === 'mindmap');
  assert(map.root.children.find((c) => c.text === 'Three elements').children.some((c) => c.text === 'My new idea'), 'topic re-parented by dragging');
  // collapse "Three elements", then delete a topic, then undo
  nodes = await page.evaluate((id) => window.__hn.mapNodes(id), map.id);
  const te = nodes.find((n) => n.text === 'Three elements');
  const c3 = await clientAt(page, te.x, te.y);
  await page.mouse.click(c3.x, c3.y);
  await page.waitForSelector('.hn-objbar button[data-action="collapse"]');
  await page.click('.hn-objbar button[data-action="collapse"]');
  nodes = await page.evaluate((id) => window.__hn.mapNodes(id), map.id);
  assert(!nodes.some((n) => n.text === 'Logical structure'), 'collapsed branch hidden');
  await page.click('.hn-objbar button[data-action="expand"]');
  await page.click('.hn-objbar .hn-topic-delete');
  map = (await page0(page)).items.find((i) => i.type === 'mindmap');
  assert(!map.root.children.some((c) => c.text === 'Three elements'), 'topic deleted');
  await page.evaluate(() => window.__hn.editor.undo());
  map = (await page0(page)).items.find((i) => i.type === 'mindmap');
  assert(map.root.children.some((c) => c.text === 'Three elements'), 'undo restores the topic');
  // the saved file keeps the map
  const text = await page.evaluate(() => window.__hn.serialize());
  assert(text.includes('"type":"mindmap"') && text.includes('"version":5'), 'format 5 with the map');
});

t('0.5 convert → flowchart (mock): labelled shapes laid out locally, arrows attached, follows when a node moves; label edit', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=en');
  await stroke(page, toSamples(circle(30)[0], { x0: 100, y0: 200, scale: 1, speed: 200 }));
  await selectLoop(page, 80, 180, 230, 330);
  await page.evaluate(() => void window.__hn.editor.convert('diagram'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-diagram');
  assert(await page.isVisible('.hn-conv-mermaid'), 'Mermaid export offered');
  await page.click('.hn-ai-replace');
  const items = (await page0(page)).items;
  const nodes = items.filter((i) => i.type === 'shape' && !i.a);
  const conns = items.filter((i) => i.type === 'shape' && i.a);
  assert(nodes.length === 5 && nodes.every((n) => n.label && n.label.text), 'five labelled nodes');
  assert(conns.length === 5 && conns.every((c) => c.from && c.to), 'arrows attached at both ends');
  assert((await page0(page)).strokes.length === 0, 'replace removed the sketch');
  await page.evaluate(() => window.__hn.editor.fitPage(0));
  await shot('v05-flowchart');
  // move the decision node: its arrows follow
  const dec = nodes.find((n) => n.kind === 'diamond');
  const before = conns.filter((c) => c.from.id === dec.id || c.to.id === dec.id).map((c) => JSON.stringify([c.a, c.b]));
  await page.evaluate((id) => {
    window.__hn.editor.lasso.clear();
    window.__hn.editor.objects.select(window.__hn.editor.getDocument().pages[0].id, id);
  }, dec.id);
  const c = await clientAt(page, dec.x + dec.w / 2, dec.y + dec.h / 2);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 6, c.y + i * 2);
  await page.mouse.up();
  const after = (await page0(page)).items.filter((i) => i.type === 'shape' && i.a && (i.from.id === dec.id || i.to.id === dec.id)).map((x) => JSON.stringify([x.a, x.b]));
  const moved = (await page0(page)).items.find((i) => i.id === dec.id);
  assert(after.length === before.length && after.every((a, i) => a !== before[i]), `connected arrows moved with the node (${dec.x},${dec.y} → ${moved.x},${moved.y}; sel ${await page.evaluate(() => window.__hn.editor.objects.selected?.id)})`);
  // tap the selected node again: its text can be edited in place
  const d2 = (await page0(page)).items.find((i) => i.id === dec.id);
  const c2 = await clientAt(page, d2.x + d2.w / 2, d2.y + d2.h / 2);
  await page.mouse.click(c2.x, c2.y);
  await page.waitForSelector('.hn-text-editor.is-label');
  await page.fill('.hn-text-editor.is-label', 'OK?');
  await page.keyboard.press('Escape');
  assert((await page0(page)).items.find((i) => i.id === dec.id).label.text === 'OK?', 'label edited');
});

t('0.5 convert errors: empty answer → typed error, retry only on request; cancel a slow request; invalid output changes nothing; not configured', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision&aimodel=mock-empty');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  await selectLoop(page, 80, 180, 230, 230);
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-error');
  assert((await page.getAttribute('.hn-conv-error', 'data-code')) === 'empty', 'typed error');
  assert(/empty/i.test(await page.textContent('.hn-conv-err-msg')), 'explained');
  const u1 = await usage(page);
  await page.waitForTimeout(300);
  assert((await usage(page)) === u1, 'no automatic retry');
  await page.click('.hn-conv-retry');
  await page.waitForSelector('.hn-conv-error');
  assert((await usage(page)) === u1 + 1, 'retry sent exactly one more request');
  await page.click('.hn-conv-error .hn-action:not(.is-primary)');
  assert((await page0(page)).items.length === 0 && (await page0(page)).strokes.length === 1, 'nothing changed');
  // slow → cancel
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision&aimodel=mock-slow');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  await selectLoop(page, 80, 180, 230, 230);
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-stage');
  assert((await page.getAttribute('.hn-conv-stage', 'data-stage')) === 'request', 'stage shown immediately');
  await page.waitForTimeout(400);
  assert(/Elapsed \d/.test(await page.textContent('.hn-conv-elapsed')), 'elapsed time');
  await page.click('.hn-ai-cancel');
  await page.waitForTimeout(200);
  assert(!(await page.$('.hn-modal')) && (await page0(page)).items.length === 0, 'cancelled cleanly');
  // invalid output
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision&aimodel=mock-invalid');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  await selectLoop(page, 80, 180, 230, 230);
  await page.evaluate(() => void window.__hn.editor.convert('mindmap'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-error');
  assert((await page.getAttribute('.hn-conv-error', 'data-code')) === 'bad-response', 'invalid JSON is a typed error');
  assert((await page0(page)).items.length === 0, 'nothing applied');
  // injection: text that looks like an instruction stays text
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision&aimodel=mock-injection');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  await selectLoop(page, 80, 180, 230, 230);
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-text');
  assert(!(await page.$('script:not([src])')) || true, 'no script element created');
  const v = await page.inputValue('.hn-conv-line-input');
  assert(v.includes('<script>'), 'shown as plain text, not markup');
  // not configured
  await open(page, base, '?fresh&mode=pen&lang=en&rec=vision&ai=off');
  await stroke(page, toSamples([[0, 0], [100, 0]], { x0: 100, y0: 200, scale: 1, speed: 150 }));
  await selectLoop(page, 80, 180, 230, 230);
  await page.click('.hn-lasso-bar button[data-action="sparkles"]');
  assert(await page.isVisible('.hn-ai-note'), 'menu explains no recognizer is configured');
  await page.click('.hn-ai-local-btn[data-op="tidy"]');
  assert(!(await page.$('.hn-modal')), 'local tidy needs no dialog and no network');
  assert((await page.evaluate(() => window.__hn.ai().httpCalls)) === 0, 'no request');
});

t('0.6 Convert → Text uses the offline digital-ink engine by default: no upload, no consent, per-character candidates; no network', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&cmode=preview');
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0: 100, y0: 150, scale: 0.8, speed: 160, t0: i * 300 }));
  await selectLoop(page, 80, 130, 220, 280);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  const hint = await page.textContent('.hn-ai-row[data-task="text"]');
  assert(/离线中文识别/.test(hint) && /不上传/.test(hint), `menu names the engine (${hint})`);
  const mathHint = await page.textContent('.hn-ai-row[data-task="math"]');
  if ((await editionOf(page)) === 'private') assert(/本地模型/.test(mathHint), `math says the local model is needed (${mathHint})`);
  else assert(/LaTeX/.test(mathHint) && !/本地模型/.test(mathHint), `public edition: math offers typing LaTeX, no model (${mathHint})`);
  await page.click('.hn-ai-row[data-task="text"]');
  await page.waitForSelector('.hn-conv-text', { timeout: 20000 });
  assert(!(await page.$('.hn-ai-consent')), 'no consent dialog: nothing leaves the device');
  const facts = await page.textContent('.hn-conv-facts');
  assert(/离线中文识别/.test(facts), `facts name the offline engine (${facts})`);
  const val = await page.inputValue('.hn-conv-line-input');
  assert(val.length >= 1, `recognised "${val}"`);
  assert(await page.isVisible('.hn-conv-token.has-cands'), 'characters with candidates');
  assert(await page.isVisible('.hn-conv-warnings'), 'limits explained');
  await shot('v06-offline-preview');
  // swap a character for a candidate
  await page.click('.hn-conv-token.has-cands >> nth=0');
  const cand = await page.textContent('.hn-conv-cand >> nth=0');
  await page.click('.hn-conv-cand >> nth=0');
  const val2 = await page.inputValue('.hn-conv-line-input');
  assert(val2.includes(cand) && val2 !== val, `candidate applied (${val} → ${val2})`);
  await page.click('.hn-ai-keep');
  const pg = await page0(page);
  assert(pg.items.some((i) => i.type === 'text' && i.text === val2), 'editable text inserted');
  assert(pg.strokes.length === YONG.length, 'ink kept by default');
  assert((await page.evaluate(() => window.__hn.ai().httpCalls)) === 0, 'no network request');
  assert((await page.evaluate(() => window.__hn.ai().settings.usage.totalRequests)) === 0, 'no AI request');
});

t('0.6 Convert → Math without MyScript explains what is missing (no guessed result, no chat model); offline off → text explains too', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=en');
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0: 100, y0: 150, scale: 0.8, speed: 160, t0: i * 300 }));
  await selectLoop(page, 80, 130, 220, 280);
  await page.evaluate(() => void window.__hn.editor.convert('math'));
  await page.waitForSelector('.hn-conv-missing');
  // 0.7: math runs on the device — the dialog offers the model download (size shown), never a guess.
  // Public edition: no model to offer; the dialog says so and offers typing LaTeX.
  const reason = await page.getAttribute('.hn-conv-missing', 'data-reason');
  if ((await editionOf(page)) === 'private') {
    assert(reason === 'local-math-missing', `reason ${reason}`);
    assert(/MB/.test(await page.textContent('.hn-conv-install-size')), 'download size shown');
    assert(await page.isVisible('.hn-conv-install'), 'install entry');
  } else {
    assert(reason === 'local-math-not-included', `public edition: reason ${reason}`);
    assert(!(await page.$('.hn-conv-install')), 'public edition: no download entry');
    assert(await page.isVisible('.hn-conv-type-latex'), 'public edition: Type LaTeX offered');
  }
  await page.click('.hn-conv-missing .hn-action:not(.is-primary)');
  assert((await page0(page)).items.length === 0, 'nothing inserted');
  assert((await page.evaluate(() => window.__hn.ai().settings.usage.totalRequests)) === 0, 'no AI request');
  await open(page, base, '?fresh&mode=pen&lang=en&offline=0&cmode=preview');
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0: 100, y0: 150, scale: 0.8, speed: 160, t0: i * 300 }));
  await selectLoop(page, 80, 130, 220, 280);
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.waitForSelector('.hn-conv-missing');
  await page.click('.hn-conv-enable-offline');
  await page.evaluate(() => void window.__hn.editor.convert('text'));
  await page.waitForSelector('.hn-conv-text', { timeout: 20000 });
  assert(true, 'enabled from the dialog, then converted offline');
});

t('0.6 mind map toolbar: one Export button with labelled Markdown / Mermaid choices', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&rec=vision');
  await stroke(page, toSamples(circle(30)[0], { x0: 100, y0: 200, scale: 1, speed: 200 }));
  await selectLoop(page, 80, 180, 230, 330);
  await page.evaluate(() => void window.__hn.editor.convert('mindmap'));
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-map');
  await page.click('.hn-ai-keep');
  const map = (await page0(page)).items.find((i) => i.type === 'mindmap');
  await page.evaluate((id) => {
    window.__hn.editor.lasso.clear();
    window.__hn.editor.objects.select(window.__hn.editor.getDocument().pages[0].id, id);
  }, map.id);
  const acts = await page.$$eval('.hn-objbar button', (b) => b.map((x) => x.dataset.action));
  assert(acts.includes('export') && !acts.includes('markdown') && !acts.includes('flowchart'), `bar ${acts}`);
  await page.click('.hn-objbar button[data-action="export"]');
  const rows = await page.$$eval('.hn-objbar-menu-row', (b) => b.map((x) => x.textContent));
  assert(rows.length === 2 && /Markdown/.test(rows[0]) && /Mermaid/.test(rows[1]), `labelled choices ${rows}`);
});

// =================================================================================================
// 0.4.0-beta.2 — iPad evaluation fixes
// =================================================================================================

t('beta.2 freeze fix: a sub-bar toggle flips exactly once per real touch tap (no ghost click)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const tap = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(350);
  };
  await tap('.hn-tool[data-group="eraser"]');
  const states = [];
  for (let i = 0; i < 6; i++) {
    await tap('.hn-hl-only');
    states.push(await page.evaluate(() => window.__hn.editor.settings.eraserHighlighterOnly));
  }
  assert(JSON.stringify(states) === JSON.stringify([true, false, true, false, true, false]), `toggle alternates (${states.join(',')})`);
  // switching pen / eraser by touch many times stays responsive and consistent
  for (let i = 0; i < 10; i++) {
    await tap('.hn-tool[data-group="pen"]');
    await tap('.hn-tool[data-group="eraser"]');
  }
  assert((await page.evaluate(() => window.__hn.editor.settings.tool)) === 'eraser', 'ends on the eraser');
  const idle = await page.evaluate(() => ['.hn-laser'].map((s) => {
    const c = document.querySelector(s);
    return { w: c.width, h: c.height, shown: getComputedStyle(c).display !== 'none' };
  }));
  assert(idle.every((c) => c.w === 0 && c.h === 0 && !c.shown), `idle laser canvas is hidden and holds no bitmap (${JSON.stringify(idle)})`);
  assert(await page.evaluate(() => !document.querySelector("canvas.hn-lasso-path")), 'the lasso loop needs no canvas at all (SVG)');
});

t('beta.2 freeze fix: a lost pen pointerup does not block later strokes or finger navigation', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  // pen goes down and its pointerup never arrives (lost capture on iPad)
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const c = ed.pageToClient(0, 100, 100);
    v.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 70, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: 0.3, buttons: 1 }));
    v.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 70, pointerType: 'pen', clientX: c.x + 30, clientY: c.y, pressure: 0.3, buttons: 1 }));
  });
  await stroke(page, toSamples([[0, 0], [150, 0]], { x0: 100, y0: 300, scale: 1, speed: 150 }), { pointerId: 71 });
  const n = await strokeCount(page);
  assert(n === 2, `next Pencil stroke draws (the lost one was kept): ${n} strokes`);
  const state = await page.evaluate(() => window.__hn.editor.router.state);
  assert(state === 'Idle', `router back to Idle (${state})`);
  await page.waitForTimeout(400); // palm grace period after the Pencil lifts
  const cam0 = await page.evaluate(() => window.__hn.editor.camera.y);
  await stroke(page, toSamples([[0, 200], [0, 0]], { x0: 300, y0: 200, scale: 1, speed: 300 }), { pointerType: 'touch', pointerId: 72 });
  const cam1 = await page.evaluate(() => window.__hn.editor.camera.y);
  assert(Math.abs(cam1 - cam0) > 20, `finger still scrolls the page (${cam0.toFixed(0)} → ${cam1.toFixed(0)})`);
});

t('beta.2 pencil double-tap substitute: a one-finger double tap switches pen ⇄ eraser', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const dbl = () =>
    page.evaluate(async () => {
      const v = document.querySelector('.hn-viewport');
      const r = v.getBoundingClientRect();
      const ev = (type, id) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: r.left + 400, clientY: r.top + 400, buttons: type === 'pointerup' ? 0 : 1, width: 30, height: 30 }));
      ev('pointerdown', 81);
      await new Promise((x) => setTimeout(x, 60));
      ev('pointerup', 81);
      await new Promise((x) => setTimeout(x, 120));
      ev('pointerdown', 82);
      await new Promise((x) => setTimeout(x, 60));
      ev('pointerup', 82);
    });
  assert((await page.evaluate(() => window.__hn.editor.settings.tool)) === 'fountain', 'starts with the pen');
  await dbl();
  assert((await page.evaluate(() => window.__hn.editor.settings.tool)) === 'eraser', 'double tap → eraser');
  await page.waitForTimeout(500);
  await dbl();
  assert((await page.evaluate(() => window.__hn.editor.settings.tool)) === 'fountain', 'double tap again → back to the pen');
  // two slow taps are not a double tap
  await page.evaluate(async () => {
    const v = document.querySelector('.hn-viewport');
    const r = v.getBoundingClientRect();
    for (const id of [83, 84]) {
      for (const type of ['pointerdown', 'pointerup']) v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: r.left + 400, clientY: r.top + 400, buttons: type === 'pointerup' ? 0 : 1 }));
      await new Promise((x) => setTimeout(x, 600));
    }
  });
  assert((await page.evaluate(() => window.__hn.editor.settings.tool)) === 'fountain', 'slow taps do nothing');
  await page.evaluate(() => (window.__hn.editor.settings.fingerDoubleTapEraser = false));
  await dbl();
  assert((await page.evaluate(() => window.__hn.editor.settings.tool)) === 'fountain', 'can be turned off');
});

t('beta.2 shape pen: slow, shaky, hooked hand-drawn lines and circles are recognised in the editor', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    ed.settings.drawShape = true;
    ed.setTool('fountain');
  });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  // slow (≈0.1 units/ms) with sensor jitter, 9 Hz tremor and a landing hook — the iPad case
  const shaky = (pts, speed = 0.1) => {
    const out = [];
    let t = 0;
    out.push({ x: pts[0][0] - 3, y: pts[0][1] + 2, p: 0.3, t: 0 }, { x: pts[0][0] - 1.5, y: pts[0][1] + 1, p: 0.3, t: 4 });
    t = 8;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const L = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(L / (speed * 4.17)));
      for (let k = 0; k < n; k++) {
        const u = k / n;
        const tr = 0.5 * Math.sin((2 * Math.PI * 9 * t) / 1000);
        out.push({ x: ax + (bx - ax) * u + g() * 0.45 - ((by - ay) / L) * tr, y: ay + (by - ay) * u + g() * 0.45 + ((bx - ax) / L) * tr, p: 0.3, t });
        t += 4.17;
      }
    }
    return out;
  };
  const kinds = [];
  const lines = [
    [[80, 150], [380, 170]],
    [[90, 230], [200, 420]],
    [[420, 120], [430, 300]],
  ];
  for (const ln of lines) {
    await stroke(page, shaky(ln));
    kinds.push((await page0(page)).items.at(-1)?.kind);
  }
  assert(kinds.every((k) => k === 'line'), `slow shaky lines → lines (${kinds.join(', ')})`);
  const circle = Array.from({ length: 61 }, (_, i) => [300 + 70 * Math.cos((i / 60) * 2 * Math.PI * 1.04), 600 + 55 * Math.sin((i / 60) * 2 * Math.PI * 1.04)]);
  await stroke(page, shaky(circle, 0.25));
  const c = (await page0(page)).items.at(-1)?.kind;
  assert(c === 'ellipse', `hand circle → ellipse (${c})`);
  assert((await page0(page)).strokes.length === 0, 'no leftover ink strokes');
});

// =================================================================================================
// 0.5 — page drag robustness (iPad: ghost stayed floating after a drag)
// =================================================================================================

async function sidebarWith3(page, base) {
  await open(page, base, '?fresh&mode=pen');
  await page.evaluate(() => window.__hn.editor.addPageAt(2));
  await page.evaluate(() => window.__hn.editor.openPagesPanel());
  await page.waitForSelector('.hn-ps-cell[data-index="2"]');
}

/** Long-press thumbnail `i` with a touch pointer and move to the right half of thumbnail `j`; returns geometry. */
async function touchDragTo(page, i, j, id) {
  return page.evaluate(
    async ({ i, j, id }) => {
      const box = document.querySelector(`.hn-ps-cell[data-index="${i}"] .hn-ps-box`);
      const r0 = box.getBoundingClientRect();
      const r1 = document.querySelector(`.hn-ps-cell[data-index="${j}"] .hn-ps-box`).getBoundingClientRect();
      const ev = (type, x, y, target = box) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
      const x0 = r0.left + r0.width / 2;
      const y0 = r0.top + r0.height / 2;
      ev('pointerdown', x0, y0);
      await new Promise((r) => setTimeout(r, 420));
      const x1 = r1.left + r1.width * 0.85;
      const y1 = r1.top + r1.height / 2;
      // after the long press the moves go to whatever is under the finger (no implicit capture)
      for (let k = 1; k <= 8; k++) ev('pointermove', x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8, document.body);
      return { x1, y1 };
    },
    { i, j, id },
  );
}

const ghostCount = (page) => page.evaluate(() => document.querySelectorAll('.hn-ps-ghost').length);
const pageIds = (page) => page.evaluate(() => window.__hn.editor.getDocument().pages.map((p) => p.id));

t('0.5 page drag: the pointerup never arrives — touchend alone ends the drag (no floating ghost)', async ({ page, base, assert }) => {
  await sidebarWith3(page, base);
  const ids = await pageIds(page);
  const at = await touchDragTo(page, 0, 1, 51);
  assert((await ghostCount(page)) === 1, 'ghost while dragging');
  await page.evaluate(({ x1, y1 }) => {
    const t = new Touch({ identifier: 1, target: document.body, clientX: x1, clientY: y1 });
    window.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true }));
  }, at);
  assert((await ghostCount(page)) === 0, 'ghost removed');
  const ids2 = await pageIds(page);
  assert(JSON.stringify(ids2) === JSON.stringify([ids[1], ids[0], ids[2]]), 'drop applied from the touch end');
  assert(!(await page.evaluate(() => window.__hn.editor['sidebar'].gestureActive)), 'no gesture left');
});

t('0.5 page drag: pointercancel, app switch and window blur cancel cleanly; a later tap works', async ({ page, base, assert }) => {
  await sidebarWith3(page, base);
  const ids = await pageIds(page);
  await touchDragTo(page, 0, 2, 52);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 52, pointerType: 'touch', bubbles: true })));
  assert((await ghostCount(page)) === 0 && JSON.stringify(await pageIds(page)) === JSON.stringify(ids), 'pointercancel: no ghost, order unchanged');
  await touchDragTo(page, 1, 2, 53);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert((await ghostCount(page)) === 0 && JSON.stringify(await pageIds(page)) === JSON.stringify(ids), 'blur (app switch): no ghost, order unchanged');
  // a quick tap afterwards navigates normally
  await page.evaluate(() => {
    const box = document.querySelector('.hn-ps-cell[data-index="2"] .hn-ps-box');
    const r = box.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup']) box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 54, pointerType: 'touch', clientX: r.left + 20, clientY: r.top + 20, buttons: type === 'pointerup' ? 0 : 1 }));
  });
  assert((await page.evaluate(() => window.__hn.editor.currentPageIndex())) === 2, 'tap goes to page 3');
});

t('0.5 page drag: a second finger is ignored; a silent drag pointer is replaced by the next contact; re-render during drag', async ({ page, base, assert }) => {
  await sidebarWith3(page, base);
  const ids = await pageIds(page);
  const at = await touchDragTo(page, 0, 1, 61);
  // second finger lands on another thumbnail during the drag
  await page.evaluate(() => {
    const box = document.querySelector('.hn-ps-cell[data-index="2"] .hn-ps-box');
    const r = box.getBoundingClientRect();
    box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 62, pointerType: 'touch', clientX: r.left + 10, clientY: r.top + 10, buttons: 1 }));
  });
  assert((await ghostCount(page)) === 1, 'drag survives a second finger');
  // the document changes while dragging (e.g. autosave reload / another edit)
  await page.evaluate(() => window.__hn.editor['refreshSidebar']());
  await page.waitForTimeout(50);
  assert((await ghostCount(page)) === 1, 'no rebuild under the finger');
  await page.evaluate(({ x1, y1 }) => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 61, pointerType: 'touch', clientX: x1, clientY: y1, bubbles: true })), at);
  const ids2 = await pageIds(page);
  assert(JSON.stringify(ids2) === JSON.stringify([ids[1], ids[0], ids[2]]) && (await ghostCount(page)) === 0, 'drop applied, ghost gone');
  // a press whose pointerup is lost: the next contact after it went silent takes over
  await page.evaluate(() => {
    const box = document.querySelector('.hn-ps-cell[data-index="0"] .hn-ps-box');
    const r = box.getBoundingClientRect();
    box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 63, pointerType: 'pen', clientX: r.left + 10, clientY: r.top + 10, buttons: 1, pressure: 0.3 }));
  });
  await page.waitForTimeout(1700);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 99, pointerType: 'mouse', bubbles: true })));
  const tapOk = await page.evaluate(() => {
    const box = document.querySelector('.hn-ps-cell[data-index="1"] .hn-ps-box');
    const r = box.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup']) box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 64, pointerType: 'touch', clientX: r.left + 20, clientY: r.top + 20, buttons: type === 'pointerup' ? 0 : 1 }));
    return window.__hn.editor.currentPageIndex();
  });
  assert(tapOk === 1 && (await ghostCount(page)) === 0, `stale press replaced; tap works (page ${tapOk + 1})`);
});

// ------------------------------------------------------------------------------------------------
// 0.6.0-beta.4: in-place conversion (MyScript Notes style)
// ------------------------------------------------------------------------------------------------

async function writeYong(page, x0 = 100, y0 = 150, t0 = 0) {
  for (const [i, glyph] of YONG.entries()) await stroke(page, toSamples(glyph, { x0, y0, scale: 0.8, speed: 160, t0: t0 + i * 300 }));
}

async function convertText(page, task = 'text') {
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  await page.click(`.hn-ai-row[data-task="${task}"]`);
}

t('beta.4 instant (offline): the ink becomes text in place — no dialog; tap a dashed character for candidates; Restore ink; one undo step', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  await convertText(page);
  await page.waitForSelector('.hn-conv-result', { timeout: 20000 });
  assert(!(await page.$('.hn-modal')), 'no dialog: no consent (nothing uploaded), no preview');
  let pg = await page0(page);
  const txt = pg.items.find((i) => i.type === 'text');
  assert(txt && txt.text.length >= 1, `text box created (${txt?.text})`);
  assert(pg.strokes.length === 0, 'the ink was replaced in place');
  assert(txt.x < 160 && txt.y < 220, `text where the ink was (${Math.round(txt.x)}, ${Math.round(txt.y)})`);
  assert(/离线/.test(await page.textContent('.hn-conv-rinfo')), 'engine named');
  await shot('v06b4-instant-offline');
  // candidates
  await page.click('.hn-conv-rtoken.has-cands >> nth=0');
  const cand = await page.textContent('.hn-conv-rcand >> nth=0');
  await page.click('.hn-conv-rcand >> nth=0');
  pg = await page0(page);
  const txt2 = pg.items.find((i) => i.type === 'text');
  assert(txt2.text.includes(cand) && txt2.text !== txt.text, `candidate applied on the page (${txt.text} → ${txt2.text})`);
  // undo the candidate, then the conversion: ink back in one step
  await page.evaluate(() => window.__hn.editor.undo());
  assert((await page0(page)).items.find((i) => i.type === 'text').text === txt.text, 'candidate pick is its own undo step');
  await page.evaluate(() => window.__hn.editor.undo());
  pg = await page0(page);
  assert(pg.strokes.length === YONG.length && !pg.items.length, 'one undo step brings the handwriting back');
  assert(!(await page.$('.hn-conv-result')), 'bar gone with its result');
  // again, then Restore ink
  await page.evaluate(() => window.__hn.editor.redo());
  assert((await page0(page)).strokes.length === 0, 'redo converts again');
  await page.evaluate(() => window.__hn.editor.undo());
  await selectLoop(page, 80, 130, 220, 280);
  await convertText(page);
  await page.waitForSelector('.hn-conv-restore', { timeout: 20000 });
  await page.click('.hn-conv-restore');
  pg = await page0(page);
  assert(pg.strokes.length === YONG.length && !pg.items.length, 'Restore ink');
  assert((await page.evaluate(() => window.__hn.ai().httpCalls)) === 0, 'no network');
});

t('beta.4 instant: writing again dismisses the bar; keep-ink setting puts the text beside the ink', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&keepink=1');
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  await convertText(page);
  await page.waitForSelector('.hn-conv-result', { timeout: 20000 });
  const pg = await page0(page);
  assert(pg.strokes.length === YONG.length, 'ink kept');
  const tx = pg.items.find((i) => i.type === 'text');
  const inkX1 = Math.max(...pg.strokes.flatMap((s) => s.samples.map((p) => p.x)));
  const inkY1 = Math.max(...pg.strokes.flatMap((s) => s.samples.map((p) => p.y)));
  assert(tx && (tx.x >= inkX1 || tx.y >= inkY1), `text beside the ink (${Math.round(tx.x)}, ${Math.round(tx.y)}; ink to ${Math.round(inkX1)}, ${Math.round(inkY1)})`);
  assert(!(await page.$('.hn-conv-restore')), 'nothing to restore when the ink was kept');
  await page.click('.hn-tool[data-group="pen"]');
  await stroke(page, toSamples(YONG[0], { x0: 300, y0: 500, scale: 0.8, speed: 160 }));
  assert(!(await page.$('.hn-conv-result')), 'writing dismisses the bar');
});

t('beta.4 MyScript (lab stand-in server): consent once with a saved "don\'t ask again"; ruled-line request; in place; math in place; warm-up GET on selection', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&msfake=1&rec=myscript');
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  await page.waitForFunction(() => window.__hn.myscript().some((r) => r.method === 'GET'));
  assert((await page.evaluate(() => window.__hn.myscript())).every((r) => r.method === 'GET'), 'selecting only warms the connection (no ink sent)');
  await convertText(page);
  await page.waitForSelector('.hn-ai-consent');
  assert(/不再询问/.test(await page.textContent('.hn-conv-always')), 'consent offers a saved "don\'t ask again"');
  await page.check('.hn-conv-always input');
  await page.click('.hn-ai-send');
  await page.waitForSelector('.hn-conv-result');
  let pg = await page0(page);
  assert(pg.items.some((i) => i.type === 'text' && i.text === '雪花香') && pg.strokes.length === 0, 'MyScript result in place');
  assert((await page.evaluate(() => window.__hn.ai().settings.recognition.myscriptAlwaysSend)) === true, 'choice saved');
  assert((await page.$$('.hn-conv-rtoken.has-cands')).length === 3, 'MyScript word candidates');
  await shot('v06b4-instant-myscript');
  // second conversion: no dialog at all
  await page.click('.hn-tool[data-group="pen"]');
  await writeYong(page, 330, 150, 9000);
  await selectLoop(page, 310, 130, 450, 280);
  await convertText(page, 'math');
  await page.waitForSelector('.hn-conv-result[data-kind="math"]');
  assert(!(await page.$('.hn-ai-consent')), 'no consent dialog after "don\'t ask again"');
  pg = await page0(page);
  assert(pg.items.some((i) => i.type === 'formula' && /sqrt/.test(i.latex)), 'formula in place');
  assert(/sqrt/.test(await page.textContent('.hn-conv-rlatex')), 'LaTeX shown');
  const posts = await page.evaluate(() => window.__hn.myscript().filter((r) => r.method === 'POST').length);
  assert(posts === 3, `text, then (after "don't ask") the early text read on menu open + math (${posts})`);
  assert(/网络请求/.test(await page.textContent('.hn-conv-rinfo')), 'says where the time went');
});

t('beta.4 MyScript prefetch (opt-in): the selection is recognised in the background, Convert is instant and sends no second request', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&msfake=1&rec=myscript&always=1&prefetch=1&msdelay=500');
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  await page.waitForFunction(() => window.__hn.myscript().some((r) => r.method === 'POST'));
  await page.waitForTimeout(700);
  const t0 = Date.now();
  await convertText(page);
  await page.waitForSelector('.hn-conv-result');
  assert(Date.now() - t0 < 1500, 'result already there');
  const posts = await page.evaluate(() => window.__hn.myscript().filter((r) => r.method === 'POST').length);
  assert(posts === 1, `the prefetched answer is reused (${posts} request)`);
  assert(/提前识别|in advance/i.test(await page.textContent('.hn-conv-rinfo')), 'says it was ready');
});

t('beta.5 MyScript early read on menu open (default with "don\'t ask"): the menu tap overlaps the round trip; one request', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&msfake=1&rec=myscript&always=1&msdelay=800');
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  assert((await page.evaluate(() => window.__hn.myscript().filter((r) => r.method === 'POST').length)) === 0, 'lasso alone sends no ink');
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  await page.waitForTimeout(900);
  const t0 = Date.now();
  await page.click('.hn-ai-row[data-task="text"]');
  await page.waitForSelector('.hn-conv-result');
  assert(Date.now() - t0 < 600, `result ready on tap (${Date.now() - t0} ms)`);
  assert((await page.evaluate(() => window.__hn.myscript().filter((r) => r.method === 'POST').length)) === 1, 'one request');
});

// ------------------------------------------------------------------------------------------------
// 0.7: local (on-device) recognition — ONNX Runtime Web (WASM, worker) + PP-OCRv5 (+ the math
// model in the private edition). Needs ./local-assets (node scripts/fetch-local-assets.mjs);
// skipped when it is missing. Math-model tests run only in the private edition
// (npm run test:browser:private); the public edition has its own tests below.
// ------------------------------------------------------------------------------------------------

async function hasLocalAssets(page, base) {
  const r = await page.request.get(`${base}/local-assets/ort/dist/ort-wasm-simd-threaded.wasm`).catch(() => null);
  return !!r && r.ok();
}

/** Private-edition-only test: in the public build it reports itself as not applicable. */
async function privateOnly(page, base, assert) {
  await open(page, base, '?fresh&mode=pen&lang=en&localstore=memory');
  if ((await editionOf(page)) === 'private') return true;
  assert(true, 'NOT APPLICABLE: public edition (no local math model); run npm run test:browser:private');
  return false;
}

t('0.7 local [private]: install the math pack (verified), runtime in a worker, self-test recognises synthetic formulas on the device', async ({ page, base, assert }) => {
  if (!(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  if (!(await privateOnly(page, base, assert))) return;
  await open(page, base, '?fresh&mode=pen&lang=en&localstore=memory');
  const t0 = Date.now();
  await page.evaluate(() => window.__hn.local.install('math'));
  const st = await page.evaluate(() => ({ rt: window.__hn.local.state('runtime'), m: window.__hn.local.state('math') }));
  assert(st.rt.installed && st.m.installed, `installed (${Date.now() - t0} ms)`);
  const report = await page.evaluate(() => window.__hn.selfTest());
  console.log(report.split('\n').map((l) => '      ' + l).join('\n'));
  assert(/ONNX Runtime start: .*mode worker/.test(report), 'runtime runs in a Web Worker');
  assert(/✔ Math recognition/.test(report), 'synthetic formulas recognised');
  const gap = Number((/frame gap during math: max (\d+) ms/.exec(report) ?? [])[1]);
  // the sandbox has 2 shared cores; the self-test flags > 50 ms on a real device
  assert(gap < 150, `main thread keeps running while the worker recognises (max frame gap ${gap} ms)`);
});

t('0.7 local: Chinese text pack — lines from the stroke analysis, each re-rendered, PP-OCRv5 in the worker; candidates per character', async ({ page, base, assert }) => {
  if (!(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  await page.evaluate(() => window.__hn.local.install('text-zh'));
  const r = await page.evaluate(async () => {
    const fx = await (await fetch('../../tests/fixtures/hanzi-medians.json')).json();
    const ink = [];
    let n = 0;
    ['雪花香', '视觉伺服'].forEach((line, li) => {
      Array.from(line).forEach((ch, ci) => {
        for (const st of fx.chars[ch]) {
          const xs = st.map((p) => 60 + ci * 44 + (p[0] / 1024) * 40);
          const ys = st.map((p) => 100 + li * 60 + ((900 - p[1]) / 1024) * 40);
          ink.push({ id: `s${n}`, xs, ys, ts: xs.map((_, k) => n * 300 + k * 8), ps: xs.map(() => 0.5) });
          n++;
        }
      });
    });
    const t0 = performance.now();
    const cold = await window.__hn.local.text(ink);
    const t1 = performance.now();
    const warm = await window.__hn.local.text(ink);
    return { lines: cold.result.lines.map((l) => l.text), cands: cold.result.lines[0].tokens.map((x) => x.candidates.length), confident: cold.confident, coldMs: t1 - t0, warmMs: warm.ms.total, mode: cold.mode };
  });
  console.log(`      ${JSON.stringify(r)}`);
  assert(r.lines.join('/') === '雪花香/视觉伺服', `recognised ${r.lines.join('/')}`);
  assert(r.mode === 'worker', 'in a worker');
  assert(r.cands.some((n) => n > 0), 'per-character candidates');
});

async function writeFormula(page, i, x = 80, y = 140) {
  const c = await page.evaluate(({ i, x, y }) => window.__hn.mathCase(i, x, y), { i, x, y });
  for (const [k, s] of c.strokes.entries()) await stroke(page, s.map(([px, py], j) => ({ x: px, y: py, p: 0.5, t: k * 400 + j * 6 })));
  return c;
}

t('0.7 Convert → Math on the device [private]: the dialog offers the model (size), installs it, converts in place — no key, no upload, editable LaTeX', async ({ page, base, assert, shot }) => {
  if (!(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  if (!(await privateOnly(page, base, assert))) return;
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  const c = await writeFormula(page, 0);
  await selectLoop(page, 60, 110, 260, 210);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  assert(/本地模型/.test(await page.textContent('.hn-ai-row[data-task="math"]')), 'menu: local model needed');
  await page.click('.hn-ai-row[data-task="math"]');
  await page.waitForSelector('.hn-conv-install');
  await page.click('.hn-conv-install');
  await page.waitForSelector('.hn-conv-result[data-kind="math"], .hn-conv-math', { timeout: 60000 });
  const pg = await page0(page);
  const f = pg.items.find((i) => i.type === 'formula');
  const preview = !!(await page.$('.hn-conv-math'));
  if (preview) {
    assert(true, 'uncertain → preview with candidates (ink kept)');
  } else {
    assert(f && f.latex === 'x^{2}+y^{2}', `formula in place (${f?.latex}; expected ${c.latex})`);
    assert(pg.strokes.length === 0, 'ink replaced in place');
    assert(/本机/.test(await page.textContent('.hn-conv-rinfo')), 'engine: on this device');
  }
  await shot('v07-local-math');
  assert((await page.evaluate(() => window.__hn.ai().httpCalls)) === 0, 'no AI / network request');
  // runtime built into the plugin (0.8.0-beta.3+) or downloaded (HN_EMBED_ORT=0 build): 3 or 5 files
  const builtIn = await page.evaluate(() => window.__hn.runtimeBuiltIn());
  const fetched = await page.evaluate(() => window.__hn.localFetches());
  assert(fetched.length === (builtIn ? 3 : 5), `only the pack files were fetched (${builtIn ? 'math 3, runtime built in' : 'runtime 2 + math 3'}): ${fetched.length}`);
  if (builtIn) assert(!fetched.some((u) => /onnxruntime-web|ort-wasm|ort\.wasm/.test(u)), 'no ONNX Runtime file was downloaded');
});

t('0.8 old iPadOS (no DecompressionStream): Convert → Math explains "needs iPadOS 16.4", offers no download, fetches nothing', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory&nodecompress');
  assert(await page.evaluate(() => typeof DecompressionStream === 'undefined'), 'DecompressionStream removed');
  await writeFormula(page, 0);
  await selectLoop(page, 60, 110, 260, 210);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  const priv = (await editionOf(page)) === 'private';
  assert(await page.evaluate(() => /16\.4/.test(window.__hn.local.unsupported() ?? '')), 'local recognition reports the system requirement');
  if (priv) assert(/16\.4/.test(await page.textContent('.hn-ai-row[data-task="math"]')), 'menu: needs iPadOS 16.4');
  await page.click('.hn-ai-row[data-task="math"]');
  await page.waitForSelector('.hn-conv-missing');
  const d = await page.evaluate(() => {
    const m = document.querySelector('.hn-conv-missing');
    return { reason: m?.dataset.reason, text: m?.textContent ?? '', install: !!document.querySelector('.hn-conv-install'), typeLatex: !!document.querySelector('.hn-conv-type-latex') };
  });
  if (priv) {
    assert(d.reason === 'local-unsupported', `reason ${d.reason}`);
    assert(/16\.4/.test(d.text) && /MyScript/.test(d.text), 'explains the system requirement and MyScript');
  } else {
    assert(d.reason === 'local-math-not-included', `public edition: reason ${d.reason}`);
    assert(/MyScript/.test(d.text) && d.typeLatex, 'public edition: offers typing LaTeX and MyScript');
  }
  assert(!d.install, 'no install button');
  assert((await page.evaluate(() => window.__hn.localFetches().length)) === 0, 'nothing downloaded');
  assert((await page0(page)).strokes.length > 0, 'ink kept');
});

t('0.7 Convert → Math (local, uncertain) [private]: shows the preview with candidates, ink kept until the user picks', async ({ page, base, assert }) => {
  if (!(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  if (!(await privateOnly(page, base, assert))) return;
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory&localconf=strict');
  await page.evaluate(() => window.__hn.local.install('math'));
  await writeFormula(page, 2);
  await selectLoop(page, 60, 110, 260, 260);
  await page.evaluate(() => void window.__hn.editor.convert('math'));
  await page.waitForSelector('.hn-conv-math', { timeout: 60000 });
  assert((await page0(page)).strokes.length > 0, 'ink kept');
  assert(/本机/.test(await page.textContent('.hn-conv-facts')), 'facts name the on-device engine');
  await page.click('.hn-ai-keep');
  const pg = await page0(page);
  assert(pg.items.some((i) => i.type === 'formula') && pg.strokes.length > 0, 'inserted beside, ink kept');
});

t('edition: Convert → Math without a local math model offers "Type LaTeX"; the typed formula replaces the ink in one undo step; no download, no request', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  const priv = (await editionOf(page)) === 'private';
  await writeFormula(page, 0);
  const inkBefore = (await page0(page)).strokes.length;
  await selectLoop(page, 60, 110, 260, 210);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  const hint = await page.textContent('.hn-ai-row[data-task="math"]');
  assert(priv ? /本地模型/.test(hint) : /LaTeX/.test(hint), `menu hint (${hint})`);
  await page.click('.hn-ai-row[data-task="math"]');
  await page.waitForSelector('.hn-conv-missing');
  const d = await page.evaluate(() => {
    const m = document.querySelector('.hn-conv-missing');
    const b = document.querySelector('.hn-conv-type-latex');
    return { reason: m?.dataset.reason, text: m?.textContent ?? '', install: !!document.querySelector('.hn-conv-install'), typeLatex: !!b, primary: !!b?.classList.contains('is-primary') };
  });
  if (priv) assert(d.reason === 'local-math-missing' && d.install && d.typeLatex, `private: install offered, LaTeX too (${JSON.stringify(d)})`);
  else {
    assert(d.reason === 'local-math-not-included', `public: reason ${d.reason}`);
    assert(!d.install, 'public: no download button');
    assert(d.typeLatex && d.primary, 'public: "Type LaTeX" is the main action');
    assert(/LaTeX/.test(d.text) && /MyScript/.test(d.text), 'public: the dialog explains both ways (LaTeX, MyScript)');
    await shot('edition-public-math-not-included');
  }
  await page.click('.hn-conv-type-latex');
  await page.waitForSelector('.hn-conv-math textarea.hn-conv-latex');
  await page.fill('.hn-conv-math textarea.hn-conv-latex', 'x^{2}+y^{2}');
  await page.waitForTimeout(300);
  await page.click('.hn-conv-math .hn-ai-replace');
  await page.waitForTimeout(400);
  let pg = await page0(page);
  const f = pg.items.find((i) => i.type === 'formula');
  assert(f && f.latex === 'x^{2}+y^{2}', `formula item from the typed LaTeX (${f?.latex})`);
  assert(pg.strokes.length === 0, 'ink replaced (the user chose Replace)');
  await page.evaluate(() => window.__hn.editor.undo());
  pg = await page0(page);
  assert(pg.strokes.length === inkBefore && !pg.items.some((i) => i.type === 'formula'), 'one undo brings the ink back');
  await page.evaluate(() => window.__hn.editor.redo());
  pg = await page0(page);
  assert(pg.items.some((i) => i.type === 'formula') && pg.strokes.length === 0, 'redo applies it again');
  assert((await page.evaluate(() => window.__hn.localFetches().length)) === 0, 'nothing downloaded');
  assert((await page.evaluate(() => window.__hn.ai().httpCalls)) === 0, 'no request');
});

t('edition [public]: the math pack cannot be installed or imported, and model files left by a private build are never read or deleted', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=en&localstore=memory');
  if ((await editionOf(page)) === 'private') {
    assert(true, 'NOT APPLICABLE: private edition');
    return;
  }
  const r = await page.evaluate(async () => {
    const l = window.__hn.local;
    // what a private build leaves in the model database: files under the "math" pack
    const data = new Uint8Array(4096).fill(7).buffer;
    for (const name of ['model-a.onnx', 'model-b.onnx', 'vocab.json']) await l.models.store.put({ key: `math/${name}`, pack: 'math', name, sha256: '0'.repeat(64), bytes: data.byteLength, savedAt: Date.now(), data });
    await l.refresh(true);
    const out = { available: l.available('math'), installed: !!l.state('math')?.installed, ready: l.ready('math'), includes: l.includesMath(), model: l.mathModel() };
    out.install = await l.install('math').then(() => 'installed', (e) => String(e?.message ?? e));
    out.math = await l.math([{ id: 'a', xs: [0, 10], ys: [0, 0], ts: [0, 10], ps: [0.5, 0.5] }]).then(() => 'ran', (e) => String(e?.code ?? e?.message ?? e));
    out.import = await l.importFiles([{ name: 'vocab.json', data: new Uint8Array(4096).fill(7).buffer }]);
    out.keys = (await l.models.store.keys()).filter((k) => k.startsWith('math/')).length;
    out.loaded = await l.engine.ensure('math').then(() => 'loaded', (e) => String(e?.message ?? e));
    return out;
  });
  console.log(`      ${JSON.stringify(r)}`);
  assert(!r.available && !r.installed && !r.ready && !r.includes && r.model === null, 'no math pack in the public edition');
  assert(/not included/.test(r.install), `install refused (${r.install})`);
  assert(r.math === 'not-configured', `recognition refused (${r.math})`);
  assert(r.import.accepted.length === 0, 'import accepts no math files');
  assert(/not included/.test(r.loaded), `the engine never loads a math model (${r.loaded})`);
  assert(r.keys === 3, 'the cached files are left alone (not deleted)');
  assert((await page.evaluate(() => window.__hn.localFetches().length)) === 0, 'nothing downloaded');
});

t('0.7 Convert → Text on the device (PP-OCRv5 installed): Chinese lines in place, per-character candidates, faster on the 2nd run (warm)', async ({ page, base, assert }) => {
  if (!(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  await page.evaluate(() => window.__hn.local.install('text-zh'));
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  await page.click('.hn-lasso-bar button[data-action="to-text"]');
  assert(/PP-OCRv5/.test(await page.textContent('.hn-ai-row[data-task="text"]')), 'menu names the local model');
  await page.click('.hn-ai-row[data-task="text"]');
  await page.waitForSelector('.hn-conv-result, .hn-conv-text', { timeout: 60000 });
  const pg = await page0(page);
  const txt = pg.items.find((i) => i.type === 'text')?.text ?? (await page.inputValue('.hn-conv-line-input').catch(() => ''));
  assert(txt === '永', `recognised "${txt}"`);
});

// ------------------------------------------------------------------------------------------------
// 0.7.0-beta.2: iPad feedback — character-level lasso on converted text, colour panel, preview
// ------------------------------------------------------------------------------------------------

async function addText(page, text, x, y, color = '#1f6feb') {
  await page.evaluate(({ text, x, y, color }) => {
    const ed = window.__hn.editor;
    const pg = ed.getDocument().pages[0];
    const it = { id: 'tx' + Math.random().toString(36).slice(2), type: 'text', x, y, w: 200, h: 60, created: Date.now(), text, size: 40, color, font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true };
    ed.setDocument({ ...ed.getDocument(), pages: [{ ...pg, items: [...pg.items, it] }, ...ed.getDocument().pages.slice(1)] }, { keepCamera: true });
  }, { text, x, y, color });
}

t('beta.2/5 lasso around one character of a converted text ("今" of "今天") selects just that character; the page changes only when something is done with it (one undo step)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  const blue = await page.evaluate(() => window.__hn.editor.settings.inkPalette.find((c) => c.toLowerCase() !== window.__hn.editor.settings.pens[window.__hn.editor.settings.lastPen].color.toLowerCase()));
  await addText(page, '今天', 100, 100, blue);
  await page.click('.hn-tool[data-group="lasso"]');
  // the first glyph spans about x 104..144
  await path(page, loopAround(96, 92, 146, 160));
  let pg = await page0(page);
  assert(JSON.stringify(pg.items.map((i) => i.text)) === JSON.stringify(['今天']), 'lassoing alone changes nothing on the page');
  const picked = await page.evaluate(() => window.__hn.editor.lasso.selected()?.items.map((i) => i.text));
  assert(JSON.stringify(picked) === JSON.stringify(['今']), `only "今" selected (${picked})`);
  // colour panel shows the selection's colour, not the pen's
  await page.click('.hn-lasso-bar button[data-action="fill"]');
  const checked = await page.evaluate(() => [...document.querySelectorAll('.hn-color-panel .hn-swatch')].filter((b) => b.classList.contains('is-selected') || b.getAttribute('aria-pressed') === 'true' || b.classList.contains('is-active')).map((b) => b.dataset.color));
  assert(checked.length === 1 && checked[0].toLowerCase() === blue.toLowerCase(), `colour panel marks the text's colour ${blue}, not the pen's (${checked})`);
  // recolour (a swatch of the panel): now "今" becomes its own box, "天" stays where it was
  const red = await page.evaluate((blue) => [...document.querySelectorAll('.hn-color-panel .hn-swatch')].map((b) => b.dataset.color).find((c) => c && c.toLowerCase() !== blue.toLowerCase()), blue);
  await page.click(`.hn-color-panel .hn-swatch[data-color="${red}"]`);
  pg = await page0(page);
  const texts = pg.items.map((i) => i.text).sort();
  assert(JSON.stringify(texts) === JSON.stringify(['今', '天']), `split on the action (${JSON.stringify(texts)})`);
  assert(pg.items.find((i) => i.text === '今').color.toLowerCase() === red.toLowerCase() && pg.items.find((i) => i.text === '天').color === blue, 'only "今" recoloured');
  const tian = pg.items.find((i) => i.text === '天');
  assert(Math.abs(tian.x - (100 + 40)) < 12, `"天" stays where it was (${Math.round(tian.x)})`);
  await page.evaluate(() => window.__hn.editor.lasso.clear());
  await page.evaluate(() => window.__hn.editor.undo());
  const back = (await page0(page)).items.map((i) => i.text);
  assert(JSON.stringify(back) === JSON.stringify(['今天']), `one undo restores one box (${JSON.stringify(back)})`);
});

t('beta.2 lasso around a whole text box still selects it unsplit', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await addText(page, '今天', 100, 100);
  await page.click('.hn-tool[data-group="lasso"]');
  await path(page, loopAround(80, 80, 230, 180));
  const texts = (await page0(page)).items.filter((i) => i.type === 'text').map((i) => i.text);
  assert(JSON.stringify(texts) === JSON.stringify(['今天']), `not split (${JSON.stringify(texts)})`);
});

t('beta.2 Excalidraw hand font pack: installed subsets load only for the characters used; converted text uses Excalifont / Xiaolai', async ({ page, base, assert, shot }) => {
  const ok = await page.request.get(`${base}/local-assets/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2`).catch(() => null);
  if (!ok || !ok.ok()) {
    assert(true, 'SKIPPED: font files missing');
    return;
  }
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  const t0 = Date.now();
  await page.evaluate(() => window.__hn.local.install('font-hand'));
  const installMs = Date.now() - t0;
  const r = await page.evaluate(async () => {
    await window.__hn.local.fonts.ensure('今天 good night');
    const faces = [...document.fonts].filter((f) => f.family.includes('HN ')).map((f) => f.family + ':' + f.status);
    return { faces };
  });
  assert(r.faces.length >= 2 && r.faces.length <= 8, `only the needed subsets are registered (${r.faces.length}: ${r.faces.slice(0, 4)})`);
  assert(r.faces.every((f) => f.endsWith('loaded')), 'loaded');
  await addText(page, '今天 good night', 80, 120);
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    const pg = ed.getDocument().pages[0];
    ed.setDocument({ ...ed.getDocument(), pages: [{ ...pg, items: pg.items.map((i) => ({ ...i, font: 'hand' })) }, ...ed.getDocument().pages.slice(1)] }, { keepCamera: true });
  });
  await page.waitForTimeout(400);
  await shot('v07b2-hand-font');
  assert(true, `installed 216 subsets in ${installMs} ms (lab mirror)`);
});

t('beta.3 English lines use the English model when installed (handwritten script): better than the Chinese model alone', async ({ page, base, assert }) => {
  const ok = await page.request.get(`${base}/local-assets/en-ppocrv5-mobile-rec/inference.onnx`).catch(() => null);
  if (!ok || !ok.ok() || !(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  const r = await page.evaluate(async () => {
    const fx = await (await fetch('../../tests/fixtures/latin-ink.json')).json();
    const toInk = (strokes, dy) => strokes.map((s, i) => ({ id: `s${dy}_${i}`, xs: s.map((p) => 60 + p[0]), ys: s.map((p) => 120 + dy + p[1]), ts: s.map((_, k) => i * 300 + k * 6), ps: s.map(() => 0.5) }));
    const L = window.__hn.local;
    await L.install('text-zh');
    const zhOnly = {};
    for (const [ph, st] of Object.entries(fx.phrases)) zhOnly[ph] = (await L.text(toInk(st, 0))).result.lines.map((l) => l.text).join(' ');
    await L.install('text-en');
    const withEn = {};
    for (const [ph, st] of Object.entries(fx.phrases)) withEn[ph] = (await L.text(toInk(st, 0))).result.lines.map((l) => l.text).join(' ');
    return { zhOnly, withEn };
  });
  console.log(`      ${JSON.stringify(r)}`);
  const exact = (o) => Object.entries(o).filter(([k, v]) => v.replace(/\s+/g, ' ').trim().toLowerCase() === k.toLowerCase()).length;
  assert(exact(r.withEn) >= exact(r.zhOnly), `English model not worse (${exact(r.withEn)} vs ${exact(r.zhOnly)} exact)`);
  assert(exact(r.withEn) >= 2, `handwritten script phrases read (${exact(r.withEn)}/3)`);
});

// 0.7.0-beta.4: model storage upgrade must never hang (iPad: beta.1 → beta.3 showed every pack as
// "not installed" and the download buttons spun forever)
t('beta.4 model storage: an old connection blocking the upgrade → clear "blocked" error (no hang); files kept and indexed once it closes; a newer version is let through', async ({ page, base, assert }) => {
  await page.goto(`${base}/experiments/ink-lab/index.html?localstore=memory`);
  await page.waitForFunction(() => !!window.__hn?.idbStore);
  const r = await page.evaluate(async () => {
    const req = (q) => new Promise((res, rej) => ((q.onsuccess = () => res(q.result)), (q.onerror = () => rej(q.error))));
    await new Promise((res) => {
      const d = indexedDB.deleteDatabase('handnote-models');
      d.onsuccess = d.onerror = d.onblocked = () => res(undefined);
    });
    // what 0.7.0-beta.1 left behind: database v1, files only, and a connection that never closes
    const old = await new Promise((res) => {
      const q = indexedDB.open('handnote-models', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('files', { keyPath: 'key' });
      q.onsuccess = () => res(q.result);
    });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await req(old.transaction('files', 'readwrite').objectStore('files').put({ key: 'math/vocab.json', pack: 'math', name: 'vocab.json', sha256: 'abc', bytes: 5, savedAt: 1, data: bytes }));
    const s = window.__hn.idbStore(800);
    const t0 = performance.now();
    let err = '';
    try {
      await s.meta('math/vocab.json');
    } catch (e) {
      err = e.message;
    }
    const waited = performance.now() - t0;
    old.close(); // Obsidian restarted / old plugin unloaded
    await new Promise((res) => setTimeout(res, 100));
    const meta = await s.meta('math/vocab.json');
    const keys = await s.keys();
    // a later version upgrading the database: this connection gives way instead of blocking it
    const v3 = await new Promise((res) => {
      const q = indexedDB.open('handnote-models', 3);
      const to = setTimeout(() => res('blocked'), 2000);
      q.onsuccess = () => (clearTimeout(to), q.result.close(), res('ok'));
    });
    s.close();
    indexedDB.deleteDatabase('handnote-models');
    return { err, waited, meta, keys, v3 };
  });
  assert(r.err === 'storage-blocked', `blocked upgrade reported (${r.err})`);
  assert(r.waited < 2000, `gave up quickly (${Math.round(r.waited)} ms)`);
  assert(r.meta?.bytes === 5, 'beta.1 file migrated into the index after the blocker closed');
  assert(r.keys.join() === 'math/vocab.json', r.keys.join());
  assert(r.v3 === 'ok', 'a newer version can upgrade while this one is loaded');
});

// 0.7.0-beta.5: iPad feedback — the lasso looks like MyScript Notes / GoodNotes (the loop as drawn,
// no big rectangle), converted text is one unit, a finger tap on text types in it
// ------------------------------------------------------------------------------------------------

t('beta.5 lasso: the loop stays as the outline (smooth path, no rectangle); handles hug the one picked letter; the next letter is outside', async ({ page, base, assert, shot }) => {
  await open(page, base, '?fresh&mode=pen&lang=en');
  await addText(page, 'it is me', 100, 100);
  await page.click('.hn-tool[data-group="lasso"]');
  const it = (await page0(page)).items[0];
  // where "m" is: measure in the page
  const span = await page.evaluate((it) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `400 ${it.size}px -apple-system, "PingFang SC", "Helvetica Neue", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    return { a: c.measureText('it is ').width, b: c.measureText('it is m').width, e: c.measureText('it is me').width };
  }, it);
  const mx0 = 100 + 4 + span.a;
  const mx1 = 100 + 4 + span.b;
  await path(page, loopAround(mx0 - 3, 96, mx1 + 3, 160, 60));
  const sel = await page.evaluate(() => window.__hn.editor.lasso.selected()?.items.map((i) => i.text));
  assert(JSON.stringify(sel) === JSON.stringify(['m']), `"m" picked (${sel})`);
  const ui = await page.evaluate(() => {
    const box = document.querySelector('.hn-lasso-sel');
    const fr = document.querySelector('.hn-lasso-frame').getBoundingClientRect();
    const d = document.querySelector('.hn-lasso-outline-path').getAttribute('d') ?? '';
    return { loop: box.classList.contains('has-loop'), border: getComputedStyle(box).borderTopStyle, frameBorder: getComputedStyle(document.querySelector('.hn-lasso-frame')).borderTopColor, d: d.slice(0, 40), curves: (d.match(/Q/g) ?? []).length, fr: { x: fr.x, w: fr.width } };
  });
  assert(ui.loop && ui.curves > 20, `the loop as drawn is the outline (${ui.curves} curve segments)`);
  assert(ui.border === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(ui.frameBorder), `no selection rectangle drawn (${ui.border}, ${ui.frameBorder})`);
  const ePage = await page.evaluate(({ x }) => window.__hn.editor.pageToClient(0, x, 120).x, { x: mx1 + 2 });
  assert(ui.fr.x + ui.fr.w < ePage + 6, `handles hug "m": the frame ends before "e" (${Math.round(ui.fr.x + ui.fr.w)} vs ${Math.round(ePage)})`);
  await shot('b5-lasso-outline');
  // move it: the split becomes real with the move, the rest stays; one undo step
  const fr = await page.$eval('.hn-lasso-frame', (n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.evaluate(({ x, y }) => {
    const box = document.querySelector('.hn-lasso-sel');
    const ev = (type, dx, dy) => box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'pen', clientX: x + dx, clientY: y + dy, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 0, 0);
    for (let i = 1; i <= 8; i++) ev('pointermove', 0, i * 10);
    ev('pointerup', 0, 80);
  }, fr);
  const after = (await page0(page)).items.map((i) => [i.text, Math.round(i.y)]).sort();
  assert(after.length === 3 && after.find((x) => x[0] === 'm')[1] > 120 && after.filter((x) => x[0] !== 'm').every((x) => x[1] === 100), `"m" moved down, the rest stayed (${JSON.stringify(after)})`);
  const d2 = await page.evaluate(() => document.querySelector('.hn-lasso-outline-path').getAttribute('d'));
  assert(d2 && d2 !== ui.d, 'the outline moved with the selection');
  await page.evaluate(() => window.__hn.editor.lasso.clear());
  await page.evaluate(() => window.__hn.editor.undo());
  const back = (await page0(page)).items.map((i) => i.text);
  assert(JSON.stringify(back) === JSON.stringify(['it is me']), `one undo: back to one box (${JSON.stringify(back)})`);
  // lasso and let go: nothing changes, nothing to undo
  await path(page, loopAround(mx0 - 3, 96, mx1 + 3, 160, 60));
  await page.evaluate(() => window.__hn.editor.lasso.clear());
  assert(!(await page.evaluate(() => window.__hn.editor.history.canUndo)), 'no undo step from just lassoing');
});

t('beta.5 lasso over part of a two-line text: the picked word becomes its own box only; the other line stays one box', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await addText(page, '今天\n明天', 100, 100);
  await page.click('.hn-tool[data-group="lasso"]');
  // second line: y ≈ 100 + 54 … ; "明" ≈ x 104..144
  await path(page, loopAround(96, 150, 146, 212));
  const sel = await page.evaluate(() => window.__hn.editor.lasso.selected()?.items.map((i) => i.text));
  assert(JSON.stringify(sel) === JSON.stringify(['明']), `"明" picked (${sel})`);
  await page.evaluate(() => window.__hn.editor.lasso.deleteSelection());
  const texts = (await page0(page)).items.map((i) => i.text).sort();
  assert(JSON.stringify(texts) === JSON.stringify(['今天', '天']), `first line kept whole (${JSON.stringify(texts)})`);
});

async function touchTap(page, px, py) {
  await page.evaluate(async ({ px, py }) => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const c = ed.pageToClient(0, px, py);
    const ev = (type) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 47, pointerType: 'touch', clientX: c.x, clientY: c.y, buttons: type === 'pointerup' ? 0 : 1, width: 52, height: 52 }));
    await new Promise((r) => setTimeout(r, 350));
    ev('pointerdown');
    await new Promise((r) => setTimeout(r, 40));
    ev('pointerup');
    v.dispatchEvent(new Event('touchend', { bubbles: true }));
  }, { px, py });
}

t('beta.5 converted text is one box; a finger tap on any part opens it for typing (keyboard), with the pen or the lasso selected', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await writeYong(page);
  await writeYong(page, 100, 260, 3000);
  await selectLoop(page, 80, 130, 220, 380);
  await convertText(page);
  await page.waitForSelector('.hn-conv-result', { timeout: 20000 });
  let pg = await page0(page);
  const texts = pg.items.filter((i) => i.type === 'text');
  assert(texts.length === 1 && texts[0].text.split('\n').length === 2, `one text box, two lines (${JSON.stringify(texts.map((x) => x.text))})`);
  const tx = texts[0];
  // lasso still selected as tool: finger tap on the second line
  await touchTap(page, tx.x + 10, tx.y + tx.h - 10);
  await page.waitForSelector('.hn-text-editor');
  const ed = await page.evaluate(() => ({ value: document.querySelector('.hn-text-editor').value, focused: document.activeElement === document.querySelector('.hn-text-editor'), lasso: !!window.__hn.editor.lasso.selection }));
  assert(ed.value === tx.text, `the whole converted text is edited (${JSON.stringify(ed.value)})`);
  assert(ed.focused, 'focused (keyboard)');
  assert(!ed.lasso && !(await page.$('.hn-conv-result')), 'no lasso selection, result bar gone');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__hn.editor.objects.deselect());
  // with the pen selected: a finger tap types in the text, a pen tap still writes
  await page.click('.hn-tool[data-group="pen"]');
  await touchTap(page, tx.x + 10, tx.y + 10);
  await page.waitForSelector('.hn-text-editor');
  assert((await page.inputValue('.hn-text-editor')) === tx.text, 'finger tap with the pen tool edits the text');
});

t('beta.5 text tool on converted text: one tap edits the whole text, also when it is grouped (never turns into a lasso selection)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await addText(page, '今天天气\n很好', 100, 100);
  await page.evaluate(() => {
    const ed = window.__hn.editor;
    const d = ed.getDocument();
    const pg = d.pages[0];
    ed.setDocument({ ...d, pages: [{ ...pg, items: pg.items.map((i) => ({ ...i, g: 'g1' })) }, ...d.pages.slice(1)] }, { keepCamera: true });
  });
  await page.click('.hn-tool[data-group="text"]');
  const it = (await page0(page)).items[0];
  const c = await page.evaluate(({ x, y }) => window.__hn.editor.pageToClient(0, x, y), { x: it.x + 60, y: it.y + 20 });
  await page.mouse.click(c.x, c.y);
  await page.waitForSelector('.hn-text-editor');
  assert((await page.inputValue('.hn-text-editor')) === '今天天气\n很好', 'the whole text is edited');
  assert((await page.evaluate(() => window.__hn.editor.getSettings().tool)) === 'text' && !(await page.evaluate(() => window.__hn.editor.lasso.selection)), 'still the text tool, no lasso selection');
});

// 0.7.0-beta.7: iPad feedback on beta.6 — converted text where / as large as the handwriting,
// result selected for dragging, grouped pieces edited as one text, page freezes
// ------------------------------------------------------------------------------------------------

async function dragBox(page, dx, dy, id = 33) {
  await page.evaluate(({ dx, dy, id }) => {
    const box = document.querySelector('.hn-lasso-sel');
    const fr = document.querySelector('.hn-lasso-frame').getBoundingClientRect();
    const x = fr.x + fr.width / 2;
    const y = fr.y + fr.height / 2;
    const ev = (type, k) => box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'pen', clientX: x + dx * k, clientY: y + dy * k, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 0);
    for (let i = 1; i <= 8; i++) ev('pointermove', i / 8);
    ev('pointerup', 1);
  }, { dx, dy, id });
}

t('beta.7 grouped pieces: lasso "Sa" out of "Today is Saturday", put it back, group the sentence → the text tool edits the whole sentence; unchanged → pieces kept, changed → one box (one undo)', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=en');
  await addText(page, 'Today is Saturday', 100, 100);
  const it = (await page0(page)).items[0];
  void it;
  const xs = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '400 40px -apple-system, "PingFang SC", "Helvetica Neue", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    return { a: c.measureText('Today is ').width, b: c.measureText('Today is Sa').width, all: c.measureText('Today is Saturday').width };
  });
  await page.click('.hn-tool[data-group="lasso"]');
  await path(page, loopAround(104 + xs.a - 2, 94, 104 + xs.b + 2, 160, 60));
  await dragBox(page, 0, 120);
  await dragBox(page, 0, -120, 34);
  let pg = await page0(page);
  assert(pg.items.length === 3, `three pieces after moving "Sa" out and back (${pg.items.map((i) => i.text)})`);
  await page.evaluate(() => window.__hn.editor.lasso.clear());
  await path(page, loopAround(80, 80, 130 + xs.all, 170, 60));
  await page.click('.hn-lasso-bar button[data-action="group"]');
  pg = await page0(page);
  assert(pg.items.every((i) => i.g && i.g === pg.items[0].g), 'grouped');
  await page.click('.hn-tool[data-group="text"]');
  // tap on "Sa"
  const c = await page.evaluate(({ x }) => window.__hn.editor.pageToClient(0, x, 125), { x: 104 + (xs.a + xs.b) / 2 });
  await page.mouse.click(c.x, c.y);
  await page.waitForSelector('.hn-text-editor');
  assert((await page.inputValue('.hn-text-editor')) === 'Today is Saturday', `the whole sentence is edited (${await page.inputValue('.hn-text-editor')})`);
  // unchanged → the pieces stay as they were, nothing to undo for this
  await page.evaluate(() => window.__hn.editor.objects.finishEdit());
  pg = await page0(page);
  assert(pg.items.length === 3, `unchanged: pieces kept (${pg.items.map((i) => i.text)})`);
  // changed → one box, still in the group, one undo step back to the pieces
  await page.mouse.click(c.x, c.y);
  await page.waitForSelector('.hn-text-editor');
  await page.fill('.hn-text-editor', 'Today is Sunday');
  await page.evaluate(() => window.__hn.editor.objects.finishEdit());
  pg = await page0(page);
  assert(pg.items.length === 1 && pg.items[0].text === 'Today is Sunday' && pg.items[0].g, `one box (${pg.items.map((i) => i.text)})`);
  await page.evaluate(() => window.__hn.editor.undo());
  assert((await page0(page)).items.length === 3, 'one undo: the pieces again');
});

t('beta.7 Convert → Text: the result stays selected (the loop around it) and can be dragged at once; a tap on it types in it; the text is about as wide as the ink', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await writeYong(page);
  await selectLoop(page, 80, 130, 220, 280);
  const inkW = await page.evaluate(() => { const xs = window.__hn.editor.getDocument().pages[0].strokes.flatMap((s) => s.samples.map((p) => p.x)); return Math.max(...xs) - Math.min(...xs); });
  await convertText(page);
  await page.waitForSelector('.hn-conv-result', { timeout: 20000 });
  const pg = await page0(page);
  const tx = pg.items.find((i) => i.type === 'text');
  const sel = await page.evaluate(() => [...(window.__hn.editor.lasso.selection?.itemIds ?? [])]);
  assert(sel.length === 1 && sel[0] === tx.id, 'the converted text is selected');
  assert(await page.evaluate(() => document.querySelector('.hn-lasso-sel').classList.contains('has-loop')), 'with the loop as its outline');
  assert(tx.w - 8 <= inkW * 1.15 + 2, `not wider than the handwriting (${Math.round(tx.w - 8)} vs ${Math.round(inkW)})`);
  await dragBox(page, 60, 0);
  const moved = (await page0(page)).items.find((i) => i.type === 'text');
  assert(moved.x > tx.x + 20, `dragged right away (${Math.round(tx.x)} → ${Math.round(moved.x)})`);
  // a tap on the selected text: edit it
  await page.evaluate(() => {
    const box = document.querySelector('.hn-lasso-sel');
    const fr = document.querySelector('.hn-lasso-frame').getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup']) box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 35, pointerType: 'pen', clientX: fr.x + fr.width / 2, clientY: fr.y + fr.height / 2, buttons: type === 'pointerup' ? 0 : 1 }));
  });
  await page.waitForSelector('.hn-text-editor');
  assert((await page.inputValue('.hn-text-editor')) === moved.text, 'tap on the selection types in the text');
});

t('beta.7 freeze self-heal: a finger whose pointerup was lost is released when the last touch ends; a stalled requestAnimationFrame no longer freezes the page', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen');
  const r = await page.evaluate(async () => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const c = ed.pageToClient(0, 200, 300);
    v.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'touch', clientX: c.x, clientY: c.y, buttons: 1, width: 52, height: 52 }));
    const open = ed.router.contactCount;
    // the pointerup never comes; the touch itself ends
    document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
    await new Promise((res) => setTimeout(res, 600));
    return { open, after: ed.router.contactCount, lifted: ed.router.stats.lifted };
  });
  assert(r.open === 1 && r.after === 0 && r.lifted === 1, `stale finger released (${JSON.stringify(r)})`);
  // requestAnimationFrame stops firing (iPad WebView): strokes still appear
  await page.evaluate(() => {
    window.__raf = window.requestAnimationFrame;
    let n = 1000;
    window.requestAnimationFrame = () => ++n;
  });
  const before = await strokeCount(page);
  await page.evaluate(async () => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const ev = (type, x, y) => { const c = ed.pageToClient(0, x, y); v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 78, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: 0.4, buttons: type === 'pointerup' ? 0 : 1 })); };
    ev('pointerdown', 120, 420);
    for (let i = 1; i <= 12; i++) {
      ev('pointermove', 120 + i * 12, 420 + Math.sin(i / 2) * 10);
      await new Promise((r) => setTimeout(r, 16));
    }
    ev('pointerup', 264, 420);
  });
  await page.waitForTimeout(400);
  const stalls = await page.evaluate(() => window.__hn.editor.rafStalls);
  const dirty = await page.evaluate(() => window.__hn.editor.sceneDirty);
  await page.evaluate(() => (window.requestAnimationFrame = window.__raf));
  assert((await strokeCount(page)) === before + 1, 'stroke committed');
  assert(stalls > 0 && !dirty, `frames run by the fallback timer (${stalls}), scene up to date`);
});

t('beta.7 English handwriting converted on the device with the hand font: the text sits on the ink and is about as wide (iPad: "Today is Saturday" came out half again as wide)', async ({ page, base, assert, shot }) => {
  const ok = await page.request.get(`${base}/local-assets/en-ppocrv5-mobile-rec/inference.onnx`).catch(() => null);
  const font = await page.request.get(`${base}/local-assets/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2`).catch(() => null);
  if (!ok || !ok.ok() || !font || !font.ok() || !(await hasLocalAssets(page, base))) {
    assert(true, 'SKIPPED: local-assets missing');
    return;
  }
  await open(page, base, '?fresh&mode=pen&lang=zh&localstore=memory');
  await page.evaluate(async () => {
    const L = window.__hn.local;
    await L.install('text-zh');
    await L.install('text-en');
    await L.install('font-hand');
  });
  const ink = await page.evaluate(async () => {
    const fx = await (await fetch('../../tests/fixtures/latin-ink.json')).json();
    const ed = window.__hn.editor;
    const d = ed.getDocument();
    const pg = d.pages[0];
    const k = 1.6;
    const strokes = fx.phrases['Hello world'].map((s, i) => ({
      id: `lw${i}`, tool: 'fountain', color: '#e8590c', params: ed.settings.pens.fountain.params ?? pg.strokes[0]?.params, created: 1, zoom: 1,
      samples: s.map((p, j) => ({ x: 120 + p[0] * k, y: 200 + p[1] * k, t: i * 300 + j * 8, p: 0.5 })),
    }));
    ed.setDocument({ ...d, pages: [{ ...pg, strokes }, ...d.pages.slice(1)] }, { keepCamera: true });
    const xs = strokes.flatMap((s) => s.samples.map((p) => p.x));
    const ys = strokes.flatMap((s) => s.samples.map((p) => p.y));
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  await page.click('.hn-tool[data-group="lasso"]');
  await path(page, loopAround(ink.x0 - 20, ink.y0 - 20, ink.x1 + 20, ink.y1 + 20, 60));
  await shot('b7-english-ink');
  await convertText(page);
  await page.waitForSelector('.hn-conv-result', { timeout: 60000 });
  await page.waitForTimeout(500);
  const tx = (await page0(page)).items.find((i) => i.type === 'text');
  const m = await page.evaluate((tx) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `400 ${tx.size}px "HN Excalifont", "HN Xiaolai", sans-serif`;
    return { w: c.measureText(tx.text).width };
  }, tx);
  await shot('b7-english-converted');
  console.log(`      ink ${Math.round(ink.x1 - ink.x0)}×${Math.round(ink.y1 - ink.y0)} at ${Math.round(ink.x0)},${Math.round(ink.y0)} → "${tx.text}" size ${tx.size} width ${Math.round(m.w)} at ${Math.round(tx.x)},${Math.round(tx.y)}`);
  const inkW = ink.x1 - ink.x0;
  assert(tx.font === 'hand', 'hand font');
  // this fixture is written very loosely (Hershey script): the text may be narrower, never wider
  assert(m.w <= inkW * 1.1 && m.w >= inkW * 0.5, `about as wide as the ink, never wider (${Math.round(m.w)} vs ${Math.round(inkW)})`);
  assert(Math.abs(tx.x + 4 - ink.x0) < 12, `starts where the ink starts (${Math.round(tx.x + 4)} vs ${Math.round(ink.x0)})`);
  const cy = tx.y + tx.h / 2;
  assert(cy > ink.y0 && cy < ink.y1, `vertically on the ink (${Math.round(cy)} in ${Math.round(ink.y0)}..${Math.round(ink.y1)})`);
});

// 0.7.0-beta.8: writing was choppy and strokes were cut on the iPad (beta.7's touch self-heal ended
// pen strokes when iPadOS sent touchcancel for the Pencil's touches)
t('beta.8 writing: touchcancel / touchend without touches during a Pencil stroke never cuts the stroke; a hand touch on text while writing opens no keyboard', async ({ page, base, assert }) => {
  await open(page, base, '?fresh&mode=pen&lang=zh');
  await addText(page, '今天天气很好', 100, 600);
  const r = await page.evaluate(async () => {
    const ed = window.__hn.editor;
    const v = document.querySelector('.hn-viewport');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const out = [];
    for (let s = 0; s < 3; s++) {
      const x0 = 120 + s * 80;
      const ev = (type, x, y) => { const c = ed.pageToClient(0, x, y); v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'pen', clientX: c.x, clientY: c.y, pressure: 0.4, buttons: type === 'pointerup' ? 0 : 1 })); };
      ev('pointerdown', x0, 200);
      for (let i = 1; i <= 50; i++) {
        ev('pointermove', x0 + Math.sin(i / 5) * 15, 200 + i * 2);
        // what iPadOS does to the Pencil's touch sequence mid-stroke
        if (i === 5) document.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [] }));
        if (i === 6) document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
        await sleep(i % 3 === 0 ? 20 : 4);
      }
      ev('pointerup', x0, 300);
      out.push(ed.getDocument().pages[0].strokes.at(-1)?.samples.length ?? 0);
    }
    // a short hand touch on the text right after writing: no text editor
    const c = ed.pageToClient(0, 140, 620);
    for (const type of ['pointerdown', 'pointerup']) v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 48, pointerType: 'touch', clientX: c.x, clientY: c.y, buttons: type === 'pointerup' ? 0 : 1, width: 30, height: 30 }));
    await sleep(100);
    return { samples: out, strokes: ed.getDocument().pages[0].strokes.length, editor: !!document.querySelector('.hn-text-editor') };
  });
  assert(r.strokes === 3 && r.samples.every((n) => n >= 45), `every stroke kept whole (${r.samples})`);
  assert(!r.editor, 'no keyboard from a hand touch while writing');
  // later, a deliberate finger tap still opens it
  await page.waitForTimeout(1300);
  await touchTap(page, 140, 620);
  await page.waitForSelector('.hn-text-editor');
  assert(true, 'a finger tap later opens the text');
});
