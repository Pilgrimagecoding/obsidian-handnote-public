/**
 * Input mode: how the editor is laid out and which conventions it favours on this device.
 *
 *  - pen   (Pen-first, iPad): large touch targets, compact single-row toolbar, Pencil draws,
 *          fingers navigate, two/three-finger taps.
 *  - mouse (Mouse-first, desktop): denser toolbar with hover tooltips and shortcut hints,
 *          left drag draws, Space/middle drag pans, wheel scrolls, Ctrl/Cmd+wheel zooms.
 *
 * Both modes accept every input type (a Windows pen draws with pressure, an iPad mouse draws,
 * fingers always navigate unless finger drawing is enabled). The mode is a per-device setting kept
 * in the plugin's data.json — never in the .handnote file — so a note synced between iPad and PC
 * opens with each device's own conventions.
 */
export type InputModeSetting = 'auto' | 'pen' | 'mouse';
export type InputMode = 'pen' | 'mouse';

export interface InputEnvironment {
  /** Obsidian Platform.isMobileApp (iOS/Android app). */
  isMobileApp: boolean;
  /** navigator.maxTouchPoints */
  maxTouchPoints: number;
  /** matchMedia('(pointer: coarse)') — the PRIMARY pointer is a finger. */
  primaryCoarse: boolean;
  /** matchMedia('(any-pointer: fine)') — some fine pointer (mouse, trackpad, pen) exists. */
  anyFine: boolean;
}

export function resolveInputMode(setting: InputModeSetting, env: InputEnvironment): InputMode {
  if (setting === 'pen' || setting === 'mouse') return setting;
  if (env.isMobileApp) return 'pen';
  // A tablet with a primary touch screen (no attached mouse/trackpad as primary pointer).
  if (env.primaryCoarse && env.maxTouchPoints > 0) return 'pen';
  return 'mouse';
}

export function detectEnvironment(isMobileApp: boolean): InputEnvironment {
  const mm = (q: string) => {
    try {
      return typeof matchMedia === 'function' && matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  return {
    isMobileApp,
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0,
    primaryCoarse: mm('(pointer: coarse)'),
    anyFine: mm('(any-pointer: fine)'),
  };
}
