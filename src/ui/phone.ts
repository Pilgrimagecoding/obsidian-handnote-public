/**
 * Phones: the same screens as the phone rules at the end of styles.css (narrow, or a short
 * landscape touch screen), or Obsidian's own phone class. Tablets are not phones.
 */
export const PHONE_QUERY = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';

let query: MediaQueryList | null = null;

export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.body?.classList.contains('is-phone')) return true;
  query ??= window.matchMedia?.(PHONE_QUERY) ?? null;
  return !!query?.matches;
}

/**
 * Canvas pixels per CSS px: the screen's density, at most 3, on phones at most 2. A 3× bitmap
 * holds 2.25× the pixels of a 2× one, a difference too fine to see on a phone screen; memory and
 * the time of every full redraw are what a phone runs short of.
 */
export function canvasDpr(): number {
  return Math.min(window.devicePixelRatio || 1, isPhone() ? 2 : 3);
}
