/**
 * What a file really is (0.9 document import). The extension is only a hint: the bytes decide.
 *
 *  - PDF: "%PDF-" in the first 1 KB (PDF readers accept a short prefix).
 *  - DOCX / PPTX / XLSX: a ZIP whose [Content_Types].xml names the main part of that format
 *    (word/document.xml, ppt/presentation.xml, xl/workbook.xml). Macro-enabled variants (.docm,
 *    .pptm, .xlsm) are recognised but refused — HandNote never runs macros and does not import
 *    them.
 *  - Legacy binary Office (.doc / .ppt / .xls): the OLE compound-file signature — recognised, not
 *    supported.
 *
 * The ZIP check reads only the central directory (no decompression): entry names, sizes and the
 * compression ratio, which also rejects ZIP bombs and absurd entry counts before anything is
 * inflated.
 */

export type DetectedKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'doc' | 'legacy-office' | 'macro-office' | 'zip' | 'csv' | 'unknown';

export interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

export interface Detection {
  kind: DetectedKind;
  /** Why the file is not accepted, when it is not. */
  problem?: string;
  /** ZIP entries (Office formats). */
  entries?: ZipEntry[];
}

import { Cfb } from './cfb';

export const LIMITS = {
  /** Largest file accepted for import (bytes). */
  maxFile: 200 * 1024 * 1024,
  /** Largest PDF page count imported. */
  maxPages: 2000,
  /** ZIP: most entries, largest total uncompressed size and largest ratio accepted. */
  maxEntries: 20000,
  maxUnzipped: 1024 * 1024 * 1024,
  maxRatio: 200,
};

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Central directory of a ZIP (throws on a damaged or hostile archive). */
export function zipEntries(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // end of central directory: last 22..(22+65535) bytes
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end of central directory)');
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) {
    // ZIP64: the locator is just before the EOCD
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('damaged ZIP64 archive');
    const z64 = Number(dv.getBigUint64(loc + 8, true));
    if (z64 < 0 || z64 + 56 > b.length || dv.getUint32(z64, true) !== 0x06064b50) throw new Error('damaged ZIP64 archive');
    count = Number(dv.getBigUint64(z64 + 32, true));
    cdSize = Number(dv.getBigUint64(z64 + 40, true));
    cdOff = Number(dv.getBigUint64(z64 + 48, true));
  }
  if (count > LIMITS.maxEntries) throw new Error(`too many entries in the archive (${count})`);
  if (cdOff + cdSize > b.length) throw new Error('damaged ZIP archive (central directory outside the file)');
  const out: ZipEntry[] = [];
  let p = cdOff;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('damaged ZIP archive (central directory)');
    const method = dv.getUint16(p + 10, true);
    let compressed = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff && q + 8 <= x + 4 + len) {
          size = Number(dv.getBigUint64(q, true));
          q += 8;
        }
        if (compressed === 0xffffffff && q + 8 <= x + 4 + len) {
          compressed = Number(dv.getBigUint64(q, true));
          q += 8;
        }
        if (offset === 0xffffffff && q + 8 <= x + 4 + len) offset = Number(dv.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    if (name.includes('\0') || name.length > 1024) throw new Error('damaged ZIP archive (entry name)');
    total += size;
    if (total > LIMITS.maxUnzipped) throw new Error('the archive unpacks to more than 1 GB');
    if (compressed > 0 && size / compressed > LIMITS.maxRatio && size > 10 * 1024 * 1024) throw new Error(`suspicious compression ratio in ${name}`);
    out.push({ name, method, compressed, size, offset });
    p = xEnd + commentLen;
  }
  return out;
}

const MAIN_PART: Record<'docx' | 'pptx' | 'xlsx', { part: string; types: RegExp; macro: RegExp }> = {
  docx: { part: 'word/document.xml', types: /wordprocessingml\.document\.main\+xml|wordprocessingml\.template\.main\+xml/, macro: /ms-word\.(document|template)\.macroEnabled/ },
  pptx: { part: 'ppt/presentation.xml', types: /presentationml\.(presentation|slideshow|template)\.main\+xml/, macro: /ms-powerpoint\.(presentation|slideshow|template)\.macroEnabled/ },
  xlsx: { part: 'xl/workbook.xml', types: /spreadsheetml\.(sheet|template)\.main\+xml/, macro: /ms-excel\.(sheet|template)\.macroEnabled/ },
};

/**
 * Identify a file from its bytes. `contentTypes` returns the text of [Content_Types].xml (the
 * caller inflates that one small entry; detection itself never inflates anything).
 */
export async function detectFormat(b: Uint8Array, name: string, contentTypes?: (e: ZipEntry) => Promise<string>): Promise<Detection> {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (b.length === 0) return { kind: 'unknown', problem: 'the file is empty' };
  if (b.length > LIMITS.maxFile) return { kind: 'unknown', problem: `the file is larger than ${LIMITS.maxFile / 1024 / 1024} MB` };
  if (ascii(b, 0, 1024).includes('%PDF-')) return { kind: 'pdf' };
  if (startsWith(b, OLE)) {
    // what the compound file holds decides, not the name
    let streams: string[] = [];
    try {
      streams = new Cfb(b).entries.filter((e) => e.type === 2).map((e) => e.name);
    } catch {
      return { kind: 'legacy-office', problem: `a damaged Office file (.${ext || 'doc'}) — open it in Office / WPS and save it again, or save it as PDF` };
    }
    if (streams.includes('EncryptionInfo') || streams.includes('EncryptedPackage')) return { kind: 'legacy-office', problem: `this file is password-protected (encrypted) — remove the password in Office / WPS, or save it as PDF` };
    if (streams.includes('WordDocument')) return { kind: 'doc' };
    if (streams.includes('PowerPoint Document')) return { kind: 'legacy-office', problem: 'an old PowerPoint 97–2003 file (.ppt) — save it as .pptx or as PDF (PowerPoint / WPS / Keynote) and import that' };
    if (streams.includes('Workbook') || streams.includes('Book')) return { kind: 'legacy-office', problem: 'an old Excel 97–2003 file (.xls) — save it as .xlsx or as PDF (Excel / WPS / Numbers) and import that' };
    return { kind: 'legacy-office', problem: `an old binary Office file (.${ext || '?'}) that is not a Word document — save it as .docx / .pptx / .xlsx or as PDF` };
  }
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) {
    let entries: ZipEntry[];
    try {
      entries = zipEntries(b);
    } catch (e) {
      return { kind: 'zip', problem: (e as Error).message };
    }
    const ct = entries.find((e) => e.name === '[Content_Types].xml');
    if (!ct) {
      const names = new Set(entries.map((e) => e.name));
      if (names.has('mimetype') && (names.has('content.xml') || names.has('styles.xml'))) {
        const kindOf = ext === 'odp' ? 'presentation' : ext === 'ods' ? 'spreadsheet' : 'document';
        return { kind: 'zip', problem: `an OpenDocument ${kindOf} (.odt / .odp / .ods, LibreOffice / WPS) — save it as .docx / .pptx / .xlsx or as PDF and import that`, entries };
      }
      if (entries.some((e) => e.name.startsWith('Index/') && e.name.endsWith('.iwa')) || names.has('Index.zip'))
        return { kind: 'zip', problem: 'an Apple Pages / Keynote / Numbers file — export it as Word / PowerPoint / Excel or as PDF (Share → Export) and import that', entries };
      return { kind: 'zip', problem: 'a ZIP archive, not a Word / PowerPoint / Excel document', entries };
    }
    let types = '';
    if (contentTypes) {
      if (ct.size > 2 * 1024 * 1024) return { kind: 'zip', problem: 'damaged Office document ([Content_Types].xml too large)', entries };
      try {
        types = await contentTypes(ct);
      } catch (e) {
        return { kind: 'zip', problem: `damaged Office document (${(e as Error).message})`, entries };
      }
    }
    for (const kind of ['docx', 'pptx', 'xlsx'] as const) {
      const m = MAIN_PART[kind];
      if (!entries.some((e) => e.name === m.part)) continue;
      if (m.macro.test(types)) return { kind: 'macro-office', problem: 'macro-enabled Office files are not imported (HandNote never runs macros) — save a copy as .docx / .pptx / .xlsx', entries };
      if (contentTypes && !m.types.test(types)) return { kind: 'zip', problem: 'unrecognised Office document type', entries };
      return { kind, entries };
    }
    return { kind: 'zip', problem: 'a ZIP archive, not a Word / PowerPoint / Excel document', entries };
  }
  if (ext === 'csv' || ext === 'tsv') return { kind: 'csv' };
  return { kind: 'unknown', problem: whatIsIt(b, ext) };
}

/**
 * The most specific explanation for content that is not PDF / OOXML. A cloud provider or a browser
 * sometimes hands over something else under the document's name (a sign-in page, a link file).
 */
function whatIsIt(b: Uint8Array, ext: string): string {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < b.length && i < 64 && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  const head = ascii(b, i, i + 512).toLowerCase();
  const named = ext ? ` (named .${ext})` : '';
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /^<\?xml[^>]*>\s*<html/.test(head))
    return `this is a web page (HTML), not a document${named} — often a sign-in or download page saved under the document's name. Download the real file in the cloud app (or open it in Files once) and import again`;
  if (head.startsWith('mime-version:') || head.includes('content-type: multipart/related')) return `this is a saved web page (MHTML, e.g. "Word Web page")${named} — open it in Word / WPS and save it as .docx or PDF`;
  if (head.startsWith('{\\rtf')) return `this is a Rich Text (RTF) file${named} — save it as .docx or PDF and import that`;
  if (head.startsWith('<?xml') && head.includes('schemas.microsoft.com/office/word')) return `this is a Word 2003 XML document${named} — save it as .docx or PDF and import that`;
  if (head.startsWith('{') && (head.includes('"url"') || head.includes('doc_id') || head.includes('resource_id') || head.includes('google'))) return `this is a cloud shortcut, not the file itself${named} (for example a Google Docs / Sheets / Slides document that exists only online). In the cloud app, download or export it as .docx / .pptx / .xlsx or PDF first`;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || startsWith(b, [0xff, 0xd8, 0xff]) || (b.length > 12 && ascii(b, 4, 8).startsWith('ftyp') && /heic|heix|mif1|avif/.test(ascii(b, 8, 12)))) return `this is a picture${named} — add it with Insert image instead`;
  if (b.length > 12 && ascii(b, 4, 8) === 'ftyp') return `this is a video or audio file${named}`;
  const text = b.subarray(i, Math.min(b.length, i + 2048));
  const printable = text.length && text.every((c) => c === 9 || c === 10 || c === 13 || c >= 32);
  if (printable) return `this is a plain text file${named}, not a PDF / Word / PowerPoint / Excel document`;
  return `the content is not a PDF, Word (.docx), PowerPoint (.pptx) or Excel (.xlsx) file${named}`;
}

/** Size and first bytes of a file, for the "details" of an import failure. */
export function describeBytes(b: Uint8Array, name: string): string {
  const hex = Array.from(b.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join(' ');
  const txt = ascii(b, 0, 32).replace(/[^\x20-\x7e]/g, '.');
  return `${name}: ${b.length} bytes; starts with ${hex || '(nothing)'}  "${txt}"`;
}

/** Lower-case hex SHA-256 (Web Crypto; available in Obsidian desktop and mobile). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const buf = new Uint8Array(view.byteLength);
  buf.set(view);
  const h = await crypto.subtle.digest('SHA-256', buf.buffer);
  return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('');
}
