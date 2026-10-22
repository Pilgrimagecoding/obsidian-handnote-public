/**
 * Remove control characters (no regular expression with control characters: the official lint
 * rules forbid them). `keepBreaks` keeps tab, line feed and carriage return; `bidi` also removes
 * the Unicode bidirectional embedding / isolate controls (U+202A–U+202E, U+2066–U+2069).
 */
export function stripControl(s: string, keepBreaks = true, bidi = false): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 && !(keepBreaks && (c === 0x09 || c === 0x0a || c === 0x0d))) continue;
    if (c === 0x7f && bidi) continue;
    if (bidi && ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))) continue;
    out += ch;
  }
  return out;
}
