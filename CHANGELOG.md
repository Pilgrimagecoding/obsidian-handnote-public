# Changelog

## 0.8.1 — 2026-10-22

After the first community-directory scan (no change to writing, notes or recognition results):

- Local recognition runs only in a Web Worker; the in-page fallback that injected a module script
  is removed.
- Generated stroke-data module: no blanket `eslint-disable` comment.
- Interface language from Obsidian's `getLanguage()` instead of reading `localStorage`.
- Releases: build-provenance attestations (public repository); checksums in the release notes, so
  only the three installable files are attached.
- README / FAQ: `main.js` size and Obsidian Sync's Standard plan.

## 0.8.0 — 2026-10-22 (first public release)

First public release, built from the same sources as 0.8.0-beta.4 (public edition). Summary of
what HandNote does: `docs/release-notes/0.8.0.md`.

- Licence: MIT, Copyright (c) 2026 Yanzhe Shao (the author's name replaces "Obsidian HandNote
  contributors"); `manifest.json` names the author and links the GitHub profile.
- No functional change from 0.8.0-beta.4-public.

## 0.8.0-beta.4 — 2026-10-22 (release candidate for 0.8.0; public and private editions)

- **Two editions, separated at build time.** The **public edition** (the default build, and the
  only one a public source tree can build) contains **no on-device math recognition**: no model
  weights, no download source or hashes for them, no inference code. The math model's licence is
  still unclear (the authors have been asked). The **private edition** (maintainer's own test
  builds, private repository only) keeps it unchanged. A check of every built `main.js` and of the
  public source snapshot fails if the math model ever ends up in the public edition.
- Public edition: **Convert → Math** explains that the model is not included and opens the LaTeX
  editor ("Type LaTeX": live preview; keep the ink beside the formula or replace it; one undo
  step). MyScript (your own keys) still recognises math. Chinese / English text recognition and
  the built-in ONNX Runtime are unchanged.
- Notes are the same in both editions: formulas made with either build open, edit, move, resize,
  copy and export in the other. Model files a private build left on a device are neither used nor
  deleted by the public edition.
- Which build is installed: the plugin version (`0.8.0-beta.4` = private beta, `0.8.0-beta.4-public`
  = public candidate) and the first line of the local-recognition self-test ("Edition").
- Licences: the Arphic Public License text of the bundled Chinese stroke data is now inside
  `main.js` (it was missing). `onnxruntime-web` is a pinned dev dependency (`package-lock.json`), so
  `npm ci && npm run build` reproduces `main.js` without other downloads.
- Test data: personal sample text replaced by neutral words.

## 0.8.0-beta.3 — 2026-10-22 (release candidate for 0.8.0; private beta)

- **ONNX Runtime is built into the plugin; it is never downloaded.** Obsidian's maintainers advised
  that plugins should not install dependencies and that bundling the WASM (loaded lazily) is
  preferred. The runtime (ONNX Runtime Web 1.24.2, the same files as before, checked against the same
  SHA-256) is now inside `main.js`, compressed, and decompressed only when local recognition
  starts. `main.js` grows by about 4.2 MB; users of local recognition download about 8 MB less in
  total. Tested as the experimental build 0.8.0-wasm.1 on the iPad and in Windows: no difference
  in writing or recognition.
- **Older iPadOS / iOS (before 16.4):** local recognition is switched off with a clear message
  ("needs iPadOS 16.4 or newer"); nothing is downloaded instead. MyScript keeps working.
- Model packs (Chinese, English, math, hand font) are still downloaded on request, as before. They
  stay on the device when HandNote is reinstalled (no new download).
- Settings and FAQ: the runtime row says "built into the plugin"; how to free the model storage
  before uninstalling.

## 0.8.0-beta.2 — 2026-10-21 (release candidate for 0.8.0; private beta)

- **Layout fix: "Change template" and the Convert menu no longer overlap.** Obsidian gives every
  button a fixed height; the paper previews in "Change template" and the two-line rows of the
  Convert menu were taller and spilled over the headings around them (on Windows clearly, on the
  iPad slightly). The buttons now grow with their content.
- Test: an Obsidian E2E step opens every HandNote popover in English and Chinese and checks that
  nothing spills out of a button and no blocks overlap.

## 0.8.0-beta.1 — 2026-10-21 (release candidate for 0.8.0; private beta)

- **Data safety: closing a note while it is being converted keeps the ink.** Before, a conversion
  that finished after the note was closed (or HandNote was disabled) replaced the ink in the closed
  note, where it could no longer be undone or restored. Now the running recognition is cancelled
  and its result is discarded.
- Tests: the Linux Obsidian crash seen in the audit (R16) was caused by the test tool, not by
  HandNote; the end-to-end suite runs in one session again, plus a new lifecycle suite.
- FAQ: how to back up and export notes.

## 0.7.0-beta.9 — 2026-10-21 (release-readiness audit; device-acceptance build)

This beta is for testing on your own devices; it is not a public release. See
`docs/PRODUCTION_READINESS_REPORT.md`.

- **Data safety: damaged notes are never overwritten.**
  - A damaged (for example truncated) note opens **read-only**, with a banner and "Save recovered
    copy", which writes `name (recovered <date>).handnote`.
  - Before, the recovered part opened editable, and the first save replaced the damaged file.
  - A damaged version arriving by sync no longer replaces the open note. The next save keeps it as
    a conflict copy.
- **Fault-injection tests in real Obsidian.** They run in a fresh session:
  - damaged file;
  - failing write ("disk full"): the file stays intact, the strokes stay in memory and in the
    journal, and the next save succeeds;
  - newer-format file;
  - damaged sync delivery;
  - 12+ open notes.
- **Minimum Obsidian version is now 1.11.4.** The settings use `Setting.addComponent` and the secret
  storage of 1.11.4.
- **Official ESLint rules** (eslint-plugin-obsidianmd, recommended):
  - run in CI on every push (`.github/workflows/audit.yml`), together with npm audit (0
    vulnerabilities);
  - errors went from 196 to 0. The remaining warnings are listed in
    `docs/RELEASE_READINESS_AUDIT.md`.
  - What changed:
    - the ONNX Runtime surface used by the worker is typed;
    - rejections are Error objects;
    - no control-character regular expressions;
    - static inline styles moved into CSS classes;
    - no `globalThis`;
    - async callbacks are wrapped.
- **Manifest description** follows the directory rules.
- **Release check:**
  - stable tags must be `x.y.z`;
  - `package-lock.json` and the description are checked;
  - every release gets `SHA256SUMS.txt`.
- **Documentation:**
  - new English README and Chinese README;
  - PRIVACY (every network request);
  - SECURITY, CONTRIBUTING, FAQ;
  - issue templates;
  - third-party notices for every downloadable pack;
  - audit reports: readiness, security and privacy, public-repository options, maintenance plan,
    device acceptance.

## 0.7.0-beta.8 — 2026-10-21

- **Fix: writing was choppy and strokes were cut on the iPad (regression in 0.7.0-beta.7).**
  - beta.7 added a "lost touch" self-heal: when a touchend or touchcancel reported no touches
    left, every open contact was closed, the pen included.
  - iPadOS sends touchcancel for the Apple Pencil's touch sequence while its pointer events go
    on. Every stroke was therefore ended after a few samples, and the rest of it was dropped.
    Each cut also cost a commit and a full redraw, which made writing choppy.
  - Reproduced in Chromium by dispatching a touchcancel mid-stroke: each 62-sample stroke kept 5
    samples, with a long task (53–175 ms) on nearly every stroke.
  - Now the self-heal ends only finger contacts that have been silent for 250 ms, never the pen.
    A pen whose pointerup is really lost is still ended by the existing 4 s stale-pen rule.
  - The same Chromium run now keeps all 62 samples per stroke, at 0.49–0.54 ms per event (beta.4
    measured 0.50–0.55).
- **A hand touch on a text while writing no longer opens the keyboard.** For 1.2 s after an ink
  stroke, a touch on text is not treated as a tap. A deliberate finger tap later still opens the
  text.
- Tests: unit 174/174, browser 80/80 (1 new regression test: touchcancel / touchend during Pencil
  strokes, and a hand touch on text while writing).

## 0.7.0-beta.7 — 2026-10-21 (writing regression: use 0.7.0-beta.8)

iPad feedback on beta.6.

- **Converted text matches the handwriting.**
  - The font size now comes from each line's width as written. Before, it came from the line's
    height alone, which made English handwriting ("Today is Saturday") come out half again as
    wide as the ink.
  - The size stays within 0.5–1.3× of what the height suggests.
  - The text starts where the ink starts and sits on it.
- **The converted text stays selected.**
  - After Convert → Text or Math, the result is selected with the lasso loop as its outline, so
    it can be dragged right away.
  - A tap on the selected text or formula opens it for editing.
- **Grouped text pieces are edited as one text.**
  - Example: lasso "Sa" out of "Today is Saturday", put it back, then group the sentence. A tap
    with the text tool (or a finger, or the lasso) now edits "Today is Saturday", not just "Sa".
  - The pieces are joined in reading order, with spaces put back where the pieces had a gap.
  - Left unchanged, the pieces stay as they were. Changed, they become one text box in the same
    group, in one undo step.
- **Page freezes.**
  - **requestAnimationFrame watchdog.** The editor drew only from requestAnimationFrame, and the
    iPad web view sometimes stops firing it until the page is scrolled. Now a frame that is more
    than 150 ms late runs from a timer. The lasso loop has the same fallback.
  - The diagnostics report counts these as "rAF stalls".
  - **Lost touch self-heal.** When the last finger or Pencil leaves the screen (touchend or
    touchcancel with no touches left), contacts whose pointerup never arrived are closed. Before,
    such a contact made the page ignore input. Pen ink is committed; a touch ends without a tap.
  - The diagnostics report counts these as "lifted".
- Tests:
  - unit 174/174;
  - browser 79/79, of which 4 are new: the exact "Sa" scenario, the result selected and dragged,
    the freeze self-heal with a stalled requestAnimationFrame, and English handwriting converted
    on the device with the hand font, checked for width and position.

## 0.7.0-beta.6 — 2026-10-21

- **Release-only version, no code changes.** It carries everything in 0.7.0-beta.5: the MyScript
  Notes–style lasso, converted text as one unit, and finger tap to edit.
- **Why a new version.** The `0.7.0-beta.5` tag was pushed on commit `7ab831f`, whose manifest
  says `0.7.0-beta.3`. The release check failed, so no beta.5 Release exists. That tag is left
  untouched; this version is released from the correct commit.

## 0.7.0-beta.5 — 2026-10-21 (not released: its tag points at the beta.3 commit)

iPad feedback on beta.4 (lasso and converted text).

- **The lasso looks and feels like MyScript Notes / GoodNotes.**
  - The loop is drawn as a smooth dashed line that follows the pen. Every coalesced pen sample is
    used, and the line is drawn as curves rather than straight segments.
  - The loop is drawn with SVG instead of a full-screen canvas, so no bitmap is allocated for
    every loop.
  - After the loop closes, it stays as the selection's outline and moves with the selection. The
    big dashed rectangle is gone.
  - The resize and rotate handles sit on the picked content itself. For text that means the
    letters, not the text box with its padding. Lassoing the "m" of "me" no longer shows a box
    reaching over the "e".
  - An auto-width text box is now exactly as wide as its text: the minimum of two characters'
    width now applies to empty boxes only.
- **Lassoing part of a text no longer cuts it up by itself.**
  - The picked characters are selected as a preview. The text box is split only when something
    is done with them (move, colour, delete, group…), and the split is part of that action's
    single undo step.
  - Lassoing and letting go changes nothing. Before, every partial loop left the text in pieces,
    which is why the text tool later picked single words.
  - Partial selection also works in multi-line text boxes.
- **Converted text is one unit.**
  - Convert → Text makes one text box with one line per handwritten line, instead of one box per
    line.
  - A finger tap anywhere on converted text, or any text box, opens it for typing with the
    keyboard. This works with the pen, the lasso or any other tool selected; a pen tap still
    writes. A tap on a formula opens the LaTeX editor.
  - With the text tool, one tap on a text box edits the whole box, also when it is part of a
    group. Before, a grouped text turned into a lasso selection.
  - With the lasso, a tap on text edits it directly instead of selecting it first.
- **Less work while switching between lasso and text.**
  - On-device recognition reads the selection ahead as text only when the Convert menu opens.
    Before, it read the selection as math as well, which kept the iPad's worker busy and made a
    Text tap wait.
  - Measured in Chromium at 4× CPU slowdown, synthetic page:
    - drawing an 80-point loop: about 1.45 s → 0.95 s, with no main-thread long tasks (before:
      1–4 per loop, 51–76 ms each);
    - lassoing part of a text: about 1.0–1.2 s → 0.7–0.8 s, with no long tasks.
    - Not measured on the iPad.

## 0.7.0-beta.4 — 2026-10-21

- **Model storage no longer hangs after an update.**
  - Cause, found on the iPad: 0.7.0-beta.1 kept its model-database connection open and never gave
    way. beta.2 upgraded that database (it added a metadata index), and the upgrade waited forever
    behind the old connection. Every pack showed "not installed" and the Download buttons kept
    spinning until Obsidian was quit completely.
  - Now the connection gives way to a newer version (`versionchange`) and is closed when the
    plugin unloads.
  - If an older version still holds the database, the check gives up after 6 s. Settings then
    says so ("quit Obsidian completely and reopen; nothing needs to be downloaded again") instead
    of hanging. The queued upgrade completes as soon as the old connection closes.
- **Models installed with 0.7.0-beta.1 are not downloaded again.** If a model file is in storage but
  missing from the metadata index, it is indexed on the next check instead of being reported as
  "not installed".
- **Faster, more reliable downloads.**
  - Before downloading, every mirror is probed once with a HEAD request (8 s limit). Downloads
    then start with the fastest mirror that answered. Unreachable mirrors are tried only if every
    other one fails, instead of each costing a 90 s timeout.
  - npmmirror is now listed first for the runtime and the hand font. It is reachable in mainland
    China and elsewhere.
  - The download timeout scales with the file: 20 s plus 100 KB/s.
- **Self-test.**
  - New "Model storage" line: stored files against index entries, or BLOCKED.
  - New "Download mirrors (this network)" line: the round trip per host.
  - The installed-pack line now includes the English and font packs.

## 0.7.0-beta.3 — 2026-10-21

- **English handwriting: dedicated English model.**
  - The model is PaddleOCR `en_PP-OCRv5_mobile_rec` (7.5 MB, Apache-2.0), an optional pack.
    Settings → Local recognition; or the "English model" button that appears on the result bar
    after an English line was converted.
  - Once it is installed from the result bar, the same ink is read again and the converted lines
    update in place.
  - Lines that read as Latin script go through it too, and the more confident reading is kept.
  - Synthetic handwriting (Hershey script / cursive, 12 phrases), character error rate:
    - script 20–27 % → 10 %;
    - cursive 18–21 % → 7–8 %;
    - print-like 4–5 % → 0.6–1.2 %.
  - The file was pinned from the official Baidu BOS archive, fetched on the user's PC
    (SHA-256 `b5f833df…`); its dictionary equals the one in `inference.yml`.

## 0.7.0-beta.2 — 2026-10-21 (iPad feedback on 0.7.0-beta.1)

- **Lasso part of a converted text.** Lasso just "今" of "今天" (or one word of a line): those
  characters become their own text box, selected; the rest stays exactly where it was. One undo
  step joins them again. This applies to one-line, left-aligned, unrotated, ungrouped text boxes.
- **Colour panel shows the selection's own colour** (ink, text, formula, shape outline), not the
  current pen's colour, which was always orange.
- **Excalidraw hand-drawn fonts:** Excalifont + Xiaolai (小赖), SIL OFL 1.1, 12.1 MB, optional.
  - Settings → Local recognition, or the button on the result bar after a conversion.
  - The fonts come as Excalidraw's 216 subsets split by character range, verified by SHA-256 and
    stored on the device. Only the subsets a text actually uses are loaded.
  - Converted text in the "hand" style uses them, as do hand-themed mind maps and the previews.
- **Hand style without the font pack** no longer falls back to a Song (serif) face for Chinese on
  iPad. The generic `cursive` was removed from the font chain, so PingFang SC is used.
- **Text preview:** the handwriting picture is centred in one full-width pane.
- **Local text recognition, more robust:**
  - Each line is rendered at three glyph sizes and stroke widths; the most confident reading is
    kept. Synthetic tests: Chinese CER 0.46 % → 0.23 %; cursive English improves by 5–10 points.
  - English lines will use PaddleOCR's dedicated English model once its file is pinned (fetch
    script updated: `node scripts/fetch-local-assets.mjs en fonts`).
- **Storage:** model metadata now sits in its own IndexedDB index, so checking installed packs no
  longer reads megabytes. Data from 0.7.0-beta.1 is migrated automatically.
- **Downloads:** 4 files in parallel; the mirror that answered is tried first for the next file.
- **Import model files** matches files by content (SHA-256), whatever their file names.

## 0.7.0-beta.1 — 2026-10-20 (on-device recognition: no API key, nothing uploaded)

- **Convert → Math and Convert → Text now run on this device by default.** The engine is ONNX
  Runtime Web 1.24.2, WASM CPU, one thread, in a module Web Worker; Pencil drawing stays on the
  main thread.
  - **Math:** CoMER INT8 (via ink-on), from the strokes re-rendered in CROHME style → LaTeX.
    Greedy decoding; beam candidates when unsure.
  - **Chinese text:** PP-OCRv5 mobile recognition, one line at a time. Lines come from the stroke
    analysis and are re-rendered at 48 px. Each character has candidates.
  - Results are text / formula objects in place, with the result bar (candidates, edit, Restore
    ink, undo). An uncertain result opens the preview with candidates instead, and the ink stays
    until you pick.
- **Model packs are optional downloads, kept out of the plugin and out of the vault.**
  - Sizes: runtime 11.8 MB; math 7.2 MB; Chinese text 15.8 MB.
  - Each file is pinned by SHA-256, with mirrors tried in order; Settings → *Local recognition*
    has download / delete.
  - Files are stored in this device's IndexedDB: never in a note, never synced by Remotely Save.
    Each file is checked again before use. A damaged file is removed and the pack falls back to
    "not installed".
  - When the download sources are blocked, *Import model files* accepts the same files from the
    device (verified).
- **First use:** Convert → Math shows the download size and installs on request, then converts.
- **Faster:** on lasso the models are loaded in the worker; once the Convert menu is open, the
  selection is already being recognised in the background (on the device, nothing sent).
- **Local recognition self-test** (Settings, and a command): checks WASM / SIMD / module worker /
  IndexedDB / storage; times model load and recognition; measures main-thread frame gaps. The
  report can be copied.
- **Routing change.** `auto` = on device first. MyScript (cloud) and vision models are used only
  when chosen in the settings: MyScript keys alone no longer select MyScript.
- **Licences** (docs/LOCAL_RECOGNITION.md): ONNX Runtime MIT; PaddleOCR / PP-OCRv5 Apache-2.0;
  ink-on code Apache-2.0. The CoMER weights have no declared licence, so HandNote does not host
  them: the pack downloads them from ink-on's own location.

## 0.6.0-beta.5 — 2026-10-20

- **MyScript still split a three-character name with stacked characters into two lines in beta.4 ("} 山新 / 召石口") — root cause found.**
  - MyScript's text guides are on by default with a **10 mm** line gap (iink configuration
    reference). `line-gap-mm` is documented only for the off-screen recogniser, and the server
    evidently ignores it.
  - beta.4 normalised a line to 11 mm, so a 10 mm guide line cut through the middle of every
    character. beta.3 (guides "off", real size about 17–25 mm) failed the same way.
  - Now each line is about 6.5 mm (at most 8 mm) and is placed inside its own 10 mm band, starting
    at 20 mm. No guide line can cut a character, whether the server's guides start at 0 or at the
    top margin.
- **Smaller, faster requests.** Apple Pencil writes 240 points per second. Points closer than
  0.2 mm (text, normalised) or 0.15 mm (math) are now dropped: same shape, a several times smaller
  request.
- **Recognition starts when the Convert menu opens** (new default, only after "don't ask again").
  The tap on "Text" then overlaps the network round trip, and the answer is usually already there.
  Choosing Math or Shapes instead costs one extra request. The setting has three choices: off /
  menu (default) / on lasso.
- **The result bar shows where the time went:** total, network request, round trip to the server
  and upload size. Example: "MyScript · 1.2 s · network 1.0 s · round trip 0.4 s · 5 KB".

## 0.6.0-beta.4 — 2026-10-20 (MyScript Notes–style conversion)

- **MyScript Chinese accuracy fixed at the source.** Two bugs in the request, not in MyScript:
  - **Scale:** HandNote page units are points (A4 = 595 × 842), but the request treated them as
    CSS pixels, so the ink reached MyScript 25 % too small.
  - **Lines:** guides were off, so MyScript had to guess the lines itself. Large characters whose
    parts are stacked (召 = 刀 over 口, 岩 = 山 over 石, 哲 = 折 over 口) were cut into a "top line"
    and a "bottom line": the name came back as "刀了山新 / 口！石口".
  - Now HandNote finds the lines locally, normalises the writing to a typical size (about 11 mm),
    and places line *i* on ruled guide line *i* with guides on, the way MyScript Notes hands ink
    from ruled paper to the recogniser.
  - Local line finding also keeps the dot row on top of 觉 / 学 / 常 with its line (offline engine too).
- **Instant conversion in place (new default).** Convert → Text / Math with a digital-ink engine
  (MyScript or offline) no longer opens a preview dialog. The result replaces the ink where it was
  written, in one undo step. A small bar under the result shows:
  - the words, with uncertain ones dashed: tap one to pick a candidate;
  - **Edit**;
  - **Restore ink**;
  - ✕.
  Writing on the page dismisses the bar. While the recogniser works, a small pill under the
  selection shows the progress and has a cancel ✕; nothing modal. "Preview first" and "keep the ink
  (result beside it)" are settings. A general vision model is always previewed.
- **No "Send" click every time.** The MyScript consent dialog now offers a saved "don't ask again"
  (Settings → *MyScript: don't ask before converting*, which can be switched back off). Until you
  tick it, HandNote asks as before.
- **Less waiting:**
  - When you lasso handwriting and MyScript is the text engine, HandNote opens the HTTPS
    connection early with a keyless `GET /version`; nothing of yours is sent. Connection set-up
    to the EU server no longer adds to the conversion time.
  - Optional, off by default: *recognise the selection in advance*. Convert → Text is then
    instant, but every lasso with ink costs one MyScript request.

## 0.6.0-beta.3 — 2026-10-20

- **MyScript transport:** requests now go through the browser `fetch` first, the same path
  MyScript's own web SDK uses, with a real abort after 25 s. If `fetch` is refused, they fall back
  to Obsidian's `requestUrl`. Background: on iPad, the keyless `version` URL answered in Safari, but
  the plugin's recognition request (through `requestUrl`) got no answer within 30 s.
- `requestUrl` no longer receives `Content-Type` twice (as a header and as `contentType`).
- **Connection test:** names the transport that answered, and separates "server unreachable" from
  "server reachable but the recognition request got no answer".

## 0.6.0-beta.2 — 2026-10-20

- **"Test MyScript connection" now checks in two steps and says which one failed.**
  1. Can this device reach the MyScript server? This is a keyless `GET /api/v4.0/iink/version`, with a 15 s limit.
  2. Are the keys accepted? One synthetic stroke is recognised, with a 45 s limit.
  The result is one of: network unreachable or blocked; keys / HMAC refused; quota; or OK, with
  the latency of each step. Before this, every failure showed only "no answer within 30 s".

## 0.6.0-beta.1 — 2026-10-20 (recognition architecture correction: digital-ink engines, not screenshots)

- **Convert = digital-ink recognition.** The lasso bar now has two buttons:
  - **Convert** (Text / Math / Shapes): recognises the strokes themselves.
  - **AI tools** (Mind map / Flowchart / Image text): general vision model.
  Convert → Text / Math no longer sends a screenshot to a chat model by default. That needs the
  explicit "vision fallback" setting (off by default) or choosing that engine.
- **Offline Chinese recognition (new, zero configuration):** about 9,500 characters, no network,
  nothing uploaded, no consent dialog. Each character has candidates you can tap to correct, and
  words from the personal dictionary are preferred. HandNote's own recogniser uses the bundled Make
  Me a Hanzi stroke templates (Arphic Public License). Limits: Chinese characters only, standard
  stroke order, weak on cursive. They are shown in the preview.
- **MyScript (your own keys) is the professional engine** for text in many languages and for math
  (LaTeX). Strokes are sent as vector ink (iink REST "recognize"). New in this release:
  word-level candidate chips, and *Test MyScript connection* in settings. MyScript works
  independently of the general AI switch.
- **No guessed results.** When no suitable engine exists (for example Math without MyScript), a
  dialog says what is missing and where to set it up.
- **Settings:** a new "Handwriting recognition" section at the top. Engine choices: Auto,
  MyScript, Offline Chinese, General vision model. Offline on/off, vision fallback (off),
  MyScript keys and test, dictionary, font, measured timings.
- **Mind map toolbar:** the two look-alike copy buttons are now one **Export / copy** button with
  labelled choices (Markdown outline / Mermaid).
- **Line analysis:** short strokes at the top or bottom of Chinese characters no longer form
  separate lines.
- **Benchmarks:** `npm run bench:ink` measures CER and latency of the offline engine (and of
  MyScript with your keys) on your own `.handnote` notes.
- **Docs:** `docs/RECOGNITION_ARCHITECTURE.md` covers the root cause, MyScript data mapping, the
  offline / Scribble / native-SDK assessment and measured results.
- `main.js` grows to about 1.4 MB because of the embedded templates.

## 0.5.0-beta.1 — 2026-10-20 (MyScript × Xmind upgrade: convert handwriting into editable objects)

- **Convert menu** (lasso → ✦): *Text*, *Math*, *Mind map*, *Flowchart*, *Image text*. Each shows
  which engine runs and what is uploaded (vector ink or a picture). There is a consent dialog, which
  can be remembered for the session. Progress appears immediately, with the stage, elapsed time and
  Cancel. Errors are typed (timeout / empty / invalid / auth / rate limit / network …) and come with
  a **user-triggered** Retry; a request that may have been billed is never repeated automatically.
  An unchanged selection is served from a cache, and a second tap joins the running request.
- **Models only read, HandNote lays out.** Prompts ask for text lines, LaTeX, a topic tree or a
  node/edge graph, never coordinates. Positions, sizes, spacing, connectors and colours are computed
  locally, so text and shapes no longer overlap, and answers are short and fast.
- **Text:** one text box per handwritten line, at the line's place and in the ink colour. Lines are
  editable in the preview, with alternative readings as chips. Font: standard or handwritten (the
  optional LXGW WenKai Lite download, OFL; SHA-256 pinned).
- **Formulas:** a new formula object (LaTeX). It is rendered with Obsidian's own MathJax: the
  MathJax output is snapshotted off-screen and replayed on the canvas. Tap it to edit the LaTeX
  with a live preview. It can be copied as `$$…$$`. LaTeX errors are shown and never crash.
- **Mind maps (Xmind-style):** a new mind map object holding a topic tree, with a deterministic
  layout (balanced or right), so nothing overlaps. Three local themes: Clean Academic (default),
  Hand-drawn and Minimal, with branch colours and contrast ≥ 4.5:1. Editing on the page: tap a topic
  and edit its text (Enter = sibling, Tab = subtopic), add, delete, collapse, or drag onto another
  topic to re-parent; the theme and layout can be switched. Export as a Markdown outline or Mermaid.
  The preview shows original | structure, with an editable outline.
- **Flowcharts:** shapes carry their text as a label (no separate text to drift away), with a
  layered top-down / left-right layout. Arrows attach to their shapes and follow when nodes move;
  loops are drawn as dashed side curves; edge labels sit beside the arrow. Export as Mermaid
  `flowchart`. Tap a selected shape to edit its text.
- **MyScript (optional, bring your own keys):** text and math can be recognised from the vector
  strokes through MyScript Cloud (iink "recognize" REST, HMAC-signed). Keys are kept in Obsidian
  secret storage; there is a personal dictionary. MyScript is never required.
- **DeepSeek:** thinking is disabled for recognition (it was the main source of slowness); JSON
  mode is used; empty and cut-off answers are detected. **Qwen** was removed from the default list
  (existing Qwen settings and keys are kept).
- **Page drag fix:** the sidebar drag follows the gesture on window with a touch fallback, so a
  lost `pointerup` no longer leaves a floating ghost.
- Lasso tap on an object opens it for editing. Converted results kept beside the ink go to a free
  spot on the page.
- **File format 5** (formulas, mind maps, labelled shapes, vertical-first elbows). Notes without
  them are still written as format 1–4. 0.4 opens format-5 notes read-only.
- Tests: unit 150, browser 53, Obsidian E2E 23. Real DeepSeek A/B: **NOT RUN** — this workspace
  cannot reach api.deepseek.com. Run `npm run bench:rec -- --key-file … --yes` on the PC.

## 0.4.0-beta.2 — 2026-10-20 (fixes from the iPad evaluation of 0.4.0-beta.1)

- **Fixed: frozen editor / black block.** Root causes found and fixed: (1) iPadOS ghost click after a
  tap that rebuilt the sub-bar ran the action twice (toggles such as *erase highlighter only* never
  changed) → global capture-phase ghost-click guard in `onTap`; (2) a lost Pencil `pointerup` left
  the InputRouter in `PenDrawing` forever (all later strokes "second pointer", fingers "palm") → a new
  Pencil contact ends the old one, a silent pen is released after 4 s, window-level pointerup
  backup, input handlers wrapped with a state reset; (3) canvas memory: the lasso / laser canvases
  stayed at the default 300 × 150 px in the top-left corner (the dark block) and the lasso float
  canvas could reach several viewport sizes → canvases are hidden and bitmap-free when idle, the
  float is clipped to the screen and capped at 6 MP, bitmaps freed on removal.
- **Pages sidebar** on the left replaces the popover: fixed 96 × 128 cells with fitted thumbnails
  (mixed sizes never overlap or spill), current page highlighted while you scroll, drag to reorder
  (long press for touch / Pencil, drag for mouse, auto-scroll, insertion marker), per-page menu:
  add before / after, copy / paste page (also across notes), duplicate, rotate 90° with content,
  move to start / end, export PNG / SVG, clear, delete (two-tap confirmation). The paper keeps its
  fit-to-width when the sidebar opens or closes.
- **Laser:** trail no longer ages point by point; it stays fully visible while writing (and across
  short lifts) and fades out together after a hold time (default 2 s; 1 / 2 / 5 s in the sub-bar).
- **Shape recognition:** arc-length resampling + short moving average before measuring (slow strokes
  carried 30–60 % jitter length), least-squares line fit ignoring hooks, arrows choose the vertex
  that leaves a straight shaft, head tolerance relative to the head. Seeded corpus of 420 realistic
  strokes: line 100 %, curve 98 %, ellipse 97 %, rectangle 97 %, triangle 98 %, arrow 98 %,
  handwriting false positives 0 %.
- **AI settings v2 (Excalidraw-style):** provider profiles (type, secret name, base URL) + model
  entries (profile, model id, endpoint override, multimodal flag), default model + optional
  per-task models, usage per model, verbose console log (no keys / images / text), response token
  limit; new adapters Anthropic Messages and Google Gemini (key in `x-api-key` /
  `x-goog-api-key` headers, never in the URL) and generic OpenAI-compatible (http only for
  localhost). Migration from beta.1 settings. Settings page keeps its scroll position (the AI
  section re-renders alone).
- **Pencil double tap:** not available to web content (no `UIPencilInteraction` in WKWebView);
  substitute: one-finger double tap on the page switches pen ⇄ eraser (setting, on by default).
- Tests: unit 126 (+ shape corpus, Anthropic/Gemini, migration, lost pointerup), browser 47.


## 0.4.0-beta.1 — 2026-10-19 (third iPad round: polish, editable objects, optional AI) — not released yet

- **Interaction:** `onTap` for every control (fires on pointerup within 16 px, so a Pencil wobble no
  longer loses the tap; the trailing click is ignored; keyboard activation kept); shared selected /
  hover / pressed / disabled states; colour circles forced round under Obsidian mobile button CSS,
  selected one with translucent ring + check mark; compact step slider (0/25/50/75/100 % stops,
  soft snap, value shown) replaces native range inputs.
- **Line styles:** dashed / dotted ink (pattern along the centreline, same on screen / PNG / SVG);
  "stroke settings" panel with style tiles and tapered width slider; shapes and connectors with
  dash, width, single / double arrows, open / filled heads.
- **Connectors:** curve (quadratic fitted to the drawn path) and polyline kinds; curve control and
  polyline vertex handles; curves keep their bulge when attached shapes move.
- **Shape pen:** hook trimming, lines (relaxed), arcs → curves, L / zig-zag → polylines, one-stroke
  arrows, separate "V" adds an arrow head to the nearest line end.
- **Lasso:** free / rectangle, content filter, groups, move / scale / rotate on a float layer with one
  undo step, copy / cut / paste across notes, delete, recolour, group / ungroup, local convert to
  shapes, local tidy (align / distribute by handwriting lines).
- **Laser pointer** (dot / fading trail, not saved). **Page navigator** (lazy cached thumbnails, jump,
  add, duplicate, reorder via `move-page`, delete). **Top bar:** pages | lasso, pen, eraser, text,
  image, shapes, laser.
- **Images inside the .handnote file** (format v4 `assets`, downscaled > 2048 px); settings switch
  back to attachments; command to embed the current note's attachments (one undo step).
- **File explorer:** "New HandNote" on folders and the blank area (official `file-menu` event);
  command "New handwritten note in the current folder".
- **iPad keyboard:** text box kept above the docked keyboard; one-time hint for the iPadOS floating
  keyboard (pinch out to restore).
- **AI (optional, off by default):** provider adapters (Qwen / DeepSeek / OpenAI via
  OpenAI-compatible Chat Completions, offline mock, hosted placeholder); keys in Obsidian
  SecretStorage (1.11.4+, no plaintext fallback); consent dialog with the exact upload; EditableScene
  v1 with strict validation; preview; insert beside (default) or confirmed replace; bounded retries,
  timeout, cancel, daily request limit, token counters; settings simple + advanced.
- **Format v4** only when needed (`dash`, `g`, `rot`, curve / polyline, arrow fields, `latex`, hand
  font, assets). v0.3 opens v4 files read-only.
- Tests: unit 116, browser 42, Obsidian E2E 22, AI benchmark (mock) 7/7.

## 0.3.0-beta.2 — 2026-10-18 (fixes from iPad testing of 0.3.0-beta.1)

- **Fixed (iPad): ink offset from the Pencil tip.** Focusing a text box inside the writing area
  let iPadOS scroll that overflow container (the scene canvas has overscan, so it was
  scrollable); the canvases moved away from the pen. The viewport and editor are now
  `overflow: clip`, any scroll is reset, and pointer mapping compensates residual scroll.
  `scrollIntoView` in the colour strip was replaced (it scrolls every ancestor on iOS).
- **Fixed (iPad): no keyboard for text boxes.** iOS opens the keyboard only for focus() inside a
  touch gesture; the text box is now focused again from a capture-phase touchend / click.
- **New:** ⋯ menu → Clear this page (two taps, one undo step).
- Diagnostics: scroll offsets and visual viewport in the report.
- Tests: browser 30 (+ scroll / focus / clear page).

## 0.3.0-beta.1 — 2026-10-18 (private beta, from the second iPad round)

- **UI (GoodNotes-style):** two-tier toolbar — top bar pen / eraser / text / image / shapes (icons
  only), per-tool sub-bar that toggles on a second tap; colour circles with "+" (system colour
  picker; duplicates move to the front; long-press removes); width presets edited with a tapered
  slider in mm; simple pen panel (live preview, tip sharpness, pressure sensitivity,
  stabilization; the rest under Advanced); ⋯ menu with icons; Change template dialog (A5 / A4 / A3
  / Letter, portrait / landscape, paper colour, pattern, this page / all pages); zh / en labels.
- **Pens:** fountain pen thicker (0.5 / 0.8 / 1.2 mm) with natural pressure curve 4 (hairline →
  nominal → ~2×); new pencil with graphite grain; shape pen with recognition (line, rectangle,
  ellipse, triangle, diamond, quadrilateral). Ballpoint is no longer offered (old strokes render).
- **Eraser:** precise / standard (partial — strokes are cut, cut ends keep their width) / stroke;
  three sizes; highlighter-only; erases shapes.
- **Objects:** text boxes (tap to create, in-place editing, size / font / bold / italic / align /
  colour); images as vault attachments (move, resize, non-destructive crop, cut, duplicate,
  share, delete; PNG export includes them); shapes and connectors (arrows stay attached).
- **Format:** version 3 only when a note uses the new content; history ops set-items /
  set-strokes / set-page / batch. v0.2 pen settings are reset once to the new pen model
  (colours kept).
- Tests: 89 unit, 27 browser, 18 real-Obsidian E2E.

## 0.2.0-beta.2 — 2026-10-18 (prepared, superseded by 0.3.0-beta.1; never released)

- Pressure calibrated from the first iPad report; `heavyPressure`; Calibrate from my writing.

## 0.2.0-beta.2 — 2026-10-18 (private beta, from the first iPad report)

- First real-device data (`docs/device-reports/2026-10-18-ipad-0.2.0-beta.1.md`): Pencil pressure is
  real in Obsidian's iPad web view, 240 Hz samples, 120 Hz frames, 0.13 % dropped frames; this
  writer's pressure: median 0.123, p95 0.337, max 0.469.
- B · Experimental: new stroke parameter `heavyPressure` (missing = 0.85, so beta.1 strokes are
  unchanged — snapshot test); defaults typical 0.12 / heavy 0.45 / gamma / pressure smoothing 0.85.
- Pen panel: "Heavy pressure" slider; "Calibrate from my writing" (median / p99) replaces
  "Use my typical pressure". Report prints the same suggestion and the collection period.
- beta.1 device settings are kept (heavy 0.85 added) until the writer calibrates.
- Tests: 80 unit, 21 browser, 17 real-Obsidian E2E.

## 0.2.0-beta.1 — 2026-10-18 (private beta, awaiting iPad test)

- **Fixed (P0):** fingers pan/zoom with Finger drawing OFF. Root cause: v0.1 rejected touches with
  `PointerEvent.width/height` > 46 px as palms; WebKit reports 2 × `UITouch.majorRadius`, so normal
  finger contacts were dropped. New `InputRouter` with one owner per pointer; palms by context.
- Finger drawing ON: two fingers always navigate; tentative finger strokes are discarded on pinch.
- Fountain pen A/B: v0.1 Baseline (engine 1, bit-identical) and Experimental (engine 2: independent
  pressure filter, curves, min/max width, calibratable typical pressure, proportionate tapers).
- Local input diagnostics with copyable report.
- Input mode per device (Auto / Pen-first / Mouse-first); desktop Space/middle-drag pan, shortcuts.
- Single-row toolbar, compact pen panel (Advanced collapsed), ⋯ menu; paper tones, grain, Fit page.
- Predicted ink capped (2 points / 12 px) and reset to OFF on upgrade.
- Format: version 2 only for files containing engine-2 strokes; v0.1 files re-save byte-identical.
- Tests: 74 unit, 21 browser, 17 real-Obsidian E2E.

## 0.1.0 — 2026-10-18 (pre-release, awaiting iPad testing)

First usable version.

- Independent ink engine: screen-space One Euro stabilization with corner release, centripetal
  Catmull-Rom interpolation, pressure/ink-flow/nib width model, entry and speed-dependent exit
  tapers, lift-hook trimming; filled capsule-union outlines.
- Pens: fountain, ballpoint, highlighter (grouped single fill, under ink); whole-stroke eraser
  (also hardware eraser buttons); undo/redo; two/three-finger tap gestures.
- Paged notebook: A4/A5/16:9/A4 landscape; blank/ruled/grid/dots; add/delete/navigate pages;
  pan, pinch-zoom, inertia; desktop wheel/ctrl-wheel/middle-drag.
- Low-latency input: coalesced events, append-only live layer + per-frame tail, cached scene with
  overscan, DPR-aware canvases, optional predicted ink.
- `.handnote` format v1: raw samples, delta-encoded, one stroke per line, recoverable.
- Obsidian integration: custom `FileView`, `.handnote` extension, Markdown embeds (Reading view +
  Live Preview), create / insert-at-cursor commands, PNG/SVG export, settings tab.
- Data safety: debounced autosave, flush on background/close/quit, sync-conflict guard with
  conflict copies, crash journal + restore prompt, rolling local backups, read-only for newer
  formats.
- Performance overlay and "Copy performance report".
- Tests: 32 unit, 11 browser, 14 real-Obsidian end-to-end steps.
