import type { Page, Stroke } from '../document/model';
import type { GeometryCache } from '../document/geometry-cache';
import { SvgPathSink, emitGeometry } from '../ink/outline';
import { arrowEnds, arrowTangents, connectorPoints, isLine, itemCenter, shapeOutline, type Item, type Pt, type ShapeItem } from '../document/items';
import { LINE_HEIGHT, TEXT_PAD, arrowHeadPoints, arrowSize, assetDataUrl, fontFamily, layoutText } from './items-paint';
import { emitDashedGeometry, lineDashArray } from './dash';
import { FORMULA_PAD, formulaBoxSize, formulaDrawing, sourceDrawing } from './formula';
import { mapLayout, topicFont } from '../mindmap/paint';
import type { FormulaItem, MindMapItem } from '../document/items';

function f2(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

function rotAttr(it: Item): string {
  if (!it.rot) return '';
  const [cx, cy] = itemCenter(it);
  return ` transform="rotate(${f2((it.rot * 180) / Math.PI)} ${f2(cx)} ${f2(cy)})"`;
}

function dashAttr(it: ShapeItem): string {
  const arr = lineDashArray(it.dash, it.strokeWidth);
  return arr.length ? ` stroke-dasharray="${arr.map(f2).join(' ')}"` : '';
}

function headSvg(it: ShapeItem, from: Pt, to: Pt): string {
  const [l, tip, r] = arrowHeadPoints(from, to, arrowSize(it.strokeWidth));
  const d = `M${f2(l[0])} ${f2(l[1])}L${f2(tip[0])} ${f2(tip[1])}L${f2(r[0])} ${f2(r[1])}`;
  if ((it.head ?? 'filled') === 'filled') return `<path d="${d}Z" fill="${esc(it.stroke)}"/>`;
  return `<path d="${d}" fill="none" stroke="${esc(it.stroke)}" stroke-width="${f2(it.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function shapeSvg(it: ShapeItem): string {
  const stroke = `stroke="${esc(it.stroke)}" stroke-width="${f2(it.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round"${dashAttr(it)}`;
  if (isLine(it)) {
    let d: string;
    if (it.kind === 'curve' && it.c) d = `M${f2(it.a[0])} ${f2(it.a[1])}Q${f2(it.c[0])} ${f2(it.c[1])} ${f2(it.b[0])} ${f2(it.b[1])}`;
    else d = connectorPoints(it).map((p, i) => `${i ? 'L' : 'M'}${f2(p[0])} ${f2(p[1])}`).join('');
    const ends = arrowEnds(it);
    const tan = arrowTangents(it);
    let heads = '';
    if (ends.start) heads += headSvg(it, tan.start[0], tan.start[1]);
    if (ends.end) heads += headSvg(it, tan.end[0], tan.end[1]);
    return `<path d="${d}" fill="none" ${stroke}/>${heads}`;
  }
  const fill = it.fill ? `fill="${esc(it.fill)}" fill-opacity="${f2(it.fillOpacity)}"` : 'fill="none"';
  const rot = rotAttr(it);
  if (it.kind === 'ellipse') return `<ellipse cx="${f2(it.x + it.w / 2)}" cy="${f2(it.y + it.h / 2)}" rx="${f2(it.w / 2)}" ry="${f2(it.h / 2)}" ${fill} ${stroke}${rot}/>${labelSvg(it)}`;
  if (it.kind === 'roundrect' || it.kind === 'rect') {
    const r = it.kind === 'roundrect' ? Math.min(it.w, it.h) * 0.18 : 0;
    return `<rect x="${f2(it.x)}" y="${f2(it.y)}" width="${f2(it.w)}" height="${f2(it.h)}" rx="${f2(r)}" ${fill} ${stroke}${rot}/>${labelSvg(it)}`;
  }
  const pts = shapeOutline(it).map((p) => `${f2(p[0])},${f2(p[1])}`).join(' ');
  return `<polygon points="${pts}" ${fill} ${stroke}${rot}/>${labelSvg(it)}`;
}

function labelSvg(it: ShapeItem): string {
  const lb = it.label;
  if (!lb?.text) return '';
  const inset = it.kind === 'diamond' ? 0.25 : it.kind === 'ellipse' ? 0.15 : 0.06;
  const L = layoutText({ id: '', type: 'text', x: 0, y: 0, w: it.w * (1 - inset * 2), h: 0, created: 0, text: lb.text, size: lb.size, color: lb.color, font: lb.font ?? 'sans', bold: false, italic: false, align: 'center', autoWidth: false });
  const lh = lb.size * LINE_HEIGHT;
  const top = it.y + (it.h - L.lines.length * lh) / 2;
  const cx = it.x + it.w / 2;
  const spans = L.lines.map((l, i) => `<tspan x="${f2(cx)}" y="${f2(top + i * lh + lb.size * 1.02)}">${esc(l)}</tspan>`).join('');
  return `<text font-family="${esc(fontFamily(lb.font ?? 'sans'))}" font-size="${f2(lb.size)}" fill="${esc(lb.color)}" text-anchor="middle"${rotAttr(it)}>${spans}</text>`;
}

function formulaSvg(it: FormulaItem): string {
  const d = formulaDrawing(it.latex) ?? sourceDrawing(it.latex);
  const box = formulaBoxSize(d, it.size);
  const k = Math.min(it.w / box.w, it.h / box.h);
  const s = it.size * (Number.isFinite(k) && k > 0 ? k : 1);
  const ox = it.x + (it.w - (d.w + FORMULA_PAD * 2) * s) / 2 + FORMULA_PAD * s;
  const oy = it.y + (it.h - (d.h + FORMULA_PAD * 2) * s) / 2 + FORMULA_PAD * s;
  const out: string[] = [`<g${rotAttr(it)}><title>${esc(it.latex)}</title>`];
  for (const r of d.rules) out.push(`<rect x="${f2(ox + r.x * s)}" y="${f2(oy + r.y * s)}" width="${f2(Math.max(r.w * s, 0.3))}" height="${f2(Math.max(r.h * s, 0.3))}" fill="${esc(r.color ?? it.color)}"/>`);
  for (const g of d.glyphs) {
    // MathJax fonts first, then common math fonts for viewers without them
    const fam = `${g.family}, "STIX Two Math", "Cambria Math", "Latin Modern Math", serif`;
    out.push(`<text x="${f2(ox + g.x * s)}" y="${f2(oy + g.y * s)}" font-family="${esc(fam)}" font-size="${f2(g.size * s)}"${g.style !== 'normal' ? ` font-style="${esc(g.style)}"` : ''}${g.weight !== '400' ? ` font-weight="${esc(g.weight)}"` : ''} fill="${esc(g.color ?? it.color)}">${esc(g.t)}</text>`);
  }
  out.push('</g>');
  return out.join('');
}

function mindMapSvg(it: MindMapItem): string {
  const l = mapLayout(it);
  const t = l.theme;
  const out: string[] = [`<g transform="translate(${f2(it.x)} ${f2(it.y)}) scale(${f2(it.scale)}) translate(${f2(-l.bounds.x)} ${f2(-l.bounds.y)})">`];
  for (const e of l.edges) {
    const p = e.pts;
    const d = e.kind === 'curve' ? `M${f2(p[0][0])} ${f2(p[0][1])}C${f2(p[1][0])} ${f2(p[1][1])} ${f2(p[2][0])} ${f2(p[2][1])} ${f2(p[3][0])} ${f2(p[3][1])}` : p.map((q, i) => `${i ? 'L' : 'M'}${f2(q[0])} ${f2(q[1])}`).join('');
    out.push(`<path d="${d}" fill="none" stroke="${esc(e.color)}" stroke-width="${f2(e.width)}" stroke-linecap="round"/>`);
  }
  for (const n of l.nodes) {
    const r = n.shape === 'pill' ? n.h / 2 : Math.min(8, n.h * 0.28);
    if (n.fill || (n.stroke && (n.shape === 'box' || n.shape === 'pill'))) {
      out.push(`<rect x="${f2(n.x)}" y="${f2(n.y)}" width="${f2(n.w)}" height="${f2(n.h)}" rx="${f2(r)}" fill="${n.fill ? esc(n.fill) : 'none'}"${n.stroke ? ` stroke="${esc(n.stroke)}" stroke-width="${n.depth === 0 ? 2 : 1.4}"` : ''}/>`);
    } else if (n.shape === 'underline' && n.stroke) {
      out.push(`<path d="M${f2(n.x)} ${f2(n.y + n.h)}H${f2(n.x + n.w)}" stroke="${esc(n.stroke)}" stroke-width="1.6"/>`);
    }
    const st = n.style;
    const lh = st.size * 1.3;
    const top = n.y + (n.h - n.lines.length * lh) / 2;
    const font = topicFont(st.size, st.weight, t.font);
    const weight = /^(\d+)/.exec(font)?.[1] ?? '400';
    const spans = n.lines.map((line, i) => `<tspan x="${f2(n.x + n.w / 2)}" y="${f2(top + i * lh + st.size)}">${esc(line)}</tspan>`).join('');
    out.push(`<text font-family="${esc(fontFamily(t.font))}" font-size="${st.size}" font-weight="${weight}" fill="${esc(n.textColor)}" text-anchor="middle">${spans}</text>`);
  }
  out.push('</g>');
  return out.join('');
}

function itemSvg(it: Item): string {
  if (it.type === 'shape') return shapeSvg(it);
  if (it.type === 'formula') return formulaSvg(it);
  if (it.type === 'mindmap') return mindMapSvg(it);
  if (it.type === 'image') {
    const src = assetDataUrl(it.src) ?? it.src;
    const href = src.startsWith('data:') ? src : encodeURI(src);
    return `<image href="${esc(href)}" x="${f2(it.x)}" y="${f2(it.y)}" width="${f2(it.w)}" height="${f2(it.h)}" preserveAspectRatio="none"${rotAttr(it)}/>`;
  }
  const L = layoutText(it);
  const lh = it.size * LINE_HEIGHT;
  const anchor = it.align === 'center' ? 'middle' : it.align === 'right' ? 'end' : 'start';
  const x = it.align === 'center' ? it.x + it.w / 2 : it.align === 'right' ? it.x + it.w - TEXT_PAD : it.x + TEXT_PAD;
  const spans = L.lines.map((l, i) => `<tspan x="${f2(x)}" y="${f2(it.y + TEXT_PAD + i * lh + it.size * 1.02)}">${esc(l)}</tspan>`).join('');
  return `<text font-family="${esc(fontFamily(it.font))}" font-size="${f2(it.size)}"${it.bold ? ' font-weight="700"' : ''}${it.italic ? ' font-style="italic"' : ''} fill="${esc(it.color)}" text-anchor="${anchor}"${rotAttr(it)}>${spans}</text>`;
}

function inkD(s: Stroke, cache: GeometryCache): string {
  const sink = new SvgPathSink();
  if (s.dash) emitDashedGeometry(sink, cache.get(s), s.dash, s.params.width);
  else emitGeometry(sink, cache.get(s));
  return sink.toString();
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string);
}

/** Export one page as a standalone SVG document (vector, 1 unit = 1 pt). */
export function pageToSvg(page: Page, cache: GeometryCache, opts: { background?: boolean } = {}): string {
  const w = page.width;
  const h = page.height;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}">`,
  );
  if (opts.background !== false) {
    parts.push(`<rect width="${w}" height="${h}" fill="${esc(page.background.paper)}"/>`);
    const bg = page.background;
    const sp = bg.spacing;
    if (bg.kind === 'ruled') {
      const d: string[] = [];
      for (let y = sp * 3; y < h - sp * 0.5; y += sp) d.push(`M0 ${y.toFixed(2)}H${w}`);
      parts.push(`<path d="${d.join('')}" stroke="${esc(bg.line)}" stroke-width="0.5" fill="none"/>`);
    } else if (bg.kind === 'grid') {
      const d: string[] = [];
      for (let y = sp; y < h; y += sp) d.push(`M0 ${y.toFixed(2)}H${w}`);
      for (let x = sp; x < w; x += sp) d.push(`M${x.toFixed(2)} 0V${h}`);
      parts.push(`<path d="${d.join('')}" stroke="${esc(bg.line)}" stroke-width="0.4" fill="none"/>`);
    } else if (bg.kind === 'dots') {
      const d: string[] = [];
      for (let y = sp; y < h; y += sp) for (let x = sp; x < w; x += sp) d.push(`M${x.toFixed(2)} ${y.toFixed(2)}h0`);
      parts.push(`<path d="${d.join('')}" stroke="${esc(bg.line)}" stroke-width="1" stroke-linecap="round" fill="none"/>`);
    }
  }
  parts.push('<g>');
  for (const it of page.items ?? []) if (it.type !== 'text' && it.type !== 'formula') parts.push(itemSvg(it));
  // highlighters grouped (merged path => no overlap darkening), then ink in z-order
  const groups = new Map<string, string[]>();
  for (const s of page.strokes) {
    if (s.tool !== 'highlighter') continue;
    const key = `${s.color}|${s.params.opacity}`;
    const arr = groups.get(key) ?? [];
    arr.push(inkD(s, cache));
    groups.set(key, arr);
  }
  for (const [key, ds] of groups) {
    const [color, opacity] = key.split('|');
    parts.push(`<path d="${ds.join('')}" fill="${esc(color)}" fill-opacity="${opacity}" fill-rule="nonzero"/>`);
  }
  for (const s of page.strokes) {
    if (s.tool === 'highlighter') continue;
    const d = inkD(s, cache);
    const o = s.tool === 'pencil' ? s.params.opacity * 0.85 : s.params.opacity;
    const op = o < 1 ? ` fill-opacity="${f2(o)}"` : '';
    parts.push(`<path d="${d}" fill="${esc(s.color)}"${op} fill-rule="nonzero"/>`);
  }
  for (const it of page.items ?? []) if (it.type === 'text' || it.type === 'formula') parts.push(itemSvg(it));
  parts.push('</g></svg>');
  return parts.join('\n');
}
