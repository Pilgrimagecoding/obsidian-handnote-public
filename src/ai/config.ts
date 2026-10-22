import { QWEN_REGIONS } from './providers';
import { defaultRecognitionSettings, sanitizeRecognitionSettings, type RecognitionSettings } from '../recognition/settings';
import type { AITask, ProviderType } from './types';

/**
 * AI configuration (plugin data.json). Structure modelled on how Excalidraw organises its AI
 * settings — named *provider profiles* (type + key + base URL) and named *model entries*
 * (provider profile + model id + optional endpoint + multimodal flag) — with one deliberate
 * difference: a profile never contains an API key, only the *name* of a secret in Obsidian's
 * secret storage. Keys are never written to data.json, notes, logs or URLs.
 */

export interface AIProfile {
  id: string;
  /** Shown in lists ("阿里云百炼", "OpenAI work", …). */
  name: string;
  type: ProviderType;
  /** Name of the secret in Obsidian's secret storage (never the key itself). */
  secretName?: string;
  /** Base URL; empty = the provider's official endpoint. */
  baseUrl?: string;
}

export interface AIModelEntry {
  id: string;
  /** Shown in the model list. */
  name: string;
  profileId: string;
  /** Exact model id sent to the API. */
  model: string;
  /** Optional base URL for this model only (overrides the profile's). */
  endpoint?: string;
  /** Accepts image input. HandNote sends an image of the selection, so it needs this. */
  multimodal: boolean;
}

export interface AIUsageStats {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  failures: number;
}

export interface AIModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

export interface AISettings {
  version: 2;
  enabled: boolean;
  profiles: AIProfile[];
  modelEntries: AIModelEntry[];
  /** Model entry used for every task without its own choice. */
  defaultModel: string;
  /** Optional per-task model entry (handwriting vs. diagrams …). */
  taskModels: Partial<Record<AITask, string>>;
  /** Upper bound of the answer length (tokens). */
  maxOutputTokens: number;
  timeoutSec: number;
  /** Extra attempts after a transient failure (rate limit, network, 5xx). Never unlimited. */
  maxRetries: number;
  /** Requests per day (0 = no limit). A request counter, not a money estimate. */
  dailyLimit: number;
  /** Font of converted handwriting. */
  textFont: 'hand' | 'sans';
  /** Developer console diagnostics (never keys, images or recognised text). */
  verboseLog: boolean;
  usage: AIUsageStats;
  /** Per model entry name, on this device. */
  usageByModel: Record<string, AIModelUsage>;
  /** Handwriting recognition: engine choice, MyScript (optional), user dictionary. */
  recognition: RecognitionSettings;
}

export const PROVIDER_TYPES: ProviderType[] = ['qwen', 'deepseek', 'openai', 'anthropic', 'gemini', 'openai-compatible', 'mock'];

export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  qwen: 'Qwen · 阿里云百炼 (Model Studio)',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic / Claude',
  gemini: 'Google / Gemini',
  'openai-compatible': 'OpenAI-compatible / local',
  mock: 'Mock (offline demo)',
  hosted: 'HandNote hosted (planned)',
};

/** Official base URL per provider type ('' = must be set by the user). */
export const DEFAULT_BASE_URL: Record<ProviderType, string> = {
  qwen: QWEN_REGIONS['cn-beijing'],
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'openai-compatible': '',
  mock: 'mock://local',
  hosted: '',
};

/**
 * Recommended vision models per type. Ids as named in each provider's official documentation
 * (checked 2026-10); not exercised with real keys by the test suite (docs/AI_BENCHMARK.md).
 */
export const SUGGESTED_MODELS: Record<ProviderType, string[]> = {
  qwen: ['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-ocr'],
  deepseek: ['deepseek-flash'],
  openai: ['gpt-5.4-mini', 'gpt-5.4'],
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  'openai-compatible': [],
  mock: ['mock-1', 'mock-invalid', 'mock-error', 'mock-slow', 'mock-injection'],
  hosted: [],
};

/**
 * Default providers. Qwen is no longer a default (0.5: unreliable connections and poor results in
 * the user's tests) — the type stays available ("+ Add provider"), and profiles a user already
 * configured are kept untouched by migration.
 */
export function defaultProfiles(): AIProfile[] {
  return [
    { id: 'deepseek', name: 'DeepSeek', type: 'deepseek', baseUrl: '' },
    { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: '' },
    { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: '' },
    { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: '' },
    { id: 'openai-compatible', name: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: '' },
    { id: 'mock', name: 'Mock (offline demo)', type: 'mock', baseUrl: '' },
  ];
}

export function defaultModelEntries(): AIModelEntry[] {
  return [
    { id: 'deepseek-flash', name: 'deepseek-flash', profileId: 'deepseek', model: 'deepseek-flash', multimodal: true },
    { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini', profileId: 'openai', model: 'gpt-5.4-mini', multimodal: true },
    { id: 'claude-haiku-5-5', name: 'claude-haiku-5-5', profileId: 'anthropic', model: 'claude-haiku-5-5', multimodal: true },
    { id: 'gemini-3.8-flash', name: 'gemini-3.8-flash', profileId: 'gemini', model: 'gemini-3.8-flash', multimodal: true },
    { id: 'mock-1', name: 'mock (offline demo)', profileId: 'mock', model: 'mock-1', multimodal: true },
  ];
}

function emptyUsage(): AIUsageStats {
  return { day: '', requests: 0, inputTokens: 0, outputTokens: 0, totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, failures: 0 };
}

export function defaultAISettings(): AISettings {
  return {
    version: 2,
    enabled: false,
    profiles: defaultProfiles(),
    modelEntries: defaultModelEntries(),
    defaultModel: 'deepseek-flash',
    taskModels: {},
    maxOutputTokens: 4096,
    timeoutSec: 60,
    maxRetries: 0,
    dailyLimit: 100,
    textFont: 'hand',
    verboseLog: false,
    usage: emptyUsage(),
    usageByModel: {},
    recognition: defaultRecognitionSettings(),
  };
}

/** Obsidian secret ids: lowercase letters, digits and dashes. */
export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Model ids as providers document them (also safe inside a URL path). */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isLocalHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/**
 * Accepted base URLs: https:// (no credentials, no query). Plain http:// only to this computer
 * (localhost / 127.0.0.1) and only for "OpenAI-compatible / local" — for a local model server.
 */
export function isAllowedBaseUrl(u: string, type: ProviderType): boolean {
  try {
    const x = new URL(u);
    if (x.username || x.password || x.search || x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && type === 'openai-compatible' && isLocalHost(x.hostname);
  } catch {
    return false;
  }
}

export function isHttpsUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password && !x.search;
  } catch {
    return false;
  }
}

const n = (v: unknown, fb: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fb);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function sanitizeUsage(raw: unknown): AIUsageStats {
  const u = (raw ?? {}) as Partial<AIUsageStats>;
  return {
    day: typeof u.day === 'string' ? u.day.slice(0, 10) : '',
    requests: n(u.requests, 0, 0, 1e9),
    inputTokens: n(u.inputTokens, 0, 0, 1e12),
    outputTokens: n(u.outputTokens, 0, 0, 1e12),
    totalRequests: n(u.totalRequests, 0, 0, 1e9),
    totalInputTokens: n(u.totalInputTokens, 0, 0, 1e12),
    totalOutputTokens: n(u.totalOutputTokens, 0, 0, 1e12),
    failures: n(u.failures, 0, 0, 1e9),
  };
}

/**
 * Validate settings read from data.json. Anything that looks like a key in a wrong place is
 * dropped (a profile keeps only a secret *name*). v1 settings (single provider) are migrated.
 */
export function sanitizeAISettings(raw: unknown): AISettings {
  const d = defaultAISettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  if (r.version !== 2) return migrateV1(r);
  const profiles: AIProfile[] = [];
  for (const p of Array.isArray(r.profiles) ? (r.profiles as Record<string, unknown>[]) : []) {
    if (!p || typeof p !== 'object') continue;
    const type = p.type as ProviderType;
    const id = str(p.id, 64);
    if (!PROVIDER_TYPES.includes(type) || !ID_RE.test(id) || profiles.some((x) => x.id === id)) continue;
    const prof: AIProfile = { id, name: str(p.name, 60) || id, type };
    const sn = str(p.secretName, 64);
    if (SECRET_NAME_RE.test(sn)) prof.secretName = sn;
    const bu = str(p.baseUrl, 300);
    prof.baseUrl = bu && isAllowedBaseUrl(bu, type) ? bu : '';
    profiles.push(prof);
    if (profiles.length >= 40) break;
  }
  const modelEntries: AIModelEntry[] = [];
  for (const m of Array.isArray(r.modelEntries) ? (r.modelEntries as Record<string, unknown>[]) : []) {
    if (!m || typeof m !== 'object') continue;
    const id = str(m.id, 64);
    const model = str(m.model, 80);
    const profileId = str(m.profileId, 64);
    if (!ID_RE.test(id) || !MODEL_ID_RE.test(model) || modelEntries.some((x) => x.id === id)) continue;
    const prof = profiles.find((p) => p.id === profileId);
    if (!prof) continue;
    const e: AIModelEntry = { id, name: str(m.name, 60) || model, profileId, model, multimodal: m.multimodal !== false };
    const ep = str(m.endpoint, 300);
    if (ep && isAllowedBaseUrl(ep, prof.type)) e.endpoint = ep;
    modelEntries.push(e);
    if (modelEntries.length >= 80) break;
  }
  const has = (id: unknown) => typeof id === 'string' && modelEntries.some((m) => m.id === id);
  const taskModels: AISettings['taskModels'] = {};
  const tm = (r.taskModels ?? {}) as Record<string, unknown>;
  for (const t of ['handwriting', 'diagram', 'image-text', 'mindmap'] as AITask[]) if (has(tm[t])) taskModels[t] = tm[t] as string;
  const usageByModel: AISettings['usageByModel'] = {};
  const ub = (r.usageByModel ?? {}) as Record<string, Partial<AIModelUsage>>;
  for (const k of Object.keys(ub).slice(0, 100)) {
    const u = ub[k] ?? {};
    usageByModel[k.slice(0, 60)] = { requests: n(u.requests, 0, 0, 1e9), inputTokens: n(u.inputTokens, 0, 0, 1e12), outputTokens: n(u.outputTokens, 0, 0, 1e12), failures: n(u.failures, 0, 0, 1e9) };
  }
  return {
    version: 2,
    enabled: r.enabled === true,
    profiles,
    modelEntries,
    defaultModel: has(r.defaultModel) ? (r.defaultModel as string) : (modelEntries[0]?.id ?? ''),
    taskModels,
    maxOutputTokens: n(r.maxOutputTokens, d.maxOutputTokens, 256, 32000),
    timeoutSec: n(r.timeoutSec, d.timeoutSec, 10, 300),
    maxRetries: n(r.maxRetries, d.maxRetries, 0, 2),
    dailyLimit: n(r.dailyLimit, d.dailyLimit, 0, 10000),
    textFont: r.textFont === 'sans' ? 'sans' : 'hand',
    verboseLog: r.verboseLog === true,
    usage: sanitizeUsage(r.usage),
    usageByModel,
    recognition: sanitizeRecognitionSettings(r.recognition),
  };
}

/** v0.4.0-beta.1 settings: one active provider, secret names / URLs per provider, per-task models. */
function migrateV1(r: Record<string, unknown>): AISettings {
  const s = defaultAISettings();
  s.enabled = r.enabled === true;
  s.timeoutSec = n(r.timeoutSec, s.timeoutSec, 10, 300);
  s.maxRetries = n(r.maxRetries, s.maxRetries, 0, 2);
  s.dailyLimit = n(r.dailyLimit, s.dailyLimit, 0, 10000);
  s.textFont = r.textFont === 'sans' ? 'sans' : 'hand';
  s.usage = sanitizeUsage(r.usage);
  const names = (r.secretNames ?? {}) as Record<string, unknown>;
  const urls = (r.customBaseUrl ?? {}) as Record<string, unknown>;
  // Qwen is no longer a default, but a user who had set it up keeps it
  if (names.qwen || r.provider === 'qwen' || urls.qwen) {
    s.profiles.unshift({ id: 'qwen', name: '阿里云百炼 Qwen (中国内地)', type: 'qwen', baseUrl: '' }, { id: 'qwen-intl', name: 'Qwen (International)', type: 'qwen', baseUrl: QWEN_REGIONS['intl-singapore'] });
    s.modelEntries.unshift(
      { id: 'qwen3-vl-plus', name: 'qwen3-vl-plus', profileId: 'qwen', model: 'qwen3-vl-plus', multimodal: true },
      { id: 'qwen3-vl-plus-intl', name: 'qwen3-vl-plus (Intl)', profileId: 'qwen-intl', model: 'qwen3-vl-plus', multimodal: true },
    );
  }
  for (const p of s.profiles) {
    const key = p.type === 'qwen' ? 'qwen' : p.type;
    const sn = str(names[key], 64);
    if ((p.type === 'qwen' || p.type === 'deepseek' || p.type === 'openai') && SECRET_NAME_RE.test(sn)) p.secretName = sn;
    const u = str(urls[key], 300);
    if (p.id !== 'qwen-intl' && u && isHttpsUrl(u) && (p.type === 'deepseek' || p.type === 'openai' || p.id === 'qwen')) p.baseUrl = u;
  }
  const provider = typeof r.provider === 'string' ? r.provider : '';
  const profileId = provider === 'qwen' ? (r.qwenRegion === 'intl-singapore' ? 'qwen-intl' : 'qwen') : provider === 'hosted' || !provider ? 'deepseek' : provider;
  const base = s.modelEntries.find((m) => m.profileId === profileId);
  if (base) s.defaultModel = base.id;
  // per-task overrides become their own model entries
  const models = (r.models ?? {}) as Record<string, unknown>;
  for (const t of ['handwriting', 'diagram', 'image-text', 'mindmap'] as AITask[]) {
    const m = str(models[t], 80);
    if (!m || !MODEL_ID_RE.test(m) || !s.profiles.some((p) => p.id === profileId)) continue;
    let e = s.modelEntries.find((x) => x.profileId === profileId && x.model === m);
    if (!e) {
      e = { id: `${profileId}-${m}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64), name: m, profileId, model: m, multimodal: true };
      if (!s.modelEntries.some((x) => x.id === e!.id)) s.modelEntries.push(e);
    }
    s.taskModels[t] = e.id;
  }
  return s;
}

export function newEntityId(prefix: string, taken: { id: string }[]): string {
  for (let i = 0; i < 1000; i++) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.some((x) => x.id === id)) return id;
  }
  return `${prefix}-${Date.now()}`;
}
