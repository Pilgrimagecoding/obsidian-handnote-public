# ADR-001 — Technical route for Obsidian HandNote

Status: **Accepted** (2026-10-18) · Deciders: project owner + Claude (engineering)

## Context

Goal: GoodNotes-like Apple Pencil handwriting inside Obsidian on iPad, with files that sync through
Remotely Save → OneDrive and open on Windows. Priorities: handwriting quality > features; data
safety > convenience; real iPad behaviour > desktop simulation; low latency > visual effects.

Research inputs: `GOODNOTES_REVERSE_ENGINEERING_REPORT.md` (GoodNotes internals are not lawfully
analysable; public facts point to GPU-filled, tessellated variable-width outlines and adaptive
smoothing) and source review of the candidate projects below (all cloned 2026-10-18).

## Candidate review

| Project | Licence | What it really is | Strengths | Problems for this goal |
|---|---|---|---|---|
| **GoodNotes-Ink** (connectedGraph, 2026-09) | MIT | ~1.4 k LoC zero-dependency canvas SDK; draws quadratic segments with `ctx.stroke()` and a per-segment `lineWidth`; bitmap copy on lift | Thoughtful parameters (log pressure curve with floor/ceiling, flat-nib projection, Laplacian "tension"), coalesced events | Despite the README, nothing is reverse-engineered from GoodNotes. **Per-segment `lineWidth` strokes** (the approach the brief rules out) → beads/seams on translucent ink, width steps. **Live pipeline ≠ redraw pipeline** (stabiliser live, Laplacian on redraw) → strokes change shape after reload. Saves stabilised points, not raw. Heavy EMA lag (weight ≈ 0.87). No document/pages/persistence/Obsidian integration. |
| **Obsidian Blackboard** (jameswolensky, v1.3.3, 2026-10-16) | MIT | Full Obsidian plugin (~4.5 k LoC + tests), `.blackboard` JSON files, infinite canvas, Canvas-node and Markdown-embed drawing, perfect-freehand rendering | Proven Obsidian integration on iPad: `registerExtensions`, MutationObserver embed mounting, document store with debounced saves + flush on `visibilitychange`/`pagehide`, Scribble/editor-focus guard, pointer-type palm rejection | **No `getCoalescedEvents`** (fewer samples on fast strokes); full active-stroke recompute each frame; infinite canvas (brief asks for paged notebook); perfect-freehand look (marker-like); no pressure/raw-sample separation; no sync-conflict guard. Architecture (clean/hexagonal layers) is sizeable to fork for an engine swap. |
| **perfect-freehand** (steveruizok v1.2.3) | MIT | Pressure-sensitive polygon outline generator | Mature, tested, single polygon fill | Minimum-distance filter (`size × smoothing`) drops detail in small writing; outline self-intersects at sharp turns (special-cased caps); streamline is a fixed-rate lerp (lag independent of speed); not designed for nib/fountain-pen character. |
| **Obsidian Plugin API** 1.14.4 | — | `registerExtensions`, `FileView`/`TextFileView`, `vault.process`, `registerMarkdownPostProcessor`, `Platform` | Everything needed except a public custom-embed API | Custom embeds need DOM observation of `.internal-embed` (same as Blackboard/Excalidraw). |

## Options

| | A. Fork Blackboard, swap ink engine | B. GoodNotes-Ink + new plugin shell | C. Combine OSS modules + own input/render | D. Fully independent engine (informed by research) |
|---|---|---|---|---|
| Dev cost | Medium (learn + reshape infinite canvas into pages, replace renderer, fix input) | Medium-high (engine rewrite needed anyway) | Medium | Medium-high |
| Licences | MIT ✓ | MIT ✓ | MIT ✓ | Own code ✓ |
| Input latency | Needs coalesced events + incremental render added | Coalesced ✓, but EMA lag | Depends | Designed for it ✓ |
| iPad performance | Full recompute per frame | Per-segment strokes are cheap but artifact-prone | — | Append-only live layer, cached scene ✓ |
| Chinese small text | perfect-freehand min-distance hurts | Lag + strokes rounding | Depends | Screen-space filter, dense spline, corner release ✓ |
| Data format | `.blackboard` (no raw/derived split) | none | own | own, raw samples + versioned engine ✓ |
| Long-term maintenance | Tied to upstream design decisions | Little upstream to share | Mixed ownership | Small, owned, tested (~4.7 k LoC incl. comments) ✓ |
| Obsidian compatibility | Proven | none | Copy patterns | Copy *patterns* (not code) from Blackboard ✓ |

## Decision

**Option D, informed by C:** an independent, dependency-free ink engine and plugin, reusing *ideas*
(not code) from the reviewed projects:

* from Blackboard — the Obsidian integration patterns (extension registration, embed observation,
  flush on background, editor blur against Scribble, pointer-type palm rejection);
* from GoodNotes-Ink — the pressure-curve floor/ceiling idea and flat-nib projection;
* from perfect-freehand — filled outlines instead of stroked lines, and taper easing.

No third-party runtime dependency ships in `main.js`. REA-driven binary analysis was dropped as
not lawfully possible for GoodNotes (see report §4); public algorithms are sufficient.

## Key design choices

1. **Raw vs derived.** Files store raw samples (x, y, pressure, time, tilt) + pen parameters +
   zoom at writing time + `engine` version. Geometry is recomputed on load. Future engine changes can
   re-render old notes; nothing is lost.
2. **One deterministic builder for live and committed ink.** Causal stages only → the stable prefix
   never changes, the live tail always ends at the pen tip, and the committed stroke equals the
   preview except for the exit taper (measured 97 % pixel overlap in browser tests).
3. **One Euro filter in screen space** (+ corner release) → low lag at speed, strong smoothing when slow.
4. **Centripetal Catmull-Rom** densification (no cusps/overshoot on uneven sampling).
5. **Filled union-of-capsules outlines**, nonzero fill, one fill per stroke; highlighters grouped by
   colour and filled once → no overlap darkening; drawn below ink.
6. **Canvas 2D**, three layers (scene cache with overscan, append-only live layer, tail layer).
   WebGL/WebGPU rejected for v0.1: Canvas 2D is GPU-backed in WebKit, the measured per-frame cost is
   ≪ 1 ms, and WebGPU in the Obsidian iPad web view is not guaranteed. OffscreenCanvas/worker
   rendering kept as a Phase 4 option if the iPad overlay shows main-thread contention.
7. **Paged notebook** (A4 default, A5, 16:9, landscape), continuous vertical scrolling, custom camera
   (pan/pinch/inertia) because `touch-action: none` is required for Pencil.
8. **`FileView` with an explicit save path** (not `TextFileView`) so every write goes through the
   sync guard: revision check → conflict copy → `vault.process` write → race detection.
9. **Device-local safety net** in the plugin folder (not synced): crash journal + rolling backups.

## Data format decision: `.handnote`

* Plain JSON, one stroke per line, delta-encoded integers (≈14 bytes per sample; a dense page of 600 short strokes ≈ 630 KB).
* **Remotely Save compatibility** (source-verified, not device-verified): Remotely Save enumerates
  local files with `vault.getAllLoadedFiles()` and syncs every `TFile` regardless of extension; it
  skips paths starting with `.` and, by default, `_`. Obsidian indexes files with any extension, so
  `.handnote` files are synced. The plugin never creates `_`/`.` names. **Must still be confirmed on
  the user's devices (checklist §6).**
* Fallback if it ever fails: wrap the same JSON in a Markdown code block (`.handnote.md`) — not
  implemented in v0.1 because the source review shows it is unnecessary.
* Remotely Save's default conflict action is `keep_newer`, which can silently discard one side;
  HandNote's own revision guard (above) ensures the losing side survives as a conflict copy when
  the conflict is visible to an open editor. Real-time collaboration is **not supported**.

## Consequences

+ Full control of feel/latency trade-offs; small, tested codebase; no dependency risk on mobile.
− We own all tuning; the defaults are synthetic-test tuned and must be calibrated on the iPad
  (pressure curve, smoothing, taper). Lasso, pixel eraser, PDF import and handwriting search are
  out of scope for v0.1.
