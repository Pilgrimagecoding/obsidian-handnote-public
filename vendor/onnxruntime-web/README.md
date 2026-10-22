# ONNX Runtime Web 1.24.2 — licence files

`main.js` contains the unmodified files `ort.wasm.bundle.min.mjs` and `ort-wasm-simd-threaded.wasm`
of the npm package `onnxruntime-web@1.24.2` (pinned in `package.json` / `package-lock.json`, checked
against the SHA-256 in `src/local/manifest.ts`; see `scripts/build-embedded-ort.mjs`). The npm
package does not include a licence file, so the two files here are copied unchanged from the
ONNX Runtime repository at tag `v1.24.2` (fetched 2026-10-22):

- `LICENSE` — MIT, Copyright (c) Microsoft Corporation (also embedded in `main.js`)
- `ThirdPartyNotices.txt` — notices for the components ONNX Runtime is built from
  (<https://github.com/microsoft/onnxruntime/blob/v1.24.2/ThirdPartyNotices.txt>)
