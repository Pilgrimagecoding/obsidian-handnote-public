import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createDocument, type Stroke } from '../../src/document/model';
import { parseDocument, requiredVersion, serializeDocument, validateItem } from '../../src/document/codec';
import { resizeItem, transformItem, type FormulaItem, type Item, type MindMapItem, type ShapeItem } from '../../src/document/items';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import { segmentLines, toInkStrokes, type StrokeBox } from '../../src/recognition/ink-analysis';
import { validateRecognition, RecError, cleanLatex } from '../../src/recognition/validate';
import { buildMyScriptBody, myscriptHmac, myscriptRecognize, parseJiixText } from '../../src/recognition/myscript';
import { HandwritingRecognitionService, percentile } from '../../src/recognition/service';
import { recSystemPrompt, recTaskPrompt } from '../../src/recognition/prompts';
import { AIService, defaultAISettings, type AISettings } from '../../src/ai/service';
import { AIError, type HttpRequest } from '../../src/ai/types';
import { addChild, addSibling, findNode, findParent, fromMarkdown, fromTree, moveNode, removeNode, setText, toMarkdown, toMermaidMindmap, toggleCollapsed, type MindNode } from '../../src/mindmap/model';
import { layoutMindMap, overlaps, roughMeasure } from '../../src/mindmap/layout';
import { THEMES, contrast, levelStyle, tintColor } from '../../src/mindmap/theme';
import { fitMindMap, mapLayout } from '../../src/mindmap/paint';
import { layoutDiagram, itemsToMermaid } from '../../src/diagram/layout';
import { buildMindMapItem, buildTextItems, freeSpotOffset, sizeForLine } from '../../src/convert/build';
import { formulaBoxSize, sourceDrawing } from '../../src/rendering/formula';
import { rng } from './helpers';

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

function box(id: string, x0: number, y0: number, x1: number, y1: number): StrokeBox {
  return { id, x0, y0, x1, y1 };
}

function stroke(id: string, pts: [number, number][], created = 0): Stroke {
  return {
    id,
    tool: 'fountain',
    color: '#123456',
    params: { ...DEFAULT_PEN_PARAMS },
    samples: pts.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 8 })),
    created,
    engine: 1,
    hasPressure: false,
  } as unknown as Stroke;
}

/** 0.5 vision-path tests choose the vision engine explicitly (0.6 never falls back to it silently). */
function aiSettings(patch: Partial<AISettings> = {}): AISettings {
  const d = defaultAISettings();
  return { ...d, enabled: true, defaultModel: 'mock-1', recognition: { ...d.recognition, engine: 'vision' }, ...patch };
}

function service(settings: AISettings, http: (r: HttpRequest) => Promise<{ status: number; text: string }>, secrets: Record<string, string> = {}) {
  const ai = new AIService({ settings: () => settings, saveSettings: (x) => void Object.assign(settings, x), getSecret: (n) => secrets[n] ?? null, secretsSupported: true, http });
  return new HandwritingRecognitionService({ ai, settings: () => settings, recognition: () => settings.recognition, getSecret: (n) => secrets[n] ?? null, secretsSupported: true, http });
}

const IMG = { mime: 'image/png' as const, base64: 'iVBORw0KGgo=', width: 10, height: 10 };

function randomTree(r: () => number, depth = 0, maxDepth = 3): { text: string; children: { text: string; children: unknown[] }[] } {
  const k = depth >= maxDepth ? 0 : Math.floor(r() * (depth === 0 ? 7 : 4));
  const words = ['数据', 'Transformer 模型', '视觉伺服控制', 'SLAM', '一个比较长的主题名称用来测试换行效果', 'PID', 'ok'];
  return { text: words[Math.floor(r() * words.length)], children: Array.from({ length: k }, () => randomTree(r, depth + 1, maxDepth)) as never };
}

// ------------------------------------------------------------------------------------------------
// ink analysis
// ------------------------------------------------------------------------------------------------

test('0.5 ink: lines are found top→bottom with dots attached and strokes left→right', () => {
  const boxes: StrokeBox[] = [];
  for (let line = 0; line < 3; line++) {
    const y = 40 + line * 50;
    for (let c = 4; c >= 0; c--) boxes.push(box(`l${line}c${c}`, 20 + c * 30, y, 40 + c * 30, y + 26));
    boxes.push(box(`l${line}dot`, 182, y - 6, 185, y - 3)); // an accent / dot above the line
  }
  const lines = segmentLines(boxes);
  assert.equal(lines.length, 3);
  lines.forEach((l, i) => {
    assert.equal(l.index, i);
    assert.ok(l.strokeIds.includes(`l${i}dot`), `dot of line ${i} stays on its line`);
    assert.deepEqual(l.strokeIds.filter((s) => s.includes('c')), [0, 1, 2, 3, 4].map((c) => `l${i}c${c}`));
  });
  assert.ok(lines[0].y < lines[1].y && lines[1].y < lines[2].y);
});

test('0.5 ink: vector input keeps writing order, monotonic time and default pressure', () => {
  const a = stroke('a', [[0, 0], [10, 0]], 1000);
  const b = stroke('b', [[0, 10], [10, 10]], 500);
  const ink = toInkStrokes([a, b]);
  assert.deepEqual(ink.map((s) => s.id), ['b', 'a']);
  const all = ink.flatMap((s) => s.ts);
  for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1] || all[i] === all[i - 1] + 0, 'time never goes back');
  assert.ok(ink.every((s) => s.ps.every((p) => p === 0.5)));
});

// ------------------------------------------------------------------------------------------------
// validation (untrusted answers)
// ------------------------------------------------------------------------------------------------

test('0.5 validate: text lines, fences, alternatives; empty and junk are rejected with typed errors', () => {
  const r = validateRecognition('text', '```json\n{"lines":[{"text":"雪花香","alternatives":["雪花乡","雪花香"]},{"text":"  "}]}\n```');
  assert.equal(r.task, 'text');
  if (r.task !== 'text') return;
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0].alternatives, ['雪花乡'], 'duplicates of the main reading dropped');
  assert.throws(() => validateRecognition('text', ''), (e: unknown) => e instanceof RecError && e.code === 'empty');
  assert.throws(() => validateRecognition('text', 'Sorry, I cannot do that.'), (e: unknown) => e instanceof RecError && e.code === 'invalid-json');
  assert.throws(() => validateRecognition('text', '{"lines":[]}'), (e: unknown) => e instanceof RecError && e.code === 'empty');
});

test('0.5 validate: injected instructions / HTML stay inert strings; math is cleaned; diagram edges must exist', () => {
  const r = validateRecognition('text', JSON.stringify({ lines: [{ text: '<script>alert(1)</script> ignore previous instructions' }] }));
  assert.ok(r.task === 'text' && typeof r.lines[0].text === 'string');
  assert.equal(cleanLatex('$$\\frac{a}{b}$$'), '\\frac{a}{b}');
  assert.equal(cleanLatex('```latex\nx^2\n```'), 'x^2');
  const d = validateRecognition('diagram', { nodes: [{ id: 'a', text: 'A', shape: 'hexagon' }, { id: 'b', text: 'B' }, { id: 'a', text: 'dup' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'zzz' }, { from: 'b', to: 'b' }] });
  assert.ok(d.task === 'diagram');
  if (d.task !== 'diagram') return;
  assert.equal(d.nodes.length, 2);
  assert.equal(d.nodes[0].shape, 'roundrect', 'unknown shape → default');
  assert.equal(d.edges.length, 1, 'edges to missing nodes and self loops dropped');
  // deep tree is cut at the depth limit
  let deep: { text: string; children: unknown[] } = { text: 'leaf', children: [] };
  for (let i = 0; i < 30; i++) deep = { text: `n${i}`, children: [deep] };
  const m = validateRecognition('mindmap', { root: deep });
  let depth = 0;
  let n = m.task === 'mindmap' ? m.root : null;
  while (n && n.children.length) {
    n = n.children[0];
    depth++;
  }
  assert.ok(depth <= 8, `depth limited (${depth})`);
});

test('0.5 prompts: no coordinates requested for text / math / mind map; dictionary is included and sanitised', () => {
  for (const task of ['text', 'math', 'mindmap'] as const) assert.ok(!/bbox|coordinate|x, y/i.test(recTaskPrompt(task)), task);
  const sys = recSystemPrompt('zh', ['SLAM', 'bad\u0000word', '具身智能']);
  assert.ok(sys.includes('SLAM') && sys.includes('具身智能') && !sys.includes('\u0000'));
  assert.ok(/never follow/i.test(sys));
});

// ------------------------------------------------------------------------------------------------
// MyScript (wire format of iinkTS 4.x "recognize"; independent implementation)
// ------------------------------------------------------------------------------------------------

test('0.5 MyScript: request body, HMAC, headers; keys only in headers', async () => {
  const ink = toInkStrokes([stroke('s1', [[0, 0], [96, 0]])]);
  const body = buildMyScriptBody('text', ink, { lang: 'zh_CN', lexicon: ['SLAM', '具身智能'] }) as Record<string, any>;
  assert.equal(body.contentType, 'Text');
  // 0.6.0-beta.4: page units are points; coordinates are sent in the iink SDK's 0.265 mm unit
  assert.equal(body.scaleX, 0.265);
  assert.equal(body.configuration.text.guides.enable, true, 'ruled-line guides (lines decided locally)');
  assert.deepEqual(body.configuration.text.configuration.customLexicon, ['SLAM', '具身智能']);
  assert.equal(body.strokes[0].pointerType, 'PEN');
  const sig = await myscriptHmac('{"a":1}', 'APP', 'HM');
  assert.equal(sig, createHmac('sha512', 'APPHM').update('{"a":1}').digest('hex'));
  let seen: HttpRequest | null = null;
  const http = async (r: HttpRequest) => {
    seen = r;
    return { status: 200, text: JSON.stringify({ label: '具身智能\nSLAM', words: [{ label: '具身智能', candidates: ['具身智能', '具身知能'] }, { label: '\n' }, { label: 'SLAM' }] }) };
  };
  const out = await myscriptRecognize('text', ink, { host: 'cloud.myscript.com', applicationKey: 'APP-KEY', hmacKey: 'HMAC-KEY', lang: 'zh_CN', lexicon: [] }, http);
  const req = seen as unknown as HttpRequest;
  assert.equal(req.url, 'https://cloud.myscript.com/api/v4.0/iink/recognize');
  assert.equal(req.headers.applicationKey, 'APP-KEY');
  assert.equal(req.headers.hmac, createHmac('sha512', 'APP-KEYHMAC-KEY').update(req.body as string).digest('hex'));
  assert.ok(!(req.body as string).includes('APP-KEY') && !(req.body as string).includes('HMAC-KEY'), 'keys never in the body');
  assert.ok(!req.url.includes('KEY'), 'keys never in the URL');
  assert.ok(out.result.task === 'text' && out.result.lines.length === 2);
  if (out.result.task === 'text') assert.deepEqual(out.result.lines[0].alternatives, ['具身知能']);
  await assert.rejects(myscriptRecognize('text', ink, { host: 'evil.com/x?', applicationKey: 'k', lang: 'zh_CN', lexicon: [] }, http), (e: unknown) => e instanceof AIError && e.code === 'not-configured');
  const bad = async () => ({ status: 401, text: '{"code":"access.not.granted","message":"key APP-KEY invalid"}' });
  await assert.rejects(myscriptRecognize('math', ink, { host: 'cloud.myscript.com', applicationKey: 'APP-KEY', lang: 'zh_CN', lexicon: [] }, bad), (e: unknown) => e instanceof AIError && e.code === 'auth');
});

test('0.5 MyScript: JIIX without words falls back to label lines', () => {
  const r = parseJiixText({ label: 'a\nb' });
  assert.deepEqual(r.lines.map((l) => l.text), ['a', 'b']);
  assert.throws(() => parseJiixText({ label: '  ' }), (e: unknown) => e instanceof AIError && e.code === 'empty');
});

// ------------------------------------------------------------------------------------------------
// recognition service
// ------------------------------------------------------------------------------------------------

test('0.5 service: engine routing — MyScript only when keys are configured; vision otherwise; disabled = not ready', () => {
  const s = aiSettings();
  const svc = service(s, async () => ({ status: 500, text: '' }));
  assert.equal(svc.engineFor('text').engine, 'mock');
  // 0.7: MyScript is used when chosen explicitly (auto = on device first)
  s.recognition = { ...s.recognition, engine: 'myscript', myscriptAppKeySecret: 'ms-app' };
  assert.equal(svc.engineFor('text').engine, 'myscript');
  assert.equal(svc.engineFor('text').sends, 'ink');
  assert.equal(svc.engineFor('mindmap').engine, 'mock', 'structure tasks always use the vision model');
  s.recognition = { ...s.recognition, engine: 'vision' };
  assert.equal(svc.engineFor('math').engine, 'mock');
  const off = aiSettings({ enabled: false });
  assert.equal(service(off, async () => ({ status: 200, text: '' })).engineFor('text').ready, false, 'vision engine needs AI enabled');
});

test('0.5 service: mock text → validated lines; same unchanged selection is served from cache (no 2nd request); concurrent taps join', async () => {
  const s = aiSettings();
  const svc = service(s, async () => ({ status: 500, text: '' }));
  let stages: string[] = [];
  const input = { selectionId: 'x', language: 'zh' as const, image: IMG, lineCount: 2 };
  const r1 = await svc.recognize('text', input, undefined, (st) => stages.push(st));
  assert.ok(r1.result.task === 'text' && r1.result.lines.length === 2);
  assert.ok(stages.includes('request') && stages.includes('parse'));
  assert.ok(r1.stages.some((x) => x.name === 'request'));
  const before = s.usage.totalRequests;
  const r2 = await svc.recognize('text', input);
  assert.equal(r2.cached, true);
  assert.equal(s.usage.totalRequests, before, 'no new request for a cached result');
  stages = [];
  const input3 = { ...input, image: { ...IMG, base64: 'AAAA' } };
  const [a, b] = await Promise.all([svc.recognize('math', input3), svc.recognize('math', input3)]);
  assert.equal(a.result.task, 'math');
  assert.equal(b.result.task, 'math');
  assert.equal(s.usage.totalRequests, before + 1, 'two taps, one request');
});

test('0.5 service: typed errors — invalid JSON, empty, timeout; nothing is retried automatically', async () => {
  const mk = (model: string) => {
    const s = aiSettings();
    s.modelEntries = [...s.modelEntries, { id: 'mx', name: 'mx', profileId: 'mock', model, multimodal: true }];
    s.defaultModel = 'mx';
    s.timeoutSec = 10;
    return { s, svc: service(s, async () => ({ status: 500, text: '' })) };
  };
  const input = { selectionId: 'x', language: 'en' as const, image: IMG };
  const inv = mk('mock-invalid');
  await assert.rejects(inv.svc.recognize('text', input), (e: unknown) => e instanceof AIError && (e.code === 'bad-response' || e.code === 'invalid-scene'));
  const emp = mk('mock-empty');
  await assert.rejects(emp.svc.recognize('text', input), (e: unknown) => e instanceof AIError && e.code === 'empty');
  assert.equal(emp.s.usage.totalRequests, 1, 'an empty (possibly billed) answer is not repeated');
});

test('0.5 service: DeepSeek request — thinking disabled, JSON mode, image + prompt; key only in the Authorization header', async () => {
  const s = aiSettings({ defaultModel: 'deepseek-flash' });
  s.profiles = s.profiles.map((p) => (p.type === 'deepseek' ? { ...p, secretName: 'ds' } : p));
  let req: HttpRequest | null = null;
  const svc = service(
    s,
    async (r) => {
      req = r;
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"latex":"x^2+1"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    },
    { ds: 'sk-secret-123' },
  );
  const run = await svc.recognize('math', { selectionId: 's', language: 'en', image: IMG });
  assert.ok(run.result.task === 'math' && run.result.latex === 'x^2+1');
  const r = req as unknown as HttpRequest;
  const body = JSON.parse(r.body as string);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.ok(/json/i.test(JSON.stringify(body.messages)), 'JSON mode requires the word json in the prompt');
  assert.equal(r.headers.Authorization, 'Bearer sk-secret-123');
  assert.ok(!(r.body as string).includes('sk-secret-123') && !r.url.includes('sk-secret'));
});

test('0.5 service: timings → p50 / p95 (nearest rank), cached runs excluded', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  const svc = service(aiSettings(), async () => ({ status: 500, text: '' }));
  const run = (ms: number, cached = false) => ({ result: { task: 'math', latex: 'x', alternatives: [], warnings: [] }, engine: 'mock', model: 'm', stages: [{ name: 'request', ms }], bytes: 1, usage: {}, cached }) as never;
  for (const ms of [100, 200, 300, 400]) svc.record(run(ms), ms + 10, 'math');
  svc.record(run(1, true), 1, 'math');
  const st = svc.stats();
  assert.equal(st.n, 4);
  assert.equal(st.req50, 200);
  assert.equal(st.req95, 400);
});

// ------------------------------------------------------------------------------------------------
// mind map model + layout + themes
// ------------------------------------------------------------------------------------------------

test('0.5 mind map: edit operations are immutable; no cycles; markdown / mermaid round trip', () => {
  const root = fromTree({ text: 'Root', children: [{ text: 'A', children: [{ text: 'A1', children: [] }] }, { text: 'B', children: [] }] });
  const a = root.children[0];
  const b = root.children[1];
  const c1 = addChild(root, b.id, 'B1');
  assert.notEqual(c1.root, root);
  assert.equal(findNode(root, c1.id), null, 'original unchanged');
  assert.equal(findParent(c1.root, c1.id)?.id, b.id);
  const sib = addSibling(c1.root, a.id, 'A+');
  assert.deepEqual(sib.root.children.map((c) => c.text), ['A', 'A+', 'B']);
  assert.equal(moveNode(sib.root, a.id, a.children[0].id), sib.root, 'cannot move a topic into its own subtree');
  const moved = moveNode(sib.root, a.children[0].id, b.id);
  assert.equal(findParent(moved, a.children[0].id)?.id, b.id);
  assert.equal(removeNode(moved, moved.id), moved, 'root cannot be removed');
  assert.equal(findNode(removeNode(moved, a.id), a.id), null);
  assert.equal(findNode(setText(root, a.id, 'x\u0001y'), a.id)?.text, 'xy');
  const col = toggleCollapsed(root, a.id);
  assert.equal(findNode(col, a.id)?.collapsed, true);
  const md = toMarkdown(root);
  assert.equal(md, '# Root\n- A\n  - A1\n- B');
  const back = fromMarkdown(md) as MindNode;
  assert.equal(toMarkdown(back), md);
  assert.ok(toMermaidMindmap(root).startsWith('mindmap\n  root((Root))'));
});

test('0.5 mind map layout: no overlapping topics for random trees (all themes, both layouts); deterministic', () => {
  const r = rng(7);
  for (let i = 0; i < 40; i++) {
    const root = fromTree(randomTree(r));
    for (const theme of ['academic', 'hand', 'minimal'] as const) {
      for (const lay of ['balanced', 'right'] as const) {
        const l = layoutMindMap(root, theme, lay, roughMeasure);
        assert.deepEqual(overlaps(l), [], `tree ${i} ${theme} ${lay}`);
        for (const n of l.nodes) {
          assert.ok(n.x >= l.bounds.x && n.y >= l.bounds.y && n.x + n.w <= l.bounds.x + l.bounds.w + 0.01 && n.y + n.h <= l.bounds.y + l.bounds.h + 0.01, 'inside bounds');
          if (n.depth > 0 && lay === 'right') assert.equal(n.side, 1);
        }
        const again = layoutMindMap(root, theme, lay, roughMeasure);
        assert.deepEqual(again.nodes.map((n) => [n.id, n.x, n.y]), l.nodes.map((n) => [n.id, n.x, n.y]));
      }
    }
  }
});

test('0.5 mind map layout: children right of the parent (left side mirrored), text fits its box, collapse hides the subtree', () => {
  const root = fromTree({ text: '中心主题', children: ['一', '二', '三', '四'].map((t) => ({ text: t, children: [{ text: `${t}的子主题，一个非常非常长的标题，需要自动换行显示出来`, children: [] }] })) });
  const l = layoutMindMap(root, 'academic', 'balanced', roughMeasure);
  for (const e of l.edges) {
    const p = l.byId.get(e.from)!;
    const c = l.byId.get(e.to)!;
    if (c.side === 1) assert.ok(c.x >= p.x + p.w, 'right child is right of its parent');
    else assert.ok(c.x + c.w <= p.x, 'left child is left of its parent');
  }
  assert.ok(l.nodes.some((n) => n.side === -1) && l.nodes.some((n) => n.side === 1), 'balanced uses both sides');
  for (const n of l.nodes) for (const line of n.lines) assert.ok(roughMeasure(line, n.style.size, n.style.weight, 'sans') <= n.w - n.style.padX * 2 + 0.5, 'line fits');
  assert.ok(l.nodes.some((n) => n.lines.length > 1), 'long topics wrap');
  const col = toggleCollapsed(root, root.children[0].id);
  const lc = layoutMindMap(col, 'academic', 'balanced', roughMeasure);
  assert.equal(lc.nodes.length, l.nodes.length - 1);
  assert.equal(lc.byId.get(root.children[0].id)?.hidden, 1);
});

test('0.5 themes: colours come from the theme; text / fill contrast ≥ 4.5:1; branches get different colours', () => {
  for (const th of Object.values(THEMES)) {
    assert.ok(contrast(th.rootText, th.rootFill) >= 4.5, `${th.id} root`);
    for (const c of th.palette) {
      const fill = th.tint > 0 ? tintColor(c, th.tint) : '#ffffff';
      assert.ok(contrast(th.text, fill) >= 4.5, `${th.id} level-1 on ${fill}`);
      assert.ok(contrast(th.subText, '#ffffff') >= 4.5, `${th.id} sub text`);
    }
    assert.ok(levelStyle(th, 0).size > levelStyle(th, 1).size && levelStyle(th, 1).size >= levelStyle(th, 5).size, 'hierarchy by size');
  }
  const root = fromTree({ text: 'R', children: ['a', 'b', 'c'].map((t) => ({ text: t, children: [] })) });
  const l = layoutMindMap(root, 'academic', 'right', roughMeasure);
  const colors = new Set(l.nodes.filter((n) => n.depth === 1).map((n) => n.color));
  assert.equal(colors.size, 3);
});

test('0.5 mind map item: fit keeps the root in place while editing; resize scales; rotation is ignored', () => {
  const root = fromTree({ text: 'Root', children: [{ text: 'A', children: [] }] });
  const it = fitMindMap({ id: 'm', type: 'mindmap', root, theme: 'academic', layout: 'balanced', scale: 1, x: 100, y: 100, w: 0, h: 0, created: 0 });
  const r0 = mapLayout(it).byId.get(root.id)!;
  const p0 = [it.x + (r0.x - mapLayout(it).bounds.x) * it.scale, it.y + (r0.y - mapLayout(it).bounds.y) * it.scale];
  let next = root;
  for (let i = 0; i < 5; i++) next = addChild(next, root.id, `new ${i}`).root;
  const it2 = fitMindMap({ ...it, root: next }, it);
  const l2 = mapLayout(it2);
  const r2 = l2.byId.get(root.id)!;
  const p2 = [it2.x + (r2.x - l2.bounds.x) * it2.scale, it2.y + (r2.y - l2.bounds.y) * it2.scale];
  assert.ok(Math.abs(p0[0] - p2[0]) < 0.01 && Math.abs(p0[1] - p2[1]) < 0.01, 'root did not move');
  assert.ok(it2.h > it.h);
  const big = resizeItem(it2, { x: it2.x, y: it2.y, w: it2.w * 2, h: it2.h * 3 }) as MindMapItem;
  assert.ok(Math.abs(big.scale - 2) < 1e-9 && Math.abs(big.w / big.h - it2.w / it2.h) < 1e-9, 'uniform scale');
  const rot = transformItem(it2, [0, 0], 1, 0.7, 0, 0) as MindMapItem;
  assert.equal(rot.rot, undefined);
});

// ------------------------------------------------------------------------------------------------
// flowchart
// ------------------------------------------------------------------------------------------------

test('0.5 flowchart: layered layout, text inside shapes, attached arrows, back edge, no overlap, Mermaid export', () => {
  const d = validateRecognition('diagram', {
    direction: 'TB',
    nodes: [
      { id: 'a', text: '开始', shape: 'ellipse', pos: [0.5, 0.1] },
      { id: 'b', text: '读取输入', shape: 'parallelogram', pos: [0.5, 0.3] },
      { id: 'c', text: '是否有效？', shape: 'diamond', pos: [0.5, 0.5] },
      { id: 'd', text: '处理', shape: 'rect', pos: [0.3, 0.8] },
      { id: 'e', text: '结束', shape: 'ellipse', pos: [0.7, 0.8] },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd', label: '是' },
      { from: 'c', to: 'e', label: '否' },
      { from: 'd', to: 'b', dashed: true },
    ],
  });
  assert.ok(d.task === 'diagram');
  if (d.task !== 'diagram') return;
  const out = layoutDiagram(d, { x: 50, y: 60 }, 'academic', roughMeasure);
  const shapes = out.items.filter((i): i is ShapeItem => i.type === 'shape' && !i.a);
  const conns = out.items.filter((i): i is ShapeItem => i.type === 'shape' && !!i.a);
  assert.equal(shapes.length, 5);
  assert.ok(shapes.every((s) => s.label?.text), 'node text is a label of its shape');
  const byText = (t: string) => shapes.find((s) => s.label?.text === t)!;
  assert.ok(byText('开始').y < byText('读取输入').y && byText('读取输入').y < byText('是否有效？').y && byText('是否有效？').y < byText('处理').y, 'ranks top → bottom');
  assert.ok(byText('处理').x < byText('结束').x, 'drawn left/right order kept');
  assert.equal(byText('是否有效？').kind, 'diamond');
  assert.equal(conns.length, 5);
  assert.ok(conns.every((c) => c.from && c.to), 'every arrow attached at both ends');
  assert.ok(conns.some((c) => c.kind === 'curve' && c.dash === 'dash'), 'loop back drawn as a dashed curve on the side');
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'no overlapping nodes');
    }
  assert.ok(out.items.filter((i) => i.type === 'text').length === 2, 'edge labels');
  const mm = itemsToMermaid(out.items);
  assert.ok(mm.startsWith('flowchart TD'));
  assert.ok(/N3\{"是否有效？"\}/.test(mm));
  assert.ok(/N3 -->\|是\| N4/.test(mm), mm);
  assert.ok(/-\.->/.test(mm), 'dashed edge');
});

// ------------------------------------------------------------------------------------------------
// building results
// ------------------------------------------------------------------------------------------------

test('0.5 build: text lands on its handwritten line, in the ink colour; line count mismatch → stacked', () => {
  const ink = [
    { index: 0, strokeIds: ['a'], x: 100, y: 100, w: 200, h: 30 },
    { index: 1, strokeIds: ['b'], x: 102, y: 150, w: 180, h: 32 },
  ];
  const items = buildTextItems([{ text: '第一行', alternatives: [] }, { text: '第二行', alternatives: [] }], ink, { x: 100, y: 100, w: 200, h: 82 }, { font: 'hand', color: '#c92a2a', dx: 0, dy: 0 });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.color === '#c92a2a' && i.font === 'hand'));
  assert.ok(Math.abs(items[0].y + items[0].h / 2 - 115) < 6 && Math.abs(items[1].y + items[1].h / 2 - 166) < 6, 'vertically centred on the lines');
  assert.equal(items[0].size, items[1].size, 'one size for the block');
  assert.equal(sizeForLine(30), 21.5);
  const stacked = buildTextItems([{ text: 'a', alternatives: [] }, { text: 'b', alternatives: [] }, { text: 'c', alternatives: [] }], ink, { x: 100, y: 100, w: 200, h: 82 }, { font: 'sans', color: '#000000', dx: 0, dy: 0 });
  assert.equal(stacked.length, 3);
  assert.ok(stacked[1].y >= stacked[0].y + stacked[0].h - 0.01 && stacked[2].y >= stacked[1].y + stacked[1].h - 0.01, 'no overlap');
});

test('0.5 build: a converted mind map fits on the page', () => {
  const r = rng(3);
  const tree = randomTree(r, 0, 4) as never;
  const it = buildMindMapItem(tree, { x: 400, y: 600, w: 150, h: 120 }, 'academic', 'balanced', 0, 0, { width: 595, height: 842 });
  assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.w <= 595 + 0.01 && it.y + it.h <= 842 + 0.01, JSON.stringify([it.x, it.y, it.w, it.h]));
});

test('0.5 formula: source fallback box; the box follows the drawing size', () => {
  const d = sourceDrawing('\\frac{a}{b}');
  assert.equal(d.math, false);
  const b = formulaBoxSize(d, 20);
  assert.ok(b.w > 20 && b.h > 20);
});

// ------------------------------------------------------------------------------------------------
// file format v5
// ------------------------------------------------------------------------------------------------

test('0.5 codec: formulas, mind maps and labelled shapes round-trip as format 5; other files stay ≤ 4', () => {
  const doc = createDocument({ pages: 1 });
  assert.ok(requiredVersion(doc) <= 4);
  const f: FormulaItem = { id: 'f1', type: 'formula', latex: '\\sqrt{x}', color: '#1a1a1a', size: 20, x: 10, y: 10, w: 60, h: 30, created: 1 };
  const root = fromTree({ text: 'R', children: [{ text: 'A', children: [] }] });
  const m: MindMapItem = { id: 'm1', type: 'mindmap', root: { ...root, collapsed: false }, theme: 'hand', layout: 'right', scale: 1.2, x: 50, y: 50, w: 100, h: 60, created: 1 };
  const sh: ShapeItem = { id: 's1', type: 'shape', kind: 'diamond', x: 0, y: 0, w: 80, h: 60, created: 1, stroke: '#000000', strokeWidth: 1, fill: null, fillOpacity: 1, label: { text: '是否？', size: 13, color: '#1f2933' } };
  doc.pages[0].items = [f, m, sh];
  assert.equal(requiredVersion(doc), 5);
  const text = serializeDocument(doc);
  const back = parseDocument(text);
  assert.equal(back.readOnly, false);
  const items = back.doc.pages[0].items as Item[];
  assert.equal((items[0] as FormulaItem).latex, '\\sqrt{x}');
  const mm = items[1] as MindMapItem;
  assert.equal(mm.theme, 'hand');
  assert.equal(mm.root.children[0].text, 'A');
  assert.equal(mm.root.children[0].id, root.children[0].id, 'topic ids kept');
  assert.equal((items[2] as ShapeItem).label?.text, '是否？');
  // a file from a newer plugin opens read-only
  const newer = text.replace('"version":5', '"version":7');
  assert.equal(parseDocument(newer).readOnly, true);
});

test('0.5 codec: mind maps from files are validated (ids, text, depth, size limits; no rotation)', () => {
  const w: string[] = [];
  let deep: Record<string, unknown> = { id: 'x', text: 'leaf', children: [] };
  for (let i = 0; i < 40; i++) deep = { id: `n${i}`, text: `n${i}`, children: [deep] };
  const it = validateItem({ id: 'm', type: 'mindmap', x: 0, y: 0, w: 10, h: 10, rot: 1, theme: 'neon', layout: 'spiral', scale: 99, root: { id: '<bad id>', text: 'R\u0002', children: [deep, deep] } }, w) as MindMapItem;
  assert.equal(it.type, 'mindmap');
  assert.equal(it.theme, 'academic');
  assert.equal(it.layout, 'balanced');
  assert.equal(it.scale, 8);
  assert.equal(it.rot, undefined);
  assert.notEqual(it.root.id, '<bad id>');
  assert.equal(it.root.text, 'R');
  const ids = new Set<string>();
  const walk = (n: MindNode, d: number): number => {
    assert.ok(!ids.has(n.id), 'unique ids');
    ids.add(n.id);
    return Math.max(d, ...n.children.map((c) => walk(c, d + 1)));
  };
  assert.ok(walk(it.root, 0) <= 12);
  assert.equal(validateItem({ type: 'formula', latex: '   ' }, w), null);
  assert.equal(validateItem({ type: 'mindmap', root: null }, w), null);
});

test('0.5 build: a kept result goes to a free spot — never over the ink or other objects', () => {
  const page = { width: 595, height: 842 };
  const src = { x: 300, y: 100, w: 250, h: 100 };
  const res = { x: 300, y: 100, w: 200, h: 80 };
  const busy = [{ x: 300, y: 216, w: 250, h: 100 }, { x: 40, y: 100, w: 240, h: 120 }];
  const off = freeSpotOffset(src, res, page, busy);
  const placed = { x: res.x + off.dx, y: res.y + off.dy, w: res.w, h: res.h };
  for (const o of [...busy, src]) assert.ok(!(placed.x < o.x + o.w && o.x < placed.x + placed.w && placed.y < o.y + o.h && o.y < placed.y + placed.h), JSON.stringify(placed));
  assert.ok(placed.x >= 0 && placed.y >= 0 && placed.x + placed.w <= 595 && placed.y + placed.h <= 842);
});
