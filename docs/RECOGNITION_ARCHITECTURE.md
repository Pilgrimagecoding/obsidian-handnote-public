# Handwriting recognition architecture (HandNote 0.6)

Labels:

- **VERIFIED**: checked by running code or tests here, or against an official source.
- **INFERRED**: reasoned from public information.
- **UNKNOWN**: no data yet.

## 1. What 0.5 did, and why it does not give a MyScript Notes experience

In 0.5 (`src/recognition/service.ts` at `95386a5`), when no MyScript keys were set, Convert → Text and Math used this pipeline (VERIFIED, code review):

```
lasso strokes → canvas raster (PNG) → general vision LLM (DeepSeek …) → JSON → validate → objects
```

Why this cannot feel like MyScript Notes:

| Problem | Why |
|---|---|
| The strongest signal is thrown away | Stroke order, direction, timing and pen-up / pen-down are lost when ink becomes pixels. Digital-ink recognizers use exactly this information to tell 邵 from 郭 and a fraction bar from a minus sign. |
| Latency | Each conversion is a large-model request: image upload, queueing and token generation. That is seconds, not the sub-second answer an ink recognizer gives. |
| Reliability | Chat endpoints can time out, rate-limit or return empty or invalid JSON. VERIFIED in 0.5 testing and in DeepSeek's documentation. |
| Configuration | The user has to choose a provider, model and API key just to convert handwriting. |
| No real candidates | A chat model gives one guess. It does not produce the word-level candidate lattice that ink recognizers return, so correction means retyping. |

Prompt engineering cannot fix these issues, so 0.6 changes the architecture instead.

## 2. Three technologies, kept separate

| Kind | Input | Used for | In HandNote 0.6 |
|---|---|---|---|
| **Digital-ink recognition** | The strokes themselves: x/y/t(/p) and their order | Convert → Text / Math | MyScript Cloud (BYOK) and the offline Chinese engine |
| Image OCR | Pixels of printed or handwritten text | — | Not used for ink |
| **Vision LLM understanding** | A picture plus a prompt | AI tools: mind map, flowchart, image text | DeepSeek / OpenAI / … (BYOK) |

The engine type travels with every result: `EngineInfo.kind` is `digital-ink`, `vision-llm` or `demo`. The UI names the engine and says what leaves the device.

**Convert → Text / Math never silently falls back to a chat model.** That requires the explicit setting "Allow a general vision model as a fallback" (off by default), or choosing it as the engine. When nothing suitable is available, HandNote explains what is missing and does not show a guess (VERIFIED, browser and E2E tests).

## 3. Can MyScript take HandNote strokes directly? Yes (VERIFIED, source and tests)

The source is iinkTS 4.1.0 (Apache-2.0), `src/client/HTTPClientV2.ts` (commit `dc61755`, 2026-08-25):

- **Request:** `POST https://cloud.myscript.com/api/v4.0/iink/recognize`.
- **Body:** `{configuration:{lang, text|math, export}, scaleX:0.265, scaleY:0.265, contentType:"Text"|"Math", strokes:[{id, pointerType, x[], y[], t[], p[]}]}`.
- **Headers:**
  - `applicationKey`;
  - `hmac` = HMAC-SHA512(body, applicationKey + hmacKey), in hex;
  - `Accept: application/vnd.myscript.jiix` (text) or `application/x-latex` (math).

How the HandNote data maps onto it:

| HandNote | MyScript | Note |
|---|---|---|
| Page units (1 unit = 1 pt; A4 = 595 × 842) | Math: real size, 25.4/72 mm per unit, sent as `scaleX/Y = 0.265` units. Text: normalised, see below | 0.6.0-beta.1 to beta.3 wrongly used 25.4/96, so the ink was sent 25 % too small (fixed in beta.4) |
| `samples[].t` (ms from stroke start), `stroke.created` | `t[]`, monotonic over the selection | `toInkStrokes()` builds one shared time base |
| `samples[].p` (0–1); 0.5 when the device reports no pressure | `p[]` | — |
| Stroke order = `created` order | Order of `strokes[]` | — |

Other points:

- **Text is sent on ruled guide lines (0.6.0-beta.5):**
  - MyScript's text guides are on by default, with a 10 mm line gap. Source: iink 4.0 configuration reference, `text.guides.enable`: "Default line spacing is 10 mm". `line-gap-mm` / `origin-y-mm` are documented only as `recognizer.text.guides.*` for the off-screen recogniser.
  - The user's iPad results fit a server that keeps the 10 mm guides whatever HandNote sends:
    - beta.3, guides "off", real size: "刀了山新 / 口！石口";
    - beta.4, 17.6 mm gap requested, 11 mm line: "} 山新 / 召石口".
    In both, a guide cut each stacked character in half (INFERRED from these two observations).
  - beta.5 finds the lines locally (`segmentLines`) and scales each line to about 6.5 mm (at most 8 mm). Line *i* goes inside the band [20 + 10i, 30 + 10i] mm, so no multiple of 10 mm crosses a character, whether the guides start at 0 or at the top margin (VERIFIED by unit test; real accuracy to be re-measured on the iPad).
  - Points closer than 0.2 mm (text) / 0.15 mm (math) are dropped before sending.
- **Candidates:** JIIX `words[].candidates`. HandNote turns them into tappable word chips.
- **Personal dictionary:** text `configuration.customLexicon`.
- **Languages:** the MyScript text language list includes "Chinese Simplified – China", "Chinese Traditional – Hong Kong" and "… – Taiwan". They are available in cursive and superimposed modes (VERIFIED, developer.myscript.com 4.5 text-languages page). The exact language code `zh_CN` is INFERRED from MyScript's naming scheme. Mixed Chinese/English results are UNKNOWN until measured.
- **iPad WebView compatibility:**
  - Obsidian `requestUrl` bypasses CORS (VERIFIED for other providers in 0.4/0.5).
  - WebCrypto HMAC-SHA512 is available in secure contexts (INFERRED for Obsidian iOS).
  - Real iPad test: UNKNOWN.
- **Reachability:** cloud.myscript.com could not be reached from the development sandbox (egress allowlist). End-to-end MyScript calls are therefore **NOT RUN** here. Use Settings → *Test MyScript connection* or `npm run bench:ink` with your keys.

The MyScript drawing canvas is **not** used. HandNote keeps its own ink engine and uses MyScript only as a recognition backend.

## 4. Engines available in 0.6

| Engine | Text | Math | Network | Configuration | Status |
|---|---|---|---|---|---|
| MyScript Cloud | ✔ many languages, word candidates | ✔ LaTeX | cloud.myscript.com | Your own application key + HMAC key (free developer account) | Implemented. Real calls NOT RUN here (no keys, no network). |
| **HandNote offline Chinese** | ✔ Chinese characters only (9,507), per-character candidates | ✘ | none | none (on by default) | Implemented and measured on synthetic ink (§5) and on the lab's recorded handwriting |
| Vision LLM fallback | ✔ (picture) | ✔ (picture) | provider | AI settings + explicit opt-in | Kept for AI tools; opt-in only for Convert |

**The offline Chinese engine** (`src/recognition/offline/`) is an independent implementation:

- **Templates:** stroke data of 9,507 characters (Make Me a Hanzi, via HanziLookupJS `mmah.json`). Licence: Arphic Public License; the licence text is embedded in `main.js`, and `vendor/hanzi-mmah/README.md` records the provenance and the modification notice. No HanziLookup (LGPL) code is included.
- **Per character:**
  1. Resample, smooth and find corners, which gives sub-strokes (direction, length, centre).
  2. A coarse histogram first pass keeps the closest templates.
  3. A banded sequence alignment against those templates (skips cost by length), plus a common-character prior (GB2312 level).
- **Per line:**
  1. Strokes are grouped into blocks.
  2. A character may combine up to 6 neighbouring blocks (left/right components such as 服 = 月 + 卩 + 又).
  3. The split with the best width-weighted score wins.
  4. Personal-dictionary words are preferred when their characters are among the candidates.
- **Limits** (shown in the preview):
  - Chinese characters only: no Latin letters, digits or punctuation;
  - relies on standard stroke order;
  - weak on joined (cursive) strokes;
  - no math.

## 5. Measured results (no fabricated numbers)

### Offline Chinese, synthetic ink (VERIFIED, cloud Linux, Node 22)

The ink is Make Me a Hanzi stroke medians, densified and perturbed (wobble, noise, slant, aspect, rotation). **This is optimistic**, because the templates come from the same source.

| Test | Top-1 | Top-5 | Time per char |
|---|---|---|---|
| 300 GB2312 level-1 characters, clean | 88.0 % | 98.0 % | ~22 ms |
| Perturbation 0.5 | 87.3 % | 98.3 % | ~22 ms |
| Perturbation 1.0 | 82.3 % | 95.3 % | ~24 ms |
| Perturbation 1.5 | 69.0 % | 86.7 % | ~27 ms |

Lines of random GB2312 level-1 characters (24 lines, 5–9 characters, no language model): character error rate **10.4 %** at perturbation 0.5 and **12.9 %** at 1.0, about 430 ms per line on desktop Node.

On recorded handwriting (the lab's real pen samples of 永, written as 2 lines × 3): CER 0 %, 92 ms (`npm run bench:ink`). This is a tiny sample, so it is not statistically meaningful.

| Item | Status |
|---|---|
| Messy / cursive Chinese, small characters, mixed Chinese–English, real iPad handwriting | **UNKNOWN**: no real samples were available here. Run `npm run bench:ink -- --cases <your cases>` on your own notes. |
| MyScript Chinese accuracy, math structure accuracy, latency | **UNKNOWN** (not reachable from here; see §3) |
| iPad latency | **UNKNOWN**. Desktop numbers above; WebKit JIT is usually of the same order (INFERRED). The engine yields to the UI between characters, so progress and Cancel stay responsive. |
| Old DeepSeek screenshot path vs ink engines | UNKNOWN for DeepSeek (`npm run bench:rec` exists, not run here). The ink engines need no request, consent or key for text. |

## 6. Is fully offline possible?

| Option | Answer |
|---|---|
| A. MyScript Web SDK / Cloud API | Cloud only (REST or WebSocket); needs keys. Free tier of 2,000 requests per month, then $10 per 1,000 (INFERRED, from a staff forum answer about 5 years old). |
| B. MyScript native on-device SDK (iOS) | **Not usable in an Obsidian community plugin.** Plugins run JavaScript inside Obsidian's WebView; they cannot link native frameworks or carry the per-app certificate. |
| C. Open-source offline engines | **Chinese characters: yes, at the basic level** (§4), with permissive-enough data (APL). **Math: no** usable engine that is browser-runnable and permissively licensed was found. For example, Seshat is GPL C++ and has no maintained WASM build; models trained on MathWriting are CC BY-NC-SA. **Cursive Chinese / Latin:** no legally redistributable WASM/ONNX online model of good quality was found. |
| D. iPadOS Scribble | Recognises handwriting **typed into text fields** live. It cannot recognise strokes already stored in a HandNote page: there is no public API for arbitrary stored strokes (VERIFIED, Apple Developer Forums answer by an Apple Frameworks Engineer). Apple Vision's text recognition works on images and is not reachable from a plugin. **This does not solve the request.** |
| Microsoft Azure Ink Recognizer | Retired: its documentation now sits under "previous versions" (INFERRED). |

**Conclusion:**

- Zero-configuration offline recognition **exists in 0.6 for Chinese characters written neatly**.
- High-quality cursive Chinese, mixed text and **math** need MyScript, configured with the user's own keys.
- HandNote does not pretend otherwise.

## 7. Configuration for a public release

| Mode | What the user does | Notes |
|---|---|---|
| 1. No configuration | Nothing | Offline Chinese text recognition, local shapes |
| 2. MyScript (professional) | Free developer account → application key + HMAC key → Settings → Handwriting recognition → *Test MyScript connection* | BYOK. Keys are kept in Obsidian SecretStorage and sent only in headers. A key on the device cannot be hidden from its owner or from plugin code. Your MyScript account terms and quota apply. |
| 3. General vision model | AI settings + explicit opt-in for Convert | For AI tools (mind map, flowchart, image text). Never a requirement for text. |

- **No developer key** is or will be compiled into the plugin.
- A server proxy that signs requests is the only way to offer MyScript without user keys. It would need a backend, per-user quotas and a MyScript commercial agreement, so it is **not built** (out of scope for this round, as requested).

## 8. Where the code is

| Area | Files |
|---|---|
| Stroke adapter | `src/recognition/ink-analysis.ts` (`toInkStrokes`, `segmentLines`) |
| MyScript | `src/recognition/myscript.ts` (body, HMAC, JIIX tokens) |
| Offline engine | `src/recognition/offline/hanzi.ts`, `engine.ts`, `hanzi-data.generated.ts` (built by `npm run data:hanzi`) |
| Routing | `src/recognition/service.ts` (`engineFor`, `testMyScript`) |
| UI | `src/ui/convert-panels.ts` (Convert menu, AI tools menu, engine-missing dialog, token correction), `src/editor/convert-flow.ts` |
| Benchmarks | `npm run bench:ink` (your notes, offline + optional MyScript), `npm run bench:rec` (DeepSeek A/B) |

## 9. Conversion experience (0.6.0-beta.4)

| MyScript Notes behaviour | HandNote 0.6.0-beta.4 | Remaining difference |
|---|---|---|
| Convert replaces ink in place | Default "Instant": the result replaces the ink in one undo step; "Restore ink" in the result bar | — |
| Tap a word for candidates | Dashed word chips in the result bar; a pick is its own undo step | Candidates are shown in the bar, not on the word itself |
| No confirmation | A saved "don't ask again" for MyScript (the user's explicit choice, revocable in Settings) | The first conversion asks once (third-party upload needs the user's consent) |
| Recognition while writing (interactive session) | Connection warm-up on lasso (keyless GET); optional pre-recognition of the selection (uses quota, off by default) | No continuous background recognition while writing: it would upload all ink and spend quota. The WebSocket interactive session is not implemented. |
| Round trip | One REST request to the EU server. User's iPad: 1.7 s (beta.3), 3.2 s total (beta.4, over a VPN). beta.5 starts the text request when the Convert menu opens and shows network / round-trip / size in the result bar | **MyScript Notes recognises on the device (native iink SDK) — no network at all; that is why it is instant.** A community plugin cannot load the native SDK (§6 B), so cloud recognition always pays at least one network round trip. |
