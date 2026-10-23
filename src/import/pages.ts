import { createPage, defaultBackground, newId, type DocKind, type DocSource, type Page } from '../document/model';

/** Pages for an imported document: one per document page, its size in points, plain white paper. */
export function documentPages(source: DocSource, sizes: { width: number; height: number }[]): Page[] {
  return sizes.map((s, i) => ({ ...createPage(s.width, s.height, defaultBackground('blank', 'white')), doc: { src: source.id, n: i + 1 } }));
}

/** A new source record for a file that is (now) in the vault at `path`. */
export function makeSource(kind: DocKind, path: string, size: number, sha256: string, pages: number): DocSource {
  return { id: newId('src'), kind, path, name: path.split('/').pop() ?? path, size, sha256, pages, imported: Date.now() };
}
