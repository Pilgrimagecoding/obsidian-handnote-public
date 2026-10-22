import type { InputSample } from './types';
import { newId, type Stroke } from '../document/model';

/**
 * Partial eraser: cut the raw samples of a stroke where an eraser capsule (segment a→b with
 * radius `tol`, page units) passes over them. Unaffected samples are kept exactly, so the
 * remaining ink keeps its shape; only new end points at the eraser boundary are inserted.
 * Fragments carry `cut` flags so the renderer adds no taper at the cut ends.
 */

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

function lerpSample(s0: InputSample, s1: InputSample, u: number): InputSample {
  const q: InputSample = {
    x: s0.x + (s1.x - s0.x) * u,
    y: s0.y + (s1.y - s0.y) * u,
    p: s0.p + (s1.p - s0.p) * u,
    t: s0.t + (s1.t - s0.t) * u,
  };
  if (s0.tx !== undefined && s1.tx !== undefined && s0.ty !== undefined && s1.ty !== undefined) {
    q.tx = s0.tx + (s1.tx - s0.tx) * u;
    q.ty = s0.ty + (s1.ty - s0.ty) * u;
  }
  return q;
}

interface Run {
  samples: InputSample[];
  startCut: boolean;
  endCut: boolean;
}

/**
 * Split `samples` by the eraser capsule. Returns null when nothing was erased.
 * `tol` = eraser radius + allowance for the ink width (page units).
 */
export function cutSamples(samples: readonly InputSample[], ax: number, ay: number, bx: number, by: number, tol: number): Run[] | null {
  const n = samples.length;
  if (n === 0) return null;
  const inside = (s: { x: number; y: number }) => distToSegment(s.x, s.y, ax, ay, bx, by) < tol;
  const runs: Run[] = [];
  let state = inside(samples[0]);
  let cur: Run | null = state ? null : { samples: [samples[0]], startCut: false, endCut: false };
  let changed = state;
  // binary search for the boundary between parameter values lo (state = sLo) and hi
  const boundary = (s0: InputSample, s1: InputSample, lo: number, hi: number, sLo: boolean): InputSample => {
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (inside(lerpSample(s0, s1, mid)) === sLo) lo = mid;
      else hi = mid;
    }
    return lerpSample(s0, s1, sLo ? hi : lo);
  };
  for (let i = 1; i < n; i++) {
    const s0 = samples[i - 1];
    const s1 = samples[i];
    const len = Math.hypot(s1.x - s0.x, s1.y - s0.y);
    const steps = Math.min(64, Math.max(1, Math.ceil(len / Math.max(tol * 0.4, 0.05))));
    let prevU = 0;
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const st = k === steps ? inside(s1) : inside(lerpSample(s0, s1, u));
      if (st !== state) {
        changed = true;
        const bp = boundary(s0, s1, prevU, u, state);
        if (!state) {
          // leaving ink → entering eraser: close the current run at the boundary
          if (cur) {
            cur.samples.push(bp);
            cur.endCut = true;
            runs.push(cur);
          }
          cur = null;
        } else {
          // leaving eraser: start a new run at the boundary
          cur = { samples: [bp], startCut: true, endCut: false };
        }
        state = st;
      }
      prevU = u;
    }
    if (!state && cur) cur.samples.push(s1);
  }
  if (!changed) return null;
  if (cur && !state) runs.push(cur);
  return runs;
}

function arcLength(s: InputSample[]): number {
  let L = 0;
  for (let i = 1; i < s.length; i++) L += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return L;
}

/** Cut one stroke. Returns null when untouched, otherwise the fragments (possibly none). */
export function cutStroke(stroke: Stroke, ax: number, ay: number, bx: number, by: number, eraserRadius: number, precise: boolean): Stroke[] | null {
  const halfW = stroke.params.width / 2;
  const tol = eraserRadius + halfW * (precise ? 0.5 : 0.9);
  const runs = cutSamples(stroke.samples, ax, ay, bx, by, tol);
  if (!runs) return null;
  const minLen = Math.max(0.4, halfW * 0.5);
  const cut0 = stroke.cut ?? 0;
  const out: Stroke[] = [];
  for (const r of runs) {
    if (r.samples.length < 2 || arcLength(r.samples) < minLen) continue;
    const startCut = r.startCut || (cut0 & 1) !== 0;
    const endCut = r.endCut || (cut0 & 2) !== 0;
    const flags = (startCut ? 1 : 0) | (endCut ? 2 : 0);
    const frag: Stroke = {
      ...stroke,
      id: newId('s'),
      samples: r.samples.map((q) => ({ ...q, x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100, p: Math.round(q.p * 1000) / 1000, t: Math.round(q.t) })),
    };
    if (flags) frag.cut = flags;
    else delete frag.cut;
    out.push(frag);
  }
  return out;
}
