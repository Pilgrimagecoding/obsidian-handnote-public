import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, newId, type Stroke } from '../../src/document/model';
import { parseDocument, quantizeSample, recoverDocument, requiredVersion, serializeDocument, validateItem } from '../../src/document/codec';
import { History } from '../../src/document/history';
import { arrowEnds, connectorPoints, curveMid, fitConnector, hitItem, itemBounds, resolveConnectors, transformItem, type ImageItem, type Item, type ShapeItem, type TextItem } from '../../src/document/items';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import { fitQuadratic, recognizeArrowHead, recognizeShape } from '../../src/ink/shape-recognition';
import { GeometryCache } from '../../src/document/geometry-cache';
import { CountingSink } from '../../src/ink/outline';
import { dashLengths, emitDashedGeometry, lineDashArray } from '../../src/rendering/dash';
import { inPolygon, lassoPick, transformStroke } from '../../src/editor/lasso';
import { buildUnits, layoutSelection } from '../../src/editor/layout';
import { defaultEditorSettings, sanitizeEditorSettings } from '../../src/editor/settings';
import { extractJson, validateScene, SceneError, SCENE_LIMITS } from '../../src/ai/scene';
import { AIService, defaultAISettings, sanitizeAISettings, withTimeout, type AISettings } from '../../src/ai/service';
import { mockScene, PROVIDERS, redact } from '../../src/ai/providers';
import { sceneToItems, placementBox } from '../../src/ai/convert';
import { systemPrompt } from '../../src/ai/prompts';
import { AIError, type AIImage, type HttpRequest } from '../../src/ai/types';
import { circle, line, samplePath } from './helpers';

const poly = (pts: [number, number][]) => {
  const seg: number[] = [];
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(L);
  }
  return (u: number) => {
    const d = u * L;
    let i = seg.findIndex((s) => s >= d);
    if (i < 0) i = seg.length - 1;
    const s0 = i ? seg[i - 1] : 0;
    const k = seg[i] > s0 ? (d - s0) / (seg[i] - s0) : 0;
    return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k };
  };
};

function stroke(samples = samplePath(line(10, 50, 210, 50), { durationMs: 500, hz: 120 }), tool: Stroke['tool'] = 'fountain'): Stroke {
  return { id: newId('s'), tool, color: '#1a1a1a', params: { ...DEFAULT_PEN_PARAMS[tool] }, zoom: 1.5, hasPressure: true, engine: 1, created: 0, samples: samples.map(quantizeSample) };
}

const curve: ShapeItem = fitConnector({ id: 'c1', type: 'shape', kind: 'curve', x: 0, y: 0, w: 0, h: 0, created: 0, stroke: '#1a1a1a', strokeWidth: 2, fill: null, fillOpacity: 1, a: [10, 100], b: [210, 100], c: [110, 0], arrowEnd: true, arrowStart: true, head: 'open', dash: 'dash' } as ShapeItem);
const box: ShapeItem = { id: 'b1', type: 'shape', kind: 'rect', x: 300, y: 300, w: 100, h: 50, created: 0, stroke: '#1a1a1a', strokeWidth: 1.5, fill: null, fillOpacity: 1 };

// ------------------------------------------------------------------------------------------------
// File format v4
// ------------------------------------------------------------------------------------------------

test('format v4: dash, groups, rotation, curves, arrows and embedded images need version 4 and round-trip', () => {
  const doc = createDocument({ pages: 1 });
  const s = stroke();
  doc.pages[0].strokes = [s];
  assert.equal(requiredVersion(doc), 1, 'plain baseline ink stays v1');
  doc.pages[0].strokes = [{ ...s, dash: 'dot', g: 'g1' }];
  assert.equal(requiredVersion(doc), 4);
  const img: ImageItem = { id: 'i1', type: 'image', x: 10, y: 10, w: 40, h: 30, created: 0, src: 'asset:a1', natW: 4, natH: 3, rot: 0.5, g: 'g1' };
  const txt: TextItem = { id: 't1', type: 'text', x: 0, y: 0, w: 50, h: 20, created: 0, text: 'x²', size: 14, color: '#000000', font: 'hand', bold: false, italic: false, align: 'left', autoWidth: true, latex: 'x^2' };
  const poly1: ShapeItem = { ...curve, id: 'p1', kind: 'polyline', pts: [60, 40, 120, 90] };
  delete poly1.c;
  Object.assign(poly1, fitConnector(poly1));
  doc.pages[0].items = [curve, poly1, img, txt];
  doc.assets = { a1: { id: 'a1', mime: 'image/png', w: 4, h: 3, data: 'iVBORw0KGgo=' }, unused: { id: 'unused', mime: 'image/png', w: 1, h: 1, data: 'AAAA' } };
  const text = serializeDocument(doc);
  assert.ok(text.includes('"version":4'));
  assert.ok(text.includes('],"assets":['));
  assert.ok(!text.includes('"unused"'), 'unreferenced assets are not written');
  const back = parseDocument(text);
  assert.equal(back.readOnly, false);
  assert.deepEqual(back.doc.pages[0].strokes[0].dash, 'dot');
  assert.equal(back.doc.pages[0].strokes[0].g, 'g1');
  const [c, p, i, t] = back.doc.pages[0].items as [ShapeItem, ShapeItem, ImageItem, TextItem];
  assert.equal(c.kind, 'curve');
  assert.deepEqual(c.c, [110, 0]);
  assert.equal(c.arrowStart, true);
  assert.equal(c.head, 'open');
  assert.equal(c.dash, 'dash');
  assert.deepEqual(p.pts, [60, 40, 120, 90]);
  assert.equal(i.rot, 0.5);
  assert.equal(i.g, 'g1');
  assert.equal(t.font, 'hand');
  assert.equal(t.latex, 'x^2');
  assert.equal(back.doc.assets?.a1.data, 'iVBORw0KGgo=');
  // stable re-serialization
  assert.equal(serializeDocument(back.doc), text);
  // curve bounds include the bulge (control point pulls it up to y ≈ 50)
  assert.ok(c.y < 60 && c.y > 40, `curve top ${c.y}`);
});

test('format v4: damaged files recover items and embedded images line by line', () => {
  const doc = createDocument({ pages: 1 });
  doc.pages[0].strokes = [stroke()];
  doc.pages[0].items = [{ id: 'i1', type: 'image', x: 1, y: 1, w: 2, h: 2, created: 0, src: 'asset:a1', natW: 2, natH: 2 } as ImageItem];
  doc.assets = { a1: { id: 'a1', mime: 'image/jpeg', w: 2, h: 2, data: '/9j/4AAQ' } };
  const text = serializeDocument(doc);
  const broken = text.replace(/\n\]\}\n$/, '\n'); // truncated end
  const rec = recoverDocument(broken);
  assert.ok(rec);
  assert.equal(rec!.doc.pages[0].items.length, 1);
  assert.equal(rec!.doc.assets?.a1.mime, 'image/jpeg');
});

test('format v4: validation clamps coordinates, drops bad assets and limits text', () => {
  const w: string[] = [];
  const it = validateItem({ id: 'x', type: 'text', x: 1e12, y: -1e12, w: 5, h: 5, text: 'a'.repeat(50000) }, w) as TextItem;
  assert.equal(it.x, 100000);
  assert.equal(it.y, -100000);
  assert.equal(it.text.length, 20000);
  const bad = parseDocument(JSON.stringify({ format: 'obsidian-handnote', version: 4, pages: [], assets: [{ id: 'a', mime: 'text/html', data: 'PGI+' }, { id: 'b', mime: 'image/png', data: 'not base64!' }] }));
  assert.equal(bad.doc.assets, undefined);
  assert.equal(bad.warnings.length >= 2, true);
});

test('history: move-page undo / redo', () => {
  const doc = createDocument({ pages: 3 });
  const ids = doc.pages.map((p) => p.id);
  const h = new History();
  h.push(doc, { kind: 'move-page', pageId: ids[0], from: 0, to: 2 });
  assert.deepEqual(doc.pages.map((p) => p.id), [ids[1], ids[2], ids[0]]);
  h.undo(doc);
  assert.deepEqual(doc.pages.map((p) => p.id), ids);
  h.redo(doc);
  assert.deepEqual(doc.pages.map((p) => p.id), [ids[1], ids[2], ids[0]]);
});

// ------------------------------------------------------------------------------------------------
// Line styles
// ------------------------------------------------------------------------------------------------

test('dashed / dotted ink: pattern scales with width, starts and ends with ink, deterministic', () => {
  const g = new GeometryCache().get(stroke());
  const solidLen = 200;
  const d = new CountingSink();
  emitDashedGeometry(d, g, 'dash', 1.5);
  const { on, off } = dashLengths('dash', 1.5);
  const expected = Math.round((solidLen + off) / (on + off));
  // each dash is a group of capsules; count sub-paths ≥ dashes
  assert.ok(d.subpaths >= expected, `subpaths ${d.subpaths} vs dashes ${expected}`);
  const dots = new CountingSink();
  emitDashedGeometry(dots, g, 'dot', 1.5);
  const n = Math.round(solidLen / dashLengths('dot', 1.5).off) + 1;
  assert.ok(Math.abs(dots.subpaths - n) <= 2, `dots ${dots.subpaths} vs ${n}`);
  const again = new CountingSink();
  emitDashedGeometry(again, g, 'dot', 1.5);
  assert.equal(again.ops, dots.ops);
  assert.deepEqual(lineDashArray(undefined, 2), []);
  assert.equal(lineDashArray('dot', 2)[0] < 0.01, true);
});

// ------------------------------------------------------------------------------------------------
// Shape pen: lines, curves, polylines, arrows
// ------------------------------------------------------------------------------------------------

test('shape pen: a line with a landing hook is still a line', () => {
  const pts = poly([[10, 18], [14, 10], [210, 40]]);
  const r = recognizeShape(samplePath(pts, { durationMs: 400, noise: 0.4 }));
  assert.equal(r?.kind, 'line');
  assert.ok(r!.a![0] > 12, 'hook trimmed');
});

test('shape pen: an arc becomes a smooth curve that passes near the drawn middle', () => {
  const arc = (u: number) => ({ x: 20 + 200 * u, y: 150 - Math.sin(u * Math.PI) * 60 });
  const r = recognizeShape(samplePath(arc, { durationMs: 500, noise: 0.4 }));
  assert.equal(r?.kind, 'curve');
  const m = curveMid(r!.a!, r!.c!, r!.b!);
  assert.ok(Math.abs(m[1] - 90) < 8, `curve mid y ${m[1].toFixed(1)}`);
});

test('shape pen: an L shape becomes a polyline', () => {
  const r = recognizeShape(samplePath(poly([[20, 20], [20, 160], [200, 160]]), { durationMs: 600, noise: 0.4 }));
  assert.equal(r?.kind, 'polyline');
  assert.equal(r?.pts?.length, 2);
});

test('shape pen: a one-stroke arrow (shaft + two barbs) gets an arrow head', () => {
  const r = recognizeShape(samplePath(poly([[20, 100], [220, 100], [200, 88], [220, 100], [200, 112]]), { durationMs: 700, noise: 0.3 }));
  assert.ok(r && (r.kind === 'line' || r.kind === 'polyline'), `kind ${r?.kind}`);
  assert.equal(r?.arrowEnd, true);
  assert.ok(Math.abs(r!.b![0] - 220) < 6, 'arrow ends at the tip');
});

test('shape pen: a separate V is detected as an arrow head pointing at its tip', () => {
  const h = recognizeArrowHead(samplePath(poly([[200, 88], [220, 100], [200, 112]]), { durationMs: 200 }));
  assert.ok(h);
  assert.ok(h!.dir[0] > 0.9, 'points right');
  assert.equal(recognizeArrowHead(samplePath(line(0, 0, 50, 0), { durationMs: 200 })), null);
});

test('shape pen: scribbles stay ink', () => {
  const scribble = (u: number) => ({ x: 50 + Math.cos(u * 40) * 30 + u * 60, y: 50 + Math.sin(u * 33) * 25 });
  assert.equal(recognizeShape(samplePath(scribble, { durationMs: 900 })), null);
  assert.equal(recognizeShape(samplePath(circle(150, 150, 60), { durationMs: 700, noise: 0.6 }))?.kind, 'ellipse');
});

test('quadratic fit: recovers a known control point', () => {
  const a = { x: 0, y: 0 };
  const c = { x: 50, y: 80 };
  const b = { x: 100, y: 0 };
  const pts = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  });
  const f = fitQuadratic(pts);
  assert.ok(Math.hypot(f.c.x - 50, f.c.y - 80) < 3, `c ${f.c.x.toFixed(1)},${f.c.y.toFixed(1)}`);
  assert.ok(f.err < 1);
});

test('connectors: legacy arrow defaults, curve hit test and connector following', () => {
  assert.deepEqual(arrowEnds({ ...curve, kind: 'arrow', arrowEnd: undefined, arrowStart: undefined }), { start: false, end: true });
  assert.deepEqual(arrowEnds({ ...curve, kind: 'line', arrowEnd: undefined, arrowStart: undefined }), { start: false, end: false });
  const m = curveMid(curve.a!, curve.c!, curve.b!);
  assert.ok(hitItem(curve, m[0], m[1], 2), 'on the curve');
  assert.ok(!hitItem(curve, 110, 100, 2), 'chord midpoint is not on the curve');
  const attached: ShapeItem = { ...curve, id: 'c2', to: { id: 'b1', ax: 0, ay: 0.5 } };
  const out = resolveConnectors([box, attached]);
  const moved = out[1] as ShapeItem;
  assert.deepEqual(moved.b, [300, 325]);
  assert.ok(connectorPoints(moved as ShapeItem & { a: [number, number]; b: [number, number] }).length > 10);
});

// ------------------------------------------------------------------------------------------------
// Lasso
// ------------------------------------------------------------------------------------------------

test('lasso: polygon test, content filter and whole groups', () => {
  const sq: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  assert.ok(inPolygon(50, 50, sq));
  assert.ok(!inPolygon(150, 50, sq));
  const doc = createDocument({ pages: 1 });
  const inside = stroke(samplePath(line(10, 50, 90, 50), { durationMs: 200 }));
  const hl = { ...stroke(samplePath(line(10, 70, 90, 70), { durationMs: 200 }), 'highlighter'), tool: 'highlighter' as const };
  const outside = { ...stroke(samplePath(line(300, 50, 400, 50), { durationMs: 200 })), g: 'g1' };
  const groupedInside = { ...stroke(samplePath(line(20, 30, 80, 30), { durationMs: 200 })), g: 'g1' };
  doc.pages[0].strokes = [inside, hl, outside, groupedInside];
  doc.pages[0].items = [{ ...box, x: 20, y: 20, w: 30, h: 20 }];
  const cache = new GeometryCache();
  const all = lassoPick(doc.pages[0], sq, defaultEditorSettings().lasso.filter, cache);
  assert.ok(all.strokeIds.has(inside.id) && all.strokeIds.has(hl.id));
  assert.ok(all.strokeIds.has(outside.id), 'group member outside the loop is included');
  assert.ok(all.itemIds.has('b1'));
  const onlyInk = lassoPick(doc.pages[0], sq, { ...defaultEditorSettings().lasso.filter, highlighter: false, shapes: false }, cache);
  assert.ok(!onlyInk.strokeIds.has(hl.id));
  assert.equal(onlyInk.itemIds.size, 0);
});

test('lasso: scaling a stroke scales its geometry exactly (zoom compensates)', () => {
  const s = stroke(samplePath(circle(100, 100, 40), { durationMs: 500, noise: 0.3 }));
  const cache = new GeometryCache();
  const g0 = cache.get(s);
  const k = 2;
  const t = transformStroke(s, [100, 100], k, 0, 10, 0);
  const g1 = cache.get(t);
  const w0 = g0.bbox[2] - g0.bbox[0];
  const w1 = g1.bbox[2] - g1.bbox[0];
  assert.ok(Math.abs(w1 / w0 - k) < 0.03, `scale ${(w1 / w0).toFixed(3)}`);
  assert.ok(Math.abs(t.params.width - s.params.width * k) < 1e-6);
  // a rotation keeps the length
  const r = transformStroke(stroke(), [110, 50], 1, Math.PI / 2, 0, 0);
  const gr = cache.get(r);
  assert.ok(Math.abs(gr.bbox[3] - gr.bbox[1] - 200) < 6, 'horizontal line became vertical');
});

test('lasso: items rotate (box items get rot, connectors rotate their points) and scale fonts', () => {
  const t: TextItem = { id: 't', type: 'text', x: 0, y: 0, w: 100, h: 20, created: 0, text: 'hi', size: 16, color: '#000000', font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true };
  const r = transformItem(t, [50, 10], 2, Math.PI / 4, 0, 0) as TextItem;
  assert.equal(r.size, 32);
  assert.ok(Math.abs((r.rot ?? 0) - Math.PI / 4) < 1e-9);
  const ln: ShapeItem = { ...curve, kind: 'line', c: undefined, a: [0, 0], b: [100, 0] };
  delete ln.c;
  const rl = transformItem(ln, [0, 0], 1, Math.PI / 2, 0, 0) as ShapeItem;
  assert.ok(Math.abs(rl.b![0]) < 1e-9 && Math.abs(rl.b![1] - 100) < 1e-9);
  assert.equal(rl.rot, undefined);
  const b = itemBounds(r);
  assert.ok(b.w > 140, 'rotated bounds are wider');
});

test('local tidy: handwriting lines become units; tidy aligns them left and evens the gaps', () => {
  const l1 = stroke(samplePath(line(30, 50, 120, 50), { durationMs: 200 }));
  const l1b = stroke(samplePath(line(130, 52, 180, 48), { durationMs: 200 }));
  const l2 = stroke(samplePath(line(10, 100, 100, 100), { durationMs: 200 }));
  const l3 = stroke(samplePath(line(50, 190, 150, 190), { durationMs: 200 }));
  const page = { strokes: [l1, l1b, l2, l3], items: [] as Item[] };
  const cache = new GeometryCache();
  const units = buildUnits(page.strokes, [], cache);
  assert.equal(units.length, 3, 'two strokes on the same line form one unit');
  const res = layoutSelection('tidy', page, page.strokes, [], cache);
  assert.ok(res);
  const xs = res!.strokes.map((s) => cache.get(s).bbox[0]);
  const lefts = [Math.min(xs[0], xs[1]), xs[2], xs[3]];
  assert.ok(Math.max(...lefts) - Math.min(...lefts) < 0.5, `lefts ${lefts.map((v) => v.toFixed(1))}`);
  assert.equal(layoutSelection('align-left', { strokes: [l2], items: [] }, [l2], [], cache), null, 'one unit: nothing to do');
});

test('settings: v0.4 fields are sanitized (dash per pen, lasso filter, laser, image storage)', () => {
  const s = sanitizeEditorSettings({ penDash: { fountain: 'dot', pencil: 'zigzag' }, lasso: { mode: 'rect', filter: { ink: false, text: 'yes' } }, laser: { color: 'red', fadeMs: 99999, holdMs: 5 }, imageStorage: 'cloud', tool: 'lasso' });
  assert.equal(s.penDash.fountain, 'dot');
  assert.equal(s.penDash.pencil, 'solid');
  assert.equal(s.lasso.mode, 'rect');
  assert.equal(s.lasso.filter.ink, false);
  assert.equal(s.lasso.filter.text, true);
  assert.equal(s.laser.color, '#ff3b30');
  assert.equal(s.laser.fadeMs, 4000);
  assert.equal(s.laser.holdMs, 300, 'laser hold time clamped');
  assert.equal(s.imageStorage, 'embed');
  assert.equal(s.tool, 'lasso');
});

// ------------------------------------------------------------------------------------------------
// AI: scene validation, service, conversion
// ------------------------------------------------------------------------------------------------

const ctx = { selectionId: 'sel1', bounds: { x: 100, y: 200, w: 200, h: 100 } };

test('AI scene: valid objects pass, invalid ones are dropped, references are checked', () => {
  const v = validateScene(
    {
      schemaVersion: 1,
      objects: [
        { id: 't1', type: 'text', bbox: [0.1, 0.1, 0.5, 0.2], text: 'hello\u0007 world', confidence: 2 },
        { id: 't1', type: 'text', bbox: [0, 0, 1, 1], text: 'duplicate id' },
        { id: 's1', type: 'shape', shape: 'hexagon', bbox: [0, 0, 0.2, 0.2] },
        { id: 's2', type: 'shape', shape: 'ellipse', bbox: [0.5, 0.5, 0.3, 0.3], label: 'B', color: 'red', onclick: 'alert(1)' },
        { id: 'c1', type: 'connector', points: [[0, 0], [5, 5], [0.9, 0.9]], from: 's2', to: 'ghost', arrowEnd: true },
        { id: 'x1', type: 'script', code: 'fetch("https://evil")' },
        { id: 'n1', type: 'mindmap_node', bbox: [0, 0, 0.1, 0.1], text: 'a', parent: 'n2' },
        { id: 'n2', type: 'mindmap_node', bbox: [0.2, 0, 0.1, 0.1], text: 'b', parent: 'n1' },
        { id: 'f1', type: 'formula', bbox: [0.1, 0.5, 2, 0.1], latex: 'x' },
      ],
      relations: [{ type: 'parent', from: 'n1', to: 'missing' }],
      warnings: ['ok'],
      confidence: 0.7,
    },
    ctx,
  );
  const ids = v.scene.objects.map((o) => o.id);
  assert.deepEqual(ids, ['t1', 's2', 'c1', 'n1', 'n2']);
  const t1 = v.scene.objects[0] as { text: string; confidence: number };
  assert.equal(t1.text, 'hello world', 'control characters removed');
  assert.equal(t1.confidence, 1);
  const s2 = v.scene.objects[1] as unknown as Record<string, unknown>;
  assert.equal(s2.color, undefined, 'colours are never taken from the model');
  assert.equal(s2.onclick, undefined);
  const c1 = v.scene.objects[2] as { points: number[][]; to?: string; from?: string };
  assert.equal(c1.points.length, 2, 'out-of-range point dropped');
  assert.equal(c1.to, undefined, 'unknown reference removed');
  assert.equal(c1.from, 's2');
  const parents = v.scene.objects.filter((o) => o.type === 'mindmap_node').map((o) => (o as { parent?: string }).parent);
  assert.ok(parents.includes(undefined), 'parent cycle broken');
  assert.equal(v.scene.relations.length, 0);
  assert.ok(v.dropped.length >= 5);
  assert.deepEqual(v.scene.sourceBounds, ctx.bounds);
  assert.throws(() => validateScene({ schemaVersion: 2, objects: [] }, ctx), SceneError);
  assert.throws(() => validateScene('not an object', ctx), SceneError);
});

test('AI scene: limits on objects and text; JSON extraction tolerates fences', () => {
  const objects = Array.from({ length: SCENE_LIMITS.maxObjects + 20 }, (_, i) => ({ id: `t${i}`, type: 'text', bbox: [0, 0, 0.1, 0.1], text: 'x'.repeat(100) }));
  const v = validateScene({ schemaVersion: 1, objects }, ctx);
  assert.equal(v.scene.objects.length, Math.min(SCENE_LIMITS.maxObjects, Math.floor(SCENE_LIMITS.maxTotalText / 100)));
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson('<html>no json</html>'), SceneError);
  assert.throws(() => extractJson('{' + 'x'.repeat(SCENE_LIMITS.maxResponseChars) + '}'), SceneError);
});

function image(): AIImage {
  return { mime: 'image/png', base64: 'iVBORw0KGgo=', width: 400, height: 200 };
}

/** Settings that use the default model entry of a profile; `secret` = name of the chosen secret. */
function using(profileId: string, secret?: string, over: Partial<AISettings> = {}): Partial<AISettings> {
  const d = defaultAISettings();
  const profiles = d.profiles.map((p) => (p.id === profileId && secret ? { ...p, secretName: secret } : p));
  const entry = d.modelEntries.find((m) => m.profileId === profileId);
  return { profiles, defaultModel: entry?.id ?? d.defaultModel, ...over };
}

/** The mock profile with a special mock model id (failure simulation). */
function mockModel(model: string, over: Partial<AISettings> = {}): Partial<AISettings> {
  const d = defaultAISettings();
  return { modelEntries: [...d.modelEntries, { id: 'mx', name: model, profileId: 'mock', model, multimodal: true }], defaultModel: 'mx', ...over };
}

function service(over: Partial<AISettings> = {}, http?: (r: HttpRequest) => Promise<{ status: number; text: string }>, secret: string | null = 'sk-test-1234567890') {
  let settings: AISettings = { ...defaultAISettings(), enabled: true, defaultModel: 'mock-1', ...over };
  const calls: HttpRequest[] = [];
  const svc = new AIService({
    settings: () => settings,
    saveSettings: (s) => (settings = s),
    getSecret: () => secret,
    secretsSupported: true,
    http: async (r) => {
      calls.push(r);
      if (!http) throw new Error('no network in unit tests');
      return http(r);
    },
  });
  return { svc, calls, get settings() {
    return settings;
  } };
}

test('AI service: mock provider runs without network and returns a validated scene', async () => {
  const t = service();
  const r = await t.svc.run('handwriting', image(), { ...ctx, language: 'en' });
  assert.equal(t.calls.length, 0, 'mock never touches the network');
  assert.equal(r.provider, 'mock');
  assert.ok(r.scene.objects.some((o) => o.type === 'text'));
  assert.equal(t.settings.usage.requests, 1);
  assert.equal(t.settings.usageByModel['mock (offline demo)'].requests, 1, 'usage per model');
});

test('AI service: disabled / missing key / non-vision model / unsupported secret storage are reported, never bypassed', async () => {
  assert.equal(service({ enabled: false }).svc.status().ready, false);
  const noKey = service(using('qwen'));
  assert.equal(noKey.svc.status().reason, 'no-key');
  await assert.rejects(() => noKey.svc.run('handwriting', image(), { ...ctx, language: 'en' }), (e: AIError) => e.code === 'not-configured');
  let settings: AISettings = { ...defaultAISettings(), enabled: true, ...using('openai', 'openai-key') };
  const old = new AIService({ settings: () => settings, saveSettings: (s) => (settings = s), getSecret: () => 'x', secretsSupported: false, http: async () => ({ status: 200, text: '' }) });
  assert.equal(old.status().reason, 'secret-storage-unsupported');
  const d = defaultAISettings();
  const textOnly = service({ ...using('openai', 'k'), modelEntries: d.modelEntries.map((m) => (m.profileId === 'openai' ? { ...m, multimodal: false } : m)) });
  assert.equal(textOnly.svc.status().reason, 'model-not-multimodal');
  const compat = service({ ...using('openai-compatible', 'k'), modelEntries: [...d.modelEntries, { id: 'c', name: 'c', profileId: 'openai-compatible', model: 'llava', multimodal: true }], defaultModel: 'c' });
  assert.equal(compat.svc.status().reason, 'no-endpoint', 'a compatible provider needs its address');
});

test('AI service: OpenAI-compatible request — key only in the Authorization header, JSON mode where documented', async () => {
  const answer = JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockScene({ task: 'diagram', image: image(), selectionId: 's', language: 'en' })) } }], usage: { prompt_tokens: 900, completion_tokens: 120 }, model: 'gpt-5.4-mini-2026-03-17' });
  const t = service(using('openai', 'openai-key'), async () => ({ status: 200, text: answer }));
  const r = await t.svc.run('diagram', image(), { ...ctx, language: 'en' });
  const req = t.calls[0];
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.ok(!req.url.includes('sk-'), 'no key in the URL');
  assert.equal(req.headers.Authorization, 'Bearer sk-test-1234567890');
  const body = JSON.parse(req.body!);
  assert.equal(body.model, 'gpt-5.4-mini');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.messages[1].content[0].image_url.url.startsWith('data:image/png;base64,'), true);
  assert.equal(r.usage.inputTokens, 900);
  assert.equal(t.settings.usage.inputTokens, 900);
  // Qwen International profile: region endpoint, no json mode, prompt-only JSON
  const dq = defaultAISettings();
  assert.ok(!dq.profiles.some((p) => p.type === 'qwen'), 'Qwen is no longer a default provider');
  const q = service({ profiles: [...dq.profiles, { id: 'qwen-intl', name: 'Qwen Intl', type: 'qwen', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', secretName: 'qwen-key' }], modelEntries: [...dq.modelEntries, { id: 'q', name: 'q', profileId: 'qwen-intl', model: 'qwen3-vl-plus', multimodal: true }], defaultModel: 'q' }, async () => ({ status: 200, text: answer }));
  await q.svc.run('handwriting', image(), { ...ctx, language: 'zh' });
  assert.equal(q.calls[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(JSON.parse(q.calls[0].body!).response_format, undefined);
  assert.equal(JSON.parse(q.calls[0].body!).model, 'qwen3-vl-plus');
  const d = service(using('deepseek', 'ds-key'), async () => ({ status: 200, text: answer }));
  await d.svc.run('handwriting', image(), { ...ctx, language: 'zh' });
  assert.equal(d.calls[0].url, 'https://api.deepseek.com/chat/completions');
  const db = JSON.parse(d.calls[0].body!);
  assert.equal(db.model, 'deepseek-flash');
  assert.deepEqual(db.thinking, { type: 'disabled' }, 'DeepSeek thinking mode off (it is on by default and slow)');
  assert.deepEqual(db.response_format, { type: 'json_object' }, 'DeepSeek JSON Output');
});

test('AI service: Anthropic and Gemini adapters — key in headers only, image inline, usage parsed', async () => {
  const scene = JSON.stringify(mockScene({ task: 'handwriting', image: image(), selectionId: 's', language: 'en' }));
  const an = service(using('anthropic', 'claude-key', { maxOutputTokens: 2000 }), async () => ({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: scene }], usage: { input_tokens: 700, output_tokens: 90 }, model: 'claude-haiku-5-5' }) }));
  const ra = await an.svc.run('handwriting', image(), { ...ctx, language: 'en' });
  const ar = an.calls[0];
  assert.equal(ar.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ar.headers['x-api-key'], 'sk-test-1234567890');
  assert.equal(ar.headers['anthropic-version'], '2023-06-01');
  assert.equal(ar.headers.Authorization, undefined);
  const ab = JSON.parse(ar.body!);
  assert.equal(ab.model, 'claude-haiku-5-5');
  assert.equal(ab.max_tokens, 2000);
  assert.equal(ab.messages[0].content[0].source.type, 'base64');
  assert.equal(ra.usage.outputTokens, 90);
  const ge = service(using('gemini', 'gemini-key'), async () => ({ status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: scene }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80 } }) }));
  const rg = await ge.svc.run('handwriting', image(), { ...ctx, language: 'en' });
  const gr = ge.calls[0];
  assert.equal(gr.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.ok(!gr.url.includes('key='), 'no key in the URL query');
  assert.equal(gr.headers['x-goog-api-key'], 'sk-test-1234567890');
  const gb = JSON.parse(gr.body!);
  assert.equal(gb.contents[0].parts[0].inline_data.mime_type, 'image/png');
  assert.equal(gb.generationConfig.responseMimeType, 'application/json');
  assert.equal(rg.usage.inputTokens, 500);
  // a per-task model overrides the default one
  const d = defaultAISettings();
  const routed = service({ ...using('gemini', 'gk'), modelEntries: [...d.modelEntries, { id: 'lite', name: 'lite', profileId: 'gemini', model: 'gemini-3.5-flash-lite', multimodal: true }], taskModels: { diagram: 'lite' } }, async () => ({ status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: scene }] } }] }) }));
  await routed.svc.run('diagram', image(), { ...ctx, language: 'en' }).catch(() => undefined);
  assert.ok(routed.calls[0].url.includes('/models/gemini-3.5-flash-lite:'), 'diagram uses its own model');
});

test('AI service: bounded retries, no retry on auth errors, errors never echo the key', async () => {
  let n = 0;
  const t = service(using('openai', 'k', { maxRetries: 1 }), async () => {
    n++;
    return { status: 503, text: '{"error":{"message":"overloaded for key sk-test-1234567890"}}' };
  });
  await assert.rejects(
    () => t.svc.run('handwriting', image(), { ...ctx, language: 'en' }),
    (e: AIError) => e.code === 'provider' && !e.message.includes('1234567890'),
  );
  assert.equal(n, 2, 'one retry, then stop');
  let m = 0;
  const a = service(using('openai', 'k', { maxRetries: 2 }), async () => {
    m++;
    return { status: 401, text: '{"error":{"message":"Incorrect API key provided: sk-test-1234567890"}}' };
  });
  await assert.rejects(() => a.svc.run('handwriting', image(), { ...ctx, language: 'en' }), (e: AIError) => e.code === 'auth' && !e.message.includes('1234567890'));
  assert.equal(m, 1, 'auth errors are not retried');
  assert.equal(redact('Bearer sk-abcdef123456 and key-zzzzzzzzzz'), 'Bearer … and key-…');
  assert.equal(redact('bad key AIzaSyA1234567890abcdefg'), 'bad key AIza…');
});

test('AI service: invalid model output, timeout, cancellation and the daily limit', async () => {
  const inv = service(mockModel('mock-invalid'));
  await assert.rejects(() => inv.svc.run('handwriting', image(), { ...ctx, language: 'en' }), (e: AIError) => e.code === 'bad-response');
  const err = service(mockModel('mock-error', { maxRetries: 0 }));
  await assert.rejects(() => err.svc.run('handwriting', image(), { ...ctx, language: 'en' }), (e: AIError) => e.code === 'provider');
  await assert.rejects(() => withTimeout(new Promise(() => undefined), 20), (e: AIError) => e.code === 'timeout');
  const ac = new AbortController();
  const p = withTimeout(new Promise(() => undefined), 5000, ac.signal);
  ac.abort();
  await assert.rejects(() => p, (e: AIError) => e.code === 'cancelled');
  const lim = service({ dailyLimit: 1 });
  await lim.svc.run('handwriting', image(), { ...ctx, language: 'en' });
  await assert.rejects(() => lim.svc.run('handwriting', image(), { ...ctx, language: 'en' }), (e: AIError) => e.code === 'limit');
});

test('AI settings: profiles keep only secret names; insecure URLs and stray keys are rejected', () => {
  const s = sanitizeAISettings({
    version: 2,
    enabled: true,
    apiKey: 'sk-should-not-survive',
    profiles: [
      { id: 'openai', name: 'OpenAI', type: 'openai', secretName: 'openai-main', apiKey: 'sk-should-not-survive', baseUrl: 'http://insecure.example/v1' },
      { id: 'q', name: 'Qwen ws', type: 'qwen', secretName: 'BAD NAME', baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
      { id: 'local', name: 'Ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
      { id: 'evil', name: 'Remote http', type: 'openai-compatible', baseUrl: 'http://example.com/v1' },
      { id: 'x', name: 'Unknown', type: 'telepathy' },
    ],
    modelEntries: [
      { id: 'm1', name: 'gpt', profileId: 'openai', model: 'gpt-5.4-mini' },
      { id: 'm2', name: 'bad', profileId: 'openai', model: '../../etc/passwd' },
      { id: 'm3', name: 'orphan', profileId: 'nope', model: 'x' },
    ],
    defaultModel: 'm2',
    maxRetries: 99,
    timeoutSec: 1,
  });
  assert.equal(JSON.stringify(s).includes('sk-should-not-survive'), false, 'no key survives anywhere');
  const byId = Object.fromEntries(s.profiles.map((p) => [p.id, p]));
  assert.equal(byId.openai.secretName, 'openai-main');
  assert.equal(byId.openai.baseUrl, '', 'plain http to a remote host is not accepted');
  assert.equal(byId.q.secretName, undefined);
  assert.ok(byId.q.baseUrl?.startsWith('https://'));
  assert.equal(byId.local.baseUrl, 'http://localhost:11434/v1', 'local OpenAI-compatible server allowed');
  assert.equal(byId.evil.baseUrl, '');
  assert.equal(byId.x, undefined);
  assert.deepEqual(s.modelEntries.map((m) => m.id), ['m1']);
  assert.equal(s.defaultModel, 'm1');
  assert.equal(s.maxRetries, 2);
  assert.equal(s.timeoutSec, 10);
});

test('AI settings: v0.4.0-beta.1 settings migrate to provider profiles + model entries', () => {
  const s = sanitizeAISettings({ enabled: true, provider: 'qwen', qwenRegion: 'intl-singapore', secretNames: { qwen: 'qwen-main', openai: 'oa' }, customBaseUrl: { openai: 'https://proxy.example/v1' }, models: { diagram: 'qwen3-vl-flash' }, dailyLimit: 7 });
  assert.equal(s.version, 2);
  assert.equal(s.enabled, true);
  assert.equal(s.dailyLimit, 7);
  const prof = (id: string) => s.profiles.find((p) => p.id === id);
  assert.equal(prof('qwen')?.secretName, 'qwen-main');
  assert.equal(prof('qwen-intl')?.secretName, 'qwen-main');
  assert.equal(prof('openai')?.secretName, 'oa');
  assert.equal(prof('openai')?.baseUrl, 'https://proxy.example/v1');
  const def = s.modelEntries.find((m) => m.id === s.defaultModel);
  assert.equal(def?.profileId, 'qwen-intl', 'the region chosen before stays in use (Qwen kept for users who had it)');
  const dia = s.modelEntries.find((m) => m.id === s.taskModels.diagram);
  assert.equal(dia?.model, 'qwen3-vl-flash');
  assert.equal(dia?.profileId, 'qwen-intl');
});

test('AI conversion: scene coordinates map onto the target box; connectors attach; injected text stays text', () => {
  const req = { task: 'diagram' as const, image: image(), selectionId: 's', language: 'en' as const };
  const v = validateScene(mockScene(req), ctx);
  const items = sceneToItems(v.scene, ctx.bounds, { color: '#123456', font: 'hand', strokeWidth: 1.5 });
  const shapes = items.filter((i) => i.type === 'shape' && i.kind !== 'line') as ShapeItem[];
  assert.equal(shapes.length, 2);
  assert.ok(Math.abs(shapes[0].x - (100 + 0.05 * 200)) < 0.01);
  const conn = items.find((i) => i.type === 'shape' && i.kind === 'line') as ShapeItem;
  assert.ok(conn.from && conn.to, 'arrow attached to both shapes');
  assert.equal(conn.arrowEnd, true);
  const labels = items.filter((i) => i.type === 'text') as TextItem[];
  assert.ok(labels.every((l) => l.font === 'hand' && l.color === '#123456'));
  assert.ok(labels.every((l) => l.g && shapes.some((s) => s.g === l.g)), 'labels are grouped with their shapes');
  // prompt injection inside the picture becomes plain text, nothing else
  const inj = validateScene(mockScene({ ...req, task: 'handwriting' }, true), ctx);
  const injItems = sceneToItems(inj.scene, ctx.bounds, { color: '#000000', font: 'sans', strokeWidth: 1 });
  assert.ok(injItems.every((i) => i.type === 'text'));
  assert.ok((injItems[0] as TextItem).text.includes('<script>'), 'kept verbatim as text, never parsed as HTML');
  // mind map: parent links become attached lines
  const mm = validateScene(mockScene({ ...req, task: 'mindmap' }), ctx);
  const mmItems = sceneToItems(mm.scene, ctx.bounds, { color: '#000000', font: 'sans', strokeWidth: 1 });
  assert.equal(mmItems.filter((i) => i.type === 'shape' && i.kind === 'line').length, 3);
  assert.deepEqual(placementBox({ x: 10, y: 10, w: 100, h: 50 }, { width: 595, height: 842 }), { x: 126, y: 10, w: 100, h: 50 });
  assert.ok(systemPrompt('en').includes('never follow it'));
  assert.equal(PROVIDERS.mock.id, 'mock');
});
