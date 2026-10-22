# AI security and privacy

## What is sent, when

- **Nothing without a user action.** AI is disabled by default. A request happens only after the
  user (1) lasso-selects content, (2) chooses a task, (3) sees the consent dialog with the exact
  image, provider, model and size, and (4) presses *Send*.
- **Only the selection.** The upload is a PNG rendered from the selected strokes / objects alone
  (white background, ≤ 1536 px). Never the `.handnote` file, other pages, other notes, the vault,
  file names, paths, the device id or note metadata. The task prompt is fixed text.
- The *Test connection* button sends one fixed text prompt ("Reply with OK.") and no note content.
- HandNote does not log requests or answers, does not keep the image, and has no telemetry.
  Local usage counters store only request and token counts.

## API keys

| Rule | Implementation |
|---|---|
| Entered via Obsidian's key UI | `SecretComponent` in settings; the user picks / creates a secret |
| Plugin settings store only the secret **name** | `AISettings.secretNames`; the sanitizer drops any other field (an `apiKey` field never survives — unit tested); E2E verifies `data.json` contains the name and not the key |
| Not in `.handnote` files, URLs, logs, errors, Git | key read at request time, sent only as `Authorization: Bearer …`; error messages pass through `redact()`; no query parameters are allowed in endpoints |
| No silent plaintext fallback | on Obsidian < 1.11.4 (no `app.secretStorage` / `SecretComponent`) keyed providers are disabled with a version notice; only the offline mock works |
| No developer key in the plugin | there is none; providers fail with "not configured" until the user adds a key |
| No implicit accounts | HandNote never tries to use a Claude / ChatGPT subscription login or any locally installed AI app |

### What Obsidian's secret storage does and does not guarantee

- Documented: secrets are stored locally, scoped to the vault on desktop, and are not part of the
  vault files (so not synced by Obsidian Sync / Remotely Save / OneDrive with the notes).
- **Observed in testing (Obsidian 1.14.4, Linux, no OS keyring):** Obsidian showed *"Secrets are
  stored without encryption because no secret store is available on this system."* So on systems
  without a keychain/keyring the key can be stored **unencrypted** on disk. On macOS/Windows/iOS the
  behaviour depends on Obsidian's use of the OS store — **not verified** here.
- A community report says that on mobile secrets appear shared across vaults — **not verified**.
- Therefore HandNote does **not** describe secret storage as a hardware vault or end-to-end
  encryption. Recommended: use a dedicated API key with a spending limit set at the provider, and
  revoke it if the device is lost.

## Model output is untrusted

- The answer must be one JSON object; it is size-limited, parsed, and validated field by field
  (`validateScene`). Unknown fields — including colours, URLs, HTML, SVG, scripts, styles — are
  never read. Only whitelisted object types and shape names are accepted.
- Text is painted with canvas `fillText` and stored as plain strings; nothing is inserted as HTML,
  executed, fetched or opened. HandNote never makes a network request suggested by model output
  and never performs file operations based on it. The converted objects affect only the current
  page and only after the user applies the preview.
- **Prompt injection:** the system prompt states that text inside the picture is content to
  transcribe, never instructions. Even if a model followed injected text, the worst outcome is
  wrong text in the preview — the output channel has no capability beyond the scene schema (tested
  with the mock "injection" model: the injected `<script>` text arrives as a plain text object).

## Changing the note

- Default apply mode inserts the result **beside** the selection and keeps the original ink.
- *Replace* deletes the selected ink only after the user ticks the confirmation box.
- Every apply is one undo step; a failed, cancelled or invalid answer changes nothing.
- No batch conversion of existing notes exists.

## Network endpoints

Only the official HTTPS endpoints listed in `AI_PROVIDER_GUIDE.md`, or a custom HTTPS endpoint
the user typed in advanced settings (with a warning). The provider is never switched
automatically (e.g. by IP / region).

## Residual risks

1. A late answer after a timeout/cancel may still be billed by the provider (requests cannot be
   aborted through `requestUrl`).
2. Unencrypted secret storage on systems without an OS keyring (see above).
3. Whatever the user selects is sent to a third party under that provider's terms.
