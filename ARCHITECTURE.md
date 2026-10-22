# Architecture

```
Pointer events (pen / touch / mouse)
  │  getCoalescedEvents() → every sample, page-local coordinates, pressure, time, tilt
  ▼
InputRouter (input/input-router.ts) — one owner per pointer: ink / erase / nav / palm / mouse-pan
  │  pen → draw · finger → pan / pinch / 2-3 finger taps · palms by context · Space/middle-drag pan
  │  (docs/INPUT_STATE_MACHINE.md)
  ▼
StrokeBuilder (ink/stroke-builder.ts)           ← deterministic, causal, incremental
  │  1. One Euro filter in screen px  + corner release            (shared by both engines)
  │  2. centripetal Catmull-Rom densification                       (shared)
  │  3. width model — engine 1 (v0.1 Baseline) or engine 2 (Experimental: independent adaptive
  │     pressure filter, curve → [min,max] width, calibrated typical pressure, proportionate tapers)
  │  stable prefix (immutable) + tail (to the pen tip, recomputed per frame)
  ▼
Outline (ink/outline.ts)  union of tapered capsules → Path2D / SVG path, nonzero fill
  ▼
Renderers
  ├─ live:   append-only "stable" canvas + per-frame "tail" canvas (viewport size)
  └─ scene:  paper + committed ink bitmap with 20% overscan; CSS transform during gestures
  ▼
Commit on pen-up: raw samples quantized → Stroke → History (undo/redo) → geometry from stored
samples (identical to what a reload shows) → painted onto the scene
  ▼
Document (document/*) ──serialize──► .handnote (one stroke per line, delta-encoded)
  ▼
HandNoteView (plugin/view.ts): debounced save · flush on background · sync guard · journal
```

## Modules

| Path | Responsibility | Obsidian-free? |
|---|---|---|
| `src/ink/types.ts`, `presets.ts`, `math.ts` | Sample/pen types, default presets, pressure & nib curves | ✓ |
| `src/ink/stroke-builder.ts` | Filtering, spline, width model (engine 1 / 2), tapers, lift-hook trimming | ✓ |
| `src/input/input-router.ts` | Pointer ownership, palm rejection, pan/pinch/taps, cancel handling | ✓ |
| `src/input/diagnostics.ts` | Local input diagnostics (pressure verdict, sampling, contact sizes) | ✓ |
| `src/input/input-mode.ts` | Auto / Pen-first / Mouse-first resolution | ✓ |
| `src/ink/erase.ts` | Partial eraser: cut raw samples at the eraser boundary (fragments with `cut` flags) | ✓ |
| `src/ink/shape-recognition.ts` | Shape pen: line / rectangle / ellipse / triangle / diamond / polygon | ✓ |
| `src/document/items.ts` | Text / image / shape items, connectors, hit tests, move / resize | ✓ |
| `src/editor/objects.ts` | Selection box, handles, floating bar, text editing, crop, connector attachment | ✓ (DOM) |
| `src/rendering/items-paint.ts` | Painting items, text layout, image store (host resolver), pencil grain | ✓ (DOM) |
| `src/ink/outline.ts` | Capsule-union outline → Canvas Path2D or SVG | ✓ |
| `src/document/model.ts` | `HandNoteDocument` → `Page` → `Stroke` (raw `InputSample[]`) | ✓ |
| `src/document/codec.ts` | Serialize / parse / recover / header peek | ✓ |
| `src/document/history.ts` | Reversible ops (strokes, pages) | ✓ |
| `src/document/geometry-cache.ts` | Lazy geometry per stroke, eraser hit tests | ✓ |
| `src/rendering/paint.ts` | Page layout, paper patterns, stroke painting, page→canvas | ✓ (DOM) |
| `src/rendering/svg-export.ts` | Vector export | ✓ |
| `src/editor/*` | Editor: camera, input, gestures, layers, menu, settings | ✓ (DOM) |
| `src/ui/*` | Two-tier toolbar + sub-bars, popovers (pen, width, eraser, colour, ⋯, template), icons, zh/en strings | ✓ (DOM) |
| `src/utils/perf.ts` | Pipeline instrumentation | ✓ |
| `src/storage/sync-guard.ts` | Save/reload decisions, conflict copy naming | ✓ |
| `src/storage/recovery.ts` | Device-local journal + backups (Obsidian `DataAdapter`) | – |
| `src/plugin/*` | Plugin entry, `FileView`, embeds, settings tab | – |
| `experiments/ink-lab/` | The editor in a plain web page (Phase 1 prototype, browser tests) | ✓ |

Everything except `src/plugin` and `src/storage/recovery.ts` runs without Obsidian, which is what
makes the unit tests (Node) and browser tests (Chromium) possible.

## Coordinates

Page units: 1 unit = 1 CSS px at zoom 1; A4 = 595 × 842 (PostScript points). Samples are stored
page-local. Camera: `screen = (world − cam) × zoom`; pages are stacked vertically, centred on x = 0.

## Why the live stroke never "jumps" on release

The builder's stages only look backwards (plus a two-point spline window). A spline segment is
emitted as *stable* once the point two ahead exists; stable samples are appended to a canvas that
is never cleared during the stroke. The tail is recomputed each frame from the last stable sample
to the newest raw sample. On pen-up the committed geometry is rebuilt from the quantized stored
samples through the same builder, so it matches the preview except for the exit taper and the
removal of a tiny lift hook. Browser test: 97 % pixel overlap between preview and committed ink.

## Saving and sync safety

* Every change marks the view dirty → journal write after 0.4 s (plugin folder) → file save after
  1.2 s. App backgrounding (`visibilitychange`, `pagehide`, `blur`, `quit`) flushes immediately; an
  in-progress stroke is committed first.
* `saveNow`: read disk → `decideSave` (revision/doc-id check) → on conflict, copy the disk version to
  `Name (conflict YYYY-MM-DD HHMM).handnote` → `vault.process` write (detects a race and preserves
  that too) → bump revision → clear journal.
* External `modify` events: own write → ignore; not dirty → reload in place; dirty → resolved at
  the next save as above.
* Files written by a newer format version open read-only. Damaged files are recovered line by
  line and the damaged original is backed up.

## Rendering choices

Canvas 2D (GPU-backed in WebKit). WebGL/WebGPU and OffscreenCanvas workers are deferred until iPad
measurements show a need (see ADR-001).
