# Third-party notices

`main.js` contains one third-party program, **ONNX Runtime Web** (MIT, see "Built into main.js"),
and third-party **data** (Chinese stroke templates, Arphic Public License — see "Bundled data"
below). Both licence texts are embedded in `main.js`. Optional packs downloaded on the user's request
are listed under "Downloaded on request". The following MIT-licensed projects were studied; their
ideas (not their code) influenced the design, as recorded in `docs/ARCHITECTURE_DECISION.md`:

| Project | Licence | Influence |
|---|---|---|
| [obsidian-blackboard](https://github.com/jameswolensky/obsidian-blackboard) © 2026 James Wolensky | MIT | Obsidian integration patterns: extension registration, observing `.internal-embed` placeholders, flushing saves on `visibilitychange`/`pagehide`, blurring the editor to keep iPadOS Scribble away |
| [goodnotes-ink](https://github.com/connectedGraph/goodnotes-ink) © 2026 Springingly | MIT | Pressure curve with floor/ceiling; flat-nib projection idea |
| [perfect-freehand](https://github.com/steveruizok/perfect-freehand) © 2021 Stephen Ruiz Ltd | MIT | Filled outlines instead of stroked lines; taper easing |

Published algorithms implemented independently:
- One Euro Filter — G. Casiez, N. Roussel, D. Vogel, *1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems*, CHI 2012.
- Centripetal Catmull-Rom splines — Yuksel, Schaefer, Keyser, *Parameterization and applications of Catmull-Rom curves*, CAD 2011 (Barry–Goldman evaluation).

Development-only dependencies (`esbuild`, `typescript`, `obsidian` type definitions) are not bundled.
GoodNotes is a trademark of Goodnotes Limited. This project is not affiliated with Goodnotes and
contains no Goodnotes code, assets or designs.

## Bundled data (0.6)

| Data | Licence | Where |
|---|---|---|
| Chinese character stroke templates (9,507 characters). Origin: [Make Me a Hanzi](https://github.com/skishore/makemeahanzi) `graphics.txt` (© Shaunak Kishore), derived from the fonts Arphic PL KaitiM GB and Arphic PL UKai; encoded as `mmah.json` by [HanziLookupJS](https://github.com/gugray/HanziLookupJS) (© Gábor Ugray), commit `b21124f` | **Arphic Public License** (full text embedded in `main.js` and in `vendor/hanzi-mmah/LICENSE-APL.txt`) | `vendor/hanzi-mmah/`, converted by `scripts/build-hanzi-data.mjs` into `src/recognition/offline/hanzi-data.generated.ts` (values unchanged; see the modification notice in `vendor/hanzi-mmah/README.md`) |
| Test fixture: stroke medians of 123 characters from Make Me a Hanzi | Arphic Public License | `tests/fixtures/hanzi-medians.json` (tests only, not bundled) |

The offline recogniser (`src/recognition/offline/hanzi.ts`) is HandNote's own implementation. It includes no code from HanziLookup / HanziLookupJS / hanzi_lookup (LGPL).

The MyScript client (`src/recognition/myscript.ts`) is an independent implementation of the HTTP request format, studied in MyScript's open-source [iinkTS](https://github.com/MyScript/iinkTS) (Apache-2.0); no iinkTS code is bundled. MyScript is a trademark of MyScript SAS; HandNote is not affiliated with MyScript.

## Built into main.js (0.8.0-beta.3)

| Component | Licence | How |
|---|---|---|
| ONNX Runtime Web 1.24.2 (`onnxruntime-web`): `ort.wasm.bundle.min.mjs`, `ort-wasm-simd-threaded.wasm` | MIT, © Microsoft Corporation; licence text embedded in `main.js` and in `vendor/onnxruntime-web/LICENSE`. Third-party components of ONNX Runtime: `vendor/onnxruntime-web/ThirdPartyNotices.txt` (copy of [ThirdPartyNotices.txt](https://github.com/microsoft/onnxruntime/blob/v1.24.2/ThirdPartyNotices.txt)) | unmodified files from the npm package, gzip + base64, generated at build time by `scripts/build-embedded-ort.mjs` (checked against the pinned SHA-256); decompressed only when local recognition starts |

## Downloaded on request (0.7, on-device recognition and hand font)

Nothing below is bundled in `main.js` or attached to a release (except the runtime row, which is
only downloaded by builds made with `HN_EMBED_ORT=0`). Each file is downloaded only when
the user presses a Download button (Settings → HandNote → Local recognition, or the offer shown
after a conversion), verified against a pinned SHA-256 and size, and stored in this device's
IndexedDB (`handnote-models`). The files can be deleted from the same settings page.

| Pack | Files | Licence | Source (first mirror tried; others carry identical bytes) | Status |
|---|---|---|---|---|
| Runtime | ONNX Runtime Web 1.24.2: `ort.wasm.bundle.min.mjs`, `ort-wasm-simd-threaded.wasm` | MIT, © Microsoft Corporation | npm package `onnxruntime-web@1.24.2` (npmmirror, jsDelivr, unpkg, Fastly) | Licence OK. **Policy question open:** this is executable code fetched at runtime (see docs/RELEASE_READINESS_AUDIT.md, R2) |
| Chinese text | PP-OCRv5_mobile_rec ONNX (`inference.onnx`), `ppocrv5_dict.txt` | Apache-2.0 (PaddleOCR; model card on Hugging Face: apache-2.0) | Baidu BOS (official PaddleOCR/PaddleX download), Hugging Face `PaddlePaddle/PP-OCRv5_mobile_rec_onnx`, hf-mirror; dictionary from the PaddleOCR repository at a pinned commit | OK |
| English text | en_PP-OCRv5_mobile_rec ONNX, `ppocrv5_en_dict.txt` | Apache-2.0 (PaddleOCR; model card: apache-2.0) | as above (`en_PP-OCRv5_mobile_rec_onnx`) | OK |
| Hand font | Excalifont (7 subsets), Xiaolai (209 subsets), woff2, Excalidraw @ `bee01e3` | SIL Open Font License 1.1 (Excalifont © Excalidraw, based on Virgil; Xiaolai © LXGW 2020; stated in each font's licence field) | npmmirror / jsDelivr / raw.githubusercontent.com / Fastly (`@excalidraw/excalidraw@0.18.0` and the Excalidraw repository) | OK (OFL permits use and redistribution; fonts are used unmodified) |
| Legacy hand font (0.4) | LXGW WenKai Lite Regular (TTF) | SIL Open Font License 1.1 | GitHub release of `lxgw/LxgwWenKai-Lite` v1.522 | OK |

This version contains **no on-device math recognition model** and no download source for one:
Convert → Math offers typing LaTeX, or MyScript with the user's own keys.

HandNote's own code that runs these models (rendering ink to images, CTC decoding, LaTeX repair,
the worker program) is original and MIT-licensed with the rest of the plugin.

Trademarks: MyScript is a trademark of MyScript SAS; Goodnotes of Goodnotes Limited; Xmind of
Xmind Ltd.; Excalidraw of Excalidraw. HandNote is an independent third-party plugin, not affiliated
with or endorsed by any of them or by Obsidian.
