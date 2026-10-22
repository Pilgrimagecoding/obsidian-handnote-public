import { el } from './dom';

/**
 * Compact step slider (replaces the native range input, whose giant thumb on Obsidian mobile
 * covered the labels). Thin track, small thumb, tick marks at the stops (default 0 / 25 / 50 / 75
 * / 100 %), soft snapping near a stop, the value shown at the right, keyboard support.
 * Updates only call `onInput`; nothing here triggers a page re-render.
 */
export interface StepSliderOptions {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Values with a tick mark (snap targets). Default: 0, 25, 50, 75, 100 % of the range. */
  stops?: number[];
  /** Show the stop labels under the track. */
  stopLabels?: boolean;
  /** Fine step for keyboard / continuous dragging. */
  step?: number;
  /** Map the value to a 0..1 track position and back (non-linear sliders, e.g. width in mm). */
  toPos?: (v: number) => number;
  fromPos?: (p: number) => number;
  format?: (v: number) => string;
  /** Tapered track (stroke width). */
  taper?: boolean;
  onInput(v: number): void;
}

const SNAP = 0.035; // fraction of the track

export interface StepSlider {
  el: HTMLElement;
  set(v: number): void;
  get(): number;
}

export function stepSlider(parent: HTMLElement, o: StepSliderOptions): StepSlider {
  const toPos = o.toPos ?? ((v: number) => (v - o.min) / (o.max - o.min));
  const fromPos = o.fromPos ?? ((p: number) => o.min + p * (o.max - o.min));
  const fmt = o.format ?? ((v: number) => String(Math.round(v * 100) / 100));
  const stops = o.stops ?? [0, 0.25, 0.5, 0.75, 1].map((p) => o.min + p * (o.max - o.min));
  const step = o.step ?? (o.max - o.min) / 100;
  let value = o.value;

  const root = el('div', 'hn-sl' + (o.taper ? ' is-taper' : ''), parent);
  const head = el('div', 'hn-sl-head', root);
  el('span', 'hn-sl-label', head, o.label);
  const valEl = el('span', 'hn-sl-value', head);
  const track = el('div', 'hn-sl-track', root);
  track.tabIndex = 0;
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', o.label);
  track.setAttribute('aria-valuemin', String(o.min));
  track.setAttribute('aria-valuemax', String(o.max));
  el('div', 'hn-sl-rail', track);
  const fill = el('div', 'hn-sl-fill', track);
  for (const s of stops) {
    const tick = el('div', 'hn-sl-tick', track);
    tick.style.left = `${toPos(s) * 100}%`;
  }
  const thumb = el('div', 'hn-sl-thumb', track);
  if (o.stopLabels) {
    const row = el('div', 'hn-sl-stops', root);
    for (const s of stops) {
      const b = el('button', 'hn-sl-stop', row, fmt(s));
      b.type = 'button';
      b.style.left = `${toPos(s) * 100}%`;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        apply(s, true);
      });
    }
  }

  const render = () => {
    const p = Math.min(1, Math.max(0, toPos(value)));
    thumb.style.left = `${p * 100}%`;
    fill.style.width = `${p * 100}%`;
    valEl.textContent = fmt(value);
    track.setAttribute('aria-valuenow', String(value));
    track.setAttribute('aria-valuetext', fmt(value));
    for (const [i, t] of Array.from(track.querySelectorAll('.hn-sl-tick')).entries()) t.classList.toggle('is-on', toPos(stops[i]) <= p + 1e-6);
  };
  const apply = (v: number, emit: boolean) => {
    const nv = Math.min(o.max, Math.max(o.min, v));
    if (nv === value) return;
    value = nv;
    render();
    if (emit) o.onInput(value);
  };
  const fromClient = (cx: number) => {
    const r = track.getBoundingClientRect();
    let p = Math.min(1, Math.max(0, (cx - r.left) / Math.max(1, r.width)));
    // soft snap to the nearest stop
    for (const s of stops) if (Math.abs(toPos(s) - p) < SNAP) p = toPos(s);
    let v = fromPos(p);
    if (!stops.some((s) => s === v)) v = Math.round(v / step) * step;
    return v;
  };
  let dragging: number | null = null;
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = e.pointerId;
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    root.classList.add('is-dragging');
    apply(fromClient(e.clientX), true);
  });
  track.addEventListener('pointermove', (e) => {
    if (dragging !== e.pointerId) return;
    e.preventDefault();
    apply(fromClient(e.clientX), true);
  });
  const end = (e: PointerEvent) => {
    if (dragging !== e.pointerId) return;
    dragging = null;
    root.classList.remove('is-dragging');
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    let v: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = value + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = value - step;
    else if (e.key === 'PageUp') v = stops.find((s) => s > value + 1e-9) ?? o.max;
    else if (e.key === 'PageDown') v = [...stops].reverse().find((s) => s < value - 1e-9) ?? o.min;
    else if (e.key === 'Home') v = o.min;
    else if (e.key === 'End') v = o.max;
    if (v === null) return;
    e.preventDefault();
    e.stopPropagation();
    apply(v, true);
  });
  render();
  return { el: root, set: (v) => apply(v, false), get: () => value };
}
