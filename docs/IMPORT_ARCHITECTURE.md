# Document import and annotation — architecture (0.9, in development)

Status: released in **HandNote 0.9.0** — long-press paste, import infrastructure, PDF, Word
(.docx, .doc), PowerPoint (.pptx) and Excel (.xlsx, A4 pages).

## Principles

1. **Content and ink are separate.** The imported page is a read-only layer painted under the page;
   ink, text boxes, shapes and images stay in the note as before.
2. **The original file is never modified and never stored inside the note.** It stays a separate
   vault file; the note keeps a reference (`sources` in the header) with its size and SHA-256.
3. **Stable coordinates.** A document page becomes a HandNote page of exactly the document page's
   size in points (1 page unit = 1 pt, the same unit HandNote already uses — A4 = 595 × 842). Ink is
   stored in page units, so zoom, scroll, page changes, reopening and other devices cannot shift it.
4. **On the device only.** PDF pages are rendered by the PDF.js that ships with Obsidian
   (`loadPdfJs()`), desktop and mobile. Nothing is downloaded, nothing is uploaded, no CDN worker.
5. **Backward compatible.** Notes without imported pages are written exactly as before (format
   1–5). Only notes with document pages are written as format **6**; HandNote 0.8 opens them
   read-only instead of dropping the references on save.

## File format v6

Header line (also kept by line-based recovery of damaged files):

```json
{"format":"obsidian-handnote","version":6, …, "sources":[
  {"id":"src…","kind":"pdf","path":"Attachments/Lecture 3.pdf","name":"Lecture 3.pdf",
   "size":482113,"sha256":"…64 hex…","pages":24,"imported":1761140000000}]}
```

Page header: `{"id":"p…","width":595,"height":842,"background":{…},"doc":{"src":"src…","n":3}, "strokes":[…`

Word / PowerPoint / Excel sources also carry `"layout":"Attachments/Report.docx.handnote-layout.json"`
(the stored page layout, see below). The layout itself is never written into the note.

- Only sources referenced by a page are written (like embedded images).
- Every field is validated on read (`validateSource`, `validatePageHeader`): unknown kinds, bad ids,
  empty paths, page numbers < 1 are dropped with a warning; a malformed SHA-256 is cleared.

## Modules

| Module | Role |
|---|---|
| `src/import/detect.ts` | Real format from the bytes: `%PDF-`, OOXML ZIP (main part + `[Content_Types].xml`), OLE (old .doc/.ppt/.xls → refused), macro-enabled OOXML (refused). Reads only the ZIP central directory: entry count, total size and compression ratio limits (ZIP bombs) before anything is inflated. SHA-256 via Web Crypto. |
| `src/import/pdf.ts` | PDF.js subset: open with `isEvalSupported:false`, `enableXfa:false`, no streaming / auto-fetch; page sizes (rotation applied, absurd sizes capped); `PdfRenderer` renders one page into a canvas, keeps the last 3 documents open. |
| `src/import/pages.ts` | Pages for a source (one per document page, its size, white paper) and the source record. |
| `src/rendering/doc-layer.ts` | Painter + cache: on-demand rasterization per visible page at a zoom bucket (powers of two, longest side ≤ 4096 px), newest request first, stale requests (page scrolled away for 1.5 s) dropped, LRU pixel budget (iPad / phone 24 MP ≈ 96 MB, desktop 64 MP), failures per file (missing, damaged, unsupported) or per page, placeholders with the reason, `ensureDocPage` for PNG export and embeds. |
| `src/plugin/import.ts` | Obsidian: import dialog (this device via the system file picker — iPadOS Files — or a vault file), progress with Cancel, duplicate detection (same size + SHA-256 → reuse the vault file), storing the original with Obsidian's attachment-folder setting, rollback, file-explorer "Annotate in HandNote", rename tracking, relinking by SHA-256 when the file moved while the note was closed. |
| `src/import/zip.ts`, `src/import/xml.ts` | Office reading without a library: ZIP entries inflated with the platform `DecompressionStream` (iPadOS 16.4+), every entry capped (declared size checked while inflating, 64 MB per part); a small XML reader with no DTD / entity support at all, size / depth / element-count limits. |
| `src/import/flow.ts` | Line breaking: Latin at spaces (over-long words split), CJK between characters, closing punctuation never starts a line, opening punctuation never ends one, tabs, manual breaks, inline pictures. |
| `src/import/docx.ts` | Word → display list: styles (defaults, basedOn chains, table styles), numbering, theme fonts, sections, paragraphs, runs, lists, tables, pictures; page flow with keep-with-next and unsplittable table rows. |
| `src/import/pptx.ts` | PowerPoint → display list: slide order, slide size, master / layout / slide inheritance (placeholders, text styles, backgrounds), theme colours and fonts, preset and free-form geometry, pictures, groups, tables, text bodies. One page per slide. |
| `src/import/cfb.ts`, `src/import/doc.ts` | Compound files (sector chains checked, loops cut, streams capped) and Word 97–2003: piece table, paragraph / character property runs (FKPs), stylesheet, table definitions, first section's page setup → WordprocessingML parts for the Word layout. Detection tells .doc / .ppt / .xls / encrypted files apart by their streams. |
| `src/import/xlsx.ts`, `src/import/numfmt.ts` | Excel → display list: workbook, sheets, shared strings, styles (fonts, fills, borders, alignment, number formats, theme / indexed colours), merged cells, column widths and row heights, pictures from drawings; pagination; the cell grid of each page and `cellAt`. Number formats as Excel shows them. |
| `src/import/display-list.ts` | The stored page layout (`DisplayList`: text runs, rectangles, lines, pictures by ZIP part name, in points), its validation when read back (untrusted vault file) and its painter. Text drawn on a device whose font is wider than the importing device's is squeezed to the stored width, so it never runs into the next run. |
| `src/import/office-render.ts` | Page renderer for Office sources: stored layout + pictures decoded on demand from the original ZIP (raster formats only, never larger than 4× the drawn size, 24 MP picture budget). |
| `src/editor/handnote-editor.ts` | `insertDocumentPages` (one undo step; replaces an untouched blank page), sources registry, repaint when a page finished rendering. |

## Import flow

1. Pick: *From this device* (`<input type=file>` opened inside the tap — iPadOS shows Files) or *From
   the vault* (fuzzy picker), or file explorer → *Annotate in HandNote* on a PDF.
2. Size limit (200 MB), real format detection, SHA-256.
3. Open the PDF (a damaged or password-protected file fails here, before anything is written), read
   the page sizes (progress, cancellable), page limit 2000.
4. Original: the vault file itself; or an identical vault file (reused, no second copy); or a new
   copy at Obsidian's attachment location.
5. New note (named after the file) or pages inserted after the current page (one undo step).
6. Any failure or Cancel after step 4 trashes the copy this import created (`fileManager.trashFile`,
   respecting the user's trash setting). Nothing else is deleted, ever.

## Word and PowerPoint pages: the stored layout

Word documents have no fixed pages: line and page breaks depend on the fonts of the device. Ink needs
a page that never moves, so the layout is computed **once at import** and stored as
`<original>.handnote-layout.json` next to the original (a small JSON file that syncs like any vault
file; Obsidian does not list `.json` files in the file explorer by default). It records the SHA-256
of the original it was computed from.

- Importing the same file again reuses the stored layout (identical pages for every note).
- A layout file is never overwritten; when the original changed, a new one is written beside it
  (`<original>.<sha8>.handnote-layout.json`).
- Lost layout (deleted, not synced): looked for next to the original, else **computed again** from
  the original and stored, with a notice (same result on the same device; on another device the
  text may sit slightly differently under the ink).
- Renaming the original keeps the layout where it is (its path is in the note); renaming the layout
  inside Obsidian is followed like the original.
- A failed or cancelled import trashes the layout file it created, like the copy of the original.

Layouts above 1 MB (large spreadsheets, long documents) are stored gzip-compressed as
`<original>.handnote-layout.json.gz` (CompressionStream; a 200 000-cell sheet: 18 MB → 2 MB).

## Picking a file on iPad, and when an import fails

- The picker is in selection mode (`multiple`): on iPadOS each file gets a circle when tapped and
  *Open* confirms (as in GoodNotes); several files are imported one after another (into the open
  note: one after another, in the order picked).
- Originals picked from the device are stored once in the folder set in the settings (default
  `HandNote imports`; empty = Obsidian's attachment location). Files annotated where they already
  are in the vault are never copied; the same bytes imported again reuse the vault file.
- *From this device* closes the import dialog and opens the system picker from an input element in
  the page body, inside the same tap (iPadOS requires the tap; a picker presented over an open
  dialog could leave the window unresponsive). The accepted types include
  `application/octet-stream`, so no file is greyed out in Files: HandNote identifies the content
  itself and explains what it cannot import (a .doc, a Pages / Keynote / Numbers file, an
  OpenDocument file, a web page or cloud shortcut saved under a document's name, a picture…).
- The picked file is read in 8 MB pieces with progress and Cancel. A read error or a 0-byte file is
  explained as a cloud file that has not been downloaded yet.
- A failure opens a dialog (it stays until closed) naming the step (reading, identifying, opening the
  PDF, laying out, storing the original, creating the note), the reason, the file size and its first
  bytes, with *Copy details* for a bug report.
- The stored copy of a picked file always carries the extension of what it really is.

## Missing, moved, renamed sources

| Situation | Behaviour |
|---|---|
| Renamed / moved inside Obsidian while the note is open | `vault.on('rename')` updates the reference and saves the note |
| Moved while the note was closed (other device, sync, file manager) | On open, a file with the same extension, size and SHA-256 is looked for (≤ 12 candidates read); reference updated and saved |
| Missing | The annotations stay; each page shows "Document not found: name" (no stale pixels); nothing is written to the source |
| The file comes back (sync, restore, renamed back) | `create` / `rename` events clear the failure and repaint |
| Same bytes imported again | The existing vault file is reused |

## Security

- PDF: no JavaScript (PDF.js scripting not enabled), no XFA, no eval, no network (bytes passed in).
- Office: ZIP limits before inflating and while inflating; XML without DTD / external entities;
  macros never executed and macro-enabled files refused; legacy binary formats and password-protected
  (encrypted) files refused with advice. Word content is drawn as text on a canvas — no HTML, no DOM
  insertion, nothing executed. External relationships (remote pictures, linked files) are ignored;
  only pictures stored inside the file are decoded, and only raster formats (no SVG, EMF, WMF).
  Embedded objects (OLE, `altChunk` HTML / RTF) are never rendered; the import notice lists them.
- A stored layout file is validated when read: unknown operations, bad numbers, colours and picture
  paths are dropped.
- SVG images are not accepted from the clipboard (could carry scripts).
- Strings and numbers from files are validated and capped.

## Not done yet (honest list)

- PowerPoint: see the support table (animations, charts, SmartArt, effects and rotated text are not
  reproduced).
- Word: see the support table in `OFFICE_FORMAT_COMPATIBILITY.md` (headers / footers, footnotes,
  text boxes, charts, equations, justified text and Word's own page breaks are not reproduced).
- PDF text selection / search, PDF links, PDF outline navigation.
- Exporting the annotated PDF (flattened). Not claimed anywhere.
- SVG page export does not include the PDF page (PNG export does).
- Thumbnails in the page sidebar show the PDF page only once it was rendered.
- Real iPad acceptance (memory with large PDFs, Files picker, Pencil latency on PDF pages) — see
  `IMPORT_DEVICE_ACCEPTANCE.md`.
