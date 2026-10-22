/**
 * Build edition, set by esbuild `define` (scripts/edition.mjs):
 *  - false (default): PUBLIC edition — no local math recognition (no weights, no download
 *    configuration, no inference code). Everything else is the same.
 *  - true: PRIVATE edition (HN_EDITION=private, private repository only) — adds local math recognition (src/private).
 */
declare const __HN_PRIVATE__: boolean;
