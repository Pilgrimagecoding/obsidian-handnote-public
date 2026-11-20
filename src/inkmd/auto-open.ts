import { parseDocument } from '../document/codec';

/**
 * Whether an annotation file holds ink or objects for the note at `mdPath` (the tab then opens with
 * its annotations shown). Mirrors InkFileStore.load: a file that belongs to another existing note
 * is not this note's.
 */
export function annotationHasInk(text: string | null, mdPath: string, isOtherNote: (path: string) => boolean): boolean {
  if (!text?.trim()) return false;
  try {
    const { doc } = parseDocument(text);
    if (!doc.annotates || (doc.annotates !== mdPath && isOtherNote(doc.annotates))) return false;
    return doc.pages.some((p) => p.strokes.length > 0 || (p.items?.length ?? 0) > 0);
  } catch {
    return false;
  }
}
