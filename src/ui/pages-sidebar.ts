import { el, hide, show } from './dom';
import { setHnIcon } from './icons';
import { t } from './i18n';
import { onTap } from './tap';

/**
 * Page navigator as a sidebar on the left (GoodNotes-style): a two-column grid of page thumbnails
 * in fixed-size cells (portrait, landscape and custom sizes never overlap), the current page
 * highlighted, a ⌄ menu per page, and drag-to-reorder (long press with Pencil / finger, drag with
 * the mouse).
 */
export interface PagesSidebarModel {
  count(): number;
  current(): number;
  readOnly(): boolean;
  /** Thumbnail of page i fitted into a box (CSS px); returns a canvas the sidebar may insert. */
  thumb(i: number, boxW: number, boxH: number): HTMLCanvasElement | null;
  hasPageClipboard(): boolean;
  onGo(i: number): void;
  onInsert(at: number): void;
  onCopy(i: number): void;
  onPaste(at: number): void;
  onDuplicate(i: number): void;
  onRotate(i: number): void;
  onMove(from: number, to: number): void;
  onExport(i: number, kind: 'png' | 'svg'): void;
  onClear(i: number): void;
  onDelete(i: number): void;
  onClose(): void;
}

export const THUMB_BOX_W = 96;
export const THUMB_BOX_H = 128;
const LONG_PRESS_MS = 320;
const DRAG_SLOP = 8;

/** A drag pointer that sent nothing for this long is treated as gone (lost pointerup). */
const STALE_MS = 1500;

interface DragState {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastEventAt: number;
  active: boolean;
  timer: number;
  ghost: HTMLElement | null;
  target: number;
  mouse: boolean;
  cell: HTMLElement;
  box: HTMLElement;
  cleanup: (() => void)[];
}

export class PagesSidebar {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly marker: HTMLElement;
  private menu: HTMLElement | null = null;
  private menuCleanup: (() => void) | null = null;
  private io: IntersectionObserver | null = null;
  private refreshQueued = false;
  private drag: DragState | null = null;
  private autoScroll = 0;
  private pendingRender = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly m: PagesSidebarModel,
  ) {
    this.el = el('div', 'hn-pages-sidebar', root);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    const head = el('div', 'hn-ps-head', this.el);
    this.titleEl = el('div', 'hn-ps-title', head);
    const close = el('button', 'hn-btn hn-ps-close', head);
    close.type = 'button';
    close.setAttribute('aria-label', t('close'));
    close.title = t('close');
    setHnIcon(close, 'close');
    onTap(close, () => this.m.onClose());
    this.list = el('div', 'hn-ps-list', this.el);
    this.marker = el('div', 'hn-ps-marker', this.list);
    hide(this.marker);
    // while a thumbnail is being dragged the list must not scroll natively (iPad)
    this.list.addEventListener(
      'touchmove',
      (e) => {
        if (this.drag?.active && e.cancelable) e.preventDefault();
      },
      { passive: false },
    );
    this.list.addEventListener('scroll', () => this.closeMenu(), { passive: true });
    this.render();
  }

  /** Rebuild the grid (keeps the scroll position). */
  render(): void {
    if (this.drag?.active) {
      // re-render after the drop (the document changed while dragging)
      this.pendingRender = true;
      return;
    }
    // a press that has not turned into a drag yet refers to cells that are about to be replaced
    if (this.drag) this.cancelGesture();
    this.pendingRender = false;
    this.closeMenu();
    const scroll = this.list.scrollTop;
    this.io?.disconnect();
    this.io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                if (!e.isIntersecting) continue;
                this.io?.unobserve(e.target);
                this.fillThumb(e.target as HTMLElement);
              }
            },
            { root: this.list, rootMargin: '200px' },
          )
        : null;
    for (const c of Array.from(this.list.querySelectorAll('.hn-ps-cell'))) c.remove();
    const n = this.m.count();
    const cur = this.m.current();
    const ro = this.m.readOnly();
    this.titleEl.textContent = `${t('pages')} · ${n}`;
    for (let i = 0; i < n; i++) {
      const cell = el('div', 'hn-ps-cell' + (i === cur ? ' is-current' : ''), this.list);
      cell.dataset.index = String(i);
      const box = el('div', 'hn-ps-box', cell);
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', `${t('page')} ${i + 1}`);
      box.style.width = `${THUMB_BOX_W}px`;
      box.style.height = `${THUMB_BOX_H}px`;
      this.bindThumb(box, cell, i);
      const foot = el('div', 'hn-ps-foot', cell);
      el('span', 'hn-ps-num', foot, String(i + 1));
      const more = el('button', 'hn-ps-more', foot);
      more.type = 'button';
      more.setAttribute('aria-label', `${t('pageOptions')} ${i + 1}`);
      setHnIcon(more, 'chevron-down');
      onTap(more, () => this.openMenu(i, more));
      if (this.io) this.io.observe(box);
      else this.fillThumb(box);
    }
    if (!ro) {
      const add = el('button', 'hn-ps-cell hn-ps-add', this.list);
      add.type = 'button';
      add.setAttribute('aria-label', t('addPage'));
      const ab = el('span', 'hn-ps-box hn-ps-add-box', add);
      ab.style.width = `${THUMB_BOX_W}px`;
      ab.style.height = `${THUMB_BOX_H}px`;
      setHnIcon(el('span', 'hn-ic', ab), 'plus');
      el('span', 'hn-ps-num', add, t('addPage'));
      onTap(add, () => this.m.onInsert(n));
    }
    this.list.scrollTop = scroll;
  }

  /**
   * Redraw the thumbnails on screen whose content may have changed (an imported page finished
   * rendering). Coalesced to one pass per frame; unchanged thumbnails are returned from the cache.
   */
  refreshThumbs(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.requestAnimationFrame(() => {
      this.refreshQueued = false;
      const top = this.list.scrollTop - 200;
      const bottom = this.list.scrollTop + this.list.clientHeight + 200;
      for (const box of Array.from(this.list.querySelectorAll<HTMLElement>('.hn-ps-cell .hn-ps-box'))) {
        const cell = box.parentElement as HTMLElement;
        if (!box.firstElementChild || cell.offsetTop + cell.offsetHeight < top || cell.offsetTop > bottom) continue;
        this.fillThumb(box);
      }
    });
  }

  /** Highlight the current page without rebuilding (scrolling the document). */
  setCurrent(i: number, reveal = false): void {
    this.list.querySelectorAll('.hn-ps-cell.is-current').forEach((c) => c.classList.remove('is-current'));
    const cell = this.list.querySelector<HTMLElement>(`.hn-ps-cell[data-index="${i}"]`);
    if (!cell) return;
    cell.classList.add('is-current');
    if (reveal) this.reveal(cell);
  }

  revealCurrent(): void {
    const cell = this.list.querySelector<HTMLElement>('.hn-ps-cell.is-current');
    if (cell) this.reveal(cell);
  }

  private reveal(cell: HTMLElement): void {
    const top = cell.offsetTop;
    const bottom = top + cell.offsetHeight;
    if (top < this.list.scrollTop || bottom > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = Math.max(0, top - this.list.clientHeight / 2 + cell.offsetHeight / 2);
    }
  }

  private fillThumb(box: HTMLElement): void {
    const cell = box.parentElement;
    const i = Number(cell?.dataset.index);
    if (!Number.isFinite(i)) return;
    const cv = this.m.thumb(i, THUMB_BOX_W - 8, THUMB_BOX_H - 8);
    if (!cv) return;
    cv.classList.add('hn-ps-canvas');
    box.textContent = '';
    box.appendChild(cv);
  }

  // ---------------------------------------------------------------------------------------------
  // Tap, long press, drag to reorder
  // ---------------------------------------------------------------------------------------------

  /**
   * A press on a thumbnail. The rest of the gesture is followed on `window` (not on the thumbnail):
   * on iPad the thumbnail can lose its implicit pointer capture or never receive the pointerup,
   * which left the drag ghost floating until some later event. Touch events (touchend /
   * touchcancel, reliable on iPadOS) are a second, independent end signal; leaving the app, a new
   * contact after the drag pointer went silent, or a re-render also end the gesture cleanly.
   */
  private bindThumb(box: HTMLElement, cell: HTMLElement, i: number): void {
    box.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      if (this.drag) {
        // another finger / pen while a drag runs is ignored; a stale gesture (its pointer went
        // silent: lost pointerup) is cancelled first
        if (performance.now() - this.drag.lastEventAt < STALE_MS) return;
        this.cancelGesture();
      }
      this.closeMenu();
      const mouse = e.pointerType === 'mouse';
      const d: DragState = {
        pointerId: e.pointerId,
        from: i,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        lastEventAt: performance.now(),
        active: false,
        timer: 0,
        ghost: null,
        target: i,
        mouse,
        cell,
        box,
        cleanup: [],
      };
      this.drag = d;
      cell.classList.add('is-pressed');
      if (!mouse && !this.m.readOnly()) d.timer = window.setTimeout(() => this.startDrag(d, d.lastX, d.lastY), LONG_PRESS_MS);
      try {
        box.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events cannot be captured */
      }
      this.followGesture(d);
    });
    box.addEventListener('contextmenu', (e) => e.preventDefault());
    // touch: a long press must not become a text selection / callout, and a drag must not scroll
    box.addEventListener(
      'touchmove',
      (e) => {
        if (this.drag?.active && e.cancelable) e.preventDefault();
      },
      { passive: false },
    );
  }

  private followGesture(d: DragState): void {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn as EventListener, true);
      d.cleanup.push(() => window.removeEventListener(type, fn as EventListener, true));
    };
    on('pointermove', (e) => {
      if (this.drag !== d || e.pointerId !== d.pointerId) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.lastEventAt = performance.now();
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (!d.active) {
        if (moved > DRAG_SLOP) {
          if (d.mouse && !this.m.readOnly()) this.startDrag(d, e.clientX, e.clientY);
          else this.endGesture(); // a finger that moves before the long press scrolls the list
        }
        return;
      }
      if (e.cancelable) e.preventDefault();
      this.dragTo(d, e.clientX, e.clientY);
    });
    on('pointerup', (e) => {
      if (this.drag === d && e.pointerId === d.pointerId) this.finishGesture(false, e.clientX, e.clientY);
    });
    on('pointercancel', (e) => {
      if (this.drag === d && e.pointerId === d.pointerId) this.finishGesture(true);
    });
    // iPadOS: touch events keep arriving even when pointer events for this contact do not
    on('touchend', (e) => {
      if (this.drag === d && !d.mouse && e.touches.length === 0) {
        const t0 = e.changedTouches[0];
        this.finishGesture(false, t0?.clientX ?? d.lastX, t0?.clientY ?? d.lastY);
      }
    });
    on('touchcancel', (e) => {
      if (this.drag === d && !d.mouse && e.touches.length === 0) this.finishGesture(true);
    });
    on('blur', (e) => {
      // only the window losing focus (app switch); element blur events also reach a capture listener
      if (e.target === window && this.drag === d) this.cancelGesture();
    });
    const vis = () => {
      if (document.visibilityState === 'hidden' && this.drag === d) this.cancelGesture();
    };
    document.addEventListener('visibilitychange', vis);
    d.cleanup.push(() => document.removeEventListener('visibilitychange', vis));
  }

  /** Pointer released: drop (reorder) or, for a short press, go to the page. */
  private finishGesture(cancelled: boolean, x?: number, y?: number): void {
    const d = this.drag;
    if (!d) return;
    if (d.active) {
      if (x !== undefined && y !== undefined && !cancelled) this.dragTo(d, x, y);
      const from = d.from;
      const to = d.target;
      this.endGesture();
      if (!cancelled && to !== from) this.m.onMove(from, to);
      else if (this.pendingRender) this.render();
      return;
    }
    this.endGesture();
    if (!cancelled) this.m.onGo(d.from);
  }

  /** Abandon the gesture without any effect. */
  cancelGesture(): void {
    const wasActive = !!this.drag?.active;
    this.endGesture();
    if (wasActive && this.pendingRender) this.render();
  }

  /** Remove the ghost, the marker, the timers and every listener of the gesture. */
  private endGesture(): void {
    const d = this.drag;
    this.drag = null;
    window.cancelAnimationFrame(this.autoScroll);
    this.autoScroll = 0;
    hide(this.marker);
    this.el.classList.remove('is-reordering');
    if (!d) return;
    window.clearTimeout(d.timer);
    for (const c of d.cleanup) c();
    d.cleanup = [];
    try {
      if (d.box.hasPointerCapture?.(d.pointerId)) d.box.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    d.cell.classList.remove('is-dragging', 'is-pressed');
    if (d.ghost) {
      const cv = d.ghost.querySelector('canvas');
      if (cv) {
        cv.width = 0;
        cv.height = 0;
      }
      d.ghost.remove();
      d.ghost = null;
    }
  }

  /** For tests / diagnostics: a press or drag is in progress. */
  get gestureActive(): boolean {
    return this.drag !== null;
  }

  private startDrag(d: DragState, x: number, y: number): void {
    if (this.drag !== d || d.active) return;
    d.active = true;
    d.cell.classList.remove('is-pressed');
    d.cell.classList.add('is-dragging');
    this.el.classList.add('is-reordering');
    const ghost = d.cell.cloneNode(true) as HTMLElement;
    ghost.classList.add('hn-ps-ghost');
    ghost.classList.remove('is-dragging', 'is-current');
    // the canvas does not clone its pixels
    const src = d.cell.querySelector('canvas');
    const dst = ghost.querySelector('canvas');
    if (src && dst) {
      dst.width = src.width;
      dst.height = src.height;
      dst.getContext('2d')?.drawImage(src, 0, 0);
    }
    this.root.appendChild(ghost);
    d.ghost = ghost;
    if (navigator.vibrate) navigator.vibrate(8);
    this.dragTo(d, x, y);
  }

  private dragTo(d: DragState, x: number, y: number): void {
    const rr = this.root.getBoundingClientRect();
    if (d.ghost) {
      d.ghost.style.left = `${x - rr.left - THUMB_BOX_W / 2}px`;
      d.ghost.style.top = `${y - rr.top - THUMB_BOX_H / 2}px`;
    }
    // target slot: nearest cell; before or after it depending on the side
    const cells = Array.from(this.list.querySelectorAll<HTMLElement>('.hn-ps-cell:not(.hn-ps-add)'));
    let best = -1;
    let bestD = Infinity;
    let after = false;
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = Math.hypot(x - cx, (y - cy) * 1.4);
      if (dist < bestD) {
        bestD = dist;
        best = Number(c.dataset.index);
        after = x > cx;
      }
    }
    if (best < 0) return;
    let to = after ? best + 1 : best;
    if (to > d.from) to -= 1; // indices after removing the dragged page
    to = Math.max(0, Math.min(cells.length - 1, to));
    d.target = to;
    // insertion marker next to the target cell
    const ref = cells[best];
    const lr = this.list.getBoundingClientRect();
    const r = ref.getBoundingClientRect();
    const mx = (after ? r.right + 4 : r.left - 4) - lr.left;
    if (to === d.from) hide(this.marker);
    else show(this.marker);
    this.marker.style.left = `${mx - 1.5}px`;
    this.marker.style.top = `${r.top - lr.top + this.list.scrollTop + 4}px`;
    this.marker.style.height = `${THUMB_BOX_H}px`;
    // auto-scroll near the list edges
    window.cancelAnimationFrame(this.autoScroll);
    const edge = 48;
    const dy = y < lr.top + edge ? -1 : y > lr.bottom - edge ? 1 : 0;
    if (dy) {
      const step = () => {
        if (!this.drag?.active) return;
        this.list.scrollTop += dy * 10;
        this.autoScroll = window.requestAnimationFrame(step);
      };
      this.autoScroll = window.requestAnimationFrame(step);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Per-page menu (GoodNotes-like)
  // ---------------------------------------------------------------------------------------------

  private openMenu(i: number, anchor: HTMLElement): void {
    const wasOpen = this.menu?.dataset.index === String(i);
    this.closeMenu();
    if (wasOpen) return;
    const ro = this.m.readOnly();
    const n = this.m.count();
    const menu = el('div', 'hn-ps-menu', this.root);
    menu.dataset.index = String(i);
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    const row = (icon: string, label: string, run: () => void, opts: { disabled?: boolean; danger?: boolean; confirm?: string } = {}) => {
      const b = el('button', 'hn-ps-menu-row' + (opts.danger ? ' is-danger' : ''), menu);
      b.type = 'button';
      b.disabled = !!opts.disabled;
      setHnIcon(el('span', 'hn-row-icon', b), icon);
      const lab = el('span', 'hn-row-label', b, label);
      let armed = false;
      onTap(b, () => {
        if (opts.confirm && !armed) {
          armed = true;
          lab.textContent = opts.confirm;
          b.classList.add('is-armed');
          return;
        }
        this.closeMenu();
        run();
      });
    };
    const sep = () => el('div', 'hn-ps-menu-sep', menu);
    if (!ro) {
      row('page-before', t('insertPageBefore'), () => this.m.onInsert(i));
      row('page-after', t('insertPageAfter'), () => this.m.onInsert(i + 1));
      sep();
    }
    row('copy', t('copyPage'), () => this.m.onCopy(i));
    if (!ro) {
      row('paste', t('pastePageAfter'), () => this.m.onPaste(i + 1), { disabled: !this.m.hasPageClipboard() });
      row('duplicate', t('duplicatePage'), () => this.m.onDuplicate(i));
      row('rotate', t('rotatePage'), () => this.m.onRotate(i));
      row('chevron-up', t('moveToFirst'), () => this.m.onMove(i, 0), { disabled: i === 0 });
      row('chevron-down', t('moveToLast'), () => this.m.onMove(i, n - 1), { disabled: i === n - 1 });
    }
    sep();
    row('export', t('exportPagePng'), () => this.m.onExport(i, 'png'));
    row('export', t('exportPageSvg'), () => this.m.onExport(i, 'svg'));
    if (!ro) {
      sep();
      row('page-clear', t('clearPage'), () => this.m.onClear(i), { danger: true, confirm: t('clearPageConfirm') });
      row('trash', t('deletePage'), () => this.m.onDelete(i), { danger: true, disabled: n <= 1, confirm: t('deletePageConfirm') });
    }
    // place to the right of the ⌄ button, inside the editor
    const rr = this.root.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = menu.offsetWidth || 220;
    const h = menu.offsetHeight || 300;
    let left = ar.right - rr.left + 6;
    if (left + w > rr.width - 8) left = Math.max(8, ar.left - rr.left - w - 6);
    let top = ar.top - rr.top - 12;
    top = Math.max(8, Math.min(top, rr.height - h - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this.menu = menu;
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    this.menuCleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }

  closeMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
    this.menu?.remove();
    this.menu = null;
  }

  destroy(): void {
    this.cancelGesture();
    this.closeMenu();
    this.io?.disconnect();
    this.el.remove();
  }
}
