/**
 * Ink Lab: the HandNote editor running in a plain web page (no Obsidian).
 * Used for Phase 1 prototyping and automated browser tests. Open index.html after `npm run lab`.
 */
import { HandNoteEditor } from '../../src/editor/handnote-editor';
import { defaultEditorSettings, sanitizeEditorSettings } from '../../src/editor/settings';
import { createDocument } from '../../src/document/model';
import { parseDocument, serializeDocument } from '../../src/document/codec';
import { setLanguage } from '../../src/ui/i18n';
import { AIService, defaultAISettings, type AISettings } from '../../src/ai/service';
import type { AIBridge } from '../../src/editor/handnote-editor';
import { HandwritingRecognitionService } from '../../src/recognition/service';
import type { RecognitionBridge } from '../../src/editor/convert-flow';
import { mapLayout, mapToPage } from '../../src/mindmap/paint';
import type { MindMapItem } from '../../src/document/items';
import { LocalRecognition } from '../../src/local';
import { IdbStore, MemoryStore } from '../../src/local/store';
import { runSelfTest, selfTestReport } from '../../src/local/selftest';
import { MATH_CASES, mathInk } from '../../src/local/synthetic-math';
import { CONFIDENCE } from '../../src/local';
import { MATH_EDITION } from '@edition/math';

const KEY = 'handnote-lab-doc';
const SKEY = 'handnote-lab-settings';

function loadDoc() {
  try {
    const t = localStorage.getItem(KEY);
    if (t) return parseDocument(t).doc;
  } catch {
    /* ignore */
  }
  return createDocument({ pages: 2 });
}

const params = new URLSearchParams(location.search);
if (params.has('fresh')) {
  localStorage.removeItem(KEY);
  localStorage.removeItem(SKEY);
}
let settings = defaultEditorSettings();
try {
  settings = sanitizeEditorSettings(JSON.parse(localStorage.getItem(SKEY) || 'null'));
} catch {
  /* ignore */
}
if (params.has('hud')) settings.showHud = true;
const langParam = params.get('lang');
if (langParam === 'zh' || langParam === 'en') setLanguage(langParam);
const modeParam = params.get('mode');
if (modeParam === 'pen' || modeParam === 'mouse') settings.inputMode = modeParam;

// AI in the lab: the offline mock provider only (no network, no keys). ?ai=off = not configured.
let aiSettings: AISettings = { ...defaultAISettings(), enabled: params.get('ai') !== 'off', defaultModel: 'mock-1' };
// recognition: ?rec=vision|offline|myscript, ?fallback=1 (vision fallback), ?offline=0
aiSettings.recognition = {
  ...aiSettings.recognition,
  ...(params.get('rec') ? { engine: params.get('rec') as 'auto' } : {}),
  visionFallback: params.get('fallback') === '1',
  offlineZh: params.get('offline') !== '0',
  convertMode: params.get('cmode') === 'preview' ? 'preview' : 'instant',
  keepInk: params.get('keepink') === '1',
  myscriptAlwaysSend: params.get('always') === '1',
  prefetch: params.get('prefetch') === '1' ? 'lasso' : params.get('prefetch') === 'off' ? 'off' : 'menu',
  // ?msfake=1: a local stand-in for the MyScript server (lab only — tests the flow, not accuracy)
  ...(params.get('msfake') ? { myscriptAppKeySecret: 'lab-myscript', myscriptHmacSecret: 'lab-myscript-hmac' } : {}),
};
const msFake = params.get('msfake') === '1';
const msDelay = Number(params.get('msdelay') ?? 300);
const msLog: { method: string; url: string; t: number }[] = [];
async function fakeMyScript(r: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; text: string; via?: string }> {
  msLog.push({ method: r.method, url: r.url, t: performance.now() });
  await new Promise((res) => setTimeout(res, r.method === 'GET' ? 20 : msDelay));
  if (r.method === 'GET') return { status: 200, text: '{"version":"lab"}', via: 'lab' };
  const body = JSON.parse(r.body ?? '{}') as { contentType?: string; strokes?: unknown[] };
  if (body.contentType === 'Math') return { status: 200, text: '\\sqrt{x^{2}+y^{2}}' };
  return {
    status: 200,
    text: JSON.stringify({ label: '雪花香', words: [{ label: '雪', candidates: ['雪', '雷', '雲'] }, { label: '花', candidates: ['花', '化'] }, { label: '香', candidates: ['香', '杳', '昏'] }] }),
  };
}
if (params.get('aimodel')) {
  aiSettings.modelEntries = [...aiSettings.modelEntries, { id: 'mock-x', name: 'mock-x', profileId: 'mock', model: params.get('aimodel') as string, multimodal: true }];
  aiSettings.defaultModel = 'mock-x';
}
let aiHttpCalls = 0;
const aiService = new AIService({
  settings: () => aiSettings,
  saveSettings: (s) => (aiSettings = s),
  getSecret: () => null,
  secretsSupported: false,
  http: async () => {
    aiHttpCalls++;
    throw new Error('the lab never uses the network');
  },
});
const ai: AIBridge = {
  status: () => aiService.status(),
  model: (task) => aiService.model(task),
  label: () => 'Mock (offline demo)',
  textFont: () => aiSettings.textFont,
  run: (task, image, meta, signal) => aiService.run(task, image, meta, signal),
};

// Local recognition in the lab: model files come from ./local-assets (fetched by
// scripts/fetch-local-assets.mjs) instead of the CDNs; ?localstore=memory keeps them in memory.
const LOCAL_FILES: Record<string, string> = {
  'ort.wasm.bundle.min.mjs': 'ort/dist/ort.wasm.bundle.min.mjs',
  'ort-wasm-simd-threaded.wasm': 'ort/dist/ort-wasm-simd-threaded.wasm',
  // private edition: the local math model's files
  ...(MATH_EDITION?.devAssets ?? {}),
  'inference.onnx': 'ppocrv5-mobile-rec/inference.onnx',
  'ppocrv5_dict.txt': 'ppocrv5-mobile-rec/ppocrv5_dict.txt',
  'ppocrv5_en_dict.txt': 'en-ppocrv5-mobile-rec/ppocrv5_en_dict.txt',
};
const localFetches: string[] = [];
// ?nodecompress simulates iOS / iPadOS before 16.4 (no DecompressionStream)
if (params.has('nodecompress')) delete (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
const local = new LocalRecognition(
  async (url) => {
    const name = url.split('#')[0].split('/').pop() as string;
    const tarMember = url.includes('#tar=') ? url.split('#tar=')[1] : null;
    const file = (url.includes('en_PP-OCRv5') ? 'en-ppocrv5-mobile-rec/inference.onnx' : undefined) ?? LOCAL_FILES[tarMember ?? name] ?? (name.startsWith('Excalifont-') ? `fonts/Excalifont/${name}` : name.startsWith('Xiaolai-') ? `fonts/Xiaolai/${name}` : undefined);
    localFetches.push(url);
    if (!file || params.get('localnet') === 'fail') throw new Error('lab: offline mirror has no ' + name);
    const r = await fetch(`../../local-assets/${file}`);
    if (!r.ok) throw new Error(`lab: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (params.get('localcorrupt') === name) new Uint8Array(buf)[100] ^= 255;
    return buf;
  },
  params.get('localstore') === 'memory' ? new MemoryStore() : undefined,
  { idleMs: 0 },
);
void local.refresh();
if (params.get('localconf') === 'strict') Object.assign(CONFIDENCE, { mathScore: 1, textMinP: 2 });

const recService = new HandwritingRecognitionService({
  local: params.get('local') === '0' ? undefined : local,
  ai: aiService,
  settings: () => aiSettings,
  recognition: () => aiSettings.recognition,
  getSecret: (name) => (msFake && name.startsWith('lab-myscript') ? 'lab-key' : null),
  secretsSupported: msFake,
  http: async (r) => {
    if (msFake) return fakeMyScript(r);
    aiHttpCalls++;
    throw new Error('the lab never uses the network');
  },
});
const recognizer: RecognitionBridge = {
  engineFor: (task) => {
    const e = recService.engineFor(task);
    return e.engine === 'mock' ? { ...e, label: 'Mock (offline demo)' } : e;
  },
  enableOffline: () => {
    aiSettings = { ...aiSettings, recognition: { ...aiSettings.recognition, offlineZh: true } };
  },
  recognize: (task, input, signal, onStage) => recService.recognize(task, input, signal, onStage),
  textFont: () => aiSettings.textFont,
  mapTheme: () => aiSettings.recognition.mapTheme,
  record: (run, ms, task) => recService.record(run, ms, task),
  prefs: () => {
    const r = aiSettings.recognition;
    return { mode: r.convertMode, keepInk: r.keepInk, alwaysSend: r.myscriptAlwaysSend, prefetch: r.prefetch };
  },
  setAlwaysSend: (on) => {
    aiSettings = { ...aiSettings, recognition: { ...aiSettings.recognition, myscriptAlwaysSend: on } };
  },
  warmUp: () => recService.warmUp(),
  warmLocal: (task) => recService.warmLocal(task),
  prepareText: (text) => local.fonts.ensure(text),
  englishMissingBytes: () => (local.available('text-en') ? local.missingBytes('text-en') : undefined),
  installEnglish: async (progress) => {
    await local.install('text-en', (p) => progress(`${p.done}/${p.total}`));
    recService.clearCache();
  },
  fontMissingBytes: () => (local.available('font-hand') ? local.missingBytes('font-hand') : undefined),
  installFont: async (progress) => {
    await local.install('font-hand', (p) => progress(`${p.done}/${p.total}`));
  },
  localMissingBytes: (task) => {
    const id = task === 'math' ? 'math' : 'text-zh';
    return local.available(id) ? local.missingBytes(id) : undefined;
  },
  installLocal: async (task, progress) => {
    await local.install(task === 'math' ? 'math' : 'text-zh', (p) => progress(`${p.file} ${p.done + 1}/${p.total}`));
    recService.clearCache();
  },
  rtt: () => recService.networkRtt(),
};

const container = document.getElementById('app') as HTMLElement;
let saves = 0;
const exports: { index: number; kind: string }[] = [];
const editor = new HandNoteEditor(container, loadDoc(), settings, {
  onChange() {
    localStorage.setItem(KEY, serializeDocument(editor.getDocument()));
    saves++;
  },
  onSettingsChange(s) {
    localStorage.setItem(SKEY, JSON.stringify(s));
  },
  ai,
  recognizer,
  exportPage: (index, kind) => exports.push({ index, kind }),
  menuActions: [
    {
      label: 'Clear document',
      run: () => {
        localStorage.removeItem(KEY);
        editor.setDocument(createDocument({ pages: 2 }));
      },
    },
  ],
});


// test hooks
(window as unknown as Record<string, unknown>).__hn = {
  local,
  /** a fresh model-database connection (tests of the upgrade / blocked behaviour) */
  idbStore: (blockedMs?: number) => new IdbStore(blockedMs),
  localFetches: () => localFetches,
  runtimeBuiltIn: () => local.runtimeBuiltIn,
  edition: () => (__HN_PRIVATE__ ? 'private' : 'public'),
  /** Synthetic formula strokes (page units) for tests: MATH_CASES[i] at (x, y). */
  mathCase: (i: number, x = 80, y = 140, size = 30) => ({ name: MATH_CASES[i].name, latex: MATH_CASES[i].latex, strokes: mathInk(MATH_CASES[i].node, { x, y, size, seed: 5 + i, jitter: 0.6 }) }),
  selfTest: async () => selfTestReport(await runSelfTest(local, () => undefined)),
  editor,
  serialize: () => serializeDocument(editor.getDocument()),
  saves: () => saves,
  exports: () => exports,
  perf: () => editor.perf.snapshot(),
  ai: () => ({ settings: aiSettings, httpCalls: aiHttpCalls }),
  rec: () => ({ stats: recService.stats(), timings: recService.recentTimings() }),
  /** Requests the lab's stand-in MyScript server received (?msfake=1). */
  myscript: () => msLog.map((x) => ({ method: x.method, url: x.url })),
  /** Page positions of a mind map's visible topics (tests). */
  mapNodes: (id: string) => {
    for (const p of editor.getDocument().pages) {
      const it = p.items.find((i) => i.id === id) as MindMapItem | undefined;
      if (!it || it.type !== 'mindmap') continue;
      const l = mapLayout(it);
      return l.nodes.map((n) => {
        const [x, y] = mapToPage(it, l, n.x + n.w / 2, n.y + n.h / 2);
        return { id: n.id, text: n.lines.join(''), depth: n.depth, x, y, w: n.w * it.scale, h: n.h * it.scale, color: n.color };
      });
    }
    return [];
  },
};
