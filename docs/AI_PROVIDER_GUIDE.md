# AI provider guide (BYOK)

Settings are organised like Excalidraw's AI settings: **provider profiles** (which service, which
API key, which address) and **model entries** (which model of which profile). Unlike Excalidraw,
HandNote never stores the key in the plugin's `data.json`: a profile only remembers the *name* of
a secret in Obsidian's secret storage (Obsidian **1.11.4+**). The key is read at request time and
sent only in a header (`Authorization: Bearer`, `x-api-key` or `x-goog-api-key`) — never in a URL,
log line, error message or note.

> Model ids are those named in each provider's official documentation (checked 2026-10-19).
> **None has been called with a real key by the HandNote test suite**; real quality, latency and
> cost are **UNKNOWN** — see `AI_BENCHMARK.md`.

## Setup

1. Settings → HandNote → **AI 智能整理** → *启用 AI 功能*.
2. **定义可用的提供商**: tap ✎ on a provider (e.g. 阿里云百炼 Qwen) → *API key*: pick or create a
   secret → (Qwen) choose the region where the key was created → *Test* → OK. The row then shows
   “API: 已配置”.
3. **识别模型**: choose the model entry to use (default `qwen3-vl-plus`). ✎ edits it, ⊕ adds one
   (provider, model id, optional endpoint, *multimodal* — HandNote needs image input), 🗑 removes,
   ↺ restores the defaults. Optional: a different model per task (handwriting / diagram / image
   text / mind map).
4. *Test connection* (one tiny text request, no note content).
5. In a note: lasso → floating bar ✨ → task → check what is uploaded → *Send* → preview → apply.

## Provider types

| Type | Default address | Request | Default model |
|---|---|---|---|
| Qwen · 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` (Intl: `dashscope-intl…`) | OpenAI-compatible Chat Completions, `image_url` data URL, JSON by prompt | `qwen3-vl-plus` |
| DeepSeek | `https://api.deepseek.com` | Chat Completions, `image_url` (documented for `deepseek-flash`) | `deepseek-flash` |
| OpenAI | `https://api.openai.com/v1` | Chat Completions, `response_format: json_object`, `max_completion_tokens` | `gpt-5.4-mini` |
| Anthropic / Claude | `https://api.anthropic.com` | Messages API `/v1/messages`, base64 image block, `anthropic-version: 2023-06-01` | `claude-haiku-5-5` |
| Google / Gemini | `https://generativelanguage.googleapis.com` | `/v1beta/models/{model}:generateContent`, `inline_data`, `responseMimeType: application/json` | `gemini-3.8-flash` |
| OpenAI-compatible / local | (must be set) | Chat Completions; `http://` allowed only for `localhost` / `127.0.0.1` | — |
| Mock | offline | deterministic sample scenes, no network | `mock-1` |

Addresses: `https://` only (no credentials, no query); the selection image and your key go to that
address — use only services you trust. Qwen workspace URLs
(`https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`) can be entered as a custom
address.

## Usage and costs

Every recognition is one request with one image of the selection and a JSON answer limited by
*回复 Token 上限* (default 4096). *AI 用量* lists requests and the token counts the provider
reported, per model, on this device. HandNote does **not** estimate money; your provider's bill is
authoritative. *每日请求上限* caps requests per day (default 100). Retries: 0–2, only for rate
limits, network and server errors.

## Verbose log

Off by default. When on, request diagnostics go to the developer console: task, provider type,
model, host, image size, duration, token counts, error code. Never the key, the image, prompts or
recognised text.

## Migration

0.4.0-beta.1 settings (one active provider, secret names per provider, per-task model ids) are
converted on load: secrets and custom URLs go to the matching profiles, the active provider's model
becomes the default model, per-task ids become model entries.
