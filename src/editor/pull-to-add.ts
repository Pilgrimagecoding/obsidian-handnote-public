import { el } from '../ui/dom';
import { setHnIcon } from '../ui/icons';
import { t } from '../ui/i18n';

/** Screen pixels of pull past the end that arm "add a page". */
export const PULL_THRESHOLD = 120;
/** Below this the indicator stays hidden (a normal scroll that just touches the end). */
const PULL_SHOW = 8;
const R = 26;
const CIRC = 2 * Math.PI * R;

/**
 * "Pull to add a page" (0.10, GoodNotes-style): a ring with a page icon below the last page that
 * fills up — grey to the accent colour — while the user keeps pulling past the end. Pure view +
 * state: the editor feeds the overshoot and asks `armed` when the gesture ends.
 */
export class PullToAddPage {
  readonly el: HTMLElement;
  private readonly ring: SVGCircleElement;
  private readonly label: HTMLElement;
  private progress = 0;

  constructor(root: HTMLElement) {
    this.el = el('div', 'hn-pull-add is-hidden', root);
    this.el.setAttribute('aria-hidden', 'true');
    const disc = el('div', 'hn-pull-disc', this.el);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.classList.add('hn-pull-svg');
    const track = document.createElementNS(NS, 'circle');
    track.setAttribute('cx', '32');
    track.setAttribute('cy', '32');
    track.setAttribute('r', String(R));
    track.classList.add('hn-pull-track');
    this.ring = document.createElementNS(NS, 'circle');
    this.ring.setAttribute('cx', '32');
    this.ring.setAttribute('cy', '32');
    this.ring.setAttribute('r', String(R));
    this.ring.classList.add('hn-pull-ring');
    this.ring.setAttribute('stroke-dasharray', String(CIRC));
    this.ring.setAttribute('stroke-dashoffset', String(CIRC));
    svg.append(track, this.ring);
    disc.appendChild(svg);
    setHnIcon(el('span', 'hn-pull-icon', disc), 'page-add');
    this.label = el('div', 'hn-pull-label', this.el, t('pullToAddPage'));
  }

  /** Pull distance past the end in screen px (0 = none); `x`/`y`: where the ring goes (root px). */
  update(overshoot: number, x: number, y: number): void {
    if (overshoot < PULL_SHOW) {
      this.reset();
      return;
    }
    this.progress = Math.min(1, overshoot / PULL_THRESHOLD);
    this.el.classList.remove('is-hidden');
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    this.ring.setAttribute('stroke-dashoffset', String(CIRC * (1 - this.progress)));
    const armed = this.progress >= 1;
    this.el.classList.toggle('is-armed', armed);
    this.el.style.setProperty('--hn-pull', String(this.progress));
    this.label.textContent = armed ? t('releaseToAddPage') : t('pullToAddPage');
  }

  get armed(): boolean {
    return this.progress >= 1;
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden');
  }

  reset(): void {
    this.progress = 0;
    this.el.classList.add('is-hidden');
    this.el.classList.remove('is-armed');
    this.ring.setAttribute('stroke-dashoffset', String(CIRC));
  }

  destroy(): void {
    this.el.remove();
  }
}
