export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smallest absolute difference between two angles (radians), in [0, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Exponential smoothing factor for a step of size `step` with characteristic length `len`. */
export function expAlpha(step: number, len: number): number {
  if (len <= 0) return 1;
  return 1 - Math.exp(-step / len);
}

/**
 * Pressure response curve.
 *
 * Maps raw pressure to a width multiplier where `typical` pressure gives 1.0. A gamma < 1 makes the
 * light-pressure range responsive (small characters written lightly still get modulation), and a
 * soft ceiling stops heavy pressure from bloating the line.
 */
export function pressureMultiplier(p: number, sensitivity: number, typical = 0.3): number {
  if (sensitivity <= 0) return 1;
  const gamma = 0.65;
  const pc = clamp(p, 0, 1);
  const ratio = Math.pow(Math.max(pc, 0.001), gamma) / Math.pow(typical, gamma);
  const ceil = 2.2;
  const soft = ratio > 1 ? 1 + (ceil - 1) * Math.tanh((ratio - 1) / (ceil - 1)) : ratio;
  return clamp(1 + sensitivity * (soft - 1), 0.28, 2.1);
}

export const PRESSURE_CURVES = ['gamma', 'linear', 'smoothstep', 'piecewise'] as const;

/** Shape of a pressure curve on t in [0,1]. */
export function curveShape(curve: number, t: number): number {
  const x = clamp(t, 0, 1);
  switch (curve) {
    case 1:
      return x;
    case 2:
      return x * x * (3 - 2 * x);
    case 3:
      // soft knee: responsive light range, flatter heavy range
      return x < 0.35 ? (x / 0.35) * 0.7 : 0.7 + ((x - 0.35) / 0.65) * 0.3;
    default:
      return Math.pow(x, 0.6);
  }
}

/**
 * Pressure range mapped onto the curve (pressure below lo = lightest, above hi = heaviest).
 * PRESSURE_HI is the fixed top used by 0.2.0-beta.1; newer strokes carry their own `heavyPressure`.
 */
export const PRESSURE_LO = 0.02;
export const PRESSURE_HI = 0.85;

/**
 * Engine 2 pressure → width factor. The curve maps pressure onto [minRatio, maxRatio] of the
 * nominal width, then the result is normalized so the writer's typical pressure gives exactly the
 * nominal width (writing normally never needs extra force). Sensitivity blends toward constant width.
 */
export function pressureWidthFactor(
  p: number,
  sensitivity: number,
  curve: number,
  minRatio: number,
  maxRatio: number,
  typical: number,
  heavy: number = PRESSURE_HI,
): number {
  if (sensitivity <= 0) return 1;
  if (curve === 4) return Math.max(0.05, 1 + sensitivity * (naturalCurve(p, minRatio, maxRatio, typical, heavy) - 1));
  const hi = clamp(heavy, PRESSURE_LO + 0.05, 1);
  const norm = (v: number) => (clamp(v, 0, 1) - PRESSURE_LO) / (hi - PRESSURE_LO);
  const f = (v: number) => minRatio + (maxRatio - minRatio) * curveShape(curve, norm(v));
  const ft = Math.max(1e-3, f(clamp(typical, PRESSURE_LO + 0.01, hi - 0.01)));
  return Math.max(0.05, 1 + sensitivity * (f(p) / ft - 1));
}

/**
 * Curve 4 "natural" (v0.3). Defined directly in pressure space around the writer's calibrated
 * typical and heavy pressure, so a feather-light touch really gives a hairline (GoodNotes-like
 * contrast) while normal writing stays at the nominal width:
 *   0 → typical: minRatio → 1, convex (exponent 1.3), so very light pressure is very thin;
 *   typical → heavy: 1 → maxRatio, ease-out (exponent 1.6), so heavy pressure saturates gently.
 */
export function naturalCurve(p: number, minRatio: number, maxRatio: number, typical: number, heavy: number): number {
  const t = clamp(typical, 0.01, 0.9);
  const h = Math.max(t + 0.02, clamp(heavy, 0.05, 1));
  const pc = clamp(p, 0, 1);
  if (pc <= t) return minRatio + (1 - minRatio) * Math.pow(pc / t, 1.3);
  const u = clamp((pc - t) / (h - t), 0, 1);
  return 1 + (maxRatio - 1) * (1 - Math.pow(1 - u, 1.6));
}

/** Page units per millimetre (1 unit = 1 pt). */
export const UNITS_PER_MM = 72 / 25.4;

/**
 * Flat-nib width factor: projection of an elliptical nib (major axis at nibAngle) onto the normal
 * of the stroke direction. Normalized so the average over all directions is ~1.
 */
export function nibMultiplier(direction: number, nibAngleRad: number, flatness: number): number {
  if (flatness <= 0) return 1;
  const b = 1 - flatness;
  const d = direction - nibAngleRad;
  const s = Math.sin(d);
  const c = Math.cos(d);
  const h = Math.sqrt(s * s + b * b * c * c);
  return h / ((1 + b) / 2);
}
