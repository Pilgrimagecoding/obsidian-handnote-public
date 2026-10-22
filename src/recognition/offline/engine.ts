import { AIError } from '../../ai/types';
import { segmentLines } from '../ink-analysis';
import type { InkStrokeIn, TextLineResult, TextResult } from '../types';
import { hanziSize, recognizeLine, type InkStroke } from './hanzi';

/**
 * Offline Chinese text recognition for the Convert → Text flow: the selected strokes are split into
 * lines (local ink analysis), every line into characters, and each character is matched against
 * the bundled stroke templates. No network, no key, nothing leaves the device.
 *
 * Every character keeps up to 5 candidates for one-tap correction; words of the personal
 * dictionary are preferred when all their characters are among the candidates.
 */

export const OFFLINE_ZH = {
  id: 'offline-zh' as const,
  label: 'HandNote 离线中文识别',
  characters: hanziSize(),
};

const CJK = /^[㐀-鿿豈-﫿]+$/;

function applyLexicon(chars: { text: string; candidates: string[] }[], lexicon: string[]): void {
  const words = lexicon.map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 8 && CJK.test(w));
  for (const w of words) {
    const a = Array.from(w);
    for (let i = 0; i + a.length <= chars.length; i++) {
      let ok = true;
      let changed = 0;
      for (let k = 0; k < a.length && ok; k++) {
        const c = chars[i + k];
        if (c.text === a[k]) continue;
        const pos = c.candidates.indexOf(a[k]);
        if (pos < 0 || pos > 4) ok = false;
        else changed++;
      }
      if (!ok || !changed) continue;
      for (let k = 0; k < a.length; k++) {
        const c = chars[i + k];
        if (c.text === a[k]) continue;
        c.candidates = [c.text, ...c.candidates.filter((x) => x !== a[k])].slice(0, 5);
        c.text = a[k];
      }
    }
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function recognizeOfflineText(ink: InkStrokeIn[], lexicon: string[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<TextResult> {
  const boxes = ink.map((s) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < s.xs.length; i++) {
      x0 = Math.min(x0, s.xs[i]);
      x1 = Math.max(x1, s.xs[i]);
      y0 = Math.min(y0, s.ys[i]);
      y1 = Math.max(y1, s.ys[i]);
    }
    return { id: s.id, x0, y0, x1, y1 };
  });
  const lines = segmentLines(boxes);
  const byId = new Map(ink.map((s, i) => [s.id, { s, order: i }]));
  const out: TextLineResult[] = [];
  for (let li = 0; li < lines.length; li++) {
    if (signal?.aborted) throw new AIError('cancelled', 'cancelled');
    onProgress?.(li, lines.length);
    await tick();
    const l = lines[li];
    const strokes: InkStroke[] = l.strokeIds
      .map((id) => byId.get(id))
      .filter((v): v is { s: InkStrokeIn; order: number } => !!v)
      .map(({ s, order }) => ({ pts: s.xs.map((x, k) => [x, s.ys[k]] as [number, number]), t: (s.ts[0] ?? 0) + order * 1e-3 }));
    let line;
    try {
      line = await recognizeLine(strokes, l.h, signal);
    } catch (e) {
      if (signal?.aborted) throw new AIError('cancelled', 'cancelled');
      throw e;
    }
    const chars = line.map((c) => ({ text: c.candidates[0]?.ch ?? '?', candidates: c.candidates.slice(1, 6).map((x) => x.ch) }));
    applyLexicon(chars, lexicon);
    const text = chars.map((c) => c.text).join('');
    if (text) out.push({ text, alternatives: [], tokens: chars });
  }
  onProgress?.(lines.length, lines.length);
  if (!out.length) throw new AIError('empty', 'no characters recognised');
  return {
    task: 'text',
    lines: out,
    warnings: ['i18n:offlineLimits'],
  };
}
