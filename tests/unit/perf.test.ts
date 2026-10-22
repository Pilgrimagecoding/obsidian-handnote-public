import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrokeBuilder, buildStrokeGeometry } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS, EXPERIMENTAL_FOUNTAIN } from '../../src/ink/presets';
import { CountingSink, emitGeometry } from '../../src/ink/outline';
import { parseDocument, quantizeSample, serializeDocument } from '../../src/document/codec';
import { createDocument, newId } from '../../src/document/model';
import { circle, samplePath } from './helpers';

/**
 * Processing-cost measurements in Node (V8, this machine). They bound the CPU work of the ink
 * pipeline; they say nothing about iPad WebKit timings or end-to-end pen latency.
 */
const results: Record<string, string> = {};

function time<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

test('per-sample processing cost during fast handwriting (240 Hz input)', () => {
  const raw = samplePath(circle(100, 100, 15), { durationMs: 4000, hz: 240, noise: 0.05 });
  const b = new StrokeBuilder('fountain', DEFAULT_PEN_PARAMS.fountain, { zoom: 2, hasPressure: true });
  // simulate per-frame work: add 4 samples (one 60 Hz frame of 240 Hz input) then compute the tail
  const frameTimes: number[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    const t0 = performance.now();
    for (let j = i; j < Math.min(i + 4, raw.length); j++) b.add(raw[j]);
    b.tail();
    frameTimes.push(performance.now() - t0);
  }
  frameTimes.sort((a, c) => a - c);
  const p95 = frameTimes[Math.floor(frameTimes.length * 0.95)];
  results['frame processing p95 (ms)'] = p95.toFixed(4);
  assert.ok(p95 < 2, `p95 ${p95}`);
});

test('per-sample processing cost, Fountain Experimental (engine 2)', () => {
  const raw = samplePath(circle(100, 100, 15), { durationMs: 4000, hz: 240, noise: 0.05, pressure: (u) => 0.2 + 0.3 * Math.sin(u * 40) ** 2 });
  const b = new StrokeBuilder('fountain', EXPERIMENTAL_FOUNTAIN, { zoom: 2, hasPressure: true, engine: 2 });
  const frameTimes: number[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    const t0 = performance.now();
    for (let j = i; j < Math.min(i + 4, raw.length); j++) b.add(raw[j]);
    b.tail();
    frameTimes.push(performance.now() - t0);
  }
  frameTimes.sort((a, c) => a - c);
  const p95 = frameTimes[Math.floor(frameTimes.length * 0.95)];
  results['frame processing p95, engine 2 (ms)'] = p95.toFixed(4);
  assert.ok(p95 < 2, `p95 ${p95}`);
});

test('long stroke geometry (4000 samples)', () => {
  const raw = samplePath(circle(200, 200, 150), { durationMs: 16000, hz: 250 });
  const { ms, value } = time(() => buildStrokeGeometry(raw, 'fountain', DEFAULT_PEN_PARAMS.fountain, { zoom: 1.5, hasPressure: true }));
  const c = new CountingSink();
  emitGeometry(c, value);
  results['long stroke build (ms)'] = ms.toFixed(2);
  results['long stroke outline sub-paths'] = String(c.subpaths);
  assert.ok(ms < 200);
});

test('many strokes: build + serialize + parse a dense page (600 strokes)', () => {
  const doc = createDocument({ pages: 1 });
  for (let i = 0; i < 600; i++) {
    const cx = 40 + (i % 20) * 26;
    const cy = 40 + Math.floor(i / 20) * 26;
    doc.pages[0].strokes.push({
      id: newId('s'),
      tool: 'fountain',
      color: '#1a1a1a',
      params: { ...DEFAULT_PEN_PARAMS.fountain },
      zoom: 1.5,
      hasPressure: true,
      engine: 1,
      created: 0,
      samples: samplePath(circle(cx, cy, 6), { durationMs: 300, hz: 240, seed: i }).map(quantizeSample),
    });
  }
  const build = time(() => {
    for (const s of doc.pages[0].strokes) buildStrokeGeometry(s.samples, s.tool, s.params, { zoom: s.zoom, hasPressure: true });
  });
  const ser = time(() => serializeDocument(doc));
  const par = time(() => parseDocument(ser.value));
  results['600 strokes geometry (ms)'] = build.ms.toFixed(1);
  results['600 strokes serialize (ms)'] = ser.ms.toFixed(1);
  results['600 strokes parse (ms)'] = par.ms.toFixed(1);
  results['600 strokes file size (KB)'] = (ser.value.length / 1024).toFixed(0);
  assert.equal(par.value.doc.pages[0].strokes.length, 600);
});

test('report', () => {
  console.log('\nPERF (Node/V8, not iPad):\n' + Object.entries(results).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
});
