import { el } from './dom';
import { setHnIcon } from './icons';
import { onTap } from './tap';

/**
 * Floating context menu opened by a finger long press (or a right click) on the page: a short list
 * of actions next to the touch point. Styled like HandNote's popovers (follows the light / dark
 * theme through the --hn-* variables), kept inside the editor, closed by a tap anywhere else,
 * Escape, or any page interaction (the editor closes it on pointerdown — the Pencil is never
 * blocked: its first stroke closes the menu and draws).
 */
export interface MenuEntry {
  icon: string;
  label: string;
  /** Second line (what will be pasted, why an entry is unavailable…). */
  hint?: string;
  disabled?: boolean;
  /** Runs inside the tap (a user gesture: clipboard reads and file pickers are allowed). */
  run: () => void;
}

const MARGIN = 8;
const OFFSET = 12;

/**
 * Top-left of a w × h menu for a touch at (x, y) inside a W × H root: below-right of the finger
 * when it fits, otherwise flipped above / to the left, always inside an 8 px margin.
 */
export function placeMenu(x: number, y: number, w: number, h: number, W: number, H: number): { left: number; top: number } {
  let left = x + OFFSET;
  if (left + w > W - MARGIN) left = x - OFFSET - w;
  let top = y + OFFSET;
  if (top + h > H - MARGIN) top = y - OFFSET - h;
  left = Math.max(MARGIN, Math.min(left, W - w - MARGIN));
  top = Math.max(MARGIN, Math.min(top, H - h - MARGIN));
  return { left: Math.round(left), top: Math.round(top) };
}

export class ContextMenu {
  readonly el: HTMLElement;
  private closed = false;
  private readonly onDoc = (e: Event) => {
    if (!this.el.contains(e.target as Node)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  constructor(
    root: HTMLElement,
    x: number,
    y: number,
    entries: MenuEntry[],
    private readonly onClose: () => void,
  ) {
    this.el = el('div', 'hn-popover hn-ctx-menu hn-ov-int', root);
    this.el.setAttribute('role', 'menu');
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const it of entries) {
      const b = el('button', 'hn-ctx-item', this.el);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (it.disabled) {
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
      }
      setHnIcon(el('span', 'hn-ic', b), it.icon);
      const txt = el('span', 'hn-ctx-text', b);
      el('span', 'hn-ctx-label', txt, it.label);
      if (it.hint) el('span', 'hn-ctx-hint', txt, it.hint);
      onTap(b, () => {
        if (it.disabled) return;
        this.close();
        it.run();
      });
    }
    const rr = root.getBoundingClientRect();
    const pos = placeMenu(x, y, this.el.offsetWidth || 240, this.el.offsetHeight || 48 * entries.length, rr.width, rr.height);
    this.el.style.left = `${pos.left}px`;
    this.el.style.top = `${pos.top}px`;
    // listen from the next event on, so the touch that opened the menu does not close it
    window.setTimeout(() => {
      if (this.closed) return;
      document.addEventListener('pointerdown', this.onDoc, true);
      document.addEventListener('keydown', this.onKey, true);
    }, 0);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener('pointerdown', this.onDoc, true);
    document.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.onClose();
  }
}
