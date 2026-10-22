# Notes for the community-directory review

Short technical answers for reviewers (public edition). Every statement can be checked in the
source; file names are given.

## What the plugin is

HandNote adds handwritten notebook pages (`.handnote` files) for Apple Pencil, touch and mouse,
with a lasso, editable objects and optional handwriting conversion. Plugin ID `handnote`,
`isDesktopOnly: false`, `minAppVersion` 1.11.4 (Obsidian secret storage for optional API keys).

## Build

- `npm ci && npm run build` produces the release `main.js` (the scanner's first command, `build`, is
  the production build). Exact dependency versions come from `package-lock.json`.
- `main.js` is plain esbuild output, not minified or obfuscated. Two parts of it are not HandNote's
  source code: ONNX Runtime Web 1.24.2 (below) and the Chinese stroke-template data (Arphic Public
  License); both carry their licence text inside `main.js`.
- `node scripts/check-release.mjs` rebuilds `main.js` and checks it is byte-identical, that its only
  `require` is `obsidian`, and that it uses no Node / Electron API.

## ONNX Runtime Web inside `main.js`

- The on-device text recognition runs PaddleOCR models with ONNX Runtime Web (WebAssembly, CPU,
  one thread, in a Web Worker). Following the maintainers' advice in Discord `#community-directory`
  (plugins should not download dependencies; bundle the WASM and load it lazily), the runtime is
  **built into `main.js`**: the unmodified files `ort.wasm.bundle.min.mjs` and
  `ort-wasm-simd-threaded.wasm` from the npm package `onnxruntime-web@1.24.2` (pinned in
  `package.json` / `package-lock.json`), gzip + base64, verified against SHA-256 values in
  `src/local/manifest.ts` at build time (`scripts/build-embedded-ort.mjs`).
- They are decompressed only when local recognition starts (`src/local/embedded-runtime.ts`) and run
  in a module Worker created from a blob URL. No other script is loaded from anywhere.
- On iOS / iPadOS before 16.4 (`DecompressionStream` missing) local recognition is switched off with
  a message; nothing is downloaded instead.

## Model files (downloaded on request — disclosed)

| Pack | Size | Source | Licence of the weights |
|---|---|---|---|
| PP-OCRv5 mobile rec (Chinese) + dictionary | 15.8 MB | PaddleOCR official download (Baidu BOS), Hugging Face `PaddlePaddle/PP-OCRv5_mobile_rec_onnx`, hf-mirror; dictionary from the PaddleOCR repository | Apache-2.0 (model card) |
| en_PP-OCRv5 mobile rec (English) + dictionary | 7.5 MB | same, `en_PP-OCRv5_mobile_rec_onnx` | Apache-2.0 (model card) |
| Excalifont + Xiaolai fonts (optional) | ≤ 12.1 MB, per character subset | Excalidraw npm package / repository | SIL OFL 1.1 |

- Data only (ONNX graphs, dictionaries, fonts); no code. Downloaded only after the user presses a
  Download button (or accepts the offer after a conversion), size shown first; never at startup, on
  install or in the background; no automatic updates (a new model only arrives with a new plugin
  version, and the user still presses the button).
- Each file has a pinned size and SHA-256 in `src/local/manifest.ts`; mismatches are discarded.
- Stored in IndexedDB on the device (not in the vault, not synced); deletable in Settings.
- "Import files" accepts the same files from disk (same hash check) for blocked networks.
- Disclosed in README ("On-device recognition and model downloads") and PRIVACY.md.
- **Policy status:** whether on-request model downloads are acceptable has been asked; no official
  answer yet. If they are not, the alternative we can ship is: text recognition only through the
  bundled offline Chinese engine and MyScript, with model packs only through "Import files".
- No handwritten-math model is included or downloaded by this version.

## Network use (all off until the user acts)

Model downloads (above); MyScript with the user's own keys; AI providers with the user's own keys
(OpenAI, Anthropic, Gemini, DeepSeek, Qwen, OpenAI-compatible). Each sends only the selection the
user converts, after a confirmation. Model / font downloads and AI requests use `requestUrl`;
MyScript requests use the browser `fetch` first (as MyScript's own web SDK does; abortable) and fall
back to `requestUrl`; `fetch` is otherwise only used on local `data:` URLs (embedded images). No telemetry, no ads, no
account, no server of HandNote's own. Keys live in Obsidian's secret storage. Full list:
PRIVACY.md.

## Mobile

No Node.js or Electron APIs in `main.js` (checked by `check-release.mjs`); no regular-expression
lookbehind (older iOS); WebAssembly, Web Workers, IndexedDB and `DecompressionStream` are feature-
checked at runtime. Automated tests run in Chromium, WebKit and Obsidian desktop (Linux); the
betas have been used on an iPad (Apple Pencil) and on Windows.

## Files and data safety

Notes are `.handnote` JSON files in the vault (`docs/FILE_FORMAT.md`). Every save checks the file
was not changed by sync since it was read (otherwise a conflict copy is kept); a recovery journal
and backups protect unsaved strokes; damaged or newer-format files open read-only.

## Scanner findings explained (scan of 0.8.0, 2026-10-22)

| Finding | Explanation | Status |
|---|---|---|
| "Creates script elements at runtime" | an in-page fallback for systems without module workers loaded the bundled recognition program from a blob URL (never external code) | **removed in 0.8.1** (Worker only) |
| Blanket `eslint-disable` in `hanzi-data.generated.ts` | generated data module | **removed in 0.8.1**; the file lints clean |
| Runtime base64 decode | the built-in ONNX Runtime files (gzip + base64) and the Chinese stroke table are stored as base64 strings and decoded locally; embedded images use `data:` URLs | by design, no remote data |
| Unrecognized WASM file | `ort-wasm-simd-threaded.wasm` from `onnxruntime-web@1.24.2`, unmodified, SHA-256 pinned (`src/local/manifest.ts`), licence in `vendor/onnxruntime-web/` | by design (built in as the maintainers advised) |
| Network request calls | model / font downloads after the user's click, MyScript and AI providers with the user's own keys (see "Network use") | disclosed in README / PRIVACY |
| `fetch` (4) | MyScript (abortable, falls back to `requestUrl`) and local `data:` URLs | kept |
| `localStorage` | the only read was the app language; **0.8.1 uses `getLanguage()`**; other matches are UI string keys such as `localStorageBlocked` | fixed |
| Clipboard access | copy LaTeX / Markdown / text / images and the self-test report on the user's request | by design |
| main.js > 5 MB | built-in runtime (≈ 4.2 MB); Obsidian Sync Standard does not sync files over 5 MB — stated in README / FAQ | documented |
| `!important`, `document.createElement`, `setTimeout` without `window.`, deprecated `setWarning` / `setDynamicTooltip`, `confirm()` | style / API warnings; `setDestructive` and the settings API are newer than `minAppVersion` 1.11.4 | to be reduced in later versions |
| Release had an extra file / no attestations | `SHA256SUMS.txt` | **0.8.1:** checksums in the release notes, provenance attestations |

## Licences

HandNote's own code: MIT (`LICENSE`). Third-party parts keep their own licences:
`THIRD_PARTY_NOTICES.md`.
