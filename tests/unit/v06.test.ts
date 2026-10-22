import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe as describeInk, recognizeChar, recognizeLine, hanziDb, type Pt } from '../../src/recognition/offline/hanzi';
import { recognizeOfflineText } from '../../src/recognition/offline/engine';
import { parseJiixText } from '../../src/recognition/myscript';
import { HandwritingRecognitionService } from '../../src/recognition/service';
import { sanitizeRecognitionSettings } from '../../src/recognition/settings';
import { AIService, defaultAISettings, type AISettings } from '../../src/ai/service';
import type { InkStrokeIn } from '../../src/recognition/types';
import { rng, gauss } from './helpers';

const FIX = JSON.parse(readFileSync('tests/fixtures/hanzi-medians.json', 'utf8')) as { chars: Record<string, number[][][]> };

/** Synthetic "handwriting" from Make Me a Hanzi stroke medians: densified, wobbled, slanted, scaled. */
function ink(ch: string, level: number, r: () => number, ox = 0, size = 40): Pt[][] {
  const m = FIX.chars[ch];
  const slant = (r() - 0.5) * 0.25 * level;
  const sx = 1 + (r() - 0.5) * 0.25 * level;
  const sy = 1 + (r() - 0.5) * 0.2 * level;
  return m.map((st) => {
    const out: Pt[] = [];
    const wob = [gauss(r) * level * 12, gauss(r) * level * 12];
    for (let k = 1; k < st.length; k++) {
      const [ax, ay] = st[k - 1];
      const [bx, by] = st[k];
      const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 12));
      for (let q = 0; q < n; q++) {
        const t = q / n;
        const x = ax + (bx - ax) * t + gauss(r) * 4 * level + wob[0] * Math.sin(t * 3);
        const y = 900 - (ay + (by - ay) * t) + gauss(r) * 4 * level + wob[1] * Math.cos(t * 3);
        out.push([ox + ((x * sx + y * slant) / 1024) * size, ((y * sy) / 1024) * size]);
      }
    }
    const l = st[st.length - 1];
    out.push([ox + (l[0] / 1024) * size * sx, ((900 - l[1]) / 1024) * size * sy]);
    return out;
  });
}

test('0.6 offline: ink description — direction 0 = right, 64 = up, 192 = down; dots stay one sub-stroke', () => {
  const right = describeInk([[[0, 0], [10, 0], [20, 0], [30, 0]], [[0, 5], [0, 15], [0, 25], [0, 35]]]);
  assert.equal(right.strokeCount, 2);
  assert.equal(right.subs[0].dir, 0);
  assert.equal(right.subs[1].dir, 192);
  const turn = describeInk([[[0, 0], [10, 0], [20, 0], [30, 0], [30, 10], [30, 20], [30, 30]]]);
  assert.equal(turn.subs.length, 2, 'a 90° corner splits the stroke');
  const dot = describeInk([[[5, 5], [5.5, 5.4], [6, 6]]]);
  assert.equal(dot.subs.length, 1);
});

test('0.6 offline: the template table decodes (9,507 characters, GB2312 levels)', () => {
  const d = hanziDb();
  assert.equal(d.chars.length, 9507);
  assert.ok(d.chars.includes('雪') && d.chars.includes('花') && d.chars.includes('香'));
  assert.ok([...d.gb].filter((x) => x === 1).length >= 3700);
});

test('0.6 offline: single characters from synthetic ink — clean and perturbed (measured, not a promise)', () => {
  const r = rng(11);
  const chars = Object.keys(FIX.chars);
  const res: Record<string, [number, number]> = {};
  for (const level of [0, 1]) {
    let t1 = 0;
    let t5 = 0;
    for (const ch of chars) {
      const c = recognizeChar(ink(ch, level, r));
      if (c[0]?.ch === ch) t1++;
      if (c.slice(0, 5).some((x) => x.ch === ch)) t5++;
    }
    res[level] = [t1 / chars.length, t5 / chars.length];
  }
  // thresholds a little below the measured values (synthetic ink derived from the template source)
  assert.ok(res[0][0] >= 0.8 && res[0][1] >= 0.93, `clean ${JSON.stringify(res[0])}`);
  assert.ok(res[1][0] >= 0.65 && res[1][1] >= 0.85, `perturbed ${JSON.stringify(res[1])}`);
});

test('0.6 offline: a line is split into characters (left/right components such as 明 and 们 stay one character)', async () => {
  const r = rng(5);
  for (const phrase of ['雪花香', '明天们', '具身智能']) {
    const strokes: { pts: Pt[]; t: number }[] = [];
    let x = 0;
    let t = 0;
    for (const ch of Array.from(phrase)) {
      for (const s of ink(ch, 0.3, r, x, 40)) strokes.push({ pts: s, t: t++ });
      x += 48;
    }
    const line = await recognizeLine(strokes, 40);
    assert.equal(line.length, Array.from(phrase).length, `${phrase}: ${line.map((c) => c.candidates[0]?.ch).join('')}`);
    assert.ok(line.every((c) => c.candidates.length >= 3), 'candidates for correction');
  }
});

function toIn(strokes: Pt[][], t0: number, idp: string): InkStrokeIn[] {
  return strokes.map((s, i) => ({ id: `${idp}${i}`, xs: s.map((p) => p[0]), ys: s.map((p) => p[1]), ts: s.map((_, k) => t0 + i * 400 + k * 8), ps: s.map(() => 0.5) }));
}

test('0.6 offline engine: lines in order, characters as tokens with candidates, dictionary words preferred, cancellable', async () => {
  const r = rng(3);
  const ink1: InkStrokeIn[] = [];
  let x = 0;
  for (const [i, ch] of Array.from('雪花香').entries()) {
    ink1.push(...toIn(ink(ch, 0.2, r, x, 40), i * 4000, `a${i}_`));
    x += 48;
  }
  x = 0;
  for (const [i, ch] of Array.from('视觉伺服').entries()) {
    ink1.push(...toIn(ink(ch, 0.2, r, x, 40).map((s) => s.map(([px, py]) => [px, py + 80] as Pt)), 20000 + i * 4000, `b${i}_`));
    x += 48;
  }
  const res = await recognizeOfflineText(ink1, ['视觉伺服']);
  assert.equal(res.lines.length, 2);
  assert.equal(res.lines[0].tokens?.length, 3);
  assert.equal(res.lines[1].text, '视觉伺服', `dictionary word (${res.lines[1].text})`);
  assert.ok(res.lines.every((l) => l.tokens?.every((tk) => tk.candidates.length >= 1)));
  assert.ok(res.warnings.includes('i18n:offlineLimits'));
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(recognizeOfflineText(ink1, [], ctrl.signal), (e: unknown) => (e as { code?: string }).code === 'cancelled');
});

test('0.6 MyScript JIIX: words become tokens with their candidates', () => {
  const r = parseJiixText({ label: '具身智能 SLAM', words: [{ label: '具身智能', candidates: ['具身智能', '具身知能', '具身智熊'] }, { label: ' ' }, { label: 'SLAM', candidates: ['SLAM', 'SLAN'] }] });
  assert.equal(r.lines.length, 1);
  const tk = r.lines[0].tokens!;
  assert.deepEqual(tk.map((x) => x.text), ['具身智能', ' ', 'SLAM']);
  assert.deepEqual(tk[0].candidates, ['具身知能', '具身智熊']);
  assert.deepEqual(tk[2].candidates, ['SLAN']);
});

function svc(patch: Partial<AISettings['recognition']> = {}, ai: Partial<AISettings> = {}) {
  const s: AISettings = { ...defaultAISettings(), enabled: true, defaultModel: 'mock-1', ...ai };
  s.recognition = { ...s.recognition, ...patch };
  const deps = { settings: () => s, saveSettings: (x: AISettings) => void Object.assign(s, x), getSecret: () => 'k', secretsSupported: true, http: async () => ({ status: 500, text: '' }) };
  return new HandwritingRecognitionService({ ai: new AIService(deps), settings: () => s, recognition: () => s.recognition, getSecret: () => 'k', secretsSupported: true, http: deps.http });
}

test('0.6 routing: Convert → Text / Math never silently uses a chat model', () => {
  // defaults: no MyScript → offline Chinese for text; math has no engine (explained, not guessed)
  let r = svc();
  assert.equal(r.engineFor('text').engine, 'offline');
  assert.equal(r.engineFor('text').sends, 'nothing');
  assert.equal(r.engineFor('math').ready, false);
  assert.equal(r.engineFor('math').reason, 'math-needs-myscript');
  assert.equal(r.engineFor('mindmap').kind === 'vision-llm' || r.engineFor('mindmap').kind === 'demo', true, 'AI tools use the vision model');
  // MyScript chosen (0.7: no longer implied by keys alone) → MyScript for both, even with the general AI switch off
  r = svc({ engine: 'myscript', myscriptAppKeySecret: 'ms-app' }, { enabled: false });
  assert.equal(r.engineFor('text').engine, 'myscript');
  assert.equal(r.engineFor('math').engine, 'myscript');
  assert.equal(r.engineFor('math').ready, true);
  // offline off, no MyScript, no fallback → nothing
  r = svc({ offlineZh: false });
  assert.equal(r.engineFor('text').ready, false);
  // explicit fallback → vision model, labelled as such
  r = svc({ offlineZh: false, visionFallback: true });
  assert.ok(['vision', 'mock'].includes(r.engineFor('text').engine));
  assert.equal(r.engineFor('text').sends, 'image');
  // forcing offline for math is not ready
  r = svc({ engine: 'offline' });
  assert.equal(r.engineFor('math').ready, false);
  assert.equal(r.engineFor('math').reason, 'math-not-offline');
});

test('0.6 settings: offline on, vision fallback off by default; 0.5 settings migrate', () => {
  const d = sanitizeRecognitionSettings({});
  assert.equal(d.offlineZh, true);
  assert.equal(d.visionFallback, false);
  assert.equal(d.engine, 'auto');
  const old = sanitizeRecognitionSettings({ engine: 'vision', lexicon: ['SLAM'], myscriptHost: 'cloud.myscript.com' });
  assert.equal(old.engine, 'vision', 'an explicit 0.5 choice is kept');
  assert.equal(sanitizeRecognitionSettings({ engine: 'offline' }).engine, 'offline');
});

test('0.6 MyScript diagnosis: unreachable server vs refused keys vs success are told apart', async () => {
  const mk = (http: (r: { url: string; method: string }) => Promise<{ status: number; text: string }>) => {
    const s: AISettings = { ...defaultAISettings() };
    s.recognition = { ...s.recognition, myscriptAppKeySecret: 'ms-app', myscriptHmacSecret: 'ms-hmac' };
    return new HandwritingRecognitionService({ ai: null, settings: () => s, recognition: () => s.recognition, getSecret: () => 'k', secretsSupported: true, http: http as never });
  };
  const down = await mk(async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }).testMyScript();
  assert.equal(down.step, 'network');
  const refused = await mk(async (r) => (r.method === 'GET' ? { status: 200, text: '{"version":"3.2.1"}' } : { status: 401, text: '{"code":"access.not.granted","message":"Access not granted"}' })).testMyScript();
  assert.equal(refused.step, 'auth');
  assert.equal(refused.version, '3.2.1');
  const ok = await mk(async (r) => (r.method === 'GET' ? { status: 200, text: '{"version":"3.2.1"}' } : { status: 200, text: JSON.stringify({ label: '一', words: [{ label: '一', candidates: ['一', '-'] }] }) })).testMyScript();
  assert.equal(ok.ok, true);
  assert.equal(ok.label, '一');
  const nokey = await new HandwritingRecognitionService({ ai: null, settings: () => defaultAISettings(), recognition: () => defaultAISettings().recognition, getSecret: () => null, secretsSupported: true, http: (async () => ({ status: 200, text: '' })) as never }).testMyScript();
  assert.equal(nokey.step, 'config');
});
