declare const __HN_PRIVATE__: boolean;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PACKS } from '../../src/local/manifest';
import { MemoryStore } from '../../src/local/store';
import { BundledRuntimeModels, embeddedRuntimeBuilt } from '../../src/local/embedded-runtime';
import { LocalRecognition } from '../../src/local';
import { HandwritingRecognitionService, type LocalApi } from '../../src/recognition/service';
import { defaultAISettings, type AISettings } from '../../src/ai/service';

// 0.8.0-beta.3: ONNX Runtime Web is built into main.js (never downloaded)
const built = embeddedRuntimeBuilt();

test('0.8 built-in runtime: decompressed files equal the pinned runtime pack; nothing is stored or deleted', { skip: !built && 'build made with HN_EMBED_ORT=0' }, async () => {
  const mem = new MemoryStore();
  const m = new BundledRuntimeModels(mem);
  const st = await m.state('runtime');
  assert.equal(st.installed, true);
  for (const f of PACKS.runtime.files) {
    assert.equal(await m.has('runtime', f.name), true);
    const data = await m.file('runtime', f.name);
    assert.equal(data.byteLength, f.bytes, `${f.name} size`);
    assert.equal(createHash('sha256').update(new Uint8Array(data)).digest('hex'), f.sha256, `${f.name} SHA-256`);
    await m.save('runtime', f, data); // ignored
  }
  await m.remove('runtime'); // ignored
  assert.equal((await mem.meta('runtime/ort-wasm-simd-threaded.wasm').catch(() => undefined)) ?? null, null, 'nothing written to the model store');
  // the other packs still use the store
  assert.equal((await m.state('math')).installed, false);
});

test('0.8 old systems (no DecompressionStream): local recognition is off, nothing is downloaded, the reason is shown', { skip: !built && 'build made with HN_EMBED_ORT=0' }, async () => {
  const g = globalThis as { DecompressionStream?: unknown };
  const saved = g.DecompressionStream;
  delete g.DecompressionStream;
  try {
    const fetched: string[] = [];
    const local = new LocalRecognition(async (url) => {
      fetched.push(url);
      return new ArrayBuffer(0);
    }, new MemoryStore());
    await local.refresh();
    assert.equal(local.runtimeBuiltIn, true);
    assert.match(local.unsupported() ?? '', /16\.4/);
    assert.equal(local.state('runtime')?.installed, false);
    for (const id of ['runtime', 'math', 'text-zh', 'text-en'] as const) assert.equal(local.available(id), false, `${id} not offered`);
    assert.equal(local.available('font-hand'), true, 'the hand font does not need the runtime');
    assert.equal(local.ready('math'), false);
    await assert.rejects(() => local.install(__HN_PRIVATE__ ? 'math' : 'text-zh'), /unavailable/);
    await assert.rejects(() => local.models.file('runtime', 'ort-wasm-simd-threaded.wasm'), /unavailable/);
    assert.deepEqual(fetched, [], 'no download at all');
  } finally {
    g.DecompressionStream = saved;
  }
});

function svc(local: LocalApi, engine: AISettings['recognition']['engine'] = 'auto') {
  const s: AISettings = { ...defaultAISettings(), enabled: true, defaultModel: 'mock-1' };
  s.recognition = { ...s.recognition, engine, myscriptAppKeySecret: 'ms' };
  return new HandwritingRecognitionService({ local, ai: null, settings: () => s, recognition: () => s.recognition, getSecret: () => 'k', secretsSupported: true, http: (async () => ({ status: 500, text: '' })) as never });
}

test('0.8 routing: an unsupported system explains "needs iPadOS 16.4" instead of offering a model; MyScript still works', () => {
  const api: LocalApi = {
    ready: () => true,
    unsupported: () => 'this system has no DecompressionStream (needs iPadOS / iOS 16.4 or newer)',
    math: async () => Promise.reject(new Error('unused')),
    text: async () => Promise.reject(new Error('unused')),
    warm: () => undefined,
  };
  const r = svc(api);
  assert.equal(r.engineFor('math').ready, false);
  assert.equal(r.engineFor('math').reason, 'local-unsupported');
  assert.equal(svc(api, 'myscript').engineFor('math').engine, 'myscript');
});
