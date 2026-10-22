# Editable object model (v0.4) and the AI Editable Scene

Two related schemas:

1. **Page objects** — what a `.handnote` file stores and the editor edits (format v4, see
   `docs/FILE_FORMAT.md` for the byte layout).
2. **HandNote Editable Scene** — the only shape in which AI output may enter HandNote. It is
   validated (`src/ai/scene.ts`) and then converted into page objects (`src/ai/convert.ts`).

## 1. Page objects

Every object has a stable `id` (random, prefix `s` for strokes, `i` for items), a position in page
units (1 unit = 1 pt; A4 = 595 × 842) and an implicit z-order: images, then shapes / connectors,
then ink (highlighter under pen), then text. Objects are immutable values; every edit replaces the
object and records one reversible history operation (`set-strokes`, `set-items`, `batch`, …).

| Concept (spec name) | Stored as | Key fields |
|---|---|---|
| InkStroke | `Stroke` | `tool`, `color`, `params` (pen snapshot), raw `samples` (x, y, pressure, time, tilt), `engine`, `cut`, **`dash`** (v4), **`g`** (v4) |
| TextObject | `TextItem` (`type: "text"`) | `text`, `size`, `font` (`sans`/`serif`/`mono`/**`hand`**), `bold`, `italic`, `align`, `autoWidth`, **`latex`** (formula source, v4), `rot`, `g` |
| ShapeObject | `ShapeItem` box kinds | `kind` rect/roundrect/ellipse/triangle/diamond/polygon, `stroke`, `strokeWidth`, `fill`, `fillOpacity`, `points` (normalized vertices), **`dash`**, **`rot`**, `g` |
| ConnectorObject | `ShapeItem` line kinds | `kind` line/arrow/elbow/**curve**/**polyline**, end points `a`, `b`; curve control point **`c`**; polyline vertices **`pts`**; attachments `from`/`to` `{id, ax, ay}`; **`arrowStart`**, **`arrowEnd`**, **`head`** (`open`/`filled`), **`dash`** |
| ImageObject | `ImageItem` | `src` (vault path, **`asset:<id>`** embedded, or data URL), `natW`, `natH`, non-destructive `crop`, `rot`, `g` |
| GroupObject | derived, not stored separately | every stroke / item with the same **`g`** id belongs to one group; the lasso selects groups as a whole |

Common item fields: `id`, `type`, `x`, `y`, `w`, `h` (for connectors: the path's bounding box,
recomputed from the geometry), `created`, **`rot`** (radians around the box centre, box items
only — connectors rotate their points), **`g`**.

Edit state (selection, editing text, drag in progress) is never stored. A document-level version
is the file `version` plus `revision` (incremented on every save; used for sync-conflict
detection).

### Defaults that keep older files unchanged

- Missing `dash` = solid. Missing `arrowEnd` = legacy rule: `arrow` and `elbow` have an end head,
  others not. Missing `head` = filled (the v0.3 look). Missing `rot` = 0.
- A file that uses none of the v4 fields is still written as version 1, 2 or 3.

### Planned (not implemented)

FormulaObject with rendered math, MindMapNode with automatic layout, DiagramObject. Today a formula
is a `TextItem` with `latex` (shown as its LaTeX source), and a mind map is boxes + attached lines.

### Hit testing

`hitItem()` works in page units with a tolerance of 8 screen px converted by the current zoom, so
selection accuracy is the same at every zoom. Rotated items are tested in their own frame;
connectors are tested against their sampled path (curves with 24 segments).

## 2. HandNote Editable Scene (schema version 1)

```jsonc
{
  "schemaVersion": 1,
  "sourceSelectionId": "sel…",          // set by HandNote, not the model
  "sourceBounds": { "x": 0, "y": 0, "w": 0, "h": 0 }, // page area of the uploaded image (HandNote)
  "objects": [
    { "id": "t1", "type": "text", "bbox": [x, y, w, h], "text": "…", "lines": 1, "confidence": 0.9 },
    { "id": "f1", "type": "formula", "bbox": [x, y, w, h], "latex": "a^2+b^2=c^2" },
    { "id": "s1", "type": "shape", "shape": "rect|roundrect|ellipse|triangle|diamond", "bbox": [x, y, w, h], "label": "…" },
    { "id": "c1", "type": "connector", "points": [[x, y], [x, y]], "from": "s1", "to": "s2",
      "arrowEnd": true, "arrowStart": false, "curved": false, "dashed": false, "label": "…" },
    { "id": "n1", "type": "mindmap_node", "bbox": [x, y, w, h], "text": "…", "parent": "n0" },
    { "id": "g1", "type": "group", "children": ["s1", "t1"] },
    { "id": "i1", "type": "image", "bbox": [x, y, w, h] }   // region reference only
  ],
  "relations": [{ "type": "parent|label|connects", "from": "n0", "to": "n1" }],
  "warnings": ["…"],
  "confidence": 0.85,
  "unresolvedItems": [{ "bbox": [x, y, w, h], "reason": "illegible" }]
}
```

Coordinates are normalized to the uploaded image (0 … 1), so the model never needs page units.

### Validation rules (`validateScene`)

| Check | Rule |
|---|---|
| Top level | must be an object; `schemaVersion` must be 1 (otherwise the whole answer is rejected) |
| Types | only the 7 object types above; unknown types are dropped and reported |
| Fields | unknown fields are ignored — in particular colours, URLs, HTML, styles and event handlers are never read |
| Numbers | finite; coordinates within −0.1 … 1.1 (clamped to 0 … 1); bbox width/height > 0 and ≤ 1.2 |
| Ids | 1–40 chars `[\w.:-]`, unique; duplicates dropped |
| References | connector `from`/`to`, node `parent`, group children and relations must point at existing objects; otherwise the reference is removed; parent cycles are broken |
| Limits | ≤ 300 objects, ≤ 2 000 characters per text, ≤ 20 000 characters in total, ≤ 50 points per connector, ≤ 20 warnings, answer ≤ 300 000 characters |
| Text | control and bidi-override characters removed; kept verbatim otherwise (never parsed as HTML/Markdown) |

The result is a clean scene plus a `dropped` list that the preview shows.

### Conversion (`sceneToItems`)

`text` → TextItem (size from the bbox height and line count, user's ink colour, "hand" or "sans"
font); `formula` → TextItem with `latex`; `shape` → ShapeItem + centred label TextItem in one group;
`connector` → line / curve (3+ points, `curved`) / polyline, attached to the shapes it references;
`mindmap_node` → rounded box + label, and an attached line to its parent; `group` → shared `g`;
`image` regions are ignored (HandNote never accepts generated image content). Colours and line
widths always come from the user's current style, never from the model.
