// 0.11.1-beta.5: iPadOS re-delivers the previous coalesced samples with a newer timestamp
// (a, b, a, b per frame). Found in a real note: half of all samples, a backward jump every frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INK_PIPELINE, StrokeBuilder, isRedelivered } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';
import type { InputSample } from '../../src/ink/types';

const fountain = DEFAULT_PEN_PARAMS.fountain;

/** A slow vertical line at 240 Hz with fractional coordinates, as the Pencil reports it. */
function cleanLine(): InputSample[] {
  const n = 120;
  return Array.from({ length: n }, (_, i) => ({ x: 100.37 + 0.013 * i, y: 50.21 + 0.71 * i + 0.002 * i * i, p: 0.1 + 0.02 * Math.sin(i / 9), t: i * (1000 / 240) }));
}

/** The same input as iPadOS delivers it: each 2-sample frame is followed by a copy of itself stamped with the frame's time. */
function redelivered(clean: InputSample[]): InputSample[] {
  const out: InputSample[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const a = clean[i];
    const b = clean[i + 1];
    out.push(a, b, { ...a, t: b.t }, { ...b });
  }
  return out;
}

function build(raw: InputSample[]) {
  const b = new StrokeBuilder('fountain', fountain, { zoom: 3, hasPressure: true, ink: INK_PIPELINE });
  for (const s of raw) b.add(s);
  return { geom: b.commitGeometry(), raw: b.rawSamples };
}

test('beta.5: re-delivered coalesced samples (a, b, a, b) are dropped — same ink as the clean input', () => {
  const clean = cleanLine();
  const dirty = redelivered(clean);
  assert.equal(dirty.length, clean.length * 2);
  const a = build(clean);
  const b = build(dirty);
  assert.equal(b.raw.length, clean.length);
  assert.deepEqual(b.geom, a.geom);
});

test('beta.5: without the fix the stroke would step backwards every frame', () => {
  const dirty = redelivered(cleanLine());
  let back = 0;
  for (let i = 2; i < dirty.length; i++) {
    const [p, q, r] = [dirty[i - 2], dirty[i - 1], dirty[i]];
    if ((q.y - p.y) * (r.y - q.y) < 0) back++;
  }
  assert.ok(back > 50);
});

test('beta.5: a pen held still keeps its pressure changes; a real return to a point is not a repeat by chance', () => {
  const s = (x: number, y: number, p: number, t: number): InputSample => ({ x, y, p, t });
  const raw = [s(1.5, 2.5, 0.1, 0), s(1.7, 2.9, 0.1, 4)];
  assert.equal(isRedelivered(raw, s(1.7, 2.9, 0.2, 8)), false); // held still, pressing harder
  assert.equal(isRedelivered(raw, s(1.7, 2.9, 0.1, 8)), true); // exact copy of the last sample
  assert.equal(isRedelivered(raw, s(1.5, 2.5, 0.1, 8)), true); // the sample before, again
  assert.equal(isRedelivered(raw, s(1.9, 3.3, 0.1, 8)), false); // moving on
  assert.equal(isRedelivered([], s(1, 1, 0.1, 0)), false);
});

test('beta.5: old strokes (no ink pipeline) are rebuilt exactly as before, repeats included', () => {
  const dirty = redelivered(cleanLine());
  const b = new StrokeBuilder('fountain', fountain, { zoom: 3, hasPressure: true });
  for (const x of dirty) b.add(x);
  assert.equal(b.rawSamples.length, dirty.length);
});
