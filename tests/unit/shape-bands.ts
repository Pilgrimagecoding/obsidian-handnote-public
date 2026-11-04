// Size-band corpus for the shape pen (shared by the robustness test and the evaluation script):
// the same realistic hand-drawn strokes at small, medium and large size.
import type { InputSample } from '../../src/ink/types';
import { arcPath, densify, ellipsePath, handStroke, roundedPolygon } from './handshapes';
import { rng } from './helpers';

type Pt = [number, number];
export type Band = 'small' | 'medium' | 'large';
export type Kind = 'line' | 'curve' | 'ellipse' | 'rect' | 'triangle' | 'arrow' | 'scribble';

const SIZE: Record<Band, [number, number]> = { small: [16, 45], medium: [50, 300], large: [400, 1400] };
/** Big arm-drawn shapes wobble more (relative to their length) than small wrist-drawn ones. */
const WOBBLE: Record<Band, number> = { small: 1, medium: 1, large: 1.6 };

export function bandStroke(kind: Kind, band: Band, i: number): InputSample[] {
  const r = rng(5000 + i * 13 + kind.length * 101 + band.length * 7);
  const [lo, hi] = SIZE[band];
  const s = lo + r() * (hi - lo);
  const wk = WOBBLE[band];
  const x = 300;
  const y = 300;
  let pts: Pt[];
  let wobble = 0.004;
  switch (kind) {
    case 'line': {
      const ang = r() * Math.PI * 2;
      pts = densify([[x, y], [x + Math.cos(ang) * s, y + Math.sin(ang) * s]], Math.max(0.5, s / 200));
      wobble = (0.004 + r() * 0.02) * wk;
      break;
    }
    case 'curve': {
      const ang = r() * Math.PI * 2;
      pts = arcPath([x, y], [x + Math.cos(ang) * s, y + Math.sin(ang) * s], (r() < 0.5 ? -1 : 1) * (0.14 + r() * 0.18));
      wobble = (0.004 + r() * 0.006) * wk;
      break;
    }
    case 'ellipse': {
      const rx = s / 2;
      const ry = rx * (0.55 + r() * 0.45);
      pts = ellipsePath(x, y, rx, ry, r() * Math.PI, r() * 6.28, 0.92 + r() * 0.18, 0.02 + r() * 0.03, i);
      wobble = 0.004 * wk;
      break;
    }
    case 'rect': {
      const w = s;
      const h = s * (0.5 + r() * 0.6);
      pts = roundedPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], 1 + r() * Math.min(w, h) * 0.07, -0.03 + r() * 0.1, r() * 0.2);
      wobble = (0.002 + r() * 0.003) * wk;
      break;
    }
    case 'triangle': {
      pts = roundedPolygon([[x + s / 2 + (r() - 0.5) * s * 0.3, y], [x + s, y + s * (0.75 + r() * 0.25)], [x, y + s * (0.75 + r() * 0.25)]], 0.5 + r() * Math.max(1, s * 0.02), -0.02 + r() * 0.08, r() * 0.3);
      wobble = 0.003 * wk;
      break;
    }
    case 'arrow': {
      const ang = r() * Math.PI * 2;
      const tip: Pt = [x + Math.cos(ang) * s, y + Math.sin(ang) * s];
      const hl = Math.max(6, s * (0.08 + r() * 0.08));
      const back = ang + Math.PI;
      pts = densify([[x, y], tip, [tip[0] + Math.cos(back + 0.5) * hl, tip[1] + Math.sin(back + 0.5) * hl], tip, [tip[0] + Math.cos(back - 0.5) * hl, tip[1] + Math.sin(back - 0.5) * hl]], Math.max(0.5, s / 200));
      wobble = 0.003 * wk;
      break;
    }
    default: {
      // writing-like strokes scaled to the band: loops, zig-zags, s-curves
      pts = [];
      const k = i % 3;
      for (let j = 0; j <= 200; j++) {
        const u = j / 200;
        if (k === 0) pts.push([x + u * s + (s / 11) * Math.cos(u * 26), y + (s / 11) * Math.sin(u * 26)]);
        else if (k === 1) pts.push([x + u * s, y + (Math.floor(u * 6) % 2 ? 1 : -1) * ((u * 6) % 1) * s * 0.2]);
        else pts.push([x + s * 0.27 * Math.sin(u * 9.4), y + u * s * 0.8 + s * 0.17 * Math.sin(u * 18.8)]);
      }
      wobble = 0.002;
    }
  }
  return handStroke(pts, { seed: 900 + i, wobble });
}

export function expected(kind: Kind, rec: { kind: string; arrowEnd?: boolean } | null, i = -1): boolean {
  // writing strokes stay ink — except the zig-zag, which drawn with the shape pen is a polyline
  // (0.12: the V / < strokes of handwriting are recognised as polylines on purpose)
  if (kind === 'scribble') return rec === null || (i % 3 === 1 && rec.kind === 'polyline' && !rec.arrowEnd);
  if (kind === 'arrow') return rec?.kind === 'line' && !!rec.arrowEnd;
  return rec?.kind === kind && !rec.arrowEnd;
}
