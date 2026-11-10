// 0.12 shape pen (second round): casual lines, tilted ellipses / rectangles, pentagons and hexagons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape, regularize } from '../../src/ink/shape-recognition';
import { densify, handStroke } from './handshapes';

type Pt = [number, number];

// 0.12.0-beta.9 (maintainer: "a slightly bent line becomes a straight line"): a line drawn with a
// wobble or a bow of up to 3 % stays a line; a smooth bow of 6 % or more is a curve (gentle bend threshold 4.5 %)
function bowed(len: number, ang: number, bow: number, seed: number): ReturnType<typeof recognizeShape> {
  const a = (ang * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const ideal: Pt[] = Array.from({ length: 41 }, (_, i) => {
    const u = i / 40;
    const off = bow * len * 4 * u * (1 - u);
    return [300 + ux * u * len - uy * off, 300 + uy * u * len + ux * off];
  });
  return recognizeShape(handStroke(ideal, { seed, wobble: 0.012 }));
}

test('shape pen: casual straight lines (any angle, bowed up to 3 %) become lines', () => {
  let ok = 0;
  let n = 0;
  for (const len of [60, 150, 400])
    for (const ang of [0, 30, 60, 90, 120, 160])
      for (const bow of [0, 0.015, 0.03])
        for (let s = 0; s < 2; s++) {
          n++;
          if (bowed(len, ang, bow, 7 + s * 13 + ang + len)?.kind === 'line') ok++;
        }
  console.log(`  casual lines: ${ok}/${n}`);
  assert.ok(ok / n >= 0.9, `${ok}/${n}`);
});

test('shape pen: a gently bent line (a smooth bow of 6–9 %; ≥ 85 %) is a curve', () => {
  let ok = 0;
  let n = 0;
  for (const len of [80, 150, 400])
    for (const ang of [0, 30, 60, 90, 120, 160])
      for (const bow of [0.06, 0.075, 0.09])
        for (let s = 0; s < 2; s++) {
          n++;
          if (bowed(len, ang, bow, 11 + s * 17 + ang + len)?.kind === 'curve') ok++;
        }
  console.log(`  gentle curves: ${ok}/${n}`);
  assert.ok(ok / n >= 0.85, `${ok}/${n}`);
});

const ellipse = (cx: number, cy: number, a: number, b: number, rot: number): Pt[] =>
  Array.from({ length: 97 }, (_, i) => {
    const t = (i / 96) * Math.PI * 2 + 0.3;
    const u = a * Math.cos(t);
    const v = b * Math.sin(t);
    return [cx + u * Math.cos(rot) - v * Math.sin(rot), cy + u * Math.sin(rot) + v * Math.cos(rot)];
  });

test('shape pen: a tilted ellipse is an ellipse with that tilt', () => {
  let ok = 0;
  let n = 0;
  for (const deg of [20, 35, 45, 60, -30])
    for (const size of [80, 200])
      for (let s = 0; s < 3; s++) {
        n++;
        const rot = (deg * Math.PI) / 180;
        const r = recognizeShape(handStroke(ellipse(300, 300, size, size * 0.5, rot), { seed: 3 + s * 7 + size, wobble: 0.006 }));
        if (r?.kind !== 'ellipse') continue;
        const tilt = r.rot ?? 0;
        // the long side along the drawn axis (w ≥ h with rot ≈ deg, or h ≥ w with rot ≈ deg ± 90°)
        const axis = r.w >= r.h ? tilt : tilt + Math.PI / 2;
        const d = Math.abs(Math.atan2(Math.sin(2 * (axis - rot)), Math.cos(2 * (axis - rot)))) / 2;
        if (d < (8 * Math.PI) / 180 && Math.abs(Math.max(r.w, r.h) - size * 2) < size * 0.25) ok++;
      }
  console.log(`  tilted ellipses: ${ok}/${n}`);
  assert.ok(ok / n >= 0.85, `${ok}/${n}`);
});

test('shape pen: a tilted rectangle is a rotated rect; an upright one has no rotation', () => {
  const rect = (deg: number): Pt[] => {
    const r = (deg * Math.PI) / 180;
    const cs: Pt[] = [[-90, -50], [90, -50], [90, 50], [-90, 50], [-90, -46]];
    return densify(cs.map(([x, y]) => [300 + x * Math.cos(r) - y * Math.sin(r), 300 + x * Math.sin(r) + y * Math.cos(r)] as Pt));
  };
  let ok = 0;
  for (let s = 0; s < 6; s++) {
    const r = recognizeShape(handStroke(rect(30), { seed: 11 + s, wobble: 0.004 }));
    if (r?.kind === 'rect' && r.rot && Math.abs(Math.abs(Math.atan2(Math.sin(4 * (r.rot - Math.PI / 6)), Math.cos(4 * (r.rot - Math.PI / 6))) / 4)) < 0.14) ok++;
  }
  assert.ok(ok >= 5, `${ok}/6 tilted rectangles`);
  const up = recognizeShape(handStroke(rect(0), { seed: 4, wobble: 0.004 }));
  assert.equal(up?.kind, 'rect');
  assert.ok(!up?.rot);
});

test('shape pen: pentagons and hexagons are polygons, snapped to regular ones', () => {
  for (const n of [5, 6]) {
    let ok = 0;
    for (let s = 0; s < 8; s++) {
      const cs: Pt[] = Array.from({ length: n + 1 }, (_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        return [300 + 100 * Math.cos(a), 300 + 100 * Math.sin(a)];
      });
      const r = recognizeShape(handStroke(densify(cs), { seed: 21 + s * 5 + n, wobble: 0.004 }));
      if (r?.kind === 'polygon' && r.points?.length === n * 2) ok++;
    }
    console.log(`  ${n}-gons: ${ok}/8`);
    assert.ok(ok >= 6, `${n}-gon ${ok}/8`);
  }
  // regularize: an almost regular pentagon becomes exactly regular, with a horizontal base
  const wobbly = Array.from({ length: 5 }, (_, i) => {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / 5 + (i % 2 ? 0.05 : -0.04);
    const r = 100 + (i % 2 ? 6 : -5);
    return { x: 300 + r * Math.cos(a), y: 300 + r * Math.sin(a) };
  });
  const reg = regularize(wobbly);
  const sides = reg.map((p, i) => Math.hypot(reg[(i + 1) % 5].x - p.x, reg[(i + 1) % 5].y - p.y));
  assert.ok(Math.max(...sides) - Math.min(...sides) < 1e-6, 'equal sides');
  const flat = reg.some((p, i) => Math.abs(reg[(i + 1) % 5].y - p.y) < 1e-6);
  assert.ok(flat, 'a horizontal side');
});

import { recognizeInk } from '../../src/ink/shape-recognition';
import { INK_PIPELINE, StrokeBuilder } from '../../src/ink/stroke-builder';
import { DEFAULT_PEN_PARAMS } from '../../src/ink/presets';

test('shape pen: slow, light (jittery) lines are recognised from the drawn ink, not the raw points', () => {
  let raw = 0;
  let ink = 0;
  let n = 0;
  for (const len of [80, 200])
    for (const ang of [0, 45, 90, 135])
      for (let s = 0; s < 4; s++) {
        const a = (ang * Math.PI) / 180;
        const ideal: Pt[] = Array.from({ length: 41 }, (_, i) => [300 + Math.cos(a) * (i / 40) * len, 300 + Math.sin(a) * (i / 40) * len]);
        const samples = handStroke(ideal, { seed: 3 + s * 11 + ang + len, wobble: 0.01, speed: 0.1, jitter: 0.9 });
        const b = new StrokeBuilder('fountain', DEFAULT_PEN_PARAMS.fountain, { zoom: 1, hasPressure: true, ink: INK_PIPELINE });
        for (const q of samples) b.add(q);
        n++;
        if (recognizeShape(samples)?.kind === 'line') raw++;
        if (recognizeInk(samples, b.commitGeometry())?.kind === 'line') ink++;
      }
  console.log(`  jittery slow lines: raw ${raw}/${n} → drawn ink ${ink}/${n}`);
  assert.ok(ink / n >= 0.9 && ink > raw, `${ink}/${n} (raw ${raw})`);
});
