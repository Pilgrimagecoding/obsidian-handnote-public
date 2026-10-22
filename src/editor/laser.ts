import type { LaserSettings } from './settings';
import { el, hide, show } from '../ui/dom';

interface TrailPoint {
  x: number; // viewport CSS px
  y: number;
  /** first point of a new segment (pen was lifted before it) */
  start: boolean;
}

/** Upper bound of kept trail points (a long presentation must not slow the frame down). */
const MAX_TRAIL_POINTS = 6000;

/**
 * Laser pointer: a glowing dot that follows the pen / mouse and (trail mode) the line drawn with it.
 *
 * Timing follows the way presenters use it (and GoodNotes' laser trail): the trail does not age
 * point by point. Everything written stays fully visible while the pen keeps writing — including
 * short lifts between words — and only once the pen has been idle for `holdMs` does the whole
 * trail fade out together over `fadeMs`.
 *
 * Drawn on its own screen-space canvas. Never saved, never part of undo/redo. The canvas is hidden
 * and has no bitmap while nothing is shown (iPad canvas memory).
 */
export class LaserPointer {
  private readonly canvas: HTMLCanvasElement;
  private trail: TrailPoint[] = [];
  private tip: { x: number; y: number } | null = null;
  private down = false;
  private lastActive = 0;
  private raf = 0;
  private dpr = 1;

  constructor(
    viewport: HTMLElement,
    private readonly settings: () => LaserSettings,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.canvas = el('canvas', 'hn-laser', viewport);
    this.release();
  }

  /** Hide the canvas and free its bitmap while nothing is shown. */
  private release(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
    hide(this.canvas);
  }

  private size(): void {
    const v = this.canvas.parentElement as HTMLElement;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = v.clientWidth;
    const h = v.clientHeight;
    show(this.canvas);
    if (this.canvas.width !== Math.round(w * this.dpr) || this.canvas.height !== Math.round(h * this.dpr)) {
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
  }

  begin(x: number, y: number): void {
    this.size();
    this.down = true;
    this.lastActive = this.now();
    this.tip = { x, y };
    // the previous trail has fully faded: start a fresh one
    if (this.opacity() <= 0) this.trail = [];
    if (this.settings().mode === 'trail') this.push({ x, y, start: true });
    this.loop();
  }

  move(x: number, y: number): void {
    if (!this.down) return;
    this.lastActive = this.now();
    this.tip = { x, y };
    if (this.settings().mode === 'trail') this.push({ x, y, start: false });
    this.loop();
  }

  end(): void {
    this.down = false;
    this.lastActive = this.now();
    this.loop();
  }

  /** Mouse hover (the dot follows the cursor without drawing a trail). */
  hover(x: number, y: number): void {
    if (this.down) return;
    this.size();
    this.tip = { x, y };
    if (this.opacity() <= 0) this.trail = [];
    this.lastActive = this.now();
    this.loop();
  }

  get active(): boolean {
    return this.down || this.opacity() > 0;
  }

  /** Number of trail points currently kept (tests). */
  get trailLength(): number {
    return this.trail.length;
  }

  /** 1 while writing and during the hold time, then down to 0 over the fade time. */
  opacity(): number {
    if (this.down) return 1;
    if (!this.trail.length && !this.tip) return 0;
    const s = this.settings();
    const idle = this.now() - this.lastActive;
    if (idle <= s.holdMs) return 1;
    return Math.max(0, 1 - (idle - s.holdMs) / Math.max(1, s.fadeMs));
  }

  private push(p: TrailPoint): void {
    this.trail.push(p);
    if (this.trail.length > MAX_TRAIL_POINTS) {
      this.trail.splice(0, this.trail.length - MAX_TRAIL_POINTS);
      if (this.trail.length) this.trail[0] = { ...this.trail[0], start: true };
    }
  }

  private loop(): void {
    if (this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      if (this.draw()) this.loop();
      else {
        this.trail = [];
        this.tip = null;
        this.release();
      }
    });
  }

  /** Returns true while something is still visible. */
  private draw(): boolean {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return false;
    const s = this.settings();
    const alpha = this.opacity();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (alpha <= 0) return false;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this.trail.length > 1) {
      ctx.beginPath();
      for (const p of this.trail) {
        if (p.start) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = alpha * 0.3;
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3.4;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = alpha * 0.55;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    if (this.tip) {
      // the dot itself fades a little faster once the pen is lifted
      const dotAlpha = this.down ? 1 : alpha;
      ctx.globalAlpha = dotAlpha * 0.3;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(this.tip.x, this.tip.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = dotAlpha;
      ctx.beginPath();
      ctx.arc(this.tip.x, this.tip.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = dotAlpha * 0.85;
      ctx.beginPath();
      ctx.arc(this.tip.x, this.tip.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return true;
  }

  clear(): void {
    this.trail = [];
    this.tip = null;
    this.down = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.release();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.release();
    this.canvas.remove();
  }
}
