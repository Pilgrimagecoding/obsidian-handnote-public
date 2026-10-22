import type { InkTool, PenParams } from './types';
import { clamp } from './math';

/**
 * Default pen presets. These are starting points tuned on synthetic tests; the real tuning
 * must come from Apple Pencil sessions on the iPad (see docs/IPAD_TEST_CHECKLIST.md).
 */
export const DEFAULT_PEN_PARAMS: Record<InkTool, PenParams> = {
  fountain: {
    width: 1.6,
    pressureSensitivity: 0.7,
    smoothing: 0.5,
    tapering: 0.55,
    opacity: 1,
    velocityThinning: 0.22,
    nibFlatness: 0.18,
    nibAngle: -35,
  },
  pencil: {
    width: 1.7, // 0.6 mm
    pressureSensitivity: 1,
    smoothing: 0.35,
    tapering: 0.25,
    opacity: 0.92,
    velocityThinning: 0,
    nibFlatness: 0,
    nibAngle: 0,
    pressureCurve: 4,
    minWidthRatio: 0.3,
    maxWidthRatio: 1.8,
    pressureSmoothing: 0.8,
    typicalPressure: 0.1,
    heavyPressure: 0.45,
  },
  ballpoint: {
    width: 1.15,
    pressureSensitivity: 0.18,
    smoothing: 0.45,
    tapering: 0.15,
    opacity: 1,
    velocityThinning: 0,
    nibFlatness: 0,
    nibAngle: 0,
  },
  highlighter: {
    width: 12,
    pressureSensitivity: 0,
    smoothing: 0.6,
    tapering: 0,
    opacity: 0.35,
    velocityThinning: 0,
    nibFlatness: 0,
    nibAngle: 0,
  },
};

/**
 * Fountain pen (engine 2, the default "B" pen). v0.3 defaults after the second iPad round
 * (docs/device-reports/): wider (0.8 mm at normal pressure) and a much stronger pressure contrast —
 * a feather-light touch draws a hairline, heavy pressure about twice the nominal width (curve 4).
 * The pressure range comes from the iPad reports (typical 0.06–0.12, max 0.47); calibrate per
 * writer with "Calibrate from my writing".
 */
export const EXPERIMENTAL_FOUNTAIN: PenParams = {
  width: 2.27, // 0.8 mm
  pressureSensitivity: 1,
  smoothing: 0.5,
  tapering: 0.5,
  opacity: 1,
  velocityThinning: 0.1,
  nibFlatness: 0.1,
  nibAngle: -35,
  pressureCurve: 4,
  minWidthRatio: 0.15,
  maxWidthRatio: 2,
  pressureSmoothing: 0.85,
  typicalPressure: 0.1,
  heavyPressure: 0.45,
};

/** The 0.2.0-beta.2 defaults (kept for tests and documentation). */
export const EXPERIMENTAL_FOUNTAIN_BETA2: PenParams = {
  width: 1.6,
  pressureSensitivity: 0.85,
  smoothing: 0.5,
  tapering: 0.45,
  opacity: 1,
  velocityThinning: 0.12,
  nibFlatness: 0.12,
  nibAngle: -35,
  pressureCurve: 0,
  minWidthRatio: 0.2,
  maxWidthRatio: 2.2,
  pressureSmoothing: 0.85,
  typicalPressure: 0.12,
  heavyPressure: 0.45,
};

const MM = 72 / 25.4;

/** Three quick width choices per tool (page units), shown in the sub-toolbar; user-editable. */
export const WIDTH_STEPS: Record<InkTool, number[]> = {
  fountain: [0.5 * MM, 0.8 * MM, 1.2 * MM],
  pencil: [0.4 * MM, 0.6 * MM, 1.0 * MM],
  ballpoint: [0.8, 1.15, 1.7],
  highlighter: [3 * MM, 5 * MM, 8 * MM],
};

/** Width slider range per tool, in millimetres. */
export const WIDTH_RANGE_MM: Record<InkTool, [number, number]> = {
  fountain: [0.1, 2.5],
  pencil: [0.1, 2],
  ballpoint: [0.1, 2],
  highlighter: [1, 12],
};

export const INK_COLORS = ['#1a1a1a', '#c62828', '#e8892b', '#1f6fe5', '#2e7d32', '#7c3aed', '#8a8f98'];
export const HIGHLIGHTER_COLORS = ['#ffe066', '#a6e3a1', '#ffb3c7', '#9ad0ff', '#ffcc80'];

export function defaultColor(tool: InkTool): string {
  return tool === 'highlighter' ? HIGHLIGHTER_COLORS[0] : INK_COLORS[0];
}

/** Fill in missing/invalid fields (e.g. from an older file or settings) with defaults. */
export function sanitizeParams(tool: InkTool, p: Partial<PenParams> | undefined): PenParams {
  const d = DEFAULT_PEN_PARAMS[tool];
  const num = (v: unknown, fb: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fb;
  return {
    width: num(p?.width, d.width, 0.1, 80),
    pressureSensitivity: num(p?.pressureSensitivity, d.pressureSensitivity, 0, 1),
    smoothing: num(p?.smoothing, d.smoothing, 0, 1),
    tapering: num(p?.tapering, d.tapering, 0, 1),
    opacity: num(p?.opacity, d.opacity, 0.05, 1),
    velocityThinning: num(p?.velocityThinning, d.velocityThinning, 0, 1),
    nibFlatness: num(p?.nibFlatness, d.nibFlatness, 0, 0.9),
    nibAngle: num(p?.nibAngle, d.nibAngle, -180, 180),
    ...sanitizeEngine2(p),
  };
}

/** Engine 2 fields are kept only when present, so engine 1 strokes serialize exactly as in v0.1. */
export function sanitizeEngine2(p: Partial<PenParams> | undefined): Partial<PenParams> {
  const out: Partial<PenParams> = {};
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : undefined);
  const c = num(p?.pressureCurve, 0, 4);
  if (c !== undefined) out.pressureCurve = Math.round(c);
  const mn = num(p?.minWidthRatio, 0.05, 1);
  if (mn !== undefined) out.minWidthRatio = mn;
  const mx = num(p?.maxWidthRatio, 1, 4);
  if (mx !== undefined) out.maxWidthRatio = mx;
  const ps = num(p?.pressureSmoothing, 0, 1);
  if (ps !== undefined) out.pressureSmoothing = ps;
  const tp = num(p?.typicalPressure, 0.05, 0.8);
  if (tp !== undefined) out.typicalPressure = tp;
  const hp = num(p?.heavyPressure, 0.15, 1);
  if (hp !== undefined) out.heavyPressure = hp;
  return out;
}

/** Full experimental parameter set (fills missing engine-2 fields with the experimental defaults). */
export function sanitizeExperimental(p: Partial<PenParams> | undefined): PenParams {
  const base = sanitizeParams('fountain', { ...EXPERIMENTAL_FOUNTAIN, ...(p ?? {}) });
  return { ...EXPERIMENTAL_FOUNTAIN, ...base };
}
