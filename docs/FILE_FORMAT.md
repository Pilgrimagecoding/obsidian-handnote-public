# `.handnote` file format — versions 1–5

A `.handnote` file is UTF-8 JSON written with one stroke per line:

```
{"format":"obsidian-handnote","version":1,"id":"d…","created":…,"modified":…,"revision":7,"device":"dev-…",
"pages":[
{"id":"p…","width":595,"height":842,"background":{"kind":"ruled","spacing":24,"paper":"#ffffff","line":"#c9d3e0"},"strokes":[
{"id":"s…","tool":"fountain","color":"#1a1a1a","params":{…},"zoom":1.943,"hasPressure":true,"engine":1,"created":…,"enc":"d1","pts":[…]},
{"id":"s…", … }
]},
{ … page 2 … }
]}
```

## Header

| Field | Meaning |
|---|---|
| `format` | always `obsidian-handnote` |
| `version` | format version. A reader that sees a higher version opens the file **read-only** |
| `id` | document id (stable across saves; used for conflict detection and recovery) |
| `revision` | incremented on every save. A writer must only overwrite the revision it loaded |
| `device` | random per-device id of the last writer |

## Page

`width`/`height` in page units (1 unit = 1 pt; A4 = 595 × 842). `background.kind` ∈ `blank`,
`ruled`, `grid`, `dots`; `spacing` in units.

## Stroke

| Field | Meaning |
|---|---|
| `tool` | `fountain`, `ballpoint`, `highlighter` |
| `params` | pen parameters at writing time (`width`, `pressureSensitivity`, `smoothing`, `tapering`, `opacity`, `velocityThinning`, `nibFlatness`, `nibAngle`) |
| `zoom` | screen px per unit when written (the stabilizer works in screen space) |
| `hasPressure` | false for mouse/finger input |
| `engine` | geometry algorithm version used when the stroke was written |
| `enc` | sample encoding, currently `d1` |
| `pts` | `d1`: flat integer array `[dx, dy, dp, dt, …]`, deltas from the previous sample (first sample relative to 0). x, y in 1/100 unit; pressure in 1/1000; time in ms since stroke start |
| `tilt` | optional `[dtiltX, dtiltY, …]` in whole degrees, present only when every sample has tilt |

Only **raw input** is stored. Smoothing, interpolation, widths and tapers are recomputed by the
engine, so rendering can improve without rewriting files.

## Robustness

* Unknown tools/encodings and corrupt sample arrays skip that stroke with a warning.
* If the file is not valid JSON, readers salvage the header and every stroke line that parses
  (`recoverDocument`).
* Writers must not create file names starting with `.` or `_` (Remotely Save skips them by default).

## Future versions

Additive fields are allowed within version 1. Breaking changes bump `version`; the reader keeps
the ability to load all earlier versions.

## Versions 2 and 3

A writer always uses the **lowest** version that can represent the note, so notes stay editable
by older plugin versions as long as possible:

| version | written when the note contains | added |
|---|---|---|
| 1 | only engine-1 strokes | — |
| 2 | an engine-2 stroke (v0.2 fountain pen) | engine-2 pen parameters (`pressureCurve`, `minWidthRatio`, `maxWidthRatio`, `pressureSmoothing`, `typicalPressure`, `heavyPressure`) |
| 3 | text / image / shape items, a pencil stroke, a partially erased stroke, or pressure curve 4 | `"items"` per page, `tool: "pencil"`, stroke `cut` flags |

### Stroke `cut` (v3)

Bit field: `1` = the start was cut by the partial eraser, `2` = the end was cut. No synthetic taper
(and no lift-hook trimming) is applied at a cut end, so a fragment looks like a piece of the original.

### Items (v3)

After the strokes of a page: a line `],"items":[`, then one item per line (keys `id`, `type`, then
alphabetical; numbers rounded to 1/100 unit). Painted order: images, shapes, ink, text boxes.

```json
{"id":"i…","type":"text","align":"left","autoWidth":true,"bold":false,"color":"#1a1a1a","created":…,"font":"sans","h":29.6,"italic":false,"size":16,"text":"知行合一","w":72,"x":40,"y":60}
{"id":"i…","type":"image","created":…,"crop":[0.1,0,0.8,1],"h":100,"natH":400,"natW":800,"src":"attachments/Note image 20261018.png","w":200,"x":10,"y":10}
{"id":"i…","type":"shape","created":…,"fill":"#ffe066","fillOpacity":0.4,"h":40,"kind":"rect","stroke":"#c62828","strokeWidth":2,"w":80,"x":100,"y":200}
{"id":"i…","type":"shape","a":[180,220],"b":[300,230],"created":…,"fill":null,"fillOpacity":1,"from":{"ax":1,"ay":0.5,"id":"i…"},"h":10,"kind":"arrow","stroke":"#1a1a1a","strokeWidth":1.5,"to":{"ax":0,"ay":0.5,"id":"i…"},"w":120,"x":180,"y":220}
```

* `text`: `size` in pt; `autoWidth` = the box follows the text until the user resizes it.
* `image`: `src` is a vault path (attachment, Obsidian's attachment-folder setting) or a `data:` URL;
  `crop` is the visible part of the source, normalized.
* `shape`: `kind` ∈ rect, roundrect, ellipse, triangle, diamond, polygon (with normalized `points`),
  line, arrow, elbow (with end points `a`, `b`); connector ends may be attached (`from` / `to`:
  item id + normalized anchor) and follow that item.
* Unknown item types are skipped with a warning; the line-based recovery also salvages items.

## Version 4 (HandNote 0.4)

Written only when the note uses one of these (otherwise 1–3 as before); 0.3 opens v4 files
read-only.

| Where | Field | Meaning |
|---|---|---|
| stroke | `dash` | `"dash"` or `"dot"` line style (missing = solid). Dashes keep the pressure width; the pattern is computed along the centreline, identical on screen, PNG and SVG |
| stroke, item | `g` | group id (`[A-Za-z0-9_-]{1,64}`); all members are selected / moved together |
| box item | `rot` | rotation in radians around the box centre |
| shape | `dash` | line style of outlines and connectors |
| connector | `kind: "curve"` + `c` | quadratic Bézier control point (page units) |
| connector | `kind: "polyline"` + `pts` | interior vertices `[x0, y0, x1, y1, …]` (≤ 400 points) |
| connector | `arrowStart`, `arrowEnd`, `head` | arrow heads (`head`: `"open"` / `"filled"`; missing = filled; missing `arrowEnd` = legacy rule: arrow and elbow have an end head) |
| text | `font: "hand"`, `latex` | hand-lettering font; LaTeX source of a converted formula |
| image | `src: "asset:<id>"` | embedded image (see below) |

Embedded images: after the pages, a line `],"assets":[` and one asset per line —
`{"id":"a…","mime":"image/png","w":800,"h":600,"data":"<base64>"}`. Only referenced assets are
written. Readers accept png / jpeg / webp / gif up to 40 M base64 characters; damaged assets are
skipped with a warning and the line-based recovery salvages intact ones. Design rationale:
`docs/HANDNOTE_CONTAINER_DESIGN.md`.

Limits applied when reading items (also to AI results): coordinates clamped to ±100 000 units,
text ≤ 20 000 characters.


## Version 5 (HandNote 0.5)

A file is written as version 5 **only** when it contains one of the objects below. Every other note
is still written as version 1–4. HandNote 0.4 opens version-5 files read-only and never saves over
them.

### Formula item

```json
{"type":"formula","id":"…","x":40,"y":60,"w":180,"h":48,"created":0,"latex":"\\frac{a}{b}","color":"#1a1a1a","size":22}
```

- `latex` is the source; empty formulas are dropped when reading.
- `size` is the font size in page units.
- The box keeps the aspect ratio of the rendering: resizing scales `size`.
- Rendering: Obsidian's MathJax, snapshotted to the canvas (see `src/rendering/formula.ts`). Where
  that is not available, the source is drawn instead.

### Mind map item

```json
{"type":"mindmap","id":"…","x":40,"y":300,"w":420,"h":260,"created":0,"theme":"academic","layout":"balanced","scale":1,
 "root":{"id":"m1","text":"Topic","children":[{"id":"m2","text":"Branch","children":[],"collapsed":true}]}}
```

- Topic positions are **not** stored. `layoutMindMap(root, theme, layout)` computes them, and `x / y / w / h` are the laid-out bounds × `scale`.
- `theme` is one of `academic`, `hand`, `minimal`; `layout` is `balanced` or `right`.
- Limits applied when reading:
  - at most 500 topics and depth 12;
  - topic text at most 300 characters, control characters removed;
  - topic ids must match `[\w-]{1,40}` and be unique (otherwise replaced);
  - a mind map is never rotated.

### Shape label and vertical elbow

- Box shapes may have `"label":{"text":"…","size":13,"color":"#1f2933","font":"sans"}`. The text is drawn centred inside the shape and wrapped to its width (used for flowchart nodes).
- Elbow connectors may have `"vfirst":true`: the route goes vertical first, which suits top-down flowcharts.
