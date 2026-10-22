import { AIError, type HttpFn } from '../ai/types';
import { httpError, redact } from '../ai/providers';
import { cleanLatex } from './validate';
import type { InkStrokeIn, MathResult, TextLineResult, TextResult, TextToken } from './types';
import { segmentLines, type StrokeBox } from './ink-analysis';

/**
 * Optional MyScript Cloud engine (bring your own MyScript developer keys).
 *
 * HandNote strokes go to MyScript as they are — x / y / t / p arrays — the same vector input their
 * own iink SDK sends from its capture layer (HTTP "recognize" endpoint of iinkTS 4.x, Apache-2.0,
 * studied for the wire format; this is an independent implementation, no MyScript code is
 * bundled). Nothing is re-rendered to a picture.
 *
 * Request: POST https://<host>/api/v4.0/iink/recognize
 *   headers: applicationKey, hmac (HMAC-SHA512 of the exact body, key = applicationKey + hmacKey),
 *            Accept: application/vnd.myscript.jiix (text) or application/x-latex (math)
 *   body:    { configuration: { lang, text|math, export }, scaleX, scaleY, contentType, strokes }
 *
 * Keys come from Obsidian's secret storage and are only put in headers. MyScript's terms, quota
 * and prices are the user's account terms (see docs/MYSCRIPT_XMIND_RESEARCH.md).
 */

export interface MyScriptConfig {
  host: string;
  applicationKey: string;
  hmacKey?: string;
  /** e.g. zh_CN, en_US */
  lang: string;
  lexicon: string[];
}

/** Page unit → millimetre. HandNote pages are in points (A4 = 595 × 842 units = 210 × 297 mm). */
export const MM_PER_UNIT = 25.4 / 72;
/** Coordinate unit of the request (the iink SDK's own value for screen pixels). */
const SCALE = 0.265;

/** Typical handwriting size the text recognizer sees (mm), and the guide gap around it. */
/**
 * Ruled-line layout of text ink. MyScript's text guides are ON by default with a 10 mm line gap
 * (developer.myscript.com, iink 4.0 configuration reference: "Default line spacing is 10 mm");
 * `line-gap-mm` is documented only for the off-screen recognizer, so a server may ignore it. The
 * layout therefore works with the default: guide lines every 10 mm, the first text band starting
 * at 20 mm (a multiple of 10, below any top margin), each line normalised to ~6.5 mm and placed
 * inside its own band — no guide line can cut through a character, whatever the server's origin.
 */
export const TEXT_LAYOUT = { gapMm: 10, bandStartMm: 20, lineHeightMm: 6.5, maxLineMm: 8, bottomPadMm: 1.2, leftMm: 20, minScale: 0.05, maxScale: 6, pointStepMm: 0.2 };

export interface TextLayout {
  strokes: InkStrokeIn[];
  /** guide gap (mm) */
  gapMm: number;
  lines: number;
  /** page units → mm factor applied to the typical line (size normalisation) */
  mmPerUnit: number;
  /** points sent / points written */
  points: [number, number];
}

/**
 * Text ink as MyScript Notes hands it to the recognizer: written on ruled lines.
 *
 * Without fitting the lines, big Chinese characters whose parts are stacked (召 = 刀 over 口, 岩 =
 * 山 over 石, 哲 = 折 over 口) are cut by a guide line into a "top" and a "bottom" line — a three-character name
 * came back as "刀了山新 / 口！石口" (beta.3) and "} 山新 / 召石口" (beta.4, whose 17 mm line did
 * not fit the server's 10 mm guides). HandNote finds the lines itself (the same local analysis that
 * places the converted text), scales the writing to a typical size and puts line i inside guide
 * band i. Points closer than 0.2 mm are dropped (Apple Pencil samples at 240 Hz; the shape is
 * unchanged, the request is several times smaller).
 */
export function layoutTextInk(strokes: InkStrokeIn[]): TextLayout {
  const L = TEXT_LAYOUT;
  const boxes: StrokeBox[] = [];
  for (const s of strokes) {
    if (!s.xs.length) continue;
    boxes.push({ id: s.id, x0: Math.min(...s.xs), y0: Math.min(...s.ys), x1: Math.max(...s.xs), y1: Math.max(...s.ys) });
  }
  const lines = segmentLines(boxes);
  const total = strokes.reduce((n, s) => n + s.xs.length, 0);
  if (!lines.length) return { strokes: [], gapMm: L.gapMm, lines: 0, mmPerUnit: MM_PER_UNIT, points: [0, total] };
  const hs = lines.map((l) => Math.max(1, l.h)).sort((a, b) => a - b);
  const hMed = hs[Math.floor(hs.length / 2)] * MM_PER_UNIT;
  const k = Math.min(L.maxScale, Math.max(L.minScale, L.lineHeightMm / Math.max(0.3, hMed)));
  const mm = MM_PER_UNIT * k;
  // a line taller than the others is scaled down to stay inside its band
  const lineMm = lines.map((l) => Math.min(mm, L.maxLineMm / Math.max(1, l.h)));
  const lineOf = new Map<string, number>();
  lines.forEach((l, i) => l.strokeIds.forEach((id) => lineOf.set(id, i)));
  const out: InkStrokeIn[] = [];
  let sent = 0;
  // strokes keep their writing order inside the request
  for (const s of strokes) {
    const i = lineOf.get(s.id);
    if (i === undefined) continue;
    const l = lines[i];
    const f = lineMm[i];
    const bottom = L.bandStartMm + (i + 1) * L.gapMm - L.bottomPadMm;
    const xs: number[] = [];
    const ys: number[] = [];
    const ts: number[] = [];
    const ps: number[] = [];
    let lx = Infinity;
    let ly = Infinity;
    for (let q = 0; q < s.xs.length; q++) {
      const x = (s.xs[q] - l.x) * f + L.leftMm;
      const y = bottom - (l.y + l.h - s.ys[q]) * f;
      const last = q === s.xs.length - 1;
      if (!last && xs.length && Math.hypot(x - lx, y - ly) < L.pointStepMm) continue;
      if (last && xs.length > 1 && Math.hypot(x - lx, y - ly) < L.pointStepMm * 0.25) {
        xs.pop();
        ys.pop();
        ts.pop();
        ps.pop();
      }
      xs.push(round2(x / SCALE));
      ys.push(round2(y / SCALE));
      ts.push(s.ts[q]);
      ps.push(s.ps[q]);
      lx = x;
      ly = y;
    }
    sent += xs.length;
    out.push({ ...s, xs, ys, ts, ps });
  }
  return { strokes: out, gapMm: L.gapMm, lines: lines.length, mmPerUnit: mm, points: [sent, total] };
}

/** Stroke in mm-based request units, points closer than `stepMm` dropped (first and last kept). */
export function thin(s: InkStrokeIn, mmPerUnit: number, stepMm: number): InkStrokeIn {
  const xs: number[] = [];
  const ys: number[] = [];
  const ts: number[] = [];
  const ps: number[] = [];
  let lx = Infinity;
  let ly = Infinity;
  const n = s.xs.length;
  for (let q = 0; q < n; q++) {
    const x = s.xs[q] * mmPerUnit;
    const y = s.ys[q] * mmPerUnit;
    if (q > 0 && q < n - 1 && Math.hypot(x - lx, y - ly) < stepMm) continue;
    xs.push(round2(x / SCALE));
    ys.push(round2(y / SCALE));
    ts.push(s.ts[q]);
    ps.push(s.ps[q]);
    lx = x;
    ly = y;
  }
  return { ...s, xs, ys, ts, ps };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function buildMyScriptBody(task: 'text' | 'math', strokes: InkStrokeIn[], cfg: Pick<MyScriptConfig, 'lang' | 'lexicon'>): Record<string, unknown> {
  const configuration: Record<string, unknown> = {
    lang: cfg.lang,
    export: { jiix: { 'bounding-box': false, strokes: false, ids: false, 'full-stroke-ids': false, text: { chars: false, words: true, lines: true } } },
  };
  let ink = strokes;
  if (task === 'text') {
    const lay = layoutTextInk(strokes);
    ink = lay.strokes;
    const text: Record<string, unknown> = {
      // the server default (10 mm) restated; the layout above does not depend on it being honoured
      guides: { enable: true, 'line-gap-mm': lay.gapMm, 'origin-y-mm': 0 },
      margin: { top: 0, left: 0, right: 0, bottom: 0 },
    };
    const words = cfg.lexicon.map((w) => w.trim()).filter((w) => w && w.length <= 60).slice(0, 500);
    if (words.length) text.configuration = { customLexicon: words };
    configuration.text = text;
  } else {
    // math keeps the real size (mm) and layout
    ink = strokes.map((s) => thin(s, MM_PER_UNIT, 0.15));
    configuration.math = { margin: { top: 0, left: 0, right: 0, bottom: 0 } };
  }
  return {
    configuration,
    scaleX: SCALE,
    scaleY: SCALE,
    contentType: task === 'text' ? 'Text' : 'Math',
    strokes: ink.map((s) => ({ id: s.id, pointerType: 'PEN', x: s.xs, y: s.ys, t: s.ts, p: s.ps })),
  };
}

/** HMAC-SHA512 hex of the body, key = applicationKey + hmacKey (WebCrypto: desktop and iPad). */
export async function myscriptHmac(body: string, applicationKey: string, hmacKey: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(applicationKey + hmacKey), { name: 'HMAC', hash: { name: 'SHA-512' } }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** JIIX text → lines; every word keeps its candidates (word-level correction in the preview). */
export function parseJiixText(raw: unknown): TextResult {
  const j = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { label?: string; words?: { label?: string; candidates?: string[] }[] };
  const label = typeof j?.label === 'string' ? j.label : '';
  if (!label.trim()) throw new AIError('empty', 'MyScript recognised no text');
  const lines: TextLineResult[] = [];
  let tokens: TextToken[] = [];
  const flush = () => {
    const text = tokens.map((t) => t.text).join('').trim();
    if (text) {
      // line alternatives: swap the first uncertain words for their next candidate
      const alts: string[] = [];
      tokens.forEach((t, i) => {
        for (const c of t.candidates.slice(0, 2)) {
          if (alts.length >= 3) return;
          const alt = tokens.map((x, k) => (k === i ? c : x.text)).join('').trim();
          if (alt !== text && !alts.includes(alt)) alts.push(alt);
        }
      });
      lines.push({ text, alternatives: alts, tokens: trimTokens(tokens) });
    }
    tokens = [];
  };
  const words = Array.isArray(j.words) ? j.words : [];
  if (!words.length) {
    for (const l of label.split('\n')) if (l.trim()) lines.push({ text: l.trim(), alternatives: [] });
  } else {
    for (const w of words) {
      const l = typeof w?.label === 'string' ? w.label : '';
      if (l === '\n') {
        flush();
        continue;
      }
      const cands = Array.isArray(w?.candidates) ? w.candidates.filter((c): c is string => typeof c === 'string' && c !== l).slice(0, 5) : [];
      tokens.push({ text: l, candidates: l.trim() ? cands : [] });
    }
    flush();
  }
  return { task: 'text', lines: lines.slice(0, 200), warnings: [] };
}

function trimTokens(tokens: TextToken[]): TextToken[] {
  const out = tokens.map((t) => ({ ...t }));
  while (out.length && !out[0].text.trim()) out.shift();
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  return out;
}

export function parseLatexAnswer(raw: unknown): MathResult {
  const latex = cleanLatex(typeof raw === 'string' ? raw : (raw as { latex?: unknown })?.latex);
  if (!latex) throw new AIError('empty', 'MyScript recognised no formula');
  return { task: 'math', latex, alternatives: [], warnings: [] };
}

export async function myscriptRecognize(task: 'text' | 'math', strokes: InkStrokeIn[], cfg: MyScriptConfig, http: HttpFn): Promise<{ result: TextResult | MathResult; bytes: number; netMs: number }> {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(cfg.host)) throw new AIError('not-configured', 'invalid MyScript host');
  const body = JSON.stringify(buildMyScriptBody(task, strokes, cfg));
  const headers: Record<string, string> = {
    Accept: task === 'text' ? 'application/vnd.myscript.jiix' : 'application/x-latex',
    'Content-Type': 'application/json',
    applicationKey: cfg.applicationKey,
  };
  if (cfg.hmacKey) headers.hmac = await myscriptHmac(body, cfg.applicationKey, cfg.hmacKey);
  const tNet = performance.now();
  const res = await http({ url: `https://${cfg.host}/api/v4.0/iink/recognize`, method: 'POST', headers, body });
  const netMs = performance.now() - tNet;
  if (res.status < 200 || res.status >= 300) {
    // MyScript reports bad keys / HMAC as 401 / 403 ("access.not.granted")
    const err = httpError(res);
    throw new AIError(err.code, redact(err.message), err.status);
  }
  try {
    return { result: task === 'text' ? parseJiixText(res.text) : parseLatexAnswer(res.text), bytes: body.length, netMs };
  } catch (e) {
    if (e instanceof AIError) throw e;
    throw new AIError('bad-response', 'MyScript answer could not be read');
  }
}
