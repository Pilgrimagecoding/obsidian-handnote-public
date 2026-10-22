import type { Owner, RouterPointer } from './input-router';

/**
 * Local-only input diagnostics (nothing is sent anywhere). Detailed sample collection is OFF by
 * default; classification counters are always kept because they cost nothing.
 *
 * The report answers the questions the v0.2 work needs real-device data for:
 *  - Does the Pencil deliver real, varying pressure in Obsidian's iPad web view?
 *  - What contact sizes does WebKit report for fingers and palms?
 *  - Are coalesced / predicted events available, and at what rate do samples arrive?
 *  - How wide are the rendered strokes?
 */

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

export function summarize(values: number[]): { n: number; min: number; max: number; mean: number; p50: number; p95: number } {
  const n = values.length;
  if (!n) return { n: 0, min: NaN, max: NaN, mean: NaN, p50: NaN, p95: NaN };
  const s = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of s) sum += v;
  return { n, min: s[0], max: s[n - 1], mean: sum / n, p50: quantile(s, 0.5), p95: quantile(s, 0.95) };
}

export function histogram(values: number[], bins: number, lo: number, hi: number): number[] {
  const h: number[] = new Array<number>(bins).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * bins)));
    h[i]++;
  }
  return h;
}

export interface PressureVerdict {
  verdict: 'real' | 'constant' | 'none' | 'insufficient';
  reason: string;
}

/**
 * Classify a set of pen pressure samples. Browsers report a fixed 0.5 (button down) or 0 for devices
 * without pressure; a real pressure sensor yields many distinct, varying values.
 */
export function pressureVerdict(samples: number[]): PressureVerdict {
  if (samples.length < 20) return { verdict: 'insufficient', reason: `only ${samples.length} pen samples` };
  const distinct = new Set(samples.map((v) => Math.round(v * 1000))).size;
  const zero = samples.filter((v) => v === 0).length / samples.length;
  const half = samples.filter((v) => v === 0.5).length / samples.length;
  if (zero > 0.95) return { verdict: 'none', reason: 'pressure is 0 for >95% of samples' };
  if (half > 0.95) return { verdict: 'constant', reason: 'pressure is a fixed 0.5 (no pressure sensor reported)' };
  if (distinct < 4) return { verdict: 'constant', reason: `only ${distinct} distinct pressure values` };
  return { verdict: 'real', reason: `${distinct} distinct values` };
}

interface StrokeStat {
  kind: string;
  samples: number;
  events: number;
  maxCoalesced: number;
  pMin: number;
  pMax: number;
  constantRatio: number;
  durationMs: number;
}

export class InputDiagnostics {
  enabled = false;
  enabledAt = 0;
  private readonly cap = 20000;
  readonly owners: Record<string, number> = {};
  readonly reasons: Record<string, number> = {};
  readonly touchSize: number[] = [];
  readonly palmSize: number[] = [];
  readonly pressure: number[] = [];
  readonly eventIntervals: number[] = [];
  readonly widths: number[] = [];
  readonly strokes: StrokeStat[] = [];
  private current: (StrokeStat & { startT: number; lastT: number; lastP: number; same: number }) | null = null;
  private pendingSize = new Map<number, number>();

  setEnabled(on: boolean): void {
    if (on && !this.enabled) this.enabledAt = Date.now();
    if (!on) this.enabledAt = 0;
    this.enabled = on;
  }

  clear(): void {
    for (const k of Object.keys(this.owners)) delete this.owners[k];
    for (const k of Object.keys(this.reasons)) delete this.reasons[k];
    for (const a of [this.touchSize, this.palmSize, this.pressure, this.eventIntervals, this.widths, this.strokes]) a.length = 0;
  }

  pointerDown(p: RouterPointer): void {
    if (p.kind === 'touch') this.pendingSize.set(p.id, Math.max(p.width, p.height));
  }

  classified(p: RouterPointer, owner: Owner, reason: string): void {
    this.owners[owner] = (this.owners[owner] ?? 0) + 1;
    const key = `${p.kind}:${reason}`;
    this.reasons[key] = (this.reasons[key] ?? 0) + 1;
    const size = this.pendingSize.get(p.id);
    this.pendingSize.delete(p.id);
    if (size !== undefined && this.enabled) {
      if (owner === 'palm') this.palmSize.push(size);
      else this.touchSize.push(size);
    }
  }

  strokeBegin(kind: string, t: number, pressure: number): void {
    if (!this.enabled) return;
    this.current = { kind, samples: 0, events: 0, maxCoalesced: 0, pMin: Infinity, pMax: -Infinity, constantRatio: 0, durationMs: 0, startT: t, lastT: t, lastP: NaN, same: 0 };
    this.sample(t, pressure, kind);
  }

  /** One coalesced sample. */
  sample(t: number, pressure: number, kind: string): void {
    const c = this.current;
    if (!this.enabled || !c) return;
    if (c.samples > 0) {
      const dt = t - c.lastT;
      if (dt >= 0 && dt < 100 && this.eventIntervals.length < this.cap) this.eventIntervals.push(dt);
      if (pressure === c.lastP) c.same++;
    }
    c.samples++;
    c.lastT = t;
    c.lastP = pressure;
    if (kind === 'pen') {
      if (this.pressure.length < this.cap) this.pressure.push(pressure);
      c.pMin = Math.min(c.pMin, pressure);
      c.pMax = Math.max(c.pMax, pressure);
    }
  }

  /** One pointermove event carrying `n` coalesced samples. */
  event(n: number): void {
    const c = this.current;
    if (!this.enabled || !c) return;
    c.events++;
    c.maxCoalesced = Math.max(c.maxCoalesced, n);
  }

  strokeEnd(t: number, radii: ArrayLike<number> | null): void {
    const c = this.current;
    this.current = null;
    if (!this.enabled || !c) return;
    c.durationMs = Math.max(0, t - c.startT);
    c.constantRatio = c.samples > 1 ? c.same / (c.samples - 1) : 1;
    const stat: StrokeStat = {
      kind: c.kind,
      samples: c.samples,
      events: c.events,
      maxCoalesced: c.maxCoalesced,
      pMin: c.pMin,
      pMax: c.pMax,
      constantRatio: c.constantRatio,
      durationMs: c.durationMs,
    };
    if (this.strokes.length < 500) this.strokes.push(stat);
    if (radii) for (let i = 0; i < radii.length && this.widths.length < this.cap; i += 4) this.widths.push(radii[i] * 2);
  }

  report(extra: Record<string, unknown> = {}): string {
    const f = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
    const P = summarize(this.pressure);
    const verdict = pressureVerdict(this.pressure);
    const hist = histogram(this.pressure, 10, 0, 1);
    const ev = summarize(this.eventIntervals);
    const W = summarize(this.widths);
    const T = summarize(this.touchSize);
    const PS = summarize(this.palmSize);
    const penStrokes = this.strokes.filter((s) => s.kind === 'pen');
    const constStrokes = penStrokes.filter((s) => s.constantRatio > 0.9).length;
    const lines = [
      '# HandNote input diagnostics',
      '',
      `collection: ${this.enabled ? 'ON' : 'OFF (counters only)'}${this.enabledAt ? ` since ${new Date(this.enabledAt).toISOString()}` : ''} — owner/reason counters cover the whole session; sizes, pressure and timings only the collection period`,
      '',
      '## Pen pressure',
      `verdict: **${verdict.verdict.toUpperCase()}** — ${verdict.reason}`,
      `samples ${P.n} · min ${f(P.min)} · max ${f(P.max)} · mean ${f(P.mean)} · median ${f(P.p50)} · p95 ${f(P.p95)}`,
      `histogram (0→1, 10 bins): ${hist.join(' ')}`,
      `pen strokes ${penStrokes.length} · strokes with >90% repeated pressure: ${constStrokes}`,
      verdict.verdict === 'real' && P.n >= 200
        ? ((c) => `suggested calibration: typical ${c.typical.toFixed(2)} · heavy ${c.heavy.toFixed(2)} (pen panel → Advanced → Calibrate from my writing)`)(
            calibration(P.p50, quantile([...this.pressure].sort((a, b) => a - b), 0.99)),
          )
        : 'suggested calibration: not enough real pressure data',
      '',
      '## Sampling',
      `sample interval ms: p50 ${f(ev.p50, 2)} · p95 ${f(ev.p95, 2)} (n=${ev.n})`,
      `max coalesced samples per event: ${Math.max(0, ...this.strokes.map((s) => s.maxCoalesced))}`,
      '',
      '## Rendered stroke width (page units)',
      `p50 ${f(W.p50, 2)} · p95 ${f(W.p95, 2)} · min ${f(W.min, 2)} · max ${f(W.max, 2)} (n=${W.n})`,
      '',
      '## Touch classification',
      `owners: ${JSON.stringify(this.owners)}`,
      `reasons: ${JSON.stringify(this.reasons)}`,
      `finger contact size px (navigation/ink): p50 ${f(T.p50, 1)} · p95 ${f(T.p95, 1)} · max ${f(T.max, 1)} (n=${T.n})`,
      `palm contact size px: p50 ${f(PS.p50, 1)} · p95 ${f(PS.p95, 1)} · max ${f(PS.max, 1)} (n=${PS.n})`,
      '',
      '## Environment',
      ...Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
      '',
      '_Not measured: pen-tip-to-pixel latency (not observable from a web view)._',
    ];
    return lines.join('\n');
  }
}

/** Typical = measured median; heavy = measured p99, kept clearly above typical. */
export function calibration(median: number, p99: number): { typical: number; heavy: number } {
  const typical = Math.min(0.8, Math.max(0.05, median));
  const heavy = Math.min(1, Math.max(0.15, p99, typical * 1.8, typical + 0.1));
  return { typical: Math.round(typical * 100) / 100, heavy: Math.round(heavy * 100) / 100 };
}
