# Privacy

HandNote is an Obsidian plugin that runs on your device. It has **no telemetry**, no analytics, no
accounts and no server of its own. Your notes are `.handnote` files in your vault; HandNote never
uploads them.

The plugin goes online only for the features below, and only after you turn the feature on or press
the button that starts it. Without a network connection, everything except these features keeps
working.

## Network requests

| Feature (off until you use it) | Service | Purpose | What is sent | Cost | Offline |
|---|---|---|---|---|---|
| **On-device recognition: model download** (Settings → HandNote → Local recognition → Download, or the offer after a conversion) | Mirrors carrying identical files: paddle-model-ecology.bj.bcebos.com (Baidu, the official PaddleOCR download), huggingface.co, hf-mirror.com, raw.githubusercontent.com, cdn.jsdelivr.net, fastly.jsdelivr.net, registry.npmmirror.com (unpkg.com only in builds without the built-in runtime) | Download the recognition models and the optional hand font. The size is shown before you start. ONNX Runtime Web is built into the plugin and is never downloaded. | Ordinary file requests: no note content, no identifiers. Short HEAD requests first, to find a mirror that answers. | Free | Recognition, once downloaded, works offline. The download itself needs a connection; files can also be imported from disk. |
| **On-device recognition: converting** | none | Text recognition runs on your device (WebAssembly in a background worker). This version has no on-device math recognition; typing a formula as LaTeX sends nothing either. | nothing | Free | Works offline |
| **MyScript** (only if you choose MyScript as the engine and enter **your own** MyScript keys) | cloud.myscript.com (MyScript SAS) | Handwriting → text / math | The pen strokes (coordinates and timing) of the selection you convert, after a confirmation that you can turn off. Keys are sent in request headers. | MyScript's own terms and pricing apply to your account | Not available offline; nothing is sent |
| **AI tools** (only if you add an AI provider with **your own** API key) | The provider you configure: OpenAI, Anthropic, Google Gemini, DeepSeek, Alibaba Cloud Qwen (DashScope), or an OpenAI-compatible endpoint you enter | Mind map / flowchart from a sketch, picture text, and the optional vision fallback for conversion | A picture of the selection you send, and a short instruction, after a confirmation | The provider's own pricing applies to your account | Not available offline; nothing is sent |
| **Hand font (0.4, optional)** | github.com (LXGW WenKai Lite release) | Optional handwriting-style font | File request only | Free | Previously downloaded font keeps working |

**Model files (on-device recognition):** downloaded only when you press Download (or accept the offer
after a conversion), after the size is shown; checked against a fixed SHA-256; stored in this
device's app storage (IndexedDB), not in the vault and not synced; never updated automatically;
deleted from Settings → Local recognition. Converting with them sends nothing anywhere and works
offline. Sizes and sources: README, "On-device recognition and model downloads".

HandNote does not choose a provider for you, has no keys of its own, and never sends anything
automatically. The default conversion engine is on-device. Selecting MyScript or an AI provider is
a separate opt-in, and a confirmation shows what will be sent.

## What stays on your device

- `.handnote` notes (your vault; synced only by the sync tool you use).
- Settings: `<vault>/.obsidian/plugins/handnote/data.json`. It holds **no keys**, only the names
  under which Obsidian's secret storage keeps them.
- API / MyScript keys: Obsidian's secret storage.
- Recovery journal and backups: `<vault>/.obsidian/plugins/handnote/journal/` and `backups/`, to
  recover unsaved strokes after a crash.
- Recognition models and fonts: this device's browser storage (IndexedDB `handnote-models`). They
  are never in your vault and never synced; you can delete them in Settings.
- Diagnostics (input, performance, local-recognition self-test): shown on screen. They leave the
  device only if you copy them yourself.

## Files outside the vault

HandNote reads and writes only inside your vault (notes, attachments, the plugin folder) and the
app's own browser storage.

Questions: open an issue (see `SECURITY.md` for anything security-related).
