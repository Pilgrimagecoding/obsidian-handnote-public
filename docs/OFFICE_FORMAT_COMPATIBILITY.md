# PDF / Word / PowerPoint / Excel — libraries, existing plugins and support levels

Research for the 0.9 import work (2026-10-23; updated with the Phase 3 decision). Versions and licences are from the npm registry on
that date; nothing below is installed yet unless marked **in use**.

## Current support (HandNote 0.9.0)

| Format | Level | What works | What does not |
|---|---|---|---|
| PDF (.pdf) | **Supported (development build)** | import from device or vault, one page per PDF page in its own size, on-demand rendering, ink / objects on top, undo, save / reopen, rename / move tracking, missing-file placeholder, PNG export, Markdown embed | text selection, links, outline, annotated-PDF export, SVG export of the PDF layer |
| Word (.docx) | **Supported (development build), approximate layout** | import from device or vault; fixed pages computed once at import and stored next to the original (`<file>.handnote-layout.json`); section page sizes and margins (portrait / landscape); paragraph styles, headings, alignment (left / centre / right), indents, spacing, line spacing, contextual spacing, keep-with-next; bold / italic / underline / strike / colour / size / highlight / super- and subscript; bullets and numbered lists (nested levels, decimal / letters / roman / Chinese counting); manual line and page breaks, page-break-before; tabs; inline pictures (PNG / JPEG / GIF / BMP / WebP from the file itself); tables (column widths, merged cells horizontally and vertically, cell shading, table-style and per-cell borders, cell margins, rows never split across pages); CJK line breaking with punctuation rules; same ink / undo / save / rename / export behaviour as PDF pages | page breaks are HandNote's own, not Word's; justified text is shown left-aligned; headers / footers, footnotes / endnotes, comments, text boxes, floating-picture wrapping (pictures are placed in the text flow), charts, SmartArt, equations, embedded objects (OLE, embedded HTML), fields such as page numbers / TOC page numbers, columns, right-to-left text; SVG / EMF / WMF / TIFF pictures show a placeholder; fonts are mapped to families present on desktop and iPad — glyph shapes differ from Word |
| PowerPoint (.pptx) | **Supported (development build), static slides** | one page per slide in the slide size (16:9, 4:3, custom); layout computed once at import and stored like Word's; backgrounds (colour, picture, theme reference); master and layout shapes under the slide's (unless hidden); placeholders inheriting position, body properties and text styles from layout and master; theme colours through the colour map with lumMod / lumOff / tint / shade / satMod / alpha; theme fonts; preset geometries (rectangle, rounded rectangle, ellipse, triangle, diamond, parallelogram, trapezoid, pentagon, hexagon, octagon, chevron, arrows, stars, plus, flow-chart basics, callout boxes), free-form paths (lines, Béziers, arcs), lines and connectors with dashes and arrow heads, rotation and flips; pictures with crop, rotation, flips; groups (nested transforms); tables (column widths, row heights, spans, cell fills and borders, cell margins and anchoring, PowerPoint's default table style and table styles stored in the file); text: bullets (characters incl. Wingdings / Symbol mapped), automatic numbering, levels, indents, alignment, vertical anchoring, insets, no-wrap, line / paragraph spacing, autofit font scale and spacing reduction, bold / italic / underline / strike / colour / size / super- and subscript, hyperlinks shown in the theme's link colour; page thumbnails | animations and transitions (the slide is shown with everything visible), charts, SmartArt, video / audio (poster picture only), equations, ink, rotated text (drawn upright), vertical text, text columns, gradients and patterns (one colour), shadows / glow / reflections / 3-D, rotated groups, shapes outside the list above (drawn as their box, listed), speaker notes, embedded fonts (fonts are mapped as for Word) |
| Excel (.xlsx) | **Supported (development build), printed onto A4 pages** | every visible sheet printed onto A4 paper (portrait, landscape when the used columns are wider), cells at their real size from the top-left margin, the rest of the page free for notes (OneNote-style); pages go down, then across, never cutting a merged range when avoidable; each page shows the sheet name and range, column letters and row numbers, gridlines (unless turned off), cell fills, borders (styles, colours, widths, dashes), merged cells, fonts (size, bold, italic, underline, strike, colour incl. theme colours with tint and the indexed palette), horizontal / vertical alignment, indent, wrapped text (rows grown like Excel's auto-fit), text running over empty neighbours, rotated text, `###` for numbers that do not fit; values through their number formats (General, decimals, thousands, percent, scientific, currency, negative / zero / text sections, colours, dates and times in both date systems incl. the Chinese built-ins, elapsed time); shared and inline strings, booleans, error values; hidden rows / columns / sheets left out; pictures anchored to cells (split across pages when needed); every page stores its cell grid, so a point (an annotation) maps to its cell (`'Sheet'!C12`); large layouts stored gzip-compressed | **formulas are not recalculated**: the results Excel / WPS / LibreOffice stored last are shown, and a formula with no stored result stays empty (noted); macros never run; external links not read; charts, conditional formatting, data bars / icon sets, sparklines, comments / notes, pivot-table interactivity, form controls, freeze panes, print areas and page setup, pattern fills (one colour); merged ranges across a page break are shown on each page; files above 400 000 filled cells are refused (save the needed range as PDF) |
| Word 97–2003 (.doc) | **Supported (development build), simplified** | own compound-file and binary-Word reader (`src/import/cfb.ts`, `src/import/doc.ts`), converted to the parts the Word layout reads: text (8-bit and UTF-16 pieces), the document's own paragraph styles (names, sizes, bold, alignment, spacing; headings keep with the next paragraph), runs (bold, italic, underline, strike, size, colour, font, highlight, super- / subscript), page and line breaks, tabs, field results, tables (cell boundaries → column widths, horizontal and vertical merges, cell borders), page size and margins of the first section | pictures and drawings, bullets and numbering, headers / footers, footnotes, comments, text boxes, later sections' page sizes, Word 95 and older files; password-protected files are refused; nothing in the file is run (no macros) |
| .ppt / .xls (binary) | **Not supported** | recognised from the compound file's streams and refused with advice (save as .pptx / .xlsx or PDF) | — |
| .docm / .pptm / .xlsm (macros) | **Refused** | recognised; macros are never run | — |
| CSV | Not yet | — | Phase 5 candidate |

## Existing Obsidian plugins (what can be learned, what can be reused)

| Plugin | Approach | Licence | Notes for HandNote |
|---|---|---|---|
| Handwriting Natively (`native-pdf-handwriting`, github.com/marsluay/handwriting-natively) | ink over PDFs / images / Markdown, sidecar annotation files, flattened PDF export | MIT | confirms the sidecar idea; HandNote instead keeps annotations in the `.handnote` note (one file to sync, existing save safety) |
| Ink Annotation (`ink-annotation`) | overlay on Obsidian's PDF / Markdown views, `.ink.json` per file in the plugin folder | GPL-3.0 (Basic) | GPL — code not reusable in MIT HandNote; plugin-folder storage does not sync with some tools |
| OPPO Pad PDF Annotation (`oppopad-pdf-annotation`) | overlay on Obsidian's native PDF reader, normalized page coordinates, `annotations.json` in the vault | MIT | same coordinate idea (page-normalized); HandNote uses PDF points directly |
| Obsidian core PDF viewer | PDF.js (bundled with Obsidian), `loadPdfJs()` in the public API | Obsidian | **in use**: HandNote renders pages with it — no PDF.js copy in `main.js`, no download, works on iPad |

## Libraries evaluated

| Library | Version · licence | Size / deps | Fit | Decision |
|---|---|---|---|---|
| pdfjs-dist | 6.4.299 · Apache-2.0 | 35 MB package | the engine Obsidian already ships | **not bundled** — `loadPdfJs()` instead |
| mammoth | 1.13.0 · BSD-2-Clause | 1.7 MB; jszip, xmldom, underscore… | semantic DOCX → HTML (headings, lists, tables, images); no page layout | Phase 3 candidate: simple, safe output (needs sanitizing) |
| docx-preview | 0.4.1 · Apache-2.0 | 1 MB; jszip | renders DOCX with page breaks, styles, closer to Word | Phase 3 candidate for a fixed "snapshot" page layout |
| SheetJS (xlsx) | 0.18.5 on npm · Apache-2.0 | 7.5 MB | the npm build is old and has published advisories (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363); fixed builds are only on cdn.sheetjs.com | **not from npm**; only a pinned, audited tarball would be acceptable |
| ExcelJS | 4.4.0 · MIT | 21.8 MB; many Node-oriented deps (archiver, unzipper, tmp) | heavy for the browser, last release 2024 | not preferred |
| read-excel-file | 9.3.12 · MIT | 2.7 MB; fflate | reads values / dates; little styling | Phase 5 candidate for values; styles / merges need own parsing |
| fflate | 0.8.3 · MIT | 0.8 MB, no deps | fast, small ZIP / inflate with size control | likely base for own OOXML readers (XLSX cells, PPTX slides) |
| jszip | 3.10.2 · MIT or GPL-3.0 | 0.7 MB | used by mammoth / docx-preview | only as their dependency |
| pptx-preview | 1.0.7 · ISC | 1.8 MB; lodash, echarts | renders slides to HTML | heavy (echarts); quality to be tested |
| pptxviewjs | 1.1.9 · MIT | 4.3 MB | canvas renderer | repository not listed; provenance to be checked |
| pptx-browser | 4.1.5 · MIT | 0.4 MB | renders slides in the browser | repository not listed; to be evaluated |
| DOMPurify | 3.4.17 · MPL-2.0 or Apache-2.0 | 1.6 MB | HTML sanitizer for DOCX → HTML | Phase 3 (if HTML conversion is used) |

Rules for any library that is added: exact version in `package.json` + `package-lock.json`, bundled
into `main.js` (no runtime download of JS / WASM), licence text in `THIRD_PARTY_NOTICES.md`,
`npm audit` clean, no Node APIs on mobile, and it must not run file content as code.

## Plan per format

- **DOCX (Phase 3, implemented in the development build):** HandNote's own reader and layout
  (`src/import/docx.ts`, `xml.ts`, `zip.ts`, `flow.ts`), no new dependency. Why not the candidates
  above: mammoth produces semantic HTML without pages; docx-preview produces paged HTML DOM, and a
  DOM cannot be turned into canvas pixels on iPad without html2canvas-style re-implementation or
  SVG `foreignObject` (which taints / breaks canvases on WebKit). Both would also need DOMPurify and
  jszip (≈ 3–4 MB). The own reader parses only the OOXML parts it needs, with no DTD / entity
  support, size caps on every ZIP entry and XML part, and never follows external relationships.
  The layout is computed **once at import** (canvas text measurement) into a display list stored
  next to the original; every device draws the same lines at the same positions, so ink never
  drifts. When the stored layout is lost it is computed again from the original (with a notice: on
  another device the fonts may differ slightly). "Save as PDF" stays the recommended path for
  pixel-exact Word output.
- **PPTX (Phase 4, implemented in the development build):** own reader (`src/import/pptx.ts`) on
  the same ZIP / XML / text-flow / stored-layout foundation as Word — no new dependency. Candidates
  above were not used: pptx-preview pulls in echarts and lodash (1.8 MB) and renders HTML;
  pptxviewjs / pptx-browser have no listed source repository, so their provenance could not be
  checked. Slides are fixed-position by nature, so the stored layout mainly fixes the text line
  breaks. Compared with LibreOffice renderings of the test decks (python-pptx and a LibreOffice
  round trip): same backgrounds, positions, colours, bullets, tables, groups, crops and rotations.
  For decks that rely on charts, SmartArt or animation builds, "export to PDF in PowerPoint /
  Keynote / WPS" stays the recommended path — the import notice lists what was left out.
- **XLSX (Phase 5, implemented in the development build, option A "fixed pages"):** own reader
  (`src/import/xlsx.ts`, number formats in `src/import/numfmt.ts`) on the same foundation — no new
  dependency (the npm `xlsx` 0.18.5 build has unfixed advisories; ExcelJS is heavy and Node-oriented).
  Sheets are cut into pages that are frozen at import like Word pages, so ink never moves; each page
  records its rows and columns, so annotations can be traced to cells. Option B (notes that follow
  cells when the workbook changes) would need a new note format and is not built. Cached formula
  results only; the import notice says so whenever a workbook has formulas.
