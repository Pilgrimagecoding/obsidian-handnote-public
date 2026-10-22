/**
 * Reliable one-tap activation for toolbar controls (Apple Pencil, finger, mouse, keyboard).
 *
 * Why not just `click`: on iPadOS a tiny Pencil / finger movement between touchstart and touchend
 * cancels the synthesized click, so some taps were simply lost ("needs two taps"). Here the action
 * fires on pointerup when the pointer stayed within a tolerance; the click that may follow is
 * ignored, so an action never runs twice. Keyboard activation (Enter / Space → click) still works.
 *
 * Also gives every control a pressed state (`.is-pressed`) for immediate visual feedback.
 */
const SLOP_PX = 16;
const CLICK_SUPPRESS_MS = 700;
const GHOST_RADIUS_PX = 40;

/**
 * Ghost-click guard. iPadOS synthesizes a `click` ~after touchend and hit-tests it again at that
 * moment. When the tap re-rendered the control (sub-bar buttons are rebuilt on every state change),
 * the click lands on the *new* element at the same spot and would run the action a second time —
 * a toggle such as "erase highlighter only" then flipped twice and seemed dead, and a click could
 * fall through to whatever is under a closed popover. Every trusted click near the last tap,
 * shortly after it, is swallowed in the capture phase. Keyboard clicks (detail 0) and
 * programmatic clicks (file input) are untouched.
 */
let lastTap: { x: number; y: number; t: number } | null = null;
let guardInstalled = false;

function installGhostGuard(): void {
  if (guardInstalled || typeof document === 'undefined') return;
  guardInstalled = true;
  document.addEventListener(
    'click',
    (e) => {
      const lt = lastTap;
      if (!lt || !e.isTrusted || e.detail === 0) return;
      if (performance.now() - lt.t > CLICK_SUPPRESS_MS) return;
      if (Math.hypot(e.clientX - lt.x, e.clientY - lt.y) > GHOST_RADIUS_PX) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

/** For tests: forget the last tap. */
export function resetTapGuard(): void {
  lastTap = null;
}

export interface TapOptions {
  /** Long-press handler (fires instead of the tap). */
  onLongPress?: (e: PointerEvent) => void;
  longPressMs?: number;
}

export function onTap(elm: HTMLElement, fn: (e: Event) => void, opts: TapOptions = {}): void {
  installGhostGuard();
  let down: { id: number; x: number; y: number } | null = null;
  let firedAt = -Infinity;
  /** a pointer sequence that was not a tap (dragged off, cancelled): ignore the click it may produce */
  let rejectedAt = -Infinity;
  let longTimer = 0;
  let longFired = false;
  const clear = () => {
    down = null;
    elm.classList.remove('is-pressed');
    window.clearTimeout(longTimer);
  };
  const disabled = () => (elm as HTMLButtonElement).disabled === true || elm.getAttribute('aria-disabled') === 'true';
  elm.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || disabled()) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
    longFired = false;
    elm.classList.add('is-pressed');
    if (opts.onLongPress) {
      longTimer = window.setTimeout(() => {
        if (!down) return;
        longFired = true;
        elm.classList.remove('is-pressed');
        opts.onLongPress?.(e);
      }, opts.longPressMs ?? 550);
    }
  });
  elm.addEventListener('pointermove', (e) => {
    if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > SLOP_PX) {
      clear();
      rejectedAt = performance.now();
    }
  });
  elm.addEventListener('pointerup', (e) => {
    const d = down;
    clear();
    if (!d || e.pointerId !== d.id || longFired || disabled()) {
      if (!d) return;
      rejectedAt = performance.now();
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > SLOP_PX) {
      rejectedAt = performance.now();
      return;
    }
    firedAt = performance.now();
    lastTap = { x: e.clientX, y: e.clientY, t: firedAt };
    fn(e);
  });
  elm.addEventListener('pointercancel', () => {
    if (down) rejectedAt = performance.now();
    clear();
  });
  elm.addEventListener('lostpointercapture', () => elm.classList.remove('is-pressed'));
  elm.addEventListener('click', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - firedAt < CLICK_SUPPRESS_MS || now - rejectedAt < CLICK_SUPPRESS_MS || longFired || disabled()) return;
    // keyboard / assistive technology activation (no pointer sequence before it); repeated
    // keyboard clicks are all honoured
    fn(e);
  });
  elm.addEventListener('contextmenu', (e) => {
    if (opts.onLongPress) e.preventDefault();
  });
}
