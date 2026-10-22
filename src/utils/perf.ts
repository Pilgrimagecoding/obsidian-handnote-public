/**
 * Lightweight performance instrumentation for the Input -> Processing -> Render pipeline.
 *
 * IMPORTANT: none of these numbers is end-to-end "pencil tip to photons" latency. A web view
 * cannot observe display scan-out or the touch controller. Measuring true latency requires a
 * high-speed camera; see docs/IPAD_TEST_CHECKLIST.md.
 */
export class RollingStat {
  private buf: number[] = [];
  constructor(private readonly size = 600) {}
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  get count(): number {
    return this.buf.length;
  }
  summary(): { n: number; avg: number; p50: number; p95: number; max: number } {
    const n = this.buf.length;
    if (n === 0) return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 };
    const s = [...this.buf].sort((a, b) => a - b);
    const q = (f: number) => s[Math.min(n - 1, Math.floor(f * (n - 1)))];
    return { n, avg: s.reduce((a, b) => a + b, 0) / n, p50: q(0.5), p95: q(0.95), max: s[n - 1] };
  }
  clear(): void {
    this.buf = [];
  }
}

export interface PerfSnapshot {
  inputInterval: ReturnType<RollingStat['summary']>;
  samplesPerEvent: ReturnType<RollingStat['summary']>;
  processing: ReturnType<RollingStat['summary']>;
  render: ReturnType<RollingStat['summary']>;
  frameInterval: ReturnType<RollingStat['summary']>;
  droppedFrames: number;
  framesObserved: number;
  sceneRender: ReturnType<RollingStat['summary']>;
  pressure: ReturnType<RollingStat['summary']>;
  strokes: number;
  capabilities: Record<string, boolean | number | string>;
}

export class PerfMonitor {
  readonly inputInterval = new RollingStat();
  readonly samplesPerEvent = new RollingStat();
  readonly processing = new RollingStat();
  readonly render = new RollingStat();
  readonly frameInterval = new RollingStat();
  readonly sceneRender = new RollingStat(120);
  /** Raw pen pressure values (0..1), to calibrate the pressure curve on a real device. */
  readonly pressure = new RollingStat(2000);
  droppedFrames = 0;
  framesObserved = 0;
  strokes = 0;
  capabilities: Record<string, boolean | number | string> = {};
  private lastFrame = 0;
  private lastSampleT = 0;

  sample(timestamp: number): void {
    if (this.lastSampleT > 0) {
      const d = timestamp - this.lastSampleT;
      if (d >= 0 && d < 100) this.inputInterval.push(d);
    }
    this.lastSampleT = timestamp;
  }

  strokeStart(): void {
    this.lastSampleT = 0;
    this.lastFrame = 0;
    this.strokes++;
  }

  frame(now: number): void {
    if (this.lastFrame > 0) {
      const d = now - this.lastFrame;
      if (d < 250) {
        this.frameInterval.push(d);
        this.framesObserved++;
        // estimate the display period from the fastest observed intervals
        const s = this.frameInterval.summary();
        const period = Math.max(4, Math.min(s.p50, 17));
        if (d > period * 1.6) this.droppedFrames += Math.round(d / period) - 1;
      }
    }
    this.lastFrame = now;
  }

  reset(): void {
    this.inputInterval.clear();
    this.samplesPerEvent.clear();
    this.processing.clear();
    this.render.clear();
    this.frameInterval.clear();
    this.sceneRender.clear();
    this.pressure.clear();
    this.droppedFrames = 0;
    this.framesObserved = 0;
    this.strokes = 0;
  }

  snapshot(): PerfSnapshot {
    return {
      inputInterval: this.inputInterval.summary(),
      samplesPerEvent: this.samplesPerEvent.summary(),
      processing: this.processing.summary(),
      render: this.render.summary(),
      frameInterval: this.frameInterval.summary(),
      droppedFrames: this.droppedFrames,
      framesObserved: this.framesObserved,
      sceneRender: this.sceneRender.summary(),
      pressure: this.pressure.summary(),
      strokes: this.strokes,
      capabilities: this.capabilities,
    };
  }

  format(): string {
    const s = this.snapshot();
    const f = (x: { avg: number; p95: number; n: number }) => `${x.avg.toFixed(2)} / p95 ${x.p95.toFixed(2)} ms (n=${x.n})`;
    return [
      `input interval  ${f(s.inputInterval)}`,
      `samples/event   ${s.samplesPerEvent.avg.toFixed(2)} (max ${s.samplesPerEvent.max})`,
      `processing      ${f(s.processing)}`,
      `stroke render   ${f(s.render)}`,
      `frame interval  ${f(s.frameInterval)}`,
      `dropped frames  ${s.droppedFrames} / ${s.framesObserved}`,
      `scene render    ${f(s.sceneRender)}`,
      `pen pressure    avg ${s.pressure.avg.toFixed(3)} p50 ${s.pressure.p50.toFixed(3)} p95 ${s.pressure.p95.toFixed(3)} max ${s.pressure.max.toFixed(3)}`,
      `not measured: pen-to-pixel latency`,
    ].join('\n');
  }
}
