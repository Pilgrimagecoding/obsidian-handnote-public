/** Recognition settings (plugin data.json, inside the AI settings). Never contains keys. */

import { stripControl } from '../utils/text';

/**
 * Convert → Text / Math engine.
 *  auto     — on-device first (0.7): local models when installed (math: private edition only; text: PP-OCRv5),
 *             else the bundled offline Chinese engine for text; remote providers (MyScript,
 *             vision models) only when chosen explicitly (or `visionFallback` for a picture model).
 *  myscript — always MyScript (digital ink, cloud, your keys).
 *  offline  — always the offline Chinese engine (text only, no network).
 *  vision   — a general vision model (picture of the selection) — explicit choice only.
 */
export type EngineChoice = 'auto' | 'myscript' | 'offline' | 'vision';

export interface RecognitionSettings {
  engine: EngineChoice;
  myscriptHost: string;
  /** Secret names (Obsidian secret storage) — never the keys. */
  myscriptAppKeySecret?: string;
  myscriptHmacSecret?: string;
  myscriptLang: string;
  /** User dictionary: names, technical terms (sent as a hint / MyScript custom lexicon). */
  lexicon: string[];
  /** Offline Chinese handwriting engine available (bundled templates; no network). */
  offlineZh: boolean;
  /** Allow a general vision model as a fallback for Convert → Text / Math (off by default). */
  visionFallback: boolean;
  /** Theme of converted mind maps and flowcharts. */
  mapTheme: 'academic' | 'hand' | 'minimal';
  /**
   * Convert → Text / Math with a digital-ink engine:
   *  instant — the result replaces the ink in place right away (MyScript Notes style); tap words
   *            for candidates, "Restore ink" or undo brings the handwriting back;
   *  preview — a dialog shows the result first (0.5 / 0.6.0-beta.3 behaviour).
   */
  convertMode: 'instant' | 'preview';
  /** Instant mode: keep the handwriting and put the result beside it instead of replacing it. */
  keepInk: boolean;
  /**
   * The user chose "don't ask again" for MyScript: the selected strokes (coordinates only) are
   * sent without a confirmation each time. Off until the user turns it on.
   */
  myscriptAlwaysSend: boolean;
  /**
   * Start MyScript text recognition before the user picks Text (needs `myscriptAlwaysSend`):
   *  off   — only after Convert → Text;
   *  menu  — when the Convert menu opens (default; one wasted request if Math / Shapes is picked);
   *  lasso — as soon as handwriting is lassoed (fastest; every lasso with ink costs a request).
   */
  prefetch: 'off' | 'menu' | 'lasso';
}

export const DEFAULT_LEXICON = ['AI', 'Transformer', 'SLAM', 'Visual Servoing', 'Embodied AI', 'LLM', 'ROS', 'PID', 'Kalman', 'Diffusion', '具身智能', '视觉伺服', '强化学习', '神经网络'];

export function defaultRecognitionSettings(): RecognitionSettings {
  return { engine: 'auto', myscriptHost: 'cloud.myscript.com', myscriptLang: 'zh_CN', lexicon: [...DEFAULT_LEXICON], offlineZh: true, visionFallback: false, mapTheme: 'academic', convertMode: 'instant', keepInk: false, myscriptAlwaysSend: false, prefetch: 'menu' };
}

const SECRET_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LANGS = ['zh_CN', 'zh_TW', 'en_US', 'en_GB', 'ja_JP', 'ko_KR', 'de_DE', 'fr_FR'];

export function sanitizeRecognitionSettings(raw: unknown): RecognitionSettings {
  const d = defaultRecognitionSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const out: RecognitionSettings = {
    engine: r.engine === 'vision' || r.engine === 'myscript' || r.engine === 'offline' ? r.engine : 'auto',
    myscriptHost: typeof r.myscriptHost === 'string' && /^[a-z0-9.-]{3,80}$/i.test(r.myscriptHost) ? r.myscriptHost : d.myscriptHost,
    myscriptLang: LANGS.includes(r.myscriptLang as string) ? (r.myscriptLang as string) : d.myscriptLang,
    lexicon: Array.isArray(r.lexicon)
      ? (r.lexicon as unknown[])
          .filter((w): w is string => typeof w === 'string')
          .map((w) => stripControl(w, false).trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 500)
      : d.lexicon,
    offlineZh: r.offlineZh !== false,
    visionFallback: r.visionFallback === true,
    mapTheme: r.mapTheme === 'hand' || r.mapTheme === 'minimal' ? r.mapTheme : 'academic',
    convertMode: r.convertMode === 'preview' ? 'preview' : 'instant',
    keepInk: r.keepInk === true,
    myscriptAlwaysSend: r.myscriptAlwaysSend === true,
    // 0.6.0-beta.4 stored a boolean: true = on lasso
    prefetch: r.prefetch === true || r.prefetch === 'lasso' ? 'lasso' : r.prefetch === 'off' ? 'off' : 'menu',
  };
  if (typeof r.myscriptAppKeySecret === 'string' && SECRET_RE.test(r.myscriptAppKeySecret)) out.myscriptAppKeySecret = r.myscriptAppKeySecret;
  if (typeof r.myscriptHmacSecret === 'string' && SECRET_RE.test(r.myscriptHmacSecret)) out.myscriptHmacSecret = r.myscriptHmacSecret;
  return out;
}

