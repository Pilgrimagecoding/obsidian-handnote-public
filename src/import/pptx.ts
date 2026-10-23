/**
 * PowerPoint (.pptx) → one fixed page per slide (0.9, Phase 4).
 *
 * Reads presentation, slides, layouts, masters and themes with HandNote's own XML reader and draws
 * what a slide shows at rest: background (colour, picture), the master's and layout's own shapes,
 * then the slide's shapes — preset geometries (rectangles, rounded rectangles, ellipses, lines,
 * connectors, arrows, triangles, stars…), free-form paths, pictures (crop, rotation, flips), groups,
 * tables (cell fills, borders, the default table style) and text (placeholders inheriting position
 * and text styles from layout and master, bullets and numbering, alignment, anchoring, insets,
 * line spacing, autofit scale, theme colours and fonts).
 *
 * Left out, and listed in `notes`: charts, SmartArt, video / audio (their poster picture is shown),
 * equations, ink, animations and transitions, 3-D / shadows / glow, rotated text (drawn upright),
 * vertical text, gradients and patterns (drawn as one colour).
 */
import { cssFamily, type DLPage, type DisplayList } from './display-list';
import { emitLines, flowLines, type Line, type Measurer, type Run, type RunStyle } from './flow';
import { attr, find, kid, kids, local, num, parseXml, type XNode } from './xml';
import { relsOf, resolvePart, type ZipArchive } from './zip';

const EMU = 1 / 12700;
const CJK_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

export interface PptxOptions {
  measure: Measurer;
  signal?: AbortSignal;
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
  yieldUi?: () => Promise<void>;
}

// ------------------------------------------------------------------ colours

type RGB = [number, number, number];
const hex = (c: RGB, a = 1) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('') + (a < 0.999 ? Math.round(Math.max(0, a) * 255).toString(16).padStart(2, '0') : '');
const parseHex = (h: string): RGB | null => (/^[0-9a-fA-F]{6}$/.test(h) ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : null);

function toHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

const PRESET: Record<string, string> = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', orange: 'ffa500', purple: '800080', lightGray: 'd3d3d3', darkGray: 'a9a9a9', darkBlue: '00008b', darkRed: '8b0000' };
const COLOR_KINDS = ['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr', 'a:scrgbClr', 'a:hslClr'];

interface Theme {
  colors: Record<string, string>;
  major: string;
  minor: string;
  majorEa: string;
  minorEa: string;
  lnWidths: number[];
}

class Colors {
  constructor(
    private readonly theme: Theme,
    private readonly map: Record<string, string>,
  ) {}

  /** A colour element (srgbClr, schemeClr…) with its modifiers → '#rrggbb[aa]'. */
  of(n: XNode | undefined, ph?: string): string | undefined {
    if (!n) return undefined;
    let base: RGB | null = null;
    switch (n.name) {
      case 'a:srgbClr':
        base = parseHex(attr(n, 'val') ?? '');
        break;
      case 'a:sysClr':
        base = parseHex(attr(n, 'lastClr') ?? '') ?? (attr(n, 'val') === 'window' ? [255, 255, 255] : [0, 0, 0]);
        break;
      case 'a:prstClr':
        base = parseHex(PRESET[attr(n, 'val') ?? ''] ?? '');
        break;
      case 'a:scrgbClr':
        base = [num(attr(n, 'r')) / 100000, num(attr(n, 'g')) / 100000, num(attr(n, 'b')) / 100000].map((v) => Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255) as RGB;
        break;
      case 'a:hslClr':
        base = fromHsl([num(attr(n, 'hue')) / 21600000, num(attr(n, 'sat')) / 100000, num(attr(n, 'lum')) / 100000]);
        break;
      case 'a:schemeClr': {
        const v = attr(n, 'val') ?? '';
        if (v === 'phClr') base = ph ? parseHex(ph.slice(1, 7)) : null;
        else {
          const key = this.map[v] ?? v;
          base = parseHex(this.theme.colors[key] ?? '');
        }
        break;
      }
      default:
        return undefined;
    }
    if (!base) return undefined;
    let c: RGB = base;
    let a = 1;
    for (const m of n.children) {
      const v = num(attr(m, 'val')) / 100000;
      switch (m.name) {
        case 'a:lumMod':
        case 'a:lumOff': {
          const hsl = toHsl(c);
          hsl[2] = m.name === 'a:lumMod' ? hsl[2] * v : hsl[2] + v;
          hsl[2] = Math.max(0, Math.min(1, hsl[2]));
          c = fromHsl(hsl);
          break;
        }
        case 'a:satMod': {
          const hsl = toHsl(c);
          hsl[1] = Math.max(0, Math.min(1, hsl[1] * v));
          c = fromHsl(hsl);
          break;
        }
        // tint / shade work on linear light, as in Office (black tinted 75 % is a mid grey, not #404040)
        case 'a:tint':
          c = c.map((x) => 255 * Math.pow(Math.pow(x / 255, 2.2) * v + (1 - v), 1 / 2.2)) as RGB;
          break;
        case 'a:shade':
          c = c.map((x) => 255 * Math.pow(Math.pow(x / 255, 2.2) * v, 1 / 2.2)) as RGB;
          break;
        case 'a:alpha':
          a = v;
          break;
        default:
          break;
      }
    }
    return hex(c, a);
  }

  /** The first colour child of `n`. */
  in(n: XNode | undefined, ph?: string): string | undefined {
    const c = n?.children.find((x) => COLOR_KINDS.includes(x.name));
    return this.of(c, ph);
  }
}

// ------------------------------------------------------------------ text styles

interface RProps {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
  baseline?: number;
}

interface Bullet {
  kind: 'none' | 'char' | 'auto';
  char?: string;
  scheme?: string;
  start?: number;
  font?: string;
  color?: string;
  size?: number;
}

interface PLevel {
  marL?: number;
  indent?: number;
  algn?: string;
  lnPct?: number;
  lnPts?: number;
  befPts?: number;
  befPct?: number;
  aftPts?: number;
  aftPct?: number;
  bu?: Bullet;
  r: RProps;
}

const SYMBOL_BULLETS: Record<string, string> = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', '': '■', '': '◆', '': '◦', '': '→', '': '▸', 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'Ÿ': '•', '§': '▪', 'o': '◦' };

function mergeR(a: RProps, b: RProps): RProps {
  const o: RProps = { ...a };
  for (const k of Object.keys(b) as (keyof RProps)[]) if (b[k] !== undefined) (o as Record<string, unknown>)[k] = b[k];
  return o;
}
function mergeL(a: PLevel, b: PLevel): PLevel {
  const o: PLevel = { ...a, r: mergeR(a.r, b.r) };
  for (const k of Object.keys(b) as (keyof PLevel)[]) if (k !== 'r' && b[k] !== undefined) (o as unknown as Record<string, unknown>)[k] = b[k];
  return o;
}

// ------------------------------------------------------------------ geometry helpers

type Pt = [number, number];

function rotatePts(pts: Pt[], cx: number, cy: number, deg: number, fh: boolean, fv: boolean): Pt[] {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return pts.map(([x, y]) => {
    let dx = x - cx;
    let dy = y - cy;
    if (fh) dx = -dx;
    if (fv) dy = -dy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

/** OOXML angle (60000ths of a degree, clockwise) → radians. */
const deg = (v: number) => ((Math.max(0, Math.min(21599999, v)) / 60000) * Math.PI) / 180; // pinned like the presets' own guides
/** Clockwise sweep from a1 to a2 (radians), in (0, 2π]. */
const sweep = (a1: number, a2: number) => {
  let s = (a2 - a1) % (2 * Math.PI);
  if (s <= 0) s += 2 * Math.PI;
  return s;
};

function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 12): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** Outline of a preset shape in the box (unrotated); null = not known (drawn as its box). */
function presetOutline(prst: string, x: number, y: number, w: number, h: number, adj: (name: string, def: number) => number): Pt[] | null {
  const ss = Math.min(w, h);
  const r = x + w;
  const b = y + h;
  const hc = x + w / 2;
  const vc = y + h / 2;
  switch (prst) {
    case 'rect':
    case 'flowChartProcess':
    case 'flowChartPredefinedProcess':
    case 'flowChartInternalStorage':
    case 'wedgeRectCallout':
    case 'borderCallout1':
    case 'callout1':
    case 'accentCallout1':
    case 'frame':
    case 'textBox':
      return [
        [x, y],
        [r, y],
        [r, b],
        [x, b],
      ];
    case 'roundRect':
    case 'flowChartAlternateProcess':
    case 'wedgeRoundRectCallout':
    case 'flowChartTerminator': {
      const rad = prst === 'flowChartTerminator' ? ss / 2 : Math.min(ss / 2, (ss * adj('adj', 16667)) / 100000);
      return [...arcPts(x + rad, y + rad, rad, rad, Math.PI, 1.5 * Math.PI, 6), ...arcPts(r - rad, y + rad, rad, rad, 1.5 * Math.PI, 2 * Math.PI, 6), ...arcPts(r - rad, b - rad, rad, rad, 0, 0.5 * Math.PI, 6), ...arcPts(x + rad, b - rad, rad, rad, 0.5 * Math.PI, Math.PI, 6)];
    }
    case 'round2SameRect': {
      const rad = Math.min(ss / 2, (ss * adj('adj1', 16667)) / 100000);
      return [...arcPts(x + rad, y + rad, rad, rad, Math.PI, 1.5 * Math.PI, 6), ...arcPts(r - rad, y + rad, rad, rad, 1.5 * Math.PI, 2 * Math.PI, 6), [r, b], [x, b]];
    }
    case 'snip1Rect': {
      const d = (ss * adj('adj', 16667)) / 100000;
      return [
        [x, y],
        [r - d, y],
        [r, y + d],
        [r, b],
        [x, b],
      ];
    }
    case 'ellipse':
    case 'flowChartConnector':
    case 'cloud':
    case 'wedgeEllipseCallout':
    case 'teardrop':
      return arcPts(hc, vc, w / 2, h / 2, 0, 2 * Math.PI, 48).slice(0, -1);
    case 'blockArc': {
      // a thick arc: outer edge from adj1 to adj2 (clockwise), inner edge back
      const a1 = deg(adj('adj1', 10800000));
      const sw = sweep(a1, deg(adj('adj2', 0)));
      const t = (ss * Math.max(0, Math.min(50000, adj('adj3', 25000)))) / 100000;
      const outer = arcPts(hc, vc, w / 2, h / 2, a1, a1 + sw, 36);
      const inner = arcPts(hc, vc, Math.max(0, w / 2 - t), Math.max(0, h / 2 - t), a1 + sw, a1, 36);
      return [...outer, ...inner];
    }
    case 'pie': {
      const a1 = deg(adj('adj1', 0));
      const sw = sweep(a1, deg(adj('adj2', 16200000)));
      return [[hc, vc], ...arcPts(hc, vc, w / 2, h / 2, a1, a1 + sw, 36)];
    }
    case 'chord': {
      const a1 = deg(adj('adj1', 2700000));
      const sw = sweep(a1, deg(adj('adj2', 16200000)));
      return arcPts(hc, vc, w / 2, h / 2, a1, a1 + sw, 36);
    }
    case 'circularArrow':
    case 'leftCircularArrow': {
      // band along the circle with an arrow head at the end (PowerPoint's adjust values)
      const t = (ss * adj('adj1', 12500)) / 100000;
      const head = (ss * adj('adj5', 12500)) / 100000;
      const a1 = deg(adj('adj4', 10800000));
      const a2 = deg(adj('adj3', 20457681));
      const sw = sweep(a1, a2);
      const rx = w / 2 - head;
      const ry = h / 2 - head;
      const outer = arcPts(hc, vc, rx + t / 2, ry + t / 2, a1, a1 + sw, 36);
      const inner = arcPts(hc, vc, rx - t / 2, ry - t / 2, a1 + sw, a1, 36);
      const e = a1 + sw;
      const tipA = e + Math.min(0.5, (head * 1.5) / Math.max(rx, 1));
      const tip: Pt = [hc + rx * Math.cos(tipA), vc + ry * Math.sin(tipA)];
      const ho: Pt = [hc + (rx + head) * Math.cos(e), vc + (ry + head) * Math.sin(e)];
      const hi: Pt = [hc + (rx - head) * Math.cos(e), vc + (ry - head) * Math.sin(e)];
      const pts = [...outer, ho, tip, hi, ...inner];
      return prst === 'leftCircularArrow' ? pts.map(([px, py]) => [x + r - px, py]) : pts;
    }
    case 'triangle':
    case 'flowChartExtract': {
      const ax = x + (w * adj('adj', 50000)) / 100000;
      return [
        [ax, y],
        [r, b],
        [x, b],
      ];
    }
    case 'flowChartMerge':
      return [
        [x, y],
        [r, y],
        [hc, b],
      ];
    case 'rtTriangle':
      return [
        [x, y],
        [r, b],
        [x, b],
      ];
    case 'diamond':
    case 'flowChartDecision':
      return [
        [hc, y],
        [r, vc],
        [hc, b],
        [x, vc],
      ];
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const d = prst === 'flowChartInputOutput' ? w / 5 : (ss * adj('adj', 25000)) / 100000;
      return [
        [x + d, y],
        [r, y],
        [r - d, b],
        [x, b],
      ];
    }
    case 'trapezoid': {
      const d = (ss * adj('adj', 25000)) / 100000;
      return [
        [x + d, y],
        [r - d, y],
        [r, b],
        [x, b],
      ];
    }
    case 'pentagon':
    case 'homePlate': {
      const d = (ss * adj('adj', 50000)) / 100000;
      return [
        [x, y],
        [r - d, y],
        [r, vc],
        [r - d, b],
        [x, b],
      ];
    }
    case 'chevron': {
      const d = (ss * adj('adj', 50000)) / 100000;
      return [
        [x, y],
        [r - d, y],
        [r, vc],
        [r - d, b],
        [x, b],
        [x + d, vc],
      ];
    }
    case 'hexagon': {
      const d = (ss * adj('adj', 25000)) / 100000;
      return [
        [x + d, y],
        [r - d, y],
        [r, vc],
        [r - d, b],
        [x + d, b],
        [x, vc],
      ];
    }
    case 'octagon': {
      const d = (ss * adj('adj', 29289)) / 100000;
      return [
        [x + d, y],
        [r - d, y],
        [r, y + d],
        [r, b - d],
        [r - d, b],
        [x + d, b],
        [x, b - d],
        [x, y + d],
      ];
    }
    case 'regularPentagon': {
      const pts: Pt[] = [];
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        pts.push([hc + (w / 2) * Math.cos(a), vc + (h / 2) * Math.sin(a)]);
      }
      return pts;
    }
    case 'star4':
    case 'star5':
    case 'star6':
    case 'star8': {
      const n = Number(prst.slice(4));
      const inner = n === 5 ? 0.38 : n === 4 ? 0.25 : 0.5;
      const pts: Pt[] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const k = i % 2 ? inner : 1;
        pts.push([hc + (w / 2) * k * Math.cos(a), vc + (h / 2) * k * Math.sin(a)]);
      }
      return pts;
    }
    case 'plus':
    case 'mathPlus': {
      const d = (ss * adj('adj', 25000)) / 100000;
      return [
        [x + d, y],
        [r - d, y],
        [r - d, y + d],
        [r, y + d],
        [r, b - d],
        [r - d, b - d],
        [r - d, b],
        [x + d, b],
        [x + d, b - d],
        [x, b - d],
        [x, y + d],
        [x + d, y + d],
      ];
    }
    case 'rightArrow':
    case 'leftArrow': {
      const a1 = adj('adj1', 50000) / 100000;
      const hd = (ss * adj('adj2', 50000)) / 100000;
      const t = (h * (1 - a1)) / 2;
      const pts: Pt[] = [
        [x, y + t],
        [r - hd, y + t],
        [r - hd, y],
        [r, vc],
        [r - hd, b],
        [r - hd, b - t],
        [x, b - t],
      ];
      return prst === 'leftArrow' ? pts.map(([px, py]) => [x + r - px, py]) : pts;
    }
    case 'upArrow':
    case 'downArrow': {
      const a1 = adj('adj1', 50000) / 100000;
      const hd = (ss * adj('adj2', 50000)) / 100000;
      const t = (w * (1 - a1)) / 2;
      const pts: Pt[] = [
        [x + t, b],
        [x + t, y + hd],
        [x, y + hd],
        [hc, y],
        [r, y + hd],
        [r - t, y + hd],
        [r - t, b],
      ];
      return prst === 'downArrow' ? pts.map(([px, py]) => [px, y + b - py]) : pts;
    }
    case 'leftRightArrow': {
      const a1 = adj('adj1', 50000) / 100000;
      const hd = (ss * adj('adj2', 50000)) / 100000;
      const t = (h * (1 - a1)) / 2;
      return [
        [x, vc],
        [x + hd, y],
        [x + hd, y + t],
        [r - hd, y + t],
        [r - hd, y],
        [r, vc],
        [r - hd, b],
        [r - hd, b - t],
        [x + hd, b - t],
        [x + hd, b],
      ];
    }
    case 'flowChartDocument':
      // a box with a wavy bottom edge
      return [
        [x, y],
        [r, y],
        ...Array.from({ length: 17 }, (_, i): Pt => [r - (w * i) / 16, b - h * 0.1 - h * 0.07 * Math.sin((2 * Math.PI * i) / 16)]),
      ];
    default:
      return null;
  }
}

// ------------------------------------------------------------------ the reader

interface Rel {
  target: string;
  type: string;
}

interface PhInfo {
  type: string;
  idx?: string;
  node: XNode;
}

export async function layoutPptx(zip: ZipArchive, opts: PptxOptions): Promise<DisplayList> {
  const notes = new Set<string>();
  const m = opts.measure;
  const xmlCache = new Map<string, XNode | null>();
  const getXml = async (part: string): Promise<XNode | null> => {
    if (xmlCache.has(part)) return xmlCache.get(part) ?? null;
    const t = await zip.text(part);
    const x = t ? parseXml(t) : null;
    xmlCache.set(part, x);
    return x;
  };
  const relCache = new Map<string, Map<string, Rel>>();
  const getRels = async (part: string): Promise<Map<string, Rel>> => {
    const hit = relCache.get(part);
    if (hit) return hit;
    const out = new Map<string, Rel>();
    const x = await getXml(relsOf(part));
    for (const r of kids(x ?? undefined, 'Relationship')) {
      if (attr(r, 'TargetMode') === 'External') continue; // never load remote resources
      const id = attr(r, 'Id');
      const target = attr(r, 'Target');
      if (id && target) out.set(id, { target: resolvePart(part, target), type: (attr(r, 'Type') ?? '').split('/').pop() ?? '' });
    }
    relCache.set(part, out);
    return out;
  };
  const relOfType = async (part: string, type: string) => [...(await getRels(part)).values()].find((r) => r.type === type)?.target;

  const pres = await getXml('ppt/presentation.xml');
  if (!pres) throw new Error('ppt/presentation.xml is missing');
  const sz = kid(pres, 'p:sldSz');
  const W = Math.max(50, Math.min(4000, num(attr(sz, 'cx'), 9144000) * EMU));
  const H = Math.max(50, Math.min(4000, num(attr(sz, 'cy'), 6858000) * EMU));
  const presRels = await getRels('ppt/presentation.xml');
  const slideParts = kids(kid(pres, 'p:sldIdLst'), 'p:sldId')
    .map((s) => presRels.get(attr(s, 'r:id') ?? '')?.target)
    .filter((x): x is string => !!x);
  const defaultTextStyle = kid(pres, 'p:defaultTextStyle');

  const fonts: string[] = [];
  const fontIx = (name: string | undefined) => {
    const css = cssFamily(name, 'sans');
    let i = fonts.indexOf(css);
    if (i < 0) i = fonts.push(css) - 1;
    return i;
  };

  const themeCache = new Map<string, Theme>();
  const themeOf = async (part: string | undefined): Promise<Theme> => {
    const key = part ?? '';
    const hit = themeCache.get(key);
    if (hit) return hit;
    const t = part ? await getXml(part) : null;
    const th: Theme = { colors: { dk1: '000000', lt1: 'ffffff', dk2: '1f497d', lt2: 'eeece1', accent1: '4f81bd', accent2: 'c0504d', accent3: '9bbb59', accent4: '8064a2', accent5: '4bacc6', accent6: 'f79646', hlink: '0000ff', folHlink: '800080' }, major: 'Calibri', minor: 'Calibri', majorEa: '', minorEa: '', lnWidths: [0.75, 1.5, 2.25] };
    const cs = find(t ?? undefined, 'a:clrScheme')[0];
    for (const c of cs?.children ?? []) {
      const v = c.children[0];
      const hx = v?.name === 'a:srgbClr' ? attr(v, 'val') : v?.name === 'a:sysClr' ? attr(v, 'lastClr') : undefined;
      if (hx && /^[0-9a-fA-F]{6}$/.test(hx)) th.colors[local(c.name)] = hx.toLowerCase();
    }
    const fs = find(t ?? undefined, 'a:fontScheme')[0];
    th.major = attr(kid(kid(fs, 'a:majorFont'), 'a:latin'), 'typeface') || th.major;
    th.minor = attr(kid(kid(fs, 'a:minorFont'), 'a:latin'), 'typeface') || th.minor;
    th.majorEa = attr(kid(kid(fs, 'a:majorFont'), 'a:ea'), 'typeface') ?? '';
    th.minorEa = attr(kid(kid(fs, 'a:minorFont'), 'a:ea'), 'typeface') ?? '';
    const ls = find(t ?? undefined, 'a:lnStyleLst')[0];
    const widths = kids(ls, 'a:ln').map((l) => num(attr(l, 'w'), 9525) * EMU);
    if (widths.length) th.lnWidths = widths;
    themeCache.set(key, th);
    return th;
  };

  const tableStyles = await getXml('ppt/tableStyles.xml');

  const pages: DLPage[] = [];
  const maxPages = opts.maxPages ?? 2000;
  if (slideParts.length > maxPages) throw new Error(`the presentation has more than ${maxPages} slides`);
  let last = Date.now();

  for (let si = 0; si < slideParts.length; si++) {
    if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    if (Date.now() - last > 40) {
      opts.onProgress?.(si, slideParts.length);
      await (opts.yieldUi ? opts.yieldUi() : Promise.resolve());
      last = Date.now();
    }
    const slidePart = slideParts[si];
    const slide = await getXml(slidePart);
    if (!slide) {
      pages.push({ w: W, h: H, ops: [] });
      continue;
    }
    if (attr(slide, 'show') === '0') notes.add('hidden-slides');
    const layoutPart = await relOfType(slidePart, 'slideLayout');
    const layout = layoutPart ? await getXml(layoutPart) : null;
    const masterPart = layoutPart ? await relOfType(layoutPart, 'slideMaster') : undefined;
    const master = masterPart ? await getXml(masterPart) : null;
    const theme = await themeOf(masterPart ? await relOfType(masterPart, 'theme') : undefined);
    const clrMapNode = kid(master ?? undefined, 'p:clrMap');
    const clrMap: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', ...(clrMapNode?.attrs ?? {}) };
    for (const ov of [kid(kid(layout ?? undefined, 'p:clrMapOvr'), 'a:overrideClrMapping'), kid(kid(slide, 'p:clrMapOvr'), 'a:overrideClrMapping')]) if (ov) Object.assign(clrMap, ov.attrs);
    const C = new Colors(theme, clrMap);
    const typeface = (tf: string | undefined): string | undefined => {
      if (!tf) return undefined;
      if (tf === '+mj-lt') return theme.major;
      if (tf === '+mn-lt') return theme.minor;
      if (tf === '+mj-ea') return theme.majorEa || theme.major;
      if (tf === '+mn-ea') return theme.minorEa || theme.minor;
      return tf;
    };

    // ---- text style readers (need the colour context of this slide)
    const readR = (n: XNode | undefined): RProps => {
      const r: RProps = {};
      if (!n) return r;
      if (attr(n, 'sz') !== undefined) r.size = num(attr(n, 'sz'), 1800) / 100;
      if (attr(n, 'b') !== undefined) r.bold = attr(n, 'b') === '1' || attr(n, 'b') === 'true';
      if (attr(n, 'i') !== undefined) r.italic = attr(n, 'i') === '1' || attr(n, 'i') === 'true';
      if (attr(n, 'u') !== undefined) r.underline = attr(n, 'u') !== 'none';
      if (attr(n, 'strike') !== undefined) r.strike = attr(n, 'strike') !== 'noStrike';
      if (attr(n, 'baseline') !== undefined) r.baseline = num(attr(n, 'baseline'));
      const fill = kid(n, 'a:solidFill');
      if (fill) r.color = C.in(fill);
      else if (kid(n, 'a:gradFill')) r.color = C.in(find(kid(n, 'a:gradFill'), 'a:gs')[0]);
      const latin = typeface(attr(kid(n, 'a:latin'), 'typeface'));
      const ea = typeface(attr(kid(n, 'a:ea'), 'typeface'));
      if (latin || ea) r.font = latin || ea;
      if (kid(n, 'a:hlinkClick')) {
        r.color ??= C.of({ name: 'a:schemeClr', attrs: { val: 'hlink' }, children: [], text: '' });
        r.underline ??= true;
      }
      return r;
    };
    const readL = (n: XNode | undefined): PLevel => {
      const l: PLevel = { r: readR(kid(n, 'a:defRPr')) };
      if (!n) return l;
      if (attr(n, 'marL') !== undefined) l.marL = num(attr(n, 'marL')) * EMU;
      if (attr(n, 'indent') !== undefined) l.indent = num(attr(n, 'indent')) * EMU;
      if (attr(n, 'algn') !== undefined) l.algn = attr(n, 'algn');
      const sp = (name: string): { pts?: number; pct?: number } => {
        const e = kid(n, name);
        if (!e) return {};
        const pts = kid(e, 'a:spcPts');
        const pct = kid(e, 'a:spcPct');
        return pts ? { pts: num(attr(pts, 'val')) / 100 } : pct ? { pct: num(attr(pct, 'val')) / 100000 } : {};
      };
      const ln = sp('a:lnSpc');
      if (ln.pts !== undefined) l.lnPts = ln.pts;
      if (ln.pct !== undefined) l.lnPct = ln.pct;
      const bf = sp('a:spcBef');
      if (bf.pts !== undefined) l.befPts = bf.pts;
      if (bf.pct !== undefined) l.befPct = bf.pct;
      const af = sp('a:spcAft');
      if (af.pts !== undefined) l.aftPts = af.pts;
      if (af.pct !== undefined) l.aftPct = af.pct;
      if (kid(n, 'a:buNone')) l.bu = { kind: 'none' };
      else if (kid(n, 'a:buChar')) l.bu = { kind: 'char', char: attr(kid(n, 'a:buChar'), 'char') ?? '•' };
      else if (kid(n, 'a:buAutoNum')) l.bu = { kind: 'auto', scheme: attr(kid(n, 'a:buAutoNum'), 'type') ?? 'arabicPeriod', start: num(attr(kid(n, 'a:buAutoNum'), 'startAt'), 1) };
      if (l.bu && l.bu.kind !== 'none') {
        const bf2 = attr(kid(n, 'a:buFont'), 'typeface');
        if (bf2) l.bu.font = bf2;
        const bc = kid(n, 'a:buClr');
        if (bc) l.bu.color = C.in(bc);
        const bs = kid(n, 'a:buSzPct');
        if (bs) l.bu.size = num(attr(bs, 'val'), 100000) / 100000;
      }
      return l;
    };
    const levelsOf = (list: XNode | undefined): Map<number, PLevel> => {
      const out = new Map<number, PLevel>();
      if (!list) return out;
      const def = kid(list, 'a:defPPr');
      for (let i = 1; i <= 9; i++) {
        const n = kid(list, `a:lvl${i}pPr`);
        if (n || def) out.set(i - 1, mergeL(readL(def), readL(n)));
      }
      return out;
    };

    // ---- placeholders of the layout and the master
    const phOf = (sp: XNode): { type: string; idx?: string } | null => {
      const nv = kid(sp, 'p:nvSpPr') ?? kid(sp, 'p:nvPicPr') ?? kid(sp, 'p:nvGraphicFramePr');
      const ph = kid(kid(nv, 'p:nvPr'), 'p:ph');
      if (!ph) return null;
      return { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') };
    };
    const phList = (tree: XNode | undefined): PhInfo[] => {
      const out: PhInfo[] = [];
      for (const c of tree?.children ?? []) {
        const p = c.name === 'p:sp' || c.name === 'p:pic' ? phOf(c) : null;
        if (p) out.push({ ...p, node: c });
      }
      return out;
    };
    const layoutTree = kid(kid(layout ?? undefined, 'p:cSld'), 'p:spTree');
    const masterTree = kid(kid(master ?? undefined, 'p:cSld'), 'p:spTree');
    const layoutPh = phList(layoutTree);
    const masterPh = phList(masterTree);
    const norm = (t: string) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t);
    const matchPh = (list: PhInfo[], ph: { type: string; idx?: string }, byIdx: boolean): PhInfo | undefined =>
      (byIdx && ph.idx !== undefined ? list.find((x) => x.idx === ph.idx) : undefined) ?? list.find((x) => x.type === ph.type) ?? list.find((x) => norm(x.type) === norm(ph.type));
    const txStyles = kid(master ?? undefined, 'p:txStyles');
    const styleLevels = (ph: { type: string } | null): Map<number, PLevel> => {
      const base = levelsOf(defaultTextStyle);
      if (!ph) return base;
      const t = norm(ph.type);
      const s = t === 'title' ? kid(txStyles, 'p:titleStyle') : t === 'body' ? kid(txStyles, 'p:bodyStyle') : kid(txStyles, 'p:otherStyle');
      const lv = levelsOf(s);
      for (const [k, v] of lv) base.set(k, mergeL(base.get(k) ?? { r: {} }, v));
      return base;
    };

    // ---- the page
    const page: DLPage = { w: W, h: H, ops: [] };
    const ops = page.ops;

    // background: slide, layout, master
    const bgOf = (x: XNode | null) => kid(kid(x ?? undefined, 'p:cSld'), 'p:bg');
    const bgSrc: [XNode | undefined, string | undefined][] = [
      [bgOf(slide), slidePart],
      [bgOf(layout), layoutPart],
      [bgOf(master), masterPart],
    ];
    const [bg, bgPart] = bgSrc.find((b) => b[0]) ?? [undefined, undefined];
    if (bg) {
      const pr = kid(bg, 'p:bgPr');
      const ref = kid(bg, 'p:bgRef');
      if (pr) {
        const blip = find(kid(pr, 'a:blipFill'), 'a:blip')[0];
        const rid = attr(blip, 'r:embed');
        const part = rid && bgPart ? (await getRels(bgPart)).get(rid)?.target : undefined;
        if (part) {
          page.bg = '#ffffff';
          ops.push({ k: 'img', x: 0, y: 0, w: W, h: H, part });
        } else {
          const c = kid(pr, 'a:solidFill') ? C.in(kid(pr, 'a:solidFill')) : kid(pr, 'a:gradFill') ? gradColor(kid(pr, 'a:gradFill'), C) : kid(pr, 'a:pattFill') ? C.in(kid(kid(pr, 'a:pattFill'), 'a:bgClr')) : undefined;
          if (kid(pr, 'a:gradFill') || kid(pr, 'a:pattFill')) notes.add('gradients');
          if (c) page.bg = c.slice(0, 7);
        }
      } else if (ref) {
        const c = C.in(ref);
        if (c) page.bg = c.slice(0, 7);
      }
    }
    page.bg ??= '#' + (theme.colors[clrMap.bg1 ?? 'lt1'] ?? 'ffffff');

    // ---- shapes
    interface Xf {
      ox: number;
      oy: number;
      sx: number;
      sy: number;
    }
    const ROOT: Xf = { ox: 0, oy: 0, sx: EMU, sy: EMU };
    const box = (xfrm: XNode | undefined, xf: Xf): { x: number; y: number; w: number; h: number; rot: number; fh: boolean; fv: boolean } | null => {
      const off = kid(xfrm, 'a:off');
      const ext = kid(xfrm, 'a:ext');
      if (!off || !ext) return null;
      return {
        x: xf.ox + num(attr(off, 'x')) * xf.sx,
        y: xf.oy + num(attr(off, 'y')) * xf.sy,
        w: num(attr(ext, 'cx')) * xf.sx,
        h: num(attr(ext, 'cy')) * xf.sy,
        rot: num(attr(xfrm, 'rot')) / 60000,
        fh: attr(xfrm, 'flipH') === '1',
        fv: attr(xfrm, 'flipV') === '1',
      };
    };

    /** Fill of a shape properties element: undefined = not set, null = no fill. */
    const fillOf = (spPr: XNode | undefined): string | null | undefined => {
      if (!spPr) return undefined;
      if (kid(spPr, 'a:noFill')) return null;
      const sf = kid(spPr, 'a:solidFill');
      if (sf) return C.in(sf) ?? null;
      const gf = kid(spPr, 'a:gradFill');
      if (gf) {
        notes.add('gradients');
        return gradColor(gf, C) ?? null;
      }
      const pf = kid(spPr, 'a:pattFill');
      if (pf) {
        notes.add('gradients');
        return C.in(kid(pf, 'a:fgClr')) ?? null;
      }
      return undefined;
    };
    interface LineSt {
      c: string;
      lw: number;
      dash?: number[];
      head?: string;
      tail?: string;
    }
    const lineOf = (ln: XNode | undefined, styleRef: XNode | undefined): LineSt | null => {
      let color: string | undefined;
      let lw = 0.75;
      let none = false;
      if (styleRef && num(attr(styleRef, 'idx')) > 0) {
        color = C.in(styleRef);
        lw = theme.lnWidths[num(attr(styleRef, 'idx')) - 1] ?? 0.75;
      }
      if (ln) {
        if (kid(ln, 'a:noFill')) none = true;
        const sf = kid(ln, 'a:solidFill');
        if (sf) {
          color = C.in(sf, color);
          none = false;
        }
        if (attr(ln, 'w') !== undefined) lw = num(attr(ln, 'w')) * EMU;
      }
      if (none || !color) return null;
      const pd = attr(kid(ln, 'a:prstDash'), 'val');
      const d = Math.max(1, lw);
      const dash = pd === 'dash' || pd === 'lgDash' || pd === 'sysDash' ? [d * 4, d * 3] : pd === 'dot' || pd === 'sysDot' ? [d, d * 2] : pd === 'dashDot' || pd === 'lgDashDot' || pd === 'sysDashDot' ? [d * 4, d * 2, d, d * 2] : undefined;
      const head = attr(kid(ln, 'a:headEnd'), 'type');
      const tail = attr(kid(ln, 'a:tailEnd'), 'type');
      return { c: color, lw: Math.max(0.25, Math.min(50, lw)), ...(dash ? { dash } : {}), ...(head && head !== 'none' ? { head } : {}), ...(tail && tail !== 'none' ? { tail } : {}) };
    };
    const arrowHead = (tip: Pt, from: Pt, l: LineSt) => {
      const len = Math.max(6, l.lw * 4);
      const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
      const p1: Pt = [tip[0] - len * Math.cos(a - 0.45), tip[1] - len * Math.sin(a - 0.45)];
      const p2: Pt = [tip[0] - len * Math.cos(a + 0.45), tip[1] - len * Math.sin(a + 0.45)];
      ops.push({ k: 'pg', pts: [...tip, ...p1, ...p2], c: 1, fill: l.c });
    };
    const polyOp = (pts: Pt[], closed: boolean, fill: string | null | undefined, line: LineSt | null) => {
      if (pts.length < 2 || (!fill && !line)) return;
      ops.push({ k: 'pg', pts: pts.flat(), ...(closed ? { c: 1 } : {}), ...(fill ? { fill } : {}), ...(line ? { stroke: line.c, lw: line.lw, ...(line.dash ? { dash: line.dash } : {}) } : {}) });
      if (!closed && line) {
        if (line.tail) arrowHead(pts[pts.length - 1], pts[pts.length - 2], line);
        if (line.head) arrowHead(pts[0], pts[1], line);
      }
    };

    /** Geometry of a shape (preset / custom) drawn into ops. */
    const drawGeometry = (spPr: XNode | undefined, b: NonNullable<ReturnType<typeof box>>, fill: string | null | undefined, line: LineSt | null) => {
      const pg = kid(spPr, 'a:prstGeom');
      const cg = kid(spPr, 'a:custGeom');
      const prst = pg ? (attr(pg, 'prst') ?? 'rect') : cg ? '' : 'rect';
      const av = new Map<string, number>();
      for (const gd of kids(kid(pg, 'a:avLst'), 'a:gd')) {
        const f = /^val\s+(-?\d+)/.exec(attr(gd, 'fmla') ?? '');
        if (f) av.set(attr(gd, 'name') ?? '', Number(f[1]));
      }
      const adj = (n: string, d: number) => av.get(n) ?? d;
      if (!fill && !line) return;
      const { x, y, w, h, rot, fh, fv } = b;
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (cg) {
        drawCustom(cg, b, fill, line);
        return;
      }
      if (/^(line|straightConnector1)$/.test(prst)) {
        let p: Pt[] = [
          [x, y],
          [x + w, y + h],
        ];
        p = rotatePts(p, cx, cy, rot, fh, fv);
        polyOp(p, false, null, line);
        return;
      }
      if (/^(bentConnector[2-5])$/.test(prst)) {
        const n = Number(prst.slice(-1));
        let p: Pt[] =
          n === 2
            ? [
                [x, y],
                [x + w, y],
                [x + w, y + h],
              ]
            : [
                [x, y],
                [x + (w * adj('adj1', 50000)) / 100000, y],
                [x + (w * adj('adj1', 50000)) / 100000, y + h],
                [x + w, y + h],
              ];
        p = rotatePts(p, cx, cy, rot, fh, fv);
        polyOp(p, false, null, line);
        return;
      }
      if (/^curvedConnector[2-5]$/.test(prst)) {
        const p: Pt[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          // cubic from (x,y) to (x+w,y+h) with horizontal tangents
          const bx = (1 - t) ** 3 * x + 3 * (1 - t) ** 2 * t * (x + w / 2) + 3 * (1 - t) * t * t * (x + w / 2) + t ** 3 * (x + w);
          const by = (1 - t) ** 3 * y + 3 * (1 - t) ** 2 * t * y + 3 * (1 - t) * t * t * (y + h) + t ** 3 * (y + h);
          p.push([bx, by]);
        }
        polyOp(rotatePts(p, cx, cy, rot, fh, fv), false, null, line);
        return;
      }
      if (prst === 'arc') {
        const a1 = deg(adj('adj1', 16200000));
        const p = arcPts(cx, cy, w / 2, h / 2, a1, a1 + sweep(a1, deg(adj('adj2', 0))), 36);
        polyOp(rotatePts(p, cx, cy, rot, fh, fv), false, null, line);
        return;
      }
      if (prst === 'donut') {
        const t = Math.min(Math.min(w, h) / 2, (Math.min(w, h) * adj('adj', 25000)) / 100000);
        const outer = arcPts(cx, cy, w / 2, h / 2, 0, 2 * Math.PI, 48).slice(0, -1);
        const inner = arcPts(cx, cy, w / 2 - t, h / 2 - t, 0, 2 * Math.PI, 48).slice(0, -1);
        const pts = rotatePts([...outer, ...inner], cx, cy, rot, fh, fv);
        ops.push({ k: 'pg', pts: pts.flat(), c: 1, brk: [outer.length], ...(fill ? { fill } : {}), ...(line ? { stroke: line.c, lw: line.lw } : {}) });
        return;
      }
      if (prst === 'rect' && !rot) {
        ops.push({ k: 'r', x, y, w, h, ...(fill ? { fill } : {}), ...(line ? { stroke: line.c, lw: line.lw, ...(line.dash ? { dash: line.dash } : {}) } : {}) });
        return;
      }
      if (prst === 'ellipse' && !rot) {
        if (fill || line) ops.push({ k: 'e', x, y, w, h, ...(fill ? { fill } : {}), ...(line ? { stroke: line.c, lw: line.lw, ...(line.dash ? { dash: line.dash } : {}) } : {}) });
        return;
      }
      const outline = presetOutline(prst, x, y, w, h, adj);
      if (!outline) {
        // a shape this reader cannot draw: nothing is drawn (a filled box in its place would cover
        // the slide); its text is still shown, and the import notice says shapes were left out
        notes.add('shapes');
        return;
      }
      polyOp(rotatePts(outline, cx, cy, rot, fh, fv), true, fill, line);
    };

    const drawCustom = (cg: XNode, b: NonNullable<ReturnType<typeof box>>, fill: string | null | undefined, line: LineSt | null) => {
      const { x, y, w, h, rot, fh, fv } = b;
      for (const path of kids(kid(cg, 'a:pathLst'), 'a:path')) {
        const pw = num(attr(path, 'w'), 0) || w / EMU || 1;
        const ph = num(attr(path, 'h'), 0) || h / EMU || 1;
        const kx = w / pw;
        const ky = h / ph;
        const named = (v: string | undefined, isX: boolean): number => {
          if (v === undefined) return 0;
          const n = Number(v);
          if (Number.isFinite(n)) return n;
          const full = isX ? pw : ph;
          return v === 'r' || v === 'b' || v === 'w' || v === 'h' ? full : v === 'hc' || v === 'vc' ? full / 2 : 0;
        };
        const P = (pt: XNode | undefined): Pt => [x + named(attr(pt, 'x'), true) * kx, y + named(attr(pt, 'y'), false) * ky];
        const pts: Pt[] = [];
        const brk: number[] = [];
        let cur: Pt = [x, y];
        let closed = false;
        for (const c of path.children) {
          if (c.name === 'a:moveTo') {
            if (pts.length) brk.push(pts.length);
            cur = P(kid(c, 'a:pt'));
            pts.push(cur);
          } else if (c.name === 'a:lnTo') {
            cur = P(kid(c, 'a:pt'));
            pts.push(cur);
          } else if (c.name === 'a:cubicBezTo' || c.name === 'a:quadBezTo') {
            const cps = kids(c, 'a:pt').map(P);
            const all = [cur, ...cps];
            for (let i = 1; i <= 10; i++) {
              const t = i / 10;
              let q = all.slice();
              while (q.length > 1) q = q.slice(1).map((p, k) => [q[k][0] + (p[0] - q[k][0]) * t, q[k][1] + (p[1] - q[k][1]) * t] as Pt);
              pts.push(q[0]);
            }
            cur = cps[cps.length - 1] ?? cur;
          } else if (c.name === 'a:arcTo') {
            const wr = num(attr(c, 'wR')) * kx;
            const hr = num(attr(c, 'hR')) * ky;
            const st = (num(attr(c, 'stAng')) / 60000) * (Math.PI / 180);
            const sw = (num(attr(c, 'swAng')) / 60000) * (Math.PI / 180);
            const ccx = cur[0] - wr * Math.cos(st);
            const ccy = cur[1] - hr * Math.sin(st);
            const arc = arcPts(ccx, ccy, wr, hr, st, st + sw, Math.max(4, Math.ceil(Math.abs(sw) / 0.2))).slice(1);
            pts.push(...arc);
            cur = arc[arc.length - 1] ?? cur;
          } else if (c.name === 'a:close') closed = true;
        }
        if (pts.length < 2) continue;
        const rp = rotatePts(pts, x + w / 2, y + h / 2, rot, fh, fv);
        const f = attr(path, 'fill') === 'none' ? null : fill;
        const l = attr(path, 'stroke') === '0' || attr(path, 'stroke') === 'false' ? null : line;
        if (!f && !l) continue;
        ops.push({ k: 'pg', pts: rp.flat(), ...(closed ? { c: 1 } : {}), ...(f ? { fill: f } : {}), ...(l ? { stroke: l.c, lw: l.lw, ...(l.dash ? { dash: l.dash } : {}) } : {}), ...(brk.length ? { brk } : {}) });
      }
    };

    /** Lay out and draw a text body inside a box. */
    const drawText = (txBody: XNode | undefined, b0: { x: number; y: number; w: number; h: number; rot?: number }, levels: Map<number, PLevel>, inherited: { bodyPr: XNode[]; lst: XNode[] }, fontColor?: string, defAnchor = 't', insets?: [number, number, number, number]) => {
      if (!txBody) return;
      const firstOp = ops.length;
      const paras = kids(txBody, 'a:p');
      if (!paras.some((p) => find(p, 'a:t').some((t) => t.text) || kid(p, 'a:r'))) return;
      // body properties: master < layout < shape
      const bp: Record<string, string> = {};
      let autofit: XNode | undefined;
      for (const n of [...inherited.bodyPr, kid(txBody, 'a:bodyPr')]) {
        if (!n) continue;
        Object.assign(bp, n.attrs);
        if (kid(n, 'a:normAutofit')) autofit = kid(n, 'a:normAutofit');
        else if (kid(n, 'a:noAutofit') || kid(n, 'a:spAutoFit')) autofit = undefined;
      }
      // vertical text: laid out in the box turned by 90°, then turned back (East Asian stacked
      // text is drawn turned as well — an approximation, listed in the notes)
      const vrot = bp.vert === 'vert' || bp.vert === 'eaVert' || bp.vert === 'mongolianVert' || bp.vert === 'wordArtVert' ? 90 : bp.vert === 'vert270' ? 270 : 0;
      if (bp.vert === 'mongolianVert' || bp.vert === 'wordArtVert') notes.add('vertical-text');
      const b = vrot ? { x: b0.x + b0.w / 2 - b0.h / 2, y: b0.y + b0.h / 2 - b0.w / 2, w: b0.h, h: b0.w } : b0;
      if (find(txBody, 'a:prstTxWarp').some((n) => attr(n, 'prst') !== 'textNoShape')) notes.add('text-effects');
      if (num(bp.numCol, 1) > 1) notes.add('columns');
      const scale = autofit ? num(attr(autofit, 'fontScale'), 100000) / 100000 : 1;
      const lnRed = autofit ? num(attr(autofit, 'lnSpcReduction'), 0) / 100000 : 0;
      const [li, ti, ri, bi] = insets ?? [num(bp.lIns, 91440) * EMU, num(bp.tIns, 45720) * EMU, num(bp.rIns, 91440) * EMU, num(bp.bIns, 45720) * EMU];
      const noWrap = bp.wrap === 'none';
      const anchor = bp.anchor ?? defAnchor;
      // list styles: inherited (master / layout placeholder) then the shape's own
      // the shape style's font colour (white text on a filled shape) replaces the master / default
      // text colour; colours in the placeholder's or shape's own list styles still win
      const lv = new Map<number, PLevel>();
      for (const [k, v] of levels) lv.set(k, fontColor ? { ...v, r: { ...v.r, color: fontColor } } : v);
      for (const ls of [...inherited.lst, kid(txBody, 'a:lstStyle')]) for (const [k, v] of levelsOf(ls)) lv.set(k, mergeL(lv.get(k) ?? { r: {} }, v));
      const width = Math.max(4, b.w - li - ri);
      const counters: number[] = [];
      const laid: { lines: Line[]; algn: string; marL: number; bef: number; aft: number }[] = [];
      for (const p of paras) {
        const pPr = kid(p, 'a:pPr');
        const lvl = Math.max(0, Math.min(8, num(attr(pPr, 'lvl'), 0)));
        let L: PLevel = lv.get(lvl) ?? lv.get(0) ?? { r: fontColor ? { color: fontColor } : {} };
        L = mergeL(L, readL(pPr));
        const runs: Run[] = [];
        const rs = (r: RProps): RunStyle => {
          const size = Math.max(1, Math.min(400, (r.size ?? 18) * scale));
          return {
            font: fontIx(typeface(r.font) ?? theme.minor),
            size,
            ...(r.bold ? { bold: true } : {}),
            ...(r.italic ? { italic: true } : {}),
            ...(r.color && r.color !== '#000000' ? { color: r.color } : {}),
            ...(r.underline ? { underline: true } : {}),
            ...(r.strike ? { strike: true } : {}),
            ...(r.baseline ? { vert: r.baseline > 0 ? ('super' as const) : ('sub' as const) } : {}),
          };
        };
        let hasText = false;
        for (const c of p.children) {
          if (c.name === 'a:r' || c.name === 'a:fld') {
            const r = mergeR(L.r, readR(kid(c, 'a:rPr')));
            const t = kid(c, 'a:t')?.text ?? '';
            if (t) hasText = true;
            runs.push({ kind: 'text', text: t, style: rs(r) });
          } else if (c.name === 'a:br') runs.push({ kind: 'br', style: rs(mergeR(L.r, readR(kid(c, 'a:rPr')))) });
          else if (c.name === 'a14:m' || c.name === 'mc:AlternateContent') notes.add('equations');
        }
        const endR = mergeR(L.r, readR(kid(p, 'a:endParaRPr')));
        if (!runs.length) runs.push({ kind: 'text', text: '', style: rs(endR) });
        // bullets / numbering
        const bu = L.bu;
        const first = runs.find((r): r is Extract<Run, { kind: 'text' }> => r.kind === 'text');
        if (hasText && bu && bu.kind !== 'none' && first) {
          let text = '';
          if (bu.kind === 'char') {
            const ch = bu.char ?? '•';
            text = /wingdings|symbol/i.test(bu.font ?? '') || ch.charCodeAt(0) >= 0xf000 ? (SYMBOL_BULLETS[ch] ?? '•') : ch;
          } else {
            counters[lvl] = (counters[lvl] ?? (bu.start ?? 1) - 1) + 1;
            text = autoNum(counters[lvl], bu.scheme ?? 'arabicPeriod');
          }
          for (let k = lvl + 1; k < 9; k++) counters[k] = undefined as unknown as number;
          const st = { ...first.style, ...(bu.color ? { color: bu.color } : {}), size: first.style.size * (bu.size ?? 1), font: bu.kind === 'char' && /wingdings|symbol/i.test(bu.font ?? '') ? first.style.font : bu.font ? fontIx(typeface(bu.font)) : first.style.font };
          runs.unshift({ kind: 'text', text, style: st }, { kind: 'tab', style: st });
        } else if (bu?.kind !== 'auto') counters.length = 0;
        const marL = Math.max(0, L.marL ?? 0);
        const indent = L.indent ?? 0;
        const lh = (size: number) => (L.lnPts !== undefined ? L.lnPts : size * 1.2 * Math.max(0.3, (L.lnPct ?? 1) - lnRed));
        const lines = flowLines(runs, noWrap ? 100000 : Math.max(4, width - marL), indent, m, fonts, lh, indent < 0 ? -indent : 72);
        const size0 = first?.style.size ?? (endR.size ?? 18) * scale;
        const bef = L.befPts ?? (L.befPct !== undefined ? L.befPct * size0 * 1.2 : 0);
        const aft = L.aftPts ?? (L.aftPct !== undefined ? L.aftPct * size0 * 1.2 : 0);
        laid.push({ lines, algn: L.algn ?? 'l', marL, bef, aft });
      }
      const total = laid.reduce((a, p, i) => a + (i ? p.bef : 0) + p.lines.reduce((s, l) => s + l.height, 0) + (i < laid.length - 1 ? p.aft : 0), 0);
      const inner = b.h - ti - bi;
      let y = anchor === 'ctr' ? b.y + ti + (inner - total) / 2 : anchor === 'b' ? b.y + b.h - bi - total : b.y + ti;
      laid.forEach((p, i) => {
        if (i) y += p.bef;
        const x0 = b.x + li + p.marL;
        // unwrapped text still aligns inside the box (it may run past it, as in PowerPoint)
        const wAvail = width - p.marL;
        y = emitLines(p.lines, x0, y, wAvail, p.algn, m, fonts, ops);
        y += p.aft;
      });
      const ox = Math.round((b0.x + b0.w / 2) * 100) / 100;
      const oy = Math.round((b0.y + b0.h / 2) * 100) / 100;
      if (bp.vert === 'eaVert' && !b0.rot) {
        // East Asian vertical text: CJK characters stay upright, stacked down the column
        const out: typeof ops = [];
        for (const o of ops.splice(firstOp)) {
          if (o.k !== 't' || !CJK_CHAR.test(o.s)) {
            out.push(o.k === 't' ? { ...o, rot: 90, ox, oy } : o);
            continue;
          }
          const css = `${o.i ? 'italic ' : ''}${o.b ? 'bold ' : ''}${o.z}px ${fonts[o.f] ?? 'sans-serif'}`;
          let dx = 0;
          for (const ch of Array.from(o.s)) {
            const cw = m.width(ch, css);
            const px = o.x + dx + cw / 2;
            const py = o.y - o.z * 0.35;
            const rx = ox - (py - oy);
            const ry = oy + (px - ox);
            if (ch.trim()) out.push({ ...o, s: ch, x: rx - cw / 2, y: ry + o.z * 0.35, w: Math.round(cw * 100) / 100 });
            dx += cw;
          }
        }
        ops.push(...out);
        return;
      }
      const turn = ((b0.rot ?? 0) + vrot) % 360;
      if (turn) {
        for (let i = firstOp; i < ops.length; i++) {
          const o = ops[i];
          if (o.k === 't') Object.assign(o, { rot: turn, ox, oy });
        }
      }
    };

    const drawPicture = async (pic: XNode, part: string, xf: Xf, inheritedXfrm?: XNode) => {
      const spPr = kid(pic, 'p:spPr');
      const b = box(kid(spPr, 'a:xfrm') ?? inheritedXfrm, xf);
      if (!b) return;
      const bf = kid(pic, 'p:blipFill');
      const rid = attr(kid(bf, 'a:blip'), 'r:embed');
      const target = rid ? (await getRels(part)).get(rid)?.target : undefined;
      if (find(kid(pic, 'p:nvPicPr'), 'a:videoFile').length || find(kid(pic, 'p:nvPicPr'), 'a:audioFile').length) notes.add('media');
      if (target) {
        const sr = kid(bf, 'a:srcRect');
        const crop: [number, number, number, number] | undefined = sr ? [num(attr(sr, 'l')) / 100000, num(attr(sr, 't')) / 100000, num(attr(sr, 'r')) / 100000, num(attr(sr, 'b')) / 100000] : undefined;
        ops.push({ k: 'img', x: b.x, y: b.y, w: b.w, h: b.h, part: target, ...(crop && crop.some((v) => v) ? { crop } : {}), ...(b.rot ? { rot: b.rot } : {}), ...(b.fh ? { fh: 1 as const } : {}), ...(b.fv ? { fv: 1 as const } : {}) });
      }
      const line = lineOf(kid(spPr, 'a:ln'), kid(kid(pic, 'p:style'), 'a:lnRef'));
      if (line) drawGeometry(spPr, b, null, line);
    };

    const drawTable = (frame: XNode, tbl: XNode, xf: Xf) => {
      const b = box(kid(frame, 'p:xfrm'), xf);
      if (!b) return;
      const cols = kids(kid(tbl, 'a:tblGrid'), 'a:gridCol').map((g) => num(attr(g, 'w')) * xf.sx);
      const tblPr = kid(tbl, 'a:tblPr');
      const flag = (n: string) => attr(tblPr, n) === '1';
      const styleId = kid(tblPr, 'a:tableStyleId')?.text.trim() ?? attr(tableStyles ?? undefined, 'def');
      const style = (styleId && kids(tableStyles ?? undefined, 'a:tblStyle').find((s) => attr(s, 'styleId') === styleId)) || (styleId === DEFAULT_TABLE_STYLE_ID || !styleId ? parseXml(DEFAULT_TABLE_STYLE) : undefined);
      const rows = kids(tbl, 'a:tr');
      const levels = levelsOf(defaultTextStyle);
      let y = b.y;
      const nCols = cols.length;
      rows.forEach((tr, ri) => {
        const tcs = kids(tr, 'a:tc');
        // measure: lay out cell text into a scratch list to know the row height
        const parts = ['wholeTbl'];
        const dataRow = flag('firstRow') ? ri - 1 : ri;
        if (flag('bandRow') && dataRow >= 0 && dataRow % 2 === 0) parts.push('band1H');
        if (flag('bandRow') && dataRow >= 0 && dataRow % 2 === 1) parts.push('band2H');
        if (flag('lastRow') && ri === rows.length - 1) parts.push('lastRow');
        if (flag('firstRow') && ri === 0) parts.push('firstRow');
        let rowH = num(attr(tr, 'h')) * xf.sy;
        const cellOps: (() => void)[] = [];
        let x = b.x;
        tcs.forEach((tc, ci) => {
          const span = Math.max(1, num(attr(tc, 'gridSpan'), 1));
          const w = cols.slice(ci, ci + span).reduce((a, c) => a + c, 0) || cols[ci] || 50;
          const cx = x;
          x += cols[ci] ?? 0;
          if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') return;
          const cParts = [...parts];
          if (flag('firstCol') && ci === 0) cParts.push('firstCol');
          if (flag('lastCol') && ci === nCols - 1) cParts.push('lastCol');
          // table style: fill, text colour / bold, borders
          let sFill: string | undefined;
          let sColor: string | undefined;
          let sBold = false;
          const sBorders: Record<string, LineSt | null> = {};
          for (const pn of cParts) {
            const part = kid(style, `a:${pn}`);
            if (!part) continue;
            const tx = kid(part, 'a:tcTxStyle');
            if (tx) {
              const c = C.in(tx);
              if (c) sColor = c;
              if (attr(tx, 'b') === 'on') sBold = true;
            }
            const ts = kid(part, 'a:tcStyle');
            const f = kid(kid(ts, 'a:fill'), 'a:solidFill');
            if (f) sFill = C.in(f);
            for (const bd of kid(ts, 'a:tcBdr')?.children ?? []) {
              const ln = kid(bd, 'a:ln');
              if (ln) sBorders[local(bd.name)] = lineOf(ln, undefined);
            }
          }
          const tcPr = kid(tc, 'a:tcPr');
          const own = fillOf(tcPr);
          const fill = own === undefined ? sFill : own;
          const ins: [number, number, number, number] = [num(attr(tcPr, 'marL'), 91440) * EMU, num(attr(tcPr, 'marT'), 45720) * EMU, num(attr(tcPr, 'marR'), 91440) * EMU, num(attr(tcPr, 'marB'), 45720) * EMU];
          const lv = new Map<number, PLevel>();
          for (const [k, v] of levels) lv.set(k, { ...v, r: { ...v.r, ...(sColor ? { color: sColor } : {}), ...(sBold ? { bold: true } : {}) } });
          // height of the text
          const before = ops.length;
          const probe = { x: cx, y: 0, w, h: 0 };
          drawText(kid(tc, 'a:txBody'), probe, lv, { bodyPr: [], lst: [] }, undefined, 't', ins);
          const drawn = ops.splice(before);
          const textBottom = drawn.reduce((a, o) => Math.max(a, o.k === 't' ? o.y + o.z * 0.3 : o.k === 'img' ? o.y + o.h : 0), 0);
          rowH = Math.max(rowH, textBottom + ins[3]);
          const side = (n: string, outer: string) => {
            const e = kid(tcPr, `a:ln${n}`);
            if (e) return lineOf(e, undefined);
            return sBorders[outer] !== undefined ? sBorders[outer] : (sBorders[n === 'L' || n === 'R' ? 'insideV' : 'insideH'] ?? null);
          };
          cellOps.push(() => {
            if (fill) ops.push({ k: 'r', x: cx, y, w, h: rowH, fill });
            const anchor = attr(tcPr, 'anchor') ?? 't';
            drawText(kid(tc, 'a:txBody'), { x: cx, y, w, h: rowH }, lv, { bodyPr: [], lst: [] }, undefined, anchor, ins);
            const L = side('L', ci === 0 ? 'left' : 'insideV');
            const R = side('R', ci + span >= nCols ? 'right' : 'insideV');
            const T = side('T', ri === 0 ? 'top' : 'insideH');
            const B = side('B', ri === rows.length - 1 ? 'bottom' : 'insideH');
            for (const [l, x1, y1, x2, y2] of [
              [T, cx, y, cx + w, y],
              [B, cx, y + rowH, cx + w, y + rowH],
              [L, cx, y, cx, y + rowH],
              [R, cx + w, y, cx + w, y + rowH],
            ] as [LineSt | null, number, number, number, number][])
              if (l) ops.push({ k: 'l', x1, y1, x2, y2, stroke: l.c, lw: l.lw });
          });
        });
        for (const f of cellOps) f();
        y += rowH;
      });
    };

    const drawTree = async (tree: XNode | undefined, part: string, scope: 'master' | 'layout' | 'slide', xf: Xf): Promise<void> => {
      for (const c0 of tree?.children ?? []) {
        // alternate content: the fallback is what older readers (like this one) are meant to use
        const list = c0.name === 'mc:AlternateContent' ? (kid(c0, 'mc:Fallback') ?? kid(c0, 'mc:Choice'))?.children ?? [] : [c0];
        for (const c of list) {
          if (c.name === 'p:sp' || c.name === 'p:cxnSp') {
            const ph = phOf(c);
            if (ph && scope !== 'slide') continue; // layout / master placeholders are templates
            const lph = ph ? matchPh(layoutPh, ph, true) : undefined;
            const mph = ph ? matchPh(masterPh, lph ?? ph, false) : undefined;
            const spPr = kid(c, 'p:spPr');
            const xfrm = kid(spPr, 'a:xfrm') ?? kid(kid(lph?.node, 'p:spPr'), 'a:xfrm') ?? kid(kid(mph?.node, 'p:spPr'), 'a:xfrm');
            const b = box(xfrm, xf);
            if (!b) continue;
            const st = kid(c, 'p:style');
            let fill = fillOf(spPr);
            if (fill === undefined) fill = fillOf(kid(lph?.node, 'p:spPr')) ?? fillOf(kid(mph?.node, 'p:spPr'));
            if (fill === undefined && st && num(attr(kid(st, 'a:fillRef'), 'idx')) > 0) fill = C.in(kid(st, 'a:fillRef'));
            const ln = kid(spPr, 'a:ln') ?? kid(kid(lph?.node, 'p:spPr'), 'a:ln') ?? kid(kid(mph?.node, 'p:spPr'), 'a:ln');
            const line = lineOf(ln, kid(st, 'a:lnRef'));
            const geomSrc = kid(spPr, 'a:prstGeom') || kid(spPr, 'a:custGeom') ? spPr : (kid(lph?.node, 'p:spPr') ?? spPr);
            drawGeometry(geomSrc, b, fill, line);
            const fontColor = C.in(kid(st, 'a:fontRef'));
            const inh = { bodyPr: [kid(kid(mph?.node, 'p:txBody'), 'a:bodyPr'), kid(kid(lph?.node, 'p:txBody'), 'a:bodyPr')].filter((x): x is XNode => !!x), lst: [kid(kid(mph?.node, 'p:txBody'), 'a:lstStyle'), kid(kid(lph?.node, 'p:txBody'), 'a:lstStyle')].filter((x): x is XNode => !!x) };
            drawText(kid(c, 'p:txBody'), { ...b, rot: b.fv ? b.rot + 180 : b.rot }, styleLevels(ph), inh, fontColor, ph && norm(ph.type) === 'title' ? 'ctr' : 't');
          } else if (c.name === 'p:pic') {
            const ph = phOf(c);
            if (ph && scope !== 'slide') continue;
            const lph = ph ? matchPh(layoutPh, ph, true) : undefined;
            await drawPicture(c, part, xf, kid(kid(lph?.node, 'p:spPr'), 'a:xfrm'));
          } else if (c.name === 'p:grpSp') {
            const gx = kid(kid(c, 'p:grpSpPr'), 'a:xfrm');
            const off = kid(gx, 'a:off');
            const ext = kid(gx, 'a:ext');
            const cho = kid(gx, 'a:chOff');
            const che = kid(gx, 'a:chExt');
            if (num(attr(gx, 'rot'))) notes.add('rotated-groups');
            if (off && ext && cho && che) {
              const kx = num(attr(che, 'cx')) ? num(attr(ext, 'cx')) / num(attr(che, 'cx')) : 1;
              const ky = num(attr(che, 'cy')) ? num(attr(ext, 'cy')) / num(attr(che, 'cy')) : 1;
              const inner: Xf = { ox: xf.ox + (num(attr(off, 'x')) - num(attr(cho, 'x')) * kx) * xf.sx, oy: xf.oy + (num(attr(off, 'y')) - num(attr(cho, 'y')) * ky) * xf.sy, sx: xf.sx * kx, sy: xf.sy * ky };
              await drawTree(c, part, scope, inner);
            } else await drawTree(c, part, scope, xf);
          } else if (c.name === 'p:graphicFrame') {
            const gd = find(c, 'a:graphicData')[0];
            const uri = attr(gd, 'uri') ?? '';
            const tbl = kid(gd, 'a:tbl');
            if (tbl) drawTable(c, tbl, xf);
            else if (/chart/.test(uri)) notes.add('charts');
            else if (/diagram/.test(uri)) notes.add('smartart');
            else {
              // OLE objects: their stored preview picture, when there is one
              const pic = find(gd, 'p:pic')[0];
              if (pic) {
                const b = box(kid(c, 'p:xfrm'), xf);
                const rid = attr(find(pic, 'a:blip')[0], 'r:embed');
                const target = rid ? (await getRels(part)).get(rid)?.target : undefined;
                if (b && target) ops.push({ k: 'img', x: b.x, y: b.y, w: b.w, h: b.h, part: target });
              } else notes.add('embedded-objects');
            }
          } else if (c.name === 'p:contentPart') notes.add('ink');
        }
      }
    };

    const showMaster = attr(slide, 'showMasterSp') !== '0' && attr(layout ?? undefined, 'showMasterSp') !== '0';
    if (showMaster && masterPart) await drawTree(masterTree, masterPart, 'master', ROOT);
    if (attr(slide, 'showMasterSp') !== '0' && layoutPart) await drawTree(layoutTree, layoutPart, 'layout', ROOT);
    await drawTree(kid(kid(slide, 'p:cSld'), 'p:spTree'), slidePart, 'slide', ROOT);
    if (find(slide, 'p:timing').length) notes.add('animations');
    pages.push(page);
  }

  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const pg of pages) {
    pg.w = r2(pg.w);
    pg.h = r2(pg.h);
    for (const op of pg.ops) {
      const o = op as unknown as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'number') o[k] = r2(v);
        else if (k === 'pts' && Array.isArray(v)) o[k] = (v as number[]).map(r2);
      }
    }
  }
  return { v: 1, kind: 'pptx', fonts, pages, notes: [...notes] };
}

function gradColor(g: XNode | undefined, C: Colors): string | undefined {
  const stops = find(g, 'a:gs').sort((a, b) => num(attr(a, 'pos')) - num(attr(b, 'pos')));
  if (!stops.length) return undefined;
  return C.in(stops[Math.floor((stops.length - 1) / 2)]);
}

function autoNum(n: number, scheme: string): string {
  const roman = (v: number) => {
    const t: [number, string][] = [
      [1000, 'm'],
      [900, 'cm'],
      [500, 'd'],
      [400, 'cd'],
      [100, 'c'],
      [90, 'xc'],
      [50, 'l'],
      [40, 'xl'],
      [10, 'x'],
      [9, 'ix'],
      [5, 'v'],
      [4, 'iv'],
      [1, 'i'],
    ];
    let out = '';
    for (const [k, s] of t)
      while (v >= k) {
        out += s;
        v -= k;
      }
    return out;
  };
  const alpha = (v: number) => String.fromCharCode(97 + ((v - 1) % 26));
  const core = /^alphaLc/.test(scheme) ? alpha(n) : /^alphaUc/.test(scheme) ? alpha(n).toUpperCase() : /^romanLc/.test(scheme) ? roman(n) : /^romanUc/.test(scheme) ? roman(n).toUpperCase() : /^circleNum/.test(scheme) && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : /^ea1Chs|^chs/.test(scheme) ? ('一二三四五六七八九十'[n - 1] ?? String(n)) : String(n);
  if (/^circleNum/.test(scheme)) return core;
  if (/ParenBoth$/.test(scheme)) return `(${core})`;
  if (/ParenR$/.test(scheme)) return `${core})`;
  if (/Plain$/.test(scheme)) return core;
  if (/^ea1Chs|^chs/.test(scheme)) return `${core}、`;
  return `${core}.`;
}

/** PowerPoint's default table style ("Medium Style 2 – Accent 1"); built in, so files do not carry it. */
export const DEFAULT_TABLE_STYLE_ID = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
const LT1 = '<a:solidFill><a:schemeClr val="lt1"/></a:solidFill>';
const BDR = (w: number) => `<a:ln w="${w}">${LT1}</a:ln>`;
const DEFAULT_TABLE_STYLE = `<a:tblStyle styleId="${DEFAULT_TABLE_STYLE_ID}">
<a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left>${BDR(12700)}</a:left><a:right>${BDR(12700)}</a:right><a:top>${BDR(12700)}</a:top><a:bottom>${BDR(12700)}</a:bottom><a:insideH>${BDR(12700)}</a:insideH><a:insideV>${BDR(12700)}</a:insideV></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
<a:band1H><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>
<a:lastCol><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastCol>
<a:firstCol><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstCol>
<a:lastRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:top>${BDR(38100)}</a:top></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastRow>
<a:firstRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:bottom>${BDR(38100)}</a:bottom></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
</a:tblStyle>`;
