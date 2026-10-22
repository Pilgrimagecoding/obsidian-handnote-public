import type { InputSample, InkTool, PenParams, StrokeContext } from './types';
import {
  angleDiff,
  clamp,
  pressureWidthFactor,
  PRESSURE_HI,
  expAlpha,
  lerp,
  nibMultiplier,
  pressureMultiplier,
  smoothstep,
} from './math';

/**
 * StrokeBuilder: raw samples -> stabilized centerline -> variable-radius samples.
 *
 * Design goals (see docs/ARCHITECTURE_DECISION.md):
 *  - Deterministic: the committed stroke is produced by feeding the same raw samples through the
 *    same builder, so the live preview and the final stroke are identical except for the exit
 *    taper. This is what prevents the "stroke jumps / thins when the pen lifts" artifact.
 *  - Causal and incremental: every stage only looks backwards (plus a 2-point spline window), so
 *    the prefix of a stroke becomes immutable ("stable") and only the tail is redrawn each frame.
 *  - Screen-space stabilization: jitter is a screen-space phenomenon (hand tremor, sensor noise),
 *    so the adaptive filter works in screen pixels using the zoom captured at stroke start.
 *  - The visible end of the stroke is always the latest raw sample, so filter lag never shows up
 *    as a gap between the pen tip and the ink.
 */

/** Geometry output: centerline samples with radius, in page units. */
export interface StrokeGeometry {
  xs: number[];
  ys: number[];
  rs: number[];
  /** True if the stroke should be drawn as a single dot. */
  dot: boolean;
  bbox: [number, number, number, number];
}

interface FPoint {
  x: number; // page units
  y: number;
  p: number; // smoothed pressure
  v: number; // smoothed speed, screen px / ms
  t: number;
}

interface WidthState {
  w: number; // smoothed radius
  s: number; // arc length so far (page units)
  lastX: number;
  lastY: number;
  started: boolean;
}

const MIN_SCREEN_DIST = 0.35; // screen px between filtered points
const CORNER_ANGLE = (72 * Math.PI) / 180;
const CORNER_WINDOW = 3.5; // screen px used to measure local direction (larger than sensor noise)

export class StrokeBuilder {
  readonly tool: InkTool;
  readonly params: PenParams;
  readonly ctx: StrokeContext;

  private filtered: FPoint[] = [];
  private raw: InputSample[] = [];

  // one-euro filter state (screen px)
  private fx = 0;
  private fy = 0;
  private dxh = 0;
  private dyh = 0;
  private lastT = 0;
  private ps = 0.25; // smoothed pressure
  private vs = 0; // smoothed speed
  private hasFilter = false;

  // corner detection: anchor point of the current direction window (screen px)
  private dirAnchorX = 0;
  private dirAnchorY = 0;
  private lastDir: number | null = null;

  // stable output
  private stableXs: number[] = [];
  private stableYs: number[] = [];
  private stableRs: number[] = [];
  private stableSegments = 0; // number of spline segments already emitted as stable
  private widthState: WidthState = { w: 0, s: 0, lastX: 0, lastY: 0, started: false };

  constructor(tool: InkTool, params: PenParams, ctx: StrokeContext) {
    this.tool = tool;
    this.params = params;
    this.ctx = { zoom: ctx.zoom > 0 ? ctx.zoom : 1, hasPressure: ctx.hasPressure, engine: ctx.engine === 2 ? 2 : 1 };
    if (ctx.cutStart) this.ctx.cutStart = true;
    if (ctx.cutEnd) this.ctx.cutEnd = true;
  }

  /** Number of raw samples consumed. */
  get rawCount(): number {
    return this.raw.length;
  }

  get rawSamples(): readonly InputSample[] {
    return this.raw;
  }

  get stableLength(): number {
    return this.stableXs.length;
  }

  // ---------------------------------------------------------------------------------------------
  // Stage 1: adaptive stabilization (One Euro filter, Casiez et al. 2012) with corner reset.
  // ---------------------------------------------------------------------------------------------

  add(sample: InputSample): void {
    const z = this.ctx.zoom;
    let t = sample.t;
    if (this.raw.length > 0) {
      const prev = this.raw[this.raw.length - 1];
      if (!(t >= prev.t)) t = prev.t; // also catches NaN
    }
    const s: InputSample = { ...sample, t };
    this.raw.push(s);

    const sx = s.x * z;
    const sy = s.y * z;
    const rawP = this.ctx.hasPressure ? clamp(s.p, 0, 1) : -1;

    if (!this.hasFilter) {
      this.hasFilter = true;
      this.fx = sx;
      this.fy = sy;
      this.dxh = 0;
      this.dyh = 0;
      this.lastT = t;
      this.ps = rawP >= 0 ? (rawP > 0.02 ? rawP : 0.18) : 0.5;
      this.vs = 0;
      this.dirAnchorX = sx;
      this.dirAnchorY = sy;
      this.filtered.push({ x: s.x, y: s.y, p: this.pressureValue(), v: 0, t });
      this.emitStable();
      return;
    }

    let dtMs = t - this.lastT;
    if (dtMs < 0.5) dtMs = 0.5; // coalesced samples can share timestamps; assume >= 2 kHz spacing
    const dt = dtMs / 1000;

    // corner detection on raw input (direction over a short screen-space window)
    let corner = false;
    const ax = sx - this.dirAnchorX;
    const ay = sy - this.dirAnchorY;
    if (ax * ax + ay * ay >= CORNER_WINDOW * CORNER_WINDOW) {
      const dir = Math.atan2(ay, ax);
      if (this.lastDir !== null && angleDiff(dir, this.lastDir) > CORNER_ANGLE) corner = true;
      this.lastDir = dir;
      this.dirAnchorX = sx;
      this.dirAnchorY = sy;
    }

    // One Euro filter. Smoothing 0..1 maps to min cutoff 10 Hz .. 1.6 Hz.
    const sm = this.params.smoothing;
    const minCutoff = lerp(10, 1.6, sm);
    const beta = lerp(0.03, 0.007, sm);
    const dCutoff = 1.0;
    const alpha = (cutoff: number) => {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    };
    const rdx = (sx - this.fx) / dt;
    const rdy = (sy - this.fy) / dt;
    const ad = alpha(dCutoff);
    this.dxh += (rdx - this.dxh) * ad;
    this.dyh += (rdy - this.dyh) * ad;
    const speed = Math.hypot(this.dxh, this.dyh); // px/s
    const cutoff = minCutoff + beta * speed;
    const a = alpha(cutoff);
    const nfx = this.fx + (sx - this.fx) * a;
    const nfy = this.fy + (sy - this.fy) * a;

    if (corner && sm > 0) {
      // Keep sharp turns sharp (横折, 竖钩): pull the filter onto the raw input at a corner.
      // The pen almost always decelerates into a corner, so the lag being removed is small.
      this.fx = lerp(nfx, sx, 0.85);
      this.fy = lerp(nfy, sy, 0.85);
    } else {
      this.fx = nfx;
      this.fy = nfy;
    }

    if (rawP >= 0) {
      if (this.ctx.engine === 2) {
        this.filterPressureV2(rawP, dtMs);
      } else {
        // engine 1 — pressure: asymmetric smoothing (fast attack, slower release)
        const tau = rawP > this.ps ? 6 : 16;
        this.ps += (rawP - this.ps) * (1 - Math.exp(-dtMs / tau));
      }
    }
    // speed in screen px / ms, smoothed
    const prevF = this.filtered[this.filtered.length - 1];
    const fdist = Math.hypot(this.fx - prevF.x * z, this.fy - prevF.y * z);
    const instV = fdist / Math.max(dtMs, 1) || 0;
    this.vs += (instV - this.vs) * (1 - Math.exp(-dtMs / 12));
    this.lastT = t;

    if (fdist < MIN_SCREEN_DIST && !corner) return; // too close to emit; tail uses raw anyway

    this.filtered.push({ x: this.fx / z, y: this.fy / z, p: this.pressureValue(), v: this.vs, t });
    this.emitStable();
  }

  /**
   * Engine 2 pressure filter, independent of the geometric filter: an adaptive low-pass whose time
   * constant shrinks when pressure changes deliberately (dp/dt large) and grows for small jitter,
   * so sensor noise never shows as edge wobble while real pressing/releasing stays responsive.
   */
  private dps = 0;
  private lastRawP = NaN;
  private filterPressureV2(rawP: number, dtMs: number): void {
    const sm = clamp(this.params.pressureSmoothing ?? 0.5, 0, 1);
    // Signed raw pressure rate, low-passed over ~12 ms: zero-mean sensor noise cancels out, a
    // sustained press or release does not.
    const rate = Number.isNaN(this.lastRawP) ? 0 : (rawP - this.lastRawP) / Math.max(dtMs, 0.5);
    this.lastRawP = rawP;
    this.dps += (rate - this.dps) * (1 - Math.exp(-dtMs / 12));
    const tauSlow = lerp(4, 40, sm);
    const tau = tauSlow / (1 + 700 * Math.abs(this.dps));
    this.ps += (rawP - this.ps) * (1 - Math.exp(-dtMs / Math.max(1.5, tau)));
  }

  /** Pressure used for width: real pressure, or a mild speed-based simulation for mice. */
  private pressureValue(): number {
    if (this.ctx.hasPressure) return this.ps;
    return 0.3 * (1.15 - 0.3 * smoothstep(0.3, 3, this.vs));
  }

  // ---------------------------------------------------------------------------------------------
  // Stage 2: centripetal Catmull-Rom spline + width model.
  // ---------------------------------------------------------------------------------------------

  /** Control points: filtered points, plus the latest raw sample as the live end point. */
  private controlPoints(endRaw: InputSample | null): FPoint[] {
    const pts = this.filtered;
    if (!endRaw) return pts;
    const last = pts[pts.length - 1];
    const z = this.ctx.zoom;
    const d = Math.hypot((endRaw.x - last.x) * z, (endRaw.y - last.y) * z);
    if (d < 0.05) return pts;
    return pts.concat([
      {
        x: endRaw.x,
        y: endRaw.y,
        p: last.p,
        v: last.v,
        t: endRaw.t,
      },
    ]);
  }

  /** Emit spline segments that can no longer change. Segment k needs control points k-1..k+2. */
  private emitStable(): void {
    const n = this.filtered.length;
    // Segment k (from point k to k+1) is final once point k+2 exists among filtered points.
    const lastStable = n - 3;
    while (this.stableSegments <= lastStable) {
      const k = this.stableSegments;
      if (k === 0) {
        this.pushSample(this.filtered[0], this.widthState, this.stableXs, this.stableYs, this.stableRs, 0);
      }
      this.emitSegment(this.filtered, k, this.widthState, this.stableXs, this.stableYs, this.stableRs);
      this.stableSegments++;
    }
  }

  private emitSegment(
    cps: FPoint[],
    k: number,
    ws: WidthState,
    xs: number[],
    ys: number[],
    rs: number[],
  ): void {
    const n = cps.length;
    const p1 = cps[k];
    const p2 = cps[k + 1];
    const p0 = k > 0 ? cps[k - 1] : reflect(p2, p1);
    const p3 = k + 2 < n ? cps[k + 2] : reflect(p1, p2);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const step = clamp(this.params.width * 0.3, 0.2, 0.6);
    const count = clamp(Math.ceil(len / step), 1, 64);
    for (let i = 1; i <= count; i++) {
      const u = i / count;
      const pt = catmullRom(p0, p1, p2, p3, u);
      const q: FPoint = {
        x: pt.x,
        y: pt.y,
        p: lerp(p1.p, p2.p, u),
        v: lerp(p1.v, p2.v, u),
        t: lerp(p1.t, p2.t, u),
      };
      this.pushSample(q, ws, xs, ys, rs, 1);
    }
  }

  /** Width model applied to one centerline sample. Mutates width state (causal). */
  private pushSample(q: FPoint, ws: WidthState, xs: number[], ys: number[], rs: number[], _kind: number): void {
    const prm = this.params;
    const base = prm.width / 2;
    let dir = 0;
    if (ws.started) {
      const dx = q.x - ws.lastX;
      const dy = q.y - ws.lastY;
      const ds = Math.hypot(dx, dy);
      if (ds < 1e-6) return;
      ws.s += ds;
      dir = Math.atan2(dy, dx);
    }

    let target: number;
    const v2 = this.ctx.engine === 2;
    if (this.tool === 'highlighter') {
      target = base;
    } else if (v2) {
      const pm = this.ctx.hasPressure
        ? pressureWidthFactor(q.p, prm.pressureSensitivity, prm.pressureCurve ?? 0, prm.minWidthRatio ?? 0.3, prm.maxWidthRatio ?? 1.9, prm.typicalPressure ?? 0.3, prm.heavyPressure ?? PRESSURE_HI)
        : pressureMultiplier(q.p, prm.pressureSensitivity * 0.5);
      const vm = 1 - prm.velocityThinning * 0.55 * smoothstep(0.35, 3.2, q.v);
      const nm = ws.started ? nibMultiplier(dir, (prm.nibAngle * Math.PI) / 180, prm.nibFlatness) : 1;
      target = base * pm * vm * nm;
      // Entry: with real pressure the Pencil's own pressure ramp forms the 起笔, so only a short,
      // mild synthetic taper is added (a long one makes small Chinese strokes look pinched).
      if (prm.tapering > 0 && !this.ctx.cutStart) {
        const ls = prm.tapering * (0.5 + 0.9 * prm.width);
        const minStart = this.ctx.hasPressure ? 0.82 : 0.6;
        const e = ls > 0 ? smoothstep(0, 1, ws.s / ls) : 1;
        target *= lerp(minStart, 1, e);
      }
    } else {
      const pm = pressureMultiplier(q.p, prm.pressureSensitivity);
      const vm = 1 - prm.velocityThinning * 0.55 * smoothstep(0.35, 3.2, q.v);
      const nm = ws.started ? nibMultiplier(dir, (prm.nibAngle * Math.PI) / 180, prm.nibFlatness) : 1;
      target = base * pm * vm * nm;
      // entry taper (起笔): grows over the first few widths of travel
      if (prm.tapering > 0 && !this.ctx.cutStart) {
        const ls = prm.tapering * (1.2 + 2.2 * prm.width);
        const minStart = this.tool === 'fountain' ? 0.5 : 0.8;
        const e = ls > 0 ? smoothstep(0, 1, ws.s / ls) : 1;
        target *= lerp(minStart, 1, e);
      }
    }

    if (!ws.started) {
      ws.w = target;
      ws.started = true;
    } else {
      // smooth width along arc length so pressure noise never shows as bumps
      // (engine 2 filters pressure itself, so it needs less arc-length smoothing)
      const smoothLen = v2 ? 0.3 + prm.width * 0.45 : 0.35 + prm.width * 0.6;
      const ds = Math.hypot(q.x - ws.lastX, q.y - ws.lastY);
      ws.w += (target - ws.w) * expAlpha(ds, smoothLen);
    }
    ws.lastX = q.x;
    ws.lastY = q.y;
    const minR = Math.max(0.1, base * 0.1);
    xs.push(q.x);
    ys.push(q.y);
    rs.push(Math.max(minR, ws.w));
  }

  // ---------------------------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------------------------

  /** Stable prefix (immutable once returned; callers may keep references to indices). */
  stable(): { xs: readonly number[]; ys: readonly number[]; rs: readonly number[] } {
    return { xs: this.stableXs, ys: this.stableYs, rs: this.stableRs };
  }

  /**
   * Tail samples after the stable prefix, ending at the latest raw sample. Recomputed each frame.
   * The first returned sample continues from the last stable sample.
   */
  tail(predicted?: readonly InputSample[]): { xs: number[]; ys: number[]; rs: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    const rs: number[] = [];
    if (this.filtered.length === 0) return { xs, ys, rs };
    const endRaw = this.raw.length ? this.raw[this.raw.length - 1] : null;
    let cps = this.controlPoints(endRaw);
    if (predicted && predicted.length) {
      // Predicted samples (PointerEvent.getPredictedEvents) only extend the preview; never stored.
      const last = cps[cps.length - 1];
      cps = cps.concat(predicted.map((q) => ({ x: q.x, y: q.y, p: last.p, v: last.v, t: Math.max(q.t, last.t) })));
    }
    const ws: WidthState = { ...this.widthState };
    if (this.stableXs.length === 0) {
      this.pushSample(cps[0], ws, xs, ys, rs, 0);
    }
    for (let k = this.stableSegments; k < cps.length - 1; k++) {
      this.emitSegment(cps, k, ws, xs, ys, rs);
    }
    return { xs, ys, rs };
  }

  /** Complete geometry for the finished stroke (exit taper + lift-hook suppression). */
  finalize(): StrokeGeometry {
    const st = this.stable();
    const tl = this.tail();
    const xs = (st.xs as number[]).concat(tl.xs);
    const ys = (st.ys as number[]).concat(tl.ys);
    const rs = (st.rs as number[]).concat(tl.rs);
    // a fragment end cut by the partial eraser keeps its width (no exit taper)
    const prm = this.ctx.cutEnd ? { ...this.params, tapering: 0 } : this.params;
    if (this.ctx.engine === 2) return finishGeometryV2(xs, ys, rs, this.tool, prm, this.exitSpeed(), this.ctx.hasPressure);
    return finishGeometry(xs, ys, rs, this.tool, prm, this.exitSpeed());
  }

  /** Average speed (screen px/ms) over the last few filtered points. */
  private exitSpeed(): number {
    const f = this.filtered;
    if (f.length === 0) return 0;
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, f.length - 4); i < f.length; i++) {
      sum += f[i].v;
      n++;
    }
    return sum / n;
  }
}

function reflect(a: FPoint, b: FPoint): FPoint {
  // phantom point: b + (b - a)
  return { x: 2 * b.x - a.x, y: 2 * b.y - a.y, p: b.p, v: b.v, t: b.t };
}

/** Centripetal Catmull-Rom (alpha = 0.5) between p1 and p2, Barry-Goldman formulation. */
function catmullRom(p0: FPoint, p1: FPoint, p2: FPoint, p3: FPoint, u: number): { x: number; y: number } {
  const knot = (a: FPoint, b: FPoint) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-4);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const l = (pa: { x: number; y: number }, pb: { x: number; y: number }, ta: number, tb: number) => {
    const w = (t - ta) / (tb - ta);
    return { x: pa.x + (pb.x - pa.x) * w, y: pa.y + (pb.y - pa.y) * w };
  };
  const a1 = l(p0, p1, t0, t1);
  const a2 = l(p1, p2, t1, t2);
  const a3 = l(p2, p3, t2, t3);
  const b1 = l(a1, a2, t0, t2);
  const b2 = l(a2, a3, t1, t3);
  return l(b1, b2, t1, t2);
}

/** Exit taper (收笔/出锋) and bounding box. Shared by the builder and by tests. */
export function finishGeometry(
  xs: number[],
  ys: number[],
  rs: number[],
  tool: InkTool,
  params: PenParams,
  exitSpeed: number,
): StrokeGeometry {
  const n = xs.length;
  let total = 0;
  const cum: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (i > 0) total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    cum[i] = total;
  }
  const base = params.width / 2;
  const dot = n <= 1 || total < Math.max(0.35, base * 0.5);

  if (!dot && tool !== 'highlighter' && params.tapering > 0) {
    const fast = smoothstep(0.4, 2.6, exitSpeed);
    const le = Math.min(total * 0.35, params.tapering * (1.0 + 4.0 * fast) * (0.8 + params.width));
    const minEnd = tool === 'fountain' ? lerp(0.62, 0.14, fast) : lerp(0.9, 0.6, fast);
    if (le > 0) {
      for (let i = 0; i < n; i++) {
        const d = total - cum[i];
        if (d < le) {
          const e = 1 - d / le; // 0 at taper start, 1 at the very end
          rs[i] = Math.max(0.08, rs[i] * lerp(1, minEnd, e * e));
        }
      }
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = rs[i];
    if (xs[i] - r < minX) minX = xs[i] - r;
    if (ys[i] - r < minY) minY = ys[i] - r;
    if (xs[i] + r > maxX) maxX = xs[i] + r;
    if (ys[i] + r > maxY) maxY = ys[i] + r;
  }
  if (n === 0) {
    minX = minY = maxX = maxY = 0;
  }
  if (dot && n > 0) {
    // a dot: one circle at the first sample, at least as large as the nominal pen
    let r = 0;
    for (let i = 0; i < n; i++) r = Math.max(r, rs[i]);
    r = Math.max(r, base * 0.8);
    const cx = xs[0];
    const cy = ys[0];
    return { xs: [cx], ys: [cy], rs: [r], dot: true, bbox: [cx - r, cy - r, cx + r, cy + r] };
  }
  return { xs, ys, rs, dot, bbox: [minX, minY, maxX, maxY] };
}

/**
 * Engine 2 exit (收笔/出锋). The synthetic taper is capped to a fraction of the stroke length (so
 * short strokes of small characters keep their ends), grows with exit speed (a flick gives a sharper
 * 出锋), and is weakened when the Pencil's real pressure release has already thinned the end.
 */
export function finishGeometryV2(
  xs: number[],
  ys: number[],
  rs: number[],
  tool: InkTool,
  params: PenParams,
  exitSpeed: number,
  hasPressure: boolean,
): StrokeGeometry {
  const n = xs.length;
  if (n > 2 && tool !== 'highlighter' && params.tapering > 0) {
    let total = 0;
    const cum: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      if (i > 0) total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      cum[i] = total;
    }
    const fast = smoothstep(0.4, 2.6, exitSpeed);
    const le = Math.min(total * 0.22, params.tapering * (0.6 + 2.6 * fast) * (0.6 + params.width));
    // how much the real pressure release already thinned the end
    let ref = 0;
    let refN = 0;
    for (let i = 0; i < n; i++) {
      const d = total - cum[i];
      if (d > le && d < le * 3 + 1) {
        ref += rs[i];
        refN++;
      }
    }
    const refR = refN ? ref / refN : rs[Math.max(0, n - 1)];
    const natural = hasPressure && refR > 0 ? clamp(1 - rs[n - 1] / refR, 0, 1) : 0;
    const strength = 1 - natural; // 0 = pressure already tapered the end, 1 = add full taper
    const minEnd = tool === 'fountain' ? lerp(0.72, 0.28, fast) : lerp(0.92, 0.7, fast);
    if (le > 0 && strength > 0) {
      for (let i = 0; i < n; i++) {
        const d = total - cum[i];
        if (d < le) {
          const e = 1 - d / le;
          rs[i] = Math.max(0.08, rs[i] * lerp(1, lerp(1, minEnd, strength), e * e));
        }
      }
    }
  }
  // dot / bbox handling is identical to engine 1 (tapering disabled there by passing 0)
  return finishGeometry(xs, ys, rs, tool, { ...params, tapering: 0 }, exitSpeed);
}

/**
 * Remove the small "hook" many people make when lifting the pen: a few final samples that turn
 * back sharply over a tiny distance. Operates on raw samples (returns a filtered copy); the stored
 * raw data is never modified.
 */
export function trimLiftHook(samples: readonly InputSample[], zoom: number): InputSample[] {
  const n = samples.length;
  if (n < 6) return samples.slice();
  const z = zoom > 0 ? zoom : 1;
  // main direction before the potential hook
  const a = samples[n - 6];
  const b = samples[n - 4];
  const mainDir = Math.atan2(b.y - a.y, b.x - a.x);
  const mainLen = Math.hypot((b.x - a.x) * z, (b.y - a.y) * z);
  if (mainLen < 1.5) return samples.slice();
  for (let cut = 1; cut <= 3; cut++) {
    const start = samples[n - 1 - cut];
    const end = samples[n - 1];
    const hookLen = Math.hypot((end.x - start.x) * z, (end.y - start.y) * z);
    const hookDir = Math.atan2(end.y - start.y, end.x - start.x);
    const dur = end.t - start.t;
    if (hookLen > 0.4 && hookLen < 2.5 && dur <= 24 && angleDiff(hookDir, mainDir) > (100 * Math.PI) / 180) {
      return samples.slice(0, n - cut);
    }
  }
  return samples.slice();
}

/** Build geometry for a complete stroke in one go (used for committed/loaded strokes). */
export function buildStrokeGeometry(
  samples: readonly InputSample[],
  tool: InkTool,
  params: PenParams,
  ctx: StrokeContext,
): StrokeGeometry {
  const b = new StrokeBuilder(tool, params, ctx);
  const src = ctx.cutEnd ? samples.slice() : trimLiftHook(samples, ctx.zoom);
  for (const s of src) b.add(s);
  if (src.length === 0) {
    return { xs: [], ys: [], rs: [], dot: false, bbox: [0, 0, 0, 0] };
  }
  return b.finalize();
}
