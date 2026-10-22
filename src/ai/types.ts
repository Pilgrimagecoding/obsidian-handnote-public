/**
 * AI layer contracts. Nothing here depends on Obsidian; the plugin injects the HTTP function and
 * the API key lookup (SecretStorage), the lab and the tests inject mocks.
 */

export type AITask = 'handwriting' | 'diagram' | 'image-text' | 'mindmap';
export const AI_TASKS: AITask[] = ['handwriting', 'diagram', 'image-text', 'mindmap'];

/** API family of a provider profile. */
export type ProviderType = 'qwen' | 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'mock' | 'hosted';
export type ProviderId = ProviderType;

export interface ModelCapabilities {
  vision: boolean;
  /** Provider documents `response_format: {type: "json_object"}` together with image input. */
  jsonMode: boolean;
  /** Longest image side we send (px). */
  maxImageSide: number;
  maxOutputTokens: number;
}

export interface AIImage {
  mime: 'image/png' | 'image/jpeg';
  /** base64 without the data: prefix */
  base64: string;
  width: number;
  height: number;
}

export interface AIRequest {
  task: AITask;
  image: AIImage;
  /** Random id of this selection (echoed in the scene for traceability). */
  selectionId: string;
  language: 'zh' | 'en';
  /** Recognition task (0.5 convert flow); the mock provider answers in that task's format. */
  recTask?: 'text' | 'math' | 'mindmap' | 'diagram' | 'image-text';
  /** Number of handwriting lines found locally (mock answers with that many lines). */
  lineCount?: number;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderResponse {
  /** Model text (expected to contain one JSON object). Never logged or stored. */
  text: string;
  usage: AIUsage;
  model: string;
}

export type AIErrorCode =
  | 'not-configured'
  | 'unsupported-version'
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'bad-response'
  | 'invalid-scene'
  | 'too-large'
  | 'provider'
  | 'limit'
  | 'empty'
  | 'truncated';

export class AIError extends Error {
  constructor(
    readonly code: AIErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AIError';
  }

  /**
   * Safe to repeat automatically: the provider refused the request before doing (and billing) the
   * work — rate limit or temporary unavailability. Timeouts, network drops after sending, empty or
   * cut-off answers may already have been billed: those are only repeated when the user asks.
   */
  get retryable(): boolean {
    return this.code === 'rate-limit' || (this.code === 'provider' && [502, 503, 504, 529].includes(this.status ?? 0));
  }
}

export interface HttpRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  /** Transport that answered (diagnostics only). */
  via?: string;
}

/** Injected transport (Obsidian: requestUrl with throw:false; tests: a stub). */
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export interface ProviderContext {
  apiKey: string;
  model: string;
  baseUrl: string;
  http: HttpFn;
  /** Upper bound of the answer (tokens). */
  maxOutputTokens?: number;
  /** Ask for a JSON-only answer where the provider documents it. */
  json?: boolean;
}

export interface AIProvider {
  readonly id: ProviderId;
  capabilities(model: string): ModelCapabilities;
  complete(req: AIRequest, system: string, user: string, ctx: ProviderContext): Promise<ProviderResponse>;
  /** Cheap request that checks the key and endpoint (no image). */
  testConnection(ctx: ProviderContext): Promise<void>;
}
