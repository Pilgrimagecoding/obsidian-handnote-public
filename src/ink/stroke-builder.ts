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
  /** Smoothed direction of travel (unit vector) for the nib: the direction between two spline
   * samples a fraction of a pixel apart is mostly sensor noise, and with a flat nib it showed as
   * bumps along the edges at high zoom. */
  nx: number;
  ny: number;
}

const MIN_SCREEN_DIST = 0.35; // screen px between filtered points
/** StrokeContext.ink value of the 0.12 ink pipeline. */
export const INK_PIPELINE = 2;
/** Centerline smoothing (Gaussian sigma, screen px) at smoothing 0 and 1 (4 px at the default 0.5). */
const CENTER_SIGMA_MIN = 2;
const CENTER_SIGMA_MAX = 6;
/** Travel (screen px) over which the nib direction is averaged. */
const NIB_DIR_PX = 4;
/** Longest spline step (page units): fine enough that the ink stays round at 2400 %. */
const MAX_SPLINE_STEP = 0.1;
/** Spline step while drawing (screen px). */
const LIVE_STEP_PX = 1;
const CORNER_ANGLE = (72 * Math.PI) / 180;
const CORNER_WINDOW = 3.5; // screen px used to measure local direction (larger than sensor noise)
/** 0.12 ink: a more conservative corner test (a smooth curve taken for a corner left a kink). */
const CORNER_ANGLE_V12 = (88 * Math.PI) / 180;
const CORNER_WINDOW_V12 = 5.5;
const CORNER_PULL_V12 = 0.55;

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
  /** 0.12 ink pipeline (see StrokeContext.ink). */
  private readonly v12: boolean;
  /** Sample the spline at MAX_SPLINE_STEP (the stored ink), not per screen pixel. */
  private fine = false;
  /** Arc length (screen px) of each filtered point, and the indices of corner points. */
  private arc: number[] = [];
  private corners: number[] = [];
  /** Filtered points after the centerline smoothing whose window is complete (final). */
  private smooth: FPoint[] = [];

  // corner detection: anchor point of the current direction window (screen px)
  private dirAnchorX = 0;
  private dirAnchorY = 0;
  private lastDir: number | null = null;

  // stable output
  private stableXs: number[] = [];
  private stableYs: number[] = [];
  private stableRs: number[] = [];
  private stableSegments = 0; // number of spline segments already emitted as stable
  private widthState: WidthState = { w: 0, s: 0, lastX: 0, lastY: 0, started: false, nx: 0, ny: 0 };

  constructor(tool: InkTool, params: PenParams, ctx: StrokeContext) {
    this.tool = tool;
    this.params = params;
    this.ctx = { zoom: ctx.zoom > 0 ? ctx.zoom : 1, hasPressure: ctx.hasPressure, engine: ctx.engine === 2 ? 2 : 1 };
    if (ctx.cutStart) this.ctx.cutStart = true;
    if (ctx.cutEnd) this.ctx.cutEnd = true;
    if (ctx.ink === INK_PIPELINE) this.ctx.ink = INK_PIPELINE;
    this.v12 = ctx.ink === INK_PIPELINE;
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
      this.arc.push(0);
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
    const cw = this.v12 ? CORNER_WINDOW_V12 : CORNER_WINDOW;
    if (ax * ax + ay * ay >= cw * cw) {
      const dir = Math.atan2(ay, ax);
      if (this.lastDir !== null && angleDiff(dir, this.lastDir) > (this.v12 ? CORNER_ANGLE_V12 : CORNER_ANGLE)) corner = true;
      this.lastDir = dir;
      this.dirAnchorX = sx;
      this.dirAnchorY = sy;
    }

    // One Euro filter. Smoothing 0..1 maps to min cutoff 10 Hz .. 1.6 Hz (strokes before 0.12).
    // 0.12 ink: light (30 Hz .. 12 Hz) — it only takes off sensor noise with little lag; the shape
    // is smoothed by the symmetric centerline smoothing, which does not lag behind the pen.
    const sm = this.params.smoothing;
    const minCutoff = this.v12 ? lerp(30, 12, sm) : lerp(10, 1.6, sm);
    const beta = this.v12 ? lerp(0.15, 0.06, sm) : lerp(0.03, 0.007, sm);
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
      const pull = this.v12 ? CORNER_PULL_V12 : 0.85;
      this.fx = lerp(nfx, sx, pull);
      this.fy = lerp(nfy, sy, pull);
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

    const ox = this.fx;
    const oy = this.fy;
    const prevPt = this.filtered[this.filtered.length - 1];
    this.filtered.push({ x: ox / z, y: oy / z, p: this.pressureValue(), v: this.vs, t });
    this.arc.push(this.arc[this.arc.length - 1] + Math.hypot(ox - prevPt.x * z, oy - prevPt.y * z));
    if (corner) this.corners.push(this.filtered.length - 1);
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
    const pts = this.sigma() > 0 ? this.smooth.concat(this.provisionalSmooth()) : this.filtered;
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

  /**
   * Smoothing width at a point: wider when the pen moves fast (a quick line is meant to be
   * straight; up to twice the base width at 1 px/ms), narrower when it is slow.
   */
  private sigmaAt(q: FPoint): number {
    return this.sigma() * (1 + clamp(q.v, 0, 1));
  }

  /** Centerline smoothing width (screen px, Gaussian sigma); 0 = off. */
  private sigma(): number {
    return this.v12 ? lerp(CENTER_SIGMA_MIN, CENTER_SIGMA_MAX, clamp(this.params.smoothing, 0, 1)) : 0;
  }

  /**
   * Centerline smoothing (0.12): each filtered point is replaced by a Gaussian average of its
   * neighbours along the stroke (sigma 2–6 screen px from the smoothing setting, weighted by spacing). The window
   * is symmetric — no lag, curves are not cut — and shrinks near the ends of the stroke and at
   * corners (横折 stay sharp). A point is final once the stroke has gone 2 sigma past it; until then
   * it is shown with the window that fits, which converges to the final point.
   */
  private smoothPoint(i: number, end: number): FPoint {
    const f = this.filtered;
    const arc = this.arc;
    const q = f[i];
    // segment between corners around i
    let lo = 0;
    let hi = end;
    for (const c of this.corners) {
      if (c <= i) lo = c;
      if (c >= i && c < hi) hi = c;
    }
    if (this.corners.includes(i)) return q;
    let w = Math.min(2 * this.sigmaAt(q), arc[i] - arc[lo], arc[hi] - arc[i]);
    // where the stroke bends (a tight curve, a turn the corner test missed) the window shrinks
    // until the chords before and after the point differ by at most SMOOTH_BEND: noise is evened
    // out, the shape is not (a small circle shrinks by under 5 % of its radius)
    // (shrunk in proportion to the bend, so the smoothing changes gradually along a curve)
    for (let k = 0; k < 4 && w > 0.6; k++) {
      const bend = bendAt(f, arc, i, w, lo, hi);
      if (bend <= SMOOTH_BEND) break;
      w *= Math.max(0.3, (SMOOTH_BEND / bend) * 0.95);
    }
    if (w <= 0.6) return q;
    const se = w / 2;
    let sx = 0;
    let sy = 0;
    let sp = 0;
    let sv = 0;
    let sw = 0;
    for (let j = i; j >= lo && arc[i] - arc[j] <= w; j--) {
      const d = arc[i] - arc[j];
      const span = (arc[Math.min(hi, j + 1)] - arc[Math.max(lo, j - 1)]) / 2 || 1e-3;
      const wt = Math.exp((-d * d) / (2 * se * se)) * span;
      sx += f[j].x * wt;
      sy += f[j].y * wt;
      sp += f[j].p * wt;
      sv += f[j].v * wt;
      sw += wt;
    }
    for (let j = i + 1; j <= hi && arc[j] - arc[i] <= w; j++) {
      const d = arc[j] - arc[i];
      const span = (arc[Math.min(hi, j + 1)] - arc[Math.max(lo, j - 1)]) / 2 || 1e-3;
      const wt = Math.exp((-d * d) / (2 * se * se)) * span;
      sx += f[j].x * wt;
      sy += f[j].y * wt;
      sp += f[j].p * wt;
      sv += f[j].v * wt;
      sw += wt;
    }
    // pressure and speed are evened out over the same window: their noise made the width wobble
    return sw > 0 ? { ...q, x: sx / sw, y: sy / sw, p: sp / sw, v: sv / sw } : q;
  }

  /** Move filtered points whose smoothing window is complete into the final smoothed list. */
  private finalizeSmooth(): FPoint[] {
    const n = this.filtered.length;
    const last = n - 1;
    while (this.smooth.length < n) {
      const i = this.smooth.length;
      const cornerAhead = this.corners.some((c) => c >= i && c <= last);
      if (!cornerAhead && this.arc[last] - this.arc[i] < 2 * this.sigmaAt(this.filtered[i])) break;
      this.smooth.push(this.smoothPoint(i, last));
    }
    return this.smooth;
  }

  /** The not yet final smoothed points, with the window that fits now. */
  private provisionalSmooth(): FPoint[] {
    const out: FPoint[] = [];
    const last = this.filtered.length - 1;
    for (let i = this.smooth.length; i <= last; i++) out.push(this.smoothPoint(i, last));
    return out;
  }

  /** Emit spline segments that can no longer change. Segment k needs control points k-1..k+2. */
  private emitStable(): void {
    const src = this.sigma() > 0 ? this.finalizeSmooth() : this.filtered;
    const n = src.length;
    // Segment k (from point k to k+1) is final once point k+2 exists among filtered points.
    const lastStable = n - 3;
    while (this.stableSegments <= lastStable) {
      const k = this.stableSegments;
      if (k === 0) {
        this.pushSample(src[0], this.widthState, this.stableXs, this.stableYs, this.stableRs, 0);
      }
      this.emitSegment(src, k, this.widthState, this.stableXs, this.stableYs, this.stableRs);
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
    const coarse = clamp(this.params.width * 0.3, 0.2, 0.6);
    // 0.12: while drawing, about one screen pixel per step (cheap at low zoom); the stored ink is
    // sampled again at MAX_SPLINE_STEP when the pen lifts (round at 2400 %)
    const step = this.v12 ? Math.min(coarse, this.fine ? MAX_SPLINE_STEP : Math.max(MAX_SPLINE_STEP, LIVE_STEP_PX / this.ctx.zoom)) : coarse;
    const count = clamp(Math.ceil(len / step), 1, this.v12 ? 96 : 64);
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
      if (this.v12) {
        // direction smoothed over a few screen px of travel (and at least half the pen width)
        const k = ws.nx === 0 && ws.ny === 0 ? 1 : expAlpha(ds, Math.max(prm.width * 0.5, NIB_DIR_PX / this.ctx.zoom));
        ws.nx += (dx / ds - ws.nx) * k;
        ws.ny += (dy / ds - ws.ny) * k;
        dir = Math.atan2(ws.ny, ws.nx);
      } else dir = Math.atan2(dy, dx);
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

  /**
   * The geometry to store when the pen lifts (0.12): exactly the ink drawn live (stable prefix +
   * tail, without predicted points), with two small finishing touches on that same data — a lift
   * hook is removed only when it clearly turns back, and the exit taper is half as long as the one
   * finalize() adds. Nothing is rebuilt, so the stroke does not move when the pen lifts.
   */
  commitGeometry(): { xs: number[]; ys: number[]; rs: number[] } {
    let xs: number[];
    let ys: number[];
    let rs: number[];
    if (this.v12) ({ xs, ys, rs } = this.fineCurve());
    else {
      const st = this.stable();
      const tl = this.tail();
      xs = (st.xs as number[]).concat(tl.xs);
      ys = (st.ys as number[]).concat(tl.ys);
      rs = (st.rs as number[]).concat(tl.rs);
    }
    if (!this.ctx.cutEnd) ({ xs, ys, rs } = trimGeometryHook(xs, ys, rs, this.ctx.zoom));
    const base = this.ctx.cutEnd ? { ...this.params, tapering: 0 } : this.params;
    const prm = { ...base, tapering: base.tapering * COMMIT_TAPER };
    const drawnEnd = rs.length ? rs[rs.length - 1] : 0;
    const dep = COMMIT_TAPER_DEPTH;
    const g = this.ctx.engine === 2 ? finishGeometryV2(xs, ys, rs, this.tool, prm, this.exitSpeed(), this.ctx.hasPressure, dep) : finishGeometry(xs, ys, rs, this.tool, prm, this.exitSpeed(), dep);
    if (!g.dot) keepTipReach(g.xs, g.ys, g.rs, drawnEnd);
    return quantizeGeometry(simplifyGeometry(g));
  }

  /**
   * The same curve as stable() + tail() (same control points and width model), sampled at
   * MAX_SPLINE_STEP: what is drawn live per screen pixel is stored finely enough for 2400 %.
   */
  private fineCurve(): { xs: number[]; ys: number[]; rs: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    const rs: number[] = [];
    if (this.filtered.length === 0) return { xs, ys, rs };
    const endRaw = this.raw.length ? this.raw[this.raw.length - 1] : null;
    const cps = this.controlPoints(endRaw);
    const ws: WidthState = { w: 0, s: 0, lastX: 0, lastY: 0, started: false, nx: 0, ny: 0 };
    this.fine = true;
    try {
      this.pushSample(cps[0], ws, xs, ys, rs, 0);
      for (let k = 0; k < cps.length - 1; k++) this.emitSegment(cps, k, ws, xs, ys, rs);
    } finally {
      this.fine = false;
    }
    return { xs, ys, rs };
  }

  /** Complete geometry for the finished stroke (exit taper + lift-hook suppression). */
  finalize(depth = 1): StrokeGeometry {
    const st = this.stable();
    const tl = this.tail();
    const xs = (st.xs as number[]).concat(tl.xs);
    const ys = (st.ys as number[]).concat(tl.ys);
    const rs = (st.rs as number[]).concat(tl.rs);
    // a fragment end cut by the partial eraser keeps its width (no exit taper)
    const prm = this.ctx.cutEnd ? { ...this.params, tapering: 0 } : this.params;
    if (this.ctx.engine === 2) return finishGeometryV2(xs, ys, rs, this.tool, prm, this.exitSpeed(), this.ctx.hasPressure, depth);
    return finishGeometry(xs, ys, rs, this.tool, prm, this.exitSpeed(), depth);
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
  depth = 1,
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
    const minEnd = lerp(1, tool === 'fountain' ? lerp(0.62, 0.14, fast) : lerp(0.9, 0.6, fast), depth);
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
  depth = 1,
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
    const minEnd = lerp(1, tool === 'fountain' ? lerp(0.72, 0.28, fast) : lerp(0.92, 0.7, fast), depth);
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

/**
 * Exit taper of a committed stroke relative to finalize() (0.12): half as long and half as deep,
 * so the end of the ink changes only a little when the pen lifts.
 */
export const COMMIT_TAPER = 0.5;
export const COMMIT_TAPER_DEPTH = 0;
/** Stored geometry precision: 1/100 unit for positions, 1/200 for radii (sub-pixel even at 24×). */
const GEO_Q = 100;
const GEO_RQ = 200;

/** Round stored geometry to the precision it is saved with (so a reload shows the same ink). */
export function quantizeGeometry(g: { xs: ArrayLike<number>; ys: ArrayLike<number>; rs: ArrayLike<number> }): { xs: number[]; ys: number[]; rs: number[] } {
  const n = g.xs.length;
  const xs: number[] = new Array<number>(n);
  const ys: number[] = new Array<number>(n);
  const rs: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    xs[i] = Math.round(g.xs[i] * GEO_Q) / GEO_Q;
    ys[i] = Math.round(g.ys[i] * GEO_Q) / GEO_Q;
    rs[i] = Math.max(1 / GEO_RQ, Math.round(g.rs[i] * GEO_RQ) / GEO_RQ);
  }
  return { xs, ys, rs };
}

/**
 * The taper thins the end of the ink; with round ends that also pulls the tip back by the radius it
 * takes away. Move the last point forward by that much (0.12): the tapered end reaches exactly as
 * far as the ink drawn live, inside it, so lifting the pen only thins the end, never shortens it.
 */
export function keepTipReach(xs: number[], ys: number[], rs: number[], drawnEnd: number): void {
  const n = xs.length;
  if (n < 2) return;
  const d = drawnEnd - rs[n - 1];
  if (!(d > 0)) return;
  // exit direction over the last ~2 radii (one segment can be very short)
  let k = n - 2;
  while (k > 0 && Math.hypot(xs[n - 1] - xs[k], ys[n - 1] - ys[k]) < drawnEnd * 2) k--;
  const dx = xs[n - 1] - xs[k];
  const dy = ys[n - 1] - ys[k];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  xs[n - 1] += (dx / len) * d;
  ys[n - 1] += (dy / len) * d;
}

/** Largest bend (radians) between the chords before and after a point that is smoothed at full width. */
const SMOOTH_BEND = (35 * Math.PI) / 180;

/** Angle between the chord from w px before point i to i and the chord from i to w px after it. */
function bendAt(f: readonly { x: number; y: number }[], arc: readonly number[], i: number, w: number, lo: number, hi: number): number {
  let a = i;
  while (a > lo && arc[i] - arc[a] < w) a--;
  let b = i;
  while (b < hi && arc[b] - arc[i] < w) b++;
  if (a === i || b === i) return 0;
  const d1 = Math.atan2(f[i].y - f[a].y, f[i].x - f[a].x);
  const d2 = Math.atan2(f[b].y - f[i].y, f[b].x - f[i].x);
  return angleDiff(d1, d2);
}

/** Points dropped from stored geometry may be at most this far (page units) from the kept outline. */
const SIMPLIFY_TOL = 0.008;
const SIMPLIFY_RTOL = 0.01;
/** Longest run of points one kept segment may replace. */
const SIMPLIFY_SPAN = 48;

/**
 * Drop the points of the drawn geometry that lie on the straight segment between their neighbours
 * (centerline within 0.015 units, radius within 0.01): the outline is unchanged to well under a
 * pixel even at 2400 %, and the file is several times smaller (the builder emits a point about
 * every screen pixel).
 */
export function simplifyGeometry(g: { xs: ArrayLike<number>; ys: ArrayLike<number>; rs: ArrayLike<number> }): { xs: number[]; ys: number[]; rs: number[] } {
  const n = g.xs.length;
  const xs: number[] = [];
  const ys: number[] = [];
  const rs: number[] = [];
  if (n === 0) return { xs, ys, rs };
  const keep = (i: number) => {
    xs.push(g.xs[i]);
    ys.push(g.ys[i]);
    rs.push(g.rs[i]);
  };
  keep(0);
  let a = 0;
  while (a < n - 1) {
    // extend the segment a→b as far as every point between stays on it
    let b = a + 1;
    while (b + 1 < n && b + 1 - a <= SIMPLIFY_SPAN && fits(g, a, b + 1)) b++;
    keep(b);
    a = b;
  }
  return { xs, ys, rs };
}

function fits(g: { xs: ArrayLike<number>; ys: ArrayLike<number>; rs: ArrayLike<number> }, a: number, b: number): boolean {
  const ax = g.xs[a];
  const ay = g.ys[a];
  const dx = g.xs[b] - ax;
  const dy = g.ys[b] - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return false;
  let prevT = 0;
  for (let i = a + 1; i < b; i++) {
    const px = g.xs[i] - ax;
    const py = g.ys[i] - ay;
    const t = (px * dx + py * dy) / l2;
    // the points must advance along the segment (no doubling back)
    if (t < prevT || t > 1) return false;
    prevT = t;
    const ex = px - dx * t;
    const ey = py - dy * t;
    if (ex * ex + ey * ey > SIMPLIFY_TOL * SIMPLIFY_TOL) return false;
    const r = g.rs[a] + (g.rs[b] - g.rs[a]) * t;
    if (Math.abs(r - g.rs[i]) > SIMPLIFY_RTOL) return false;
  }
  return true;
}

/** Render geometry (bbox, dot) from stored geometry. */
export function geometryFromStored(geom: { xs: number[]; ys: number[]; rs: number[] }): StrokeGeometry {
  const { xs, ys, rs } = geom;
  const n = Math.min(xs.length, ys.length, rs.length);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = rs[i];
    if (xs[i] - r < x0) x0 = xs[i] - r;
    if (ys[i] - r < y0) y0 = ys[i] - r;
    if (xs[i] + r > x1) x1 = xs[i] + r;
    if (ys[i] + r > y1) y1 = ys[i] + r;
  }
  if (n === 0) x0 = y0 = x1 = y1 = 0;
  return { xs: xs.slice(0, n), ys: ys.slice(0, n), rs: rs.slice(0, n), dot: n === 1, bbox: [x0, y0, x1, y1] };
}

/**
 * Lift hook on the drawn geometry (0.12): the last ≤ 2.5 screen px of the centerline when they turn
 * back (> 100°) against the direction before them. Only a clear hook is cut — trimming more made
 * the end of every stroke retract when the pen lifted.
 */
export function trimGeometryHook(xs: number[], ys: number[], rs: number[], zoom: number): { xs: number[]; ys: number[]; rs: number[] } {
  const n = xs.length;
  if (n < 6) return { xs, ys, rs };
  const z = zoom > 0 ? zoom : 1;
  const maxHook = 2.5 / z;
  // the start of the end piece: walk back up to maxHook along the centerline
  let len = 0;
  let k = n - 1;
  while (k > 0 && len + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]) <= maxHook) {
    len += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
    k--;
  }
  if (k >= n - 1 || len < 0.4 / z) return { xs, ys, rs };
  // direction before the end piece (over ~3 screen px)
  let j = k;
  let before = 0;
  while (j > 0 && before < 3 / z) {
    before += Math.hypot(xs[j] - xs[j - 1], ys[j] - ys[j - 1]);
    j--;
  }
  if (before < 1.5 / z) return { xs, ys, rs };
  const mainDir = Math.atan2(ys[k] - ys[j], xs[k] - xs[j]);
  const hookDir = Math.atan2(ys[n - 1] - ys[k], xs[n - 1] - xs[k]);
  if (angleDiff(hookDir, mainDir) <= (100 * Math.PI) / 180) return { xs, ys, rs };
  return { xs: xs.slice(0, k + 1), ys: ys.slice(0, k + 1), rs: rs.slice(0, k + 1) };
}

/** Build geometry for a complete stroke in one go (used for committed/loaded strokes). */
export function buildStrokeGeometry(
  samples: readonly InputSample[],
  tool: InkTool,
  params: PenParams,
  ctx: StrokeContext,
  taperDepth = 1,
): StrokeGeometry {
  const b = new StrokeBuilder(tool, params, ctx);
  const src = ctx.cutEnd ? samples.slice() : trimLiftHook(samples, ctx.zoom);
  for (const s of src) b.add(s);
  if (src.length === 0) {
    return { xs: [], ys: [], rs: [], dot: false, bbox: [0, 0, 0, 0] };
  }
  return b.finalize(taperDepth);
}
