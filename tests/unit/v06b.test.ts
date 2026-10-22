import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMyScriptBody, layoutTextInk, MM_PER_UNIT, TEXT_LAYOUT } from '../../src/recognition/myscript';
import { sanitizeRecognitionSettings } from '../../src/recognition/settings';
import type { InkStrokeIn } from '../../src/recognition/types';

const FIX = JSON.parse(readFileSync('tests/fixtures/hanzi-medians.json', 'utf8')) as { chars: Record<string, number[][][]> };

/** Characters from stroke medians at a given size (page units) and position. */
function phrase(text: string, x0: number, y0: number, size: number, idp: string, t0 = 0): InkStrokeIn[] {
  const out: InkStrokeIn[] = [];
  let x = x0;
  let n = 0;
  for (const ch of Array.from(text)) {
    for (const st of FIX.chars[ch]) {
      const xs = st.map((p) => x + (p[0] / 1024) * size);
      const ys = st.map((p) => y0 + ((900 - p[1]) / 1024) * size);
      out.push({ id: `${idp}${n}`, xs, ys, ts: xs.map((_, k) => t0 + n * 300 + k * 10), ps: xs.map(() => 0.5) });
      n++;
    }
    x += size * 1.15;
  }
  return out;
}

type Body = { scaleX: number; configuration: { text?: { guides: { enable: boolean; 'line-gap-mm': number } } }; strokes: { id: string; x: number[]; y: number[] }[] };

/** 10 mm guide band of a stroke; -1 when the stroke crosses a guide line (any multiple of 10 mm). */
function bandOf(body: Body, id: string): number {
  const s = body.strokes.find((x) => x.id === id) as Body['strokes'][number];
  const mm = s.y.map((v) => v * body.scaleX);
  const a = Math.floor(Math.min(...mm) / 10);
  const b = Math.floor((Math.max(...mm) - 1e-6) / 10);
  return a === b ? a : -1;
}

test('0.6.0-beta.4 MyScript: page units are points (A4 = 210 mm wide)', () => {
  assert.ok(Math.abs(595 * MM_PER_UNIT - 210) < 0.2);
});

test('0.6.0-beta.4 MyScript text: big stacked characters (雪花香) stay ONE line on one guide band', () => {
  // written large, like the iPad screenshot (≈ 70 pt high = 25 mm)
  const ink = phrase('雪花香', 120, 300, 70, 'a');
  const lay = layoutTextInk(ink);
  assert.equal(lay.lines, 1);
  const body = buildMyScriptBody('text', ink, { lang: 'zh_CN', lexicon: [] }) as unknown as Body;
  assert.equal(body.configuration.text?.guides.enable, true, 'guides on, like ruled paper');
  const bands = new Set(body.strokes.map((s) => bandOf(body, s.id)));
  assert.equal(bands.size, 1, `every stroke (top parts 雨/艹/禾 and bottom parts 彐/化/日) in one guide band (${[...bands]})`);
  assert.ok(!bands.has(-1), 'no 10 mm guide line (the server default) cuts a character');
  const all = body.strokes.flatMap((s) => s.y.map((v) => v * body.scaleX));
  assert.ok(Math.min(...all) >= 20 && Math.max(...all) <= 30, 'the band starts below any top margin');
  // normalised to typical handwriting size
  const ys = body.strokes.flatMap((s) => s.y.map((v) => v * body.scaleX));
  const h = Math.max(...ys) - Math.min(...ys);
  assert.ok(h > TEXT_LAYOUT.lineHeightMm * 0.7 && h <= TEXT_LAYOUT.maxLineMm + 0.01, `line height ${h.toFixed(1)} mm`);
  assert.equal(body.strokes.length, ink.length, 'every stroke sent once');
});

test('0.6.0-beta.4 MyScript text: two written lines go to two guide bands in reading order; tiny ink is scaled up', () => {
  const ink = [...phrase('视觉', 60, 100, 18, 'a'), ...phrase('伺服', 60, 130, 18, 'b', 5000)];
  const body = buildMyScriptBody('text', ink, { lang: 'zh_CN', lexicon: ['视觉伺服'] }) as unknown as Body & { configuration: { text: { configuration?: { customLexicon: string[] } } } };
  assert.equal(layoutTextInk(ink).lines, 2);
  const ba = new Set(body.strokes.filter((s) => s.id.startsWith('a')).map((s) => bandOf(body, s.id)));
  const bb = new Set(body.strokes.filter((s) => s.id.startsWith('b')).map((s) => bandOf(body, s.id)));
  assert.ok(ba.size === 1 && bb.size === 1 && !ba.has(-1), `one band per line (${[...ba]} / ${[...bb]})`);
  assert.equal([...bb][0], [...ba][0] + 1, 'second line on the next guide band');
  assert.deepEqual(body.configuration.text.configuration?.customLexicon, ['视觉伺服']);
  const ys = body.strokes.filter((s) => s.id.startsWith('a')).flatMap((s) => s.y.map((v) => v * body.scaleX));
  assert.ok(Math.max(...ys) - Math.min(...ys) > 5, 'small handwriting is enlarged to a readable size');
  // the page position does not matter: the same ink lower on the page gives the same request
  const moved = ink.map((s) => ({ ...s, ys: s.ys.map((y) => y + 400), xs: s.xs.map((x) => x + 200) }));
  assert.deepEqual((buildMyScriptBody('text', moved, { lang: 'zh_CN', lexicon: [] }) as unknown as Body).strokes, (buildMyScriptBody('text', ink, { lang: 'zh_CN', lexicon: [] }) as unknown as Body).strokes);
});

test('0.6.0-beta.5 MyScript: dense Apple Pencil samples are thinned (same shape, much smaller request)', () => {
  // 240 Hz-like: a point every ~0.3 pt
  const dense = phrase('雪花香', 120, 300, 70, 'd').map((s) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 1; k < s.xs.length; k++) {
      for (let q = 0; q < 40; q++) {
        xs.push(s.xs[k - 1] + ((s.xs[k] - s.xs[k - 1]) * q) / 40);
        ys.push(s.ys[k - 1] + ((s.ys[k] - s.ys[k - 1]) * q) / 40);
      }
    }
    xs.push(s.xs[s.xs.length - 1]);
    ys.push(s.ys[s.ys.length - 1]);
    return { ...s, xs, ys, ts: xs.map((_, i) => i * 4), ps: xs.map(() => 0.5) };
  });
  const lay = layoutTextInk(dense);
  assert.ok(lay.points[0] * 4 < lay.points[1], `points ${lay.points[0]} of ${lay.points[1]}`);
  const before = JSON.stringify(dense).length;
  const after = JSON.stringify(buildMyScriptBody('text', dense, { lang: 'zh_CN', lexicon: [] })).length;
  assert.ok(after * 3 < before, `request ${after} B vs ink ${before} B`);
  for (const s of lay.strokes) assert.ok(s.xs.length >= 2 && s.xs.length === s.ys.length && s.ts.length === s.xs.length);
});

test('0.6.0-beta.4 MyScript math: real size in mm, no guides', () => {
  const ink: InkStrokeIn[] = [{ id: 's', xs: [0, 72], ys: [0, 0], ts: [0, 100], ps: [0.5, 0.5] }];
  const body = buildMyScriptBody('math', ink, { lang: 'zh_CN', lexicon: [] }) as unknown as Body & { configuration: { math: unknown } };
  const s = body.strokes[0];
  assert.ok(Math.abs((s.x[1] - s.x[0]) * body.scaleX - 25.4) < 0.05, '72 pt = 25.4 mm');
  assert.ok(body.configuration.math && !body.configuration.text);
});

test('0.6.0-beta.4 settings: instant conversion by default; MyScript asks until the user opts out; prefetch on menu', () => {
  const d = sanitizeRecognitionSettings({});
  assert.equal(d.convertMode, 'instant');
  assert.equal(d.keepInk, false);
  assert.equal(d.myscriptAlwaysSend, false);
  assert.equal(d.prefetch, 'menu', 'early text recognition when the Convert menu opens (only with "don\'t ask")');
  const s = sanitizeRecognitionSettings({ convertMode: 'preview', keepInk: true, myscriptAlwaysSend: true, prefetch: true });
  assert.deepEqual([s.convertMode, s.keepInk, s.myscriptAlwaysSend, s.prefetch], ['preview', true, true, 'lasso'], 'beta.4 boolean migrates');
  assert.equal(sanitizeRecognitionSettings({ prefetch: 'off' }).prefetch, 'off');
  assert.equal(sanitizeRecognitionSettings({ myscriptAlwaysSend: 'yes' }).myscriptAlwaysSend, false, 'only an explicit true');
});
