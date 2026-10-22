/**
 * Core ink types.
 *
 * Coordinates are "page units": 1 unit = 1 CSS pixel at zoom 1. An A4 page is 595 x 842 units
 * (the same numbers as PostScript points), so exported PDFs/SVGs map 1:1 to points.
 *
 * Raw input samples are stored unmodified (after coordinate transform). Everything that changes
 * the look of a stroke (filtering, spline, width model, tapering) is derived from the raw samples
 * plus the stroke's pen snapshot, so the rendering algorithm can be improved later without losing
 * the original pressure/time information.
 */

/** Ink tools. 'ballpoint' is kept for strokes written by v0.1/v0.2 (no longer offered in the UI). */
export type InkTool = 'fountain' | 'pencil' | 'ballpoint' | 'highlighter';
/** Object tools create and edit text boxes, images and shapes. */
export type ObjectTool = 'text' | 'image' | 'shape';
/** Lasso selects ink and objects; the laser pointer only draws a fading trail (never saved). */
export type Tool = InkTool | 'eraser' | ObjectTool | 'lasso' | 'laser';

export function isInkTool(t: Tool): t is InkTool {
  return t === 'fountain' || t === 'pencil' || t === 'ballpoint' || t === 'highlighter';
}

export function isObjectTool(t: Tool): t is ObjectTool {
  return t === 'text' || t === 'image' || t === 'shape';
}

/** One raw input sample, in page units. */
export interface InputSample {
  x: number;
  y: number;
  /** Normalized pressure 0..1. 0 means "no pressure reported" for some devices (see hasPressure). */
  p: number;
  /** Milliseconds since the first sample of the stroke. Monotonic non-decreasing after sanitizing. */
  t: number;
  /** Tilt in degrees (PointerEvent.tiltX/tiltY), only stored when the device reports it. */
  tx?: number;
  ty?: number;
}

/** Tunable pen parameters. All values are dimensionless unless noted. */
export interface PenParams {
  /** Nominal stroke width at typical writing pressure, in page units. */
  width: number;
  /** 0..1, how strongly pressure changes the width. */
  pressureSensitivity: number;
  /** 0..1, amount of input stabilization (jitter removal). Higher = smoother but more lag on slow strokes. */
  smoothing: number;
  /** 0..1, length/strength of the entry and exit tapers (起笔/收笔). */
  tapering: number;
  /** 0..1, opacity of the whole stroke. Highlighters use < 1. */
  opacity: number;
  /** 0..1, how much faster movement thins the line (ink-flow model). */
  velocityThinning: number;
  /** 0..1, flat-nib effect (thin/thick depending on direction). 0 = round nib. */
  nibFlatness: number;
  /** Nib angle in degrees, used when nibFlatness > 0. */
  nibAngle: number;
  // ---- engine 2 (Fountain Experimental) only; ignored by engine 1 ----
  /** 0 gamma, 1 linear, 2 smoothstep, 3 piecewise, 4 natural (v0.3: hairline → typical → heavy). */
  pressureCurve?: number;
  /** Width at the lightest pressure, as a fraction of the nominal width. */
  minWidthRatio?: number;
  /** Width at full pressure, as a fraction of the nominal width. */
  maxWidthRatio?: number;
  /** 0..1, low-pass filtering of pressure noise (independent of geometric smoothing). */
  pressureSmoothing?: number;
  /** The pressure the writer naturally uses; it maps to the nominal width (calibratable). */
  typicalPressure?: number;
  /**
   * Pressure that reaches the maximum width (top of the writer's range). Missing = 0.85, the value
   * 0.2.0-beta.1 used, so strokes saved without this field keep their exact geometry.
   */
  heavyPressure?: number;
}

export interface PenState {
  tool: InkTool;
  color: string;
  params: PenParams;
}

/** Context captured at stroke start, needed to reproduce screen-space filtering deterministically. */
export interface StrokeContext {
  /** Zoom (screen px per page unit) at the time the stroke was written. */
  zoom: number;
  /** Whether the device reported real pressure. */
  hasPressure: boolean;
  /** Geometry engine: 1 = v0.1 Baseline (default), 2 = Fountain Experimental (v0.2). */
  engine?: number;
  /** The stroke start / end was cut by the partial eraser: no synthetic taper there. */
  cutStart?: boolean;
  cutEnd?: boolean;
}
