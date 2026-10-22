# Testing

Three automated layers plus the manual iPad protocol.

## v0.8.0-beta.4 (2026-10-22) — public and private editions

Every layer runs in both editions: `npm test` / `npm run test:browser` / `npm run build` are the
public edition (default); `npm run test:private` / `test:browser:private` / `build:private` the
private one. Tests that only make sense in one edition report "NOT APPLICABLE" in the other.

| Layer | Public edition | Private edition |
|---|---|---|
| Typecheck (`tsconfig.json` + `tsconfig.public.json`) | PASS | PASS |
| Unit | **182 / 182** | **182 / 182** |
| Browser (Chromium 141) | **83 / 83** (3 private-only tests not applicable) | **83 / 83** (1 public-only test not applicable) |
| Obsidian E2E + lifecycle | **34 / 34**, **12 / 12** | **34 / 34**, **12 / 12** |
| Edition switch (`tests/obsidian-e2e/edition-switch.mjs`, private repo) | **5 / 5** (private → public → private on one vault) | |
| Release check | PASS (`0.8.0-beta.4-public` candidate) | PASS (`0.8.0-beta.4`) |
| Artifact edition check | 0 markers | all markers + PRIVATE banner |
| Clean public snapshot: `npm ci && npm run build` | identical `main.js`; unit 182 / 182; release check PASS | — |
| ESLint (obsidianmd recommended) | 0 errors, 58 warnings | |

Not run by automation: iPad and Windows devices — checked by hand by the maintainer before each release (2026-10-22: iPad and Windows, both builds).

## v0.7.0-beta.3 (2026-10-21) — English model

| Layer | Result |
|---|---|
| Unit | **171 / 171** (every pack, including English and the 216 font subsets, is pinned) |
| Browser | **70 / 70**. New: script-style English phrases (Hershey data, `tests/fixtures/latin-ink.json`) through zh-only vs zh + en |
| Obsidian E2E | **25 / 25** |

## v0.7.0-beta.2 (2026-10-21) — iPad feedback

| Layer | Result |
|---|---|
| Unit | **171 / 171** (install test now order-independent: downloads run in parallel) |
| Browser | **69 / 69**. New: lasso around "今" of "今天" splits off just that character (undo joins); a loop around the whole box does not split; the colour panel marks the selection's colour; the Excalidraw font pack registers only the subsets in use |
| Obsidian E2E | **25 / 25** |
| English (MOCK, Hershey fonts) | see docs/LOCAL_RECOGNITION.md §9 |

## v0.7.0-beta.1 (2026-10-20, branch `feature/v0.7-local-recognition`) — on-device recognition

| Layer | Result |
|---|---|
| Unit | **171 / 171**. New `tests/unit/v07.test.ts`: pinned packs; install rejects wrong / truncated mirrors and uses the next; tar member; damaged file detected and removed; LaTeX repair; worker program embedded without ORT / `import()`; routing (on device first, MyScript only when chosen) |
| Browser (Chromium 141, WASM worker) | **66 / 66**. New: math pack install + self-test; Chinese text pack (two synthetic lines, candidates); Convert → Math through the install dialog, in place; uncertain → preview with ink kept; Convert → Text with PP-OCRv5. These tests need `local-assets/` (`node scripts/fetch-local-assets.mjs`) and say SKIPPED otherwise |
| Obsidian 1.14.4 E2E | **25 / 25**. New: files imported (hash-checked), module worker, self-test, Convert → Math in place (0.80–0.87 s) |
| Accuracy | MOCK (synthetic ink) only. Real handwriting: NOT RUN. iPad: NOT RUN |

## v0.6.0-beta.4 (2026-10-20) — in-place conversion, MyScript request fix

| Layer | Result |
|---|---|
| Unit | **164 / 164**. New `tests/unit/v06b.test.ts`: points → mm; a stacked three-character phrase written large stays one line on one guide band; two lines → two bands in reading order, size normalised, independent of page position; math real size; new settings defaults |
| Browser | **60 / 60**. New: offline instant conversion (no dialog, candidates on the page, one undo step, Restore ink); keep-ink + writing dismisses the bar; MyScript via the lab's stand-in server (`?msfake=1`: consent once with saved "don't ask again", warm-up GET only on selection, text and math in place, one request per conversion); prefetch reuse |
| Obsidian E2E | **24 / 24**: offline conversion in place, Restore ink |
| Release check | PASS (21) |
| Real MyScript accuracy after the fix | **NOT RUN here** (no network to MyScript). To verify on the iPad: `docs/IPAD_TEST_CHECKLIST.md` |

## v0.6.0-beta.1 (2026-10-20, branch `feature/v0.6-ink-engines`) — recognition architecture correction

| Layer | Result |
|---|---|
| Typecheck | clean |
| Unit | **158 / 158**. New in `tests/unit/v06.test.ts`: sub-stroke description, template table, single characters on synthetic ink (clean ≥ 80 % top-1, perturbed ≥ 65 % top-1, ≥ 85 % top-5), line splitting (明 们 服), offline engine (lines, tokens, dictionary, cancel), JIIX tokens, routing (no silent chat model), settings migration |
| Browser (Chromium 141) | **56 / 56**. New: offline Convert → Text (no consent, candidates, no request), Math without MyScript explains, labelled mind map export menu; menus split into Convert and AI tools |
| Obsidian 1.14.4 E2E | **24 / 24**. New: offline recognition in the real app ("永", no consent, no AI request); Math → engine-missing dialog |
| Release check | PASS (21); `main.js` 1.42 MB |
| Offline engine, synthetic ink (`docs/RECOGNITION_ARCHITECTURE.md` §5) | top-1 88.0 / 87.3 / 82.3 / 69.0 % at perturbation 0 / 0.5 / 1 / 1.5; line CER 10.4 % / 12.9 % |
| Real handwriting | lab pen samples (永 × 6): CER 0 %, 92 ms. The user's own notes: **NOT RUN** (`npm run bench:ink`) |
| MyScript | **NOT RUN**: no keys, and cloud.myscript.com is unreachable from the sandbox |
| iPad | **NOT TESTED** |

## v0.5.0-beta.1 (2026-10-20, branch `feature/v0.5-ink-recognition`) — MyScript × Xmind upgrade

| Layer | Result |
|---|---|
| Typecheck | clean |
| Unit (`npm test`) | **150 / 150**. New in `tests/unit/v05.test.ts`: ink line segmentation, vector ink, validation of untrusted answers (fences, injection, missing edges, depth), prompts carry no coordinates, MyScript body / HMAC (checked against node:crypto) / keys only in headers / error mapping, engine routing, cache and in-flight dedupe, typed errors without automatic retry, DeepSeek request (thinking off, JSON mode, key only in the header), p50/p95, mind map operations and Markdown/Mermaid, no overlap on 240 random layouts, themes with contrast ≥ 4.5, root kept fixed while editing, flowchart layout + Mermaid, text placement on lines, free spot, file format 5 |
| Browser (Chromium 141) | **53 / 53**. New: convert → text / formula / mind map (topic select, add, type, drag re-parent, collapse, delete, undo) / flowchart (attached arrows follow, label edit) / errors (empty → retry only on click, slow → cancel, invalid JSON, injection shown as text, not configured), plus page-drag fixes (touchend-only end, cancel, second finger, stale press) |
| Obsidian 1.14.4 E2E (Linux, Xvfb) | **23 / 23**. New: formulas rendered with Obsidian's MathJax 4.1.3 (glyph + rule snapshot; LaTeX error reported, not thrown); mock mind map + flowchart conversion in the real app; saved as format 5; recognition settings present |
| AI benchmark (mock, 0.4 harness) | 7 / 7 |
| Real DeepSeek A/B (`npm run bench:rec`) | **NOT RUN**: api.deepseek.com is not reachable from the cloud workspace or from the PC's Linux VM. Script checked against a local stub only. |
| iPad | NOT TESTED; see `docs/IPAD_TEST_CHECKLIST.md` |

## v0.4.0-beta.2 (2026-10-20, branch `feature/v0.4-objects-ai`) — fixes from the iPad evaluation

| Layer | Result |
|---|---|
| Typecheck | clean |
| Unit (`npm test`) | **126 / 126** — new: shape corpus (420 seeded realistic strokes: slow, tremor, hooks, gaps), lost-pointerup recovery, Anthropic / Gemini adapters, settings v2 sanitising + beta.1 migration, laser hold clamp |
| Browser (Chromium 141, touch) | **47 / 47** — new: ghost-click (real touchscreen taps on the highlighter-only toggle), lost pen pointerup, idle canvases released, pages sidebar (mixed sizes, mouse drag, long-press touch drag, menu, rotate, copy/paste, export, delete confirm), laser hold-then-fade, finger double tap, shape pen with slow shaky strokes |
| Obsidian 1.14.4 E2E (Linux, Xvfb) | see STATUS (settings scroll position, provider dialog with secret picker) |
| AI benchmark (mock) | 7 / 7 |
| iPad | NOT TESTED — `docs/IPAD_TEST_CHECKLIST.md` |

Shape corpus before → after the fix (same seeds): line 58 % → 100 %, arrow 18 % → 98 %, ellipse 93 % → 97 %.

Note: on this Linux build Obsidian 1.14.4 opened Settings in a separate window; the E2E looks up
dialogs in the settings window's document.

## v0.4.0-beta.1 (2026-10-19, branch `feature/v0.4-objects-ai`)

| Layer | Environment | Result |
|---|---|---|
| Typecheck (strict) | cloud Linux, TS 6.0.3 | **PASS** |
| Unit | Node 22 | **116 / 116** (+27 v0.4: format v4 round-trip / recovery / limits, move-page, dashed geometry, shape pen lines / arcs / polylines / arrows / V heads, quadratic fit, connectors, lasso pick / groups / exact scaling / rotation, local tidy, settings, AI scene validation and limits, AI service with mock and stubbed HTTP — key only in the header, retries, auth no-retry, redaction, timeout, cancel, daily limit — AI settings sanitizer, scene → items) |
| Browser | Chromium 141 headless | **42 / 42** (+12 v0.4: wobbly Pencil tap / no double fire / keyboard click, round swatches under generic button CSS + ring + check + pressed state, step slider snap, dashed ink with gaps, lasso move / undo / copy-paste / group / delete, scale + rotate handles + convert to shapes, curve tool + line style + shape pen line / polyline / V head, page navigator, laser fade without save/undo, embedded image survives reload, AI mock consent → preview → insert / confirmed replace → undo, diagram attach, invalid output changes nothing, not configured → no request) |
| Real Obsidian E2E | Obsidian 1.14.4 desktop (Linux, Xvfb), isolated test vault | **22 / 22** (+4 v0.4: embedded image in file + reopen + PNG export; "New HandNote" in folder and blank-area menus; key in secret storage, data.json holds only the name, settings show the key picker, mock conversion through the real UI; lasso move, page navigator, laser) |
| AI benchmark | `node scripts/ai-benchmark.mjs` (mock) | **7 / 7** robustness cases; 300-object scene validated + converted in ≈ 11 ms |
| Release check | `check-release.mjs 0.4.0-beta.1` | **22 / 22** |
| Real AI providers | — | **NOT RUN** (no authorized key) |
| Windows native | — | **NOT RUN** |
| iPad | — | **NOT TESTED** (`docs/IPAD_TEST_CHECKLIST.md`) |

Observed in E2E: on Linux without an OS keyring Obsidian warns "Secrets are stored without
encryption because no secret store is available on this system" (documented in `docs/AI_SECURITY.md`).

## v0.3.0-beta.2 (2026-10-18) — fixes from the first iPad run of 0.3.0-beta.1

Typecheck PASS · unit 89/89 · browser **30/30** (+ text box near the edge cannot scroll the writing
area and ink lands under the pen; text box re-focused inside touchend; clear page) · real Obsidian
E2E 18/18 · release check 22/22. iPad: the two fixes are **NOT VERIFIED** on the device yet
(no WebKit in this environment; diagnosis from iOS behaviour — see CHANGELOG).

## v0.3.0-beta.1 results (2026-10-18, branch `feature/v0.3-goodnotes-ui`)

| Layer | Environment | Result |
|---|---|---|
| Typecheck (strict) | cloud Linux, TS 6.0.3 | **PASS** |
| Unit | Node 22 | **89 / 89** (+ format v3 items / recovery, history ops, connectors, partial eraser cut + no taper at cut ends, shape recognition, curve 4, settings migration, palette) |
| Browser | Chromium 141 headless | **27 / 27** (two-tier toolbar at 3 iPad sizes, pen panel + mm width slider, colour "+" / dedupe, template A3 landscape, partial eraser, text box create/edit/reload/delete, shapes + attached arrow following a moved shape, shape pen, pencil, image insert + crop + delete) |
| Real Obsidian E2E | Obsidian 1.14.4 desktop (Linux, Xvfb), isolated test vault | **18 / 18** (+ image saved as vault attachment, text + shape saved, reopen, PNG export contains the image) |
| Release check | `check-release.mjs 0.3.0-beta.1` | **22 / 22** |
| Windows native | — | **NOT RUN** |
| iPad | — | **NOT TESTED** (`docs/IPAD_TEST_CHECKLIST.md`) |

Visual review: lab screenshots of every toolbar state, panel and object interaction (zh UI) were
checked during development; Obsidian screenshot `test-output/obsidian-editor.png`.

## v0.2.0-beta.2 results (2026-10-18, branch `feature/v0.2-ipad-input-pressure`)

| Layer | Environment | Result |
|---|---|---|
| Typecheck | cloud Linux, TS 6.0.3 | **PASS** |
| Unit | Node 22 | **80 / 80** (+ beta.1 engine-2 snapshot 12 cases, calibrated-range test on the real iPad distribution, settings migration, calibration, report) |
| Browser | Chromium 141 headless | **21 / 21** (diagnostics test now also clicks *Calibrate from my writing* and checks new strokes store the range) |
| Real Obsidian E2E | Obsidian 1.14.4 desktop (Linux, Xvfb), isolated test vault | **17 / 17** |
| Release check | `check-release.mjs 0.2.0-beta.2` | **22 / 22** |
| Windows native | — | **NOT RUN** |
| iPad | first diagnostics report from beta.1 received (`docs/device-reports/`); beta.2 **NOT TESTED** | |

## First real-device data (0.2.0-beta.1 on iPad, 2026-10-18)

VERIFIED from the user's report: real Pencil pressure (369 distinct values), 240 Hz samples
(interval p50 4.0 ms), 120 Hz frames, scene render avg 1.3 ms, 6 / 4667 dropped frames, finger
contacts 146 px (confirms the v0.1 root cause). UNKNOWN: palm behaviour (0 palm decisions recorded),
subjective feel, GoodNotes comparison.

## v0.2.0-beta.1 results (2026-10-18)

| Layer | Environment | Result |
|---|---|---|
| Typecheck (`tsc --noEmit`, strict) | cloud Linux, TS 6.0.3 | **PASS** |
| Unit (`npm test`) | Node 22 | **74 / 74** (24 input-router, 14 pressure/engine incl. 48 engine-1 snapshot checks, 4 v0.1-file compatibility, …) |
| Browser (`npm run test:browser`) | Chromium 141 headless, synthetic PointerEvents with realistic 52 px finger contacts | **21 / 21** |
| Real Obsidian E2E | Obsidian 1.14.4 desktop (Linux AppImage, Xvfb), isolated test vault | **17 / 17** |
| Release check | `check-release.mjs 0.2.0-beta.1` | **22 / 22** |
| Windows native (`scripts\verify-windows.cmd`) | — | **NOT RUN** for 0.2 (the PC was not reachable from this session); 0.1.0 passed on Windows |
| iPad + Apple Pencil | — | **NOT TESTED** — `docs/IPAD_TEST_CHECKLIST.md` |

Regression proof: the updated browser spec run against the released v0.1 code fails exactly the
reported way — finger pan, pinch and two-finger tap (3 failures) — and passes on v0.2.

Measured (not iPad): Node per-frame processing p95 0.09 ms (engine 1) / 0.04 ms (engine 2);
Chromium processing p95 ≈ 0.1 ms/event, live stroke render p95 ≈ 0.2 ms/frame, full scene render
≈ 6 ms. Pen-to-pixel latency: not measurable from a web view.

---

## v0.1.0 results

| Layer | Command | Environment | Result |
|---|---|---|---|
| Unit | `npm test` | Node 22 (built-in `node:test`) | **32 / 32 pass** |
| Browser integration | `npm run test:browser` | Chromium 141 headless, 1180×820 @2x, synthetic PointerEvents | **11 / 11 pass** |
| Obsidian end-to-end | see below | **Real Obsidian 1.14.4 desktop** (Linux AppImage, Xvfb), isolated test vault | **14 / 14 pass** |
| **Windows native** | `scripts\verify-windows.cmd` | Windows 10.0.26300, Node 20.18.0, npm 11.6.4, TS 6.0.3, esbuild 0.28.2 | install ✓ · typecheck ✓ · **unit 32/32** · build ✓ (byte-identical) · package ✓ · **release check 22/22** · **browser 11/11 (Edge 155)** — 2026-10-18 14:08 |
| iPad + Apple Pencil | `docs/IPAD_MINIMAL_TEST.md` | your iPad | **NOT TESTED — needs you** |

## Unit tests (`tests/unit`)

* **Ink:** pressure mapping (neutral at typical pressure, monotonic, bounded, responsive in the
  light range, soft ceiling); nib multiplier; slow-writing jitter reduction; fast-loop shape
  preservation; sharp corners (横折); final stroke starts/ends exactly at the raw samples;
  **live prefix identical to committed geometry** (no jump on release) and tail reaches the pen tip;
  no lost samples (incl. non-monotonic timestamps); taps become dots; fountain entry/exit taper and
  stable ballpoint width; heavier pressure → thicker; lift-hook trimming; outline/SVG validity;
  mouse input.
* **Document:** sample delta encoding roundtrip; lossless serialize/parse and stable output;
  truncated-file recovery; newer-version read-only; invalid strokes skipped; header peek;
  undo/redo of strokes and pages (z-order preserved, last page protected, redo cleared);
  no duplicate strokes; eraser hit tests incl. fast swipes; SVG export.
* **Storage:** save decisions (own revision / newer / older / other doc / unreadable / deleted /
  empty); external-change decisions; unique conflict-copy names; settings sanitizing.
* **Performance (Node/V8, this machine — not iPad):**

  | Metric | Value |
  |---|---|
  | per-frame processing (4 samples + tail), p95 | 0.09 ms |
  | 4 000-sample stroke geometry | 18–27 ms |
  | dense page, 600 strokes: geometry / serialize / parse | 86 ms / 9 ms / 8 ms |
  | file size for that page | 627 KB |

## Browser integration (`tests/browser/lab.spec.mjs`)

Runs `experiments/ink-lab` (the real editor without Obsidian) and dispatches pen/touch events at
real animation-frame pacing. Covers: ink drawn and committed; **finger never draws** (pans);
**palm resting/dragging during a pen stroke is ignored** (page does not move); undo/redo via API,
buttons and two-finger tap; eraser + undo; **highlighter overlap shows no darkening (Δluminance 0)
and ink stays on top**; persistence across reload (byte-identical) + continued writing;
**live vs committed ink overlap 97 %**; pinch zoom (1.94 → 5.83) without ink; a handwriting sample
(large/small 永, loops, fast circle, ballpoint, highlighter) with screenshots in `test-output/`.

Chromium measurements (synthetic events, not iPad): processing p95 ≈ 0.1 ms/event, live stroke
render p95 ≈ 0.2 ms/frame, full scene render ≈ 6 ms.

Requirements: `npm i -D playwright-core` and Chrome/Edge (Windows uses installed Edge
automatically; elsewhere set `HANDNOTE_CHROME=/path/to/chrome`).

## Obsidian end-to-end (`tests/obsidian-e2e/e2e.mjs`)

Drives a real Obsidian window through the Chrome DevTools Protocol. Steps verified:
plugin load + 7 commands; create note → HandNote view; write with 3 pens → autosave on disk
(7 strokes); eraser/undo/redo; add page; close & reopen → strokes restored, continue writing;
`![[…handnote]]` embed renders in **Reading view and Live Preview**, click opens the editor;
**sync conflict while dirty → conflict copy kept, nothing overwritten**; external change while
clean → in-place reload; SVG/PNG export; plugin disable/enable cycle; background tab releases canvas memory and restores; **crash-journal recovery
modal restores unsaved strokes**.

How to run (never on your real vault):

```bash
npm run build
node scripts/prepare-test-vault.mjs ./test-vault
# start Obsidian on ./test-vault with: Obsidian --remote-debugging-port=9333
#   (Windows: "C:\Users\<you>\AppData\Local\Programs\Obsidian\Obsidian.exe" --remote-debugging-port=9333)
npm i -D playwright-core
node tests/obsidian-e2e/e2e.mjs
```

## What is NOT verified

* Anything about Apple Pencil, iPadOS WebKit, real pressure values, 120 Hz ProMotion, palm
  rejection with a real hand, Scribble, Obsidian mobile gestures, or perceived latency.
* Remotely Save actually uploading `.handnote` (source-reviewed only).
* The Obsidian **app** on Windows (the plugin was built and unit/browser-tested on Windows, but the
  E2E steps ran against the Linux build of Obsidian 1.14.4; the plugin uses no OS-specific APIs).
* End-to-end pen-to-pixel latency (not measurable from inside a web view).
