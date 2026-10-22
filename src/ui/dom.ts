/** Tiny DOM helpers (no Obsidian dependency, so the editor also runs in the standalone lab). */

export type IconSetter = (el: HTMLElement, icon: string) => void;

/** Hide / show through a class (styles.css `.hn-hidden`), not inline styles. */
export function hide(e: Element): void {
  e.classList.add('hn-hidden');
}

export function show(e: Element): void {
  e.classList.remove('hn-hidden');
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Fallback glyphs when Obsidian's icon set is not available. */
const FALLBACK: Record<string, string> = {
  'pen-tool': '✒',
  pen: '🖊',
  highlighter: '🖍',
  eraser: '⌫',
  'undo-2': '↶',
  'redo-2': '↷',
  'chevron-up': '▲',
  'chevron-down': '▼',
  'file-plus-2': '＋',
  'sliders-horizontal': '⚙',
  'circle-dot': '●',
  check: '✓',
  'more-horizontal': '⋯',
};

export function defaultIconSetter(e: HTMLElement, icon: string): void {
  e.textContent = FALLBACK[icon] ?? icon;
}

export function button(
  parent: HTMLElement,
  opts: { icon?: string; label: string; cls?: string; onClick: (ev: MouseEvent) => void },
  setIcon: IconSetter,
): HTMLButtonElement {
  const b = el('button', 'hn-btn' + (opts.cls ? ' ' + opts.cls : ''), parent);
  b.type = 'button';
  b.setAttribute('aria-label', opts.label);
  b.title = opts.label;
  if (opts.icon) setIcon(b, opts.icon);
  else b.textContent = opts.label;
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    opts.onClick(ev);
  });
  return b;
}
