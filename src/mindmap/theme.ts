import type { MapThemeId } from './model';

/**
 * Mind map / diagram themes. Every colour on a converted map comes from here — never from the
 * recognition model — so maps look consistent and readable whatever was handwritten.
 *
 * Palettes are muted (no pure RGB primaries) and every text / fill pair keeps a WCAG contrast of at
 * least 4.5 : 1 (checked in tests/unit/v05.test.ts).
 */

export type TopicShape = 'pill' | 'box' | 'underline' | 'plain';
export type EdgeStyle = 'curve' | 'elbow';

export interface LevelStyle {
  size: number;
  weight: 400 | 600 | 700;
  shape: TopicShape;
  padX: number;
  padY: number;
  /** Max text width before wrapping (layout units). */
  maxW: number;
}

export interface MapTheme {
  id: MapThemeId;
  font: 'sans' | 'hand';
  /** root, level 1, level 2+ */
  levels: [LevelStyle, LevelStyle, LevelStyle];
  rootFill: string;
  rootText: string;
  rootStroke: string;
  /** Branch colours (level-1 topics cycle through these; descendants inherit). */
  palette: string[];
  /** Level-1 fill = branch colour mixed with white by this amount (0..1 of colour). */
  tint: number;
  text: string;
  subText: string;
  edge: EdgeStyle;
  /** Edge width at level 1 → deepest. */
  edgeW: [number, number];
  /** Fixed edge colour (null = branch colour). */
  edgeColor: string | null;
  hGap: number;
  vGap: number;
  /** Sketchy outlines. */
  rough: boolean;
}

export const THEMES: Record<MapThemeId, MapTheme> = {
  academic: {
    id: 'academic',
    font: 'sans',
    levels: [
      { size: 20, weight: 700, shape: 'pill', padX: 18, padY: 11, maxW: 260 },
      { size: 15, weight: 600, shape: 'box', padX: 12, padY: 7, maxW: 220 },
      { size: 13, weight: 400, shape: 'underline', padX: 4, padY: 4, maxW: 200 },
    ],
    rootFill: '#1f3a5f',
    rootText: '#ffffff',
    rootStroke: '#1f3a5f',
    palette: ['#3b6ea5', '#2f8079', '#b0702a', '#7d5a96', '#a8524a', '#58782c', '#4c6a87', '#96652d'],
    tint: 0.13,
    text: '#1f2933',
    subText: '#33404d',
    edge: 'curve',
    edgeW: [2.4, 1.1],
    edgeColor: null,
    hGap: 44,
    vGap: 12,
    rough: false,
  },
  hand: {
    id: 'hand',
    font: 'hand',
    levels: [
      { size: 22, weight: 400, shape: 'box', padX: 18, padY: 12, maxW: 260 },
      { size: 17, weight: 400, shape: 'box', padX: 12, padY: 8, maxW: 220 },
      { size: 15, weight: 400, shape: 'underline', padX: 4, padY: 4, maxW: 200 },
    ],
    rootFill: '#fff3bf',
    rootText: '#1e1e1e',
    rootStroke: '#1e1e1e',
    palette: ['#1864ab', '#2b8a3e', '#c2410c', '#862e9c', '#a61e4d', '#0b7285'],
    tint: 0.1,
    text: '#1e1e1e',
    subText: '#2b2b2b',
    edge: 'curve',
    edgeW: [2, 1.3],
    edgeColor: null,
    hGap: 48,
    vGap: 14,
    rough: true,
  },
  minimal: {
    id: 'minimal',
    font: 'sans',
    levels: [
      { size: 19, weight: 700, shape: 'box', padX: 14, padY: 9, maxW: 260 },
      { size: 15, weight: 600, shape: 'plain', padX: 6, padY: 5, maxW: 220 },
      { size: 13, weight: 400, shape: 'plain', padX: 4, padY: 3, maxW: 200 },
    ],
    rootFill: '#ffffff',
    rootText: '#111827',
    rootStroke: '#374151',
    palette: ['#4b5563'],
    tint: 0,
    text: '#1f2937',
    subText: '#374151',
    edge: 'elbow',
    edgeW: [1.4, 1],
    edgeColor: '#9ca3af',
    hGap: 36,
    vGap: 8,
    rough: false,
  },
};

export function themeOf(id: string | undefined): MapTheme {
  return THEMES[(id as MapThemeId) ?? 'academic'] ?? THEMES.academic;
}

export function levelStyle(t: MapTheme, depth: number): LevelStyle {
  return t.levels[Math.min(depth, 2)];
}

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Colour mixed with white: amount 0 = white, 1 = colour. */
export function tintColor(c: string, amount: number): string {
  const [r, g, b] = hex(c);
  const f = (v: number) => Math.round(255 - (255 - v) * amount);
  return `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function lum(c: string): number {
  const ch = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
