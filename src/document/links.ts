import type { HandNoteDocument } from './model';
import type { TextItem } from './items';

/**
 * Obsidian wikilinks in text boxes: `[[note]]`, `[[note#heading]]`, `[[note|shown text]]`. The
 * text keeps the link as typed (as Obsidian's source mode does); it is drawn as a link and a tap
 * opens it. The plugin indexes them for backlinks / the graph and retargets them on rename.
 */
export interface TextLink {
  /** offsets in the text: the whole `[[…]]` */
  start: number;
  end: number;
  /** link path as typed (no heading / alias), trimmed */
  target: string;
  /** `#heading` or `#^block`, or '' */
  subpath: string;
  /** text after `|`, or null */
  alias: string | null;
}

const LINK_RE = /\[\[([^[\]|#^\n]*)((?:#\^?|\^)[^[\]|\n]*)?(?:\|([^[\]\n]*))?\]\]/g;

export function findLinks(text: string): TextLink[] {
  const out: TextLink[] = [];
  if (!text.includes('[[')) return out;
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) {
    const target = m[1].trim();
    if (!target) continue;
    out.push({ start: m.index, end: m.index + m[0].length, target, subpath: m[2] ?? '', alias: m[3] ?? null });
  }
  return out;
}

/** Every link in the document's text boxes (all pages), in order. */
export function documentLinks(doc: Pick<HandNoteDocument, 'pages'>): TextLink[] {
  const out: TextLink[] = [];
  for (const page of doc.pages) for (const it of page.items ?? []) if (it.type === 'text') out.push(...findLinks(it.text));
  return out;
}

/**
 * The text with every link whose target `matches` pointing to `next` instead (heading and alias
 * kept). Returns the same string when nothing matched.
 */
/**
 * Whether link path `target` (as typed) names the file at `path`: the whole path or its end, with
 * or without the `.md` extension — Obsidian's matching of a link to a file.
 */
export function linkNames(target: string, path: string): boolean {
  const t = target.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const p = path.toLowerCase();
  const names = p.endsWith('.md') ? [p, p.slice(0, -3)] : [p];
  return names.some((n) => n === t || n.endsWith('/' + t));
}

export function retargetLinks(text: string, matches: (target: string) => boolean, next: string): string {
  const links = findLinks(text).filter((l) => matches(l.target));
  if (!links.length) return text;
  let out = '';
  let at = 0;
  for (const l of links) {
    out += text.slice(at, l.start) + `[[${next}${l.subpath}${l.alias !== null ? `|${l.alias}` : ''}]]`;
    at = l.end;
  }
  return out + text.slice(at);
}

/**
 * Retarget the links of every text box of the document (in place); `fit` sizes a changed box to
 * its new text. Returns true when a text changed.
 */
export function retargetDocument(doc: Pick<HandNoteDocument, 'pages'>, matches: (target: string) => boolean, next: string, fit: (it: TextItem) => TextItem = (it) => it): boolean {
  let changed = false;
  for (const page of doc.pages) {
    if (!page.items?.some((it) => it.type === 'text' && it.text.includes('[['))) continue;
    page.items = page.items.map((it) => {
      if (it.type !== 'text') return it;
      const text = retargetLinks(it.text, matches, next);
      if (text === it.text) return it;
      changed = true;
      return fit({ ...it, text });
    });
  }
  return changed;
}
