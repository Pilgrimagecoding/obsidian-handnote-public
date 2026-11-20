/**
 * Ink on Markdown (0.12): where the annotations of a Markdown note are kept.
 *
 * The Markdown file is never written. Its ink lives in an ordinary `.handnote` file in a visible
 * same folder as the note (visible to ordinary vault sync):
 *
 *   Courses/ML/Lecture 3.md  →  Courses/ML/Lecture 3.md.handnote
 */
export const ANNOTATION_FOLDER = 'HandNote annotations';

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

export function annotationPath(mdPath: string): string {
  return `${mdPath.replace(/^\/+/, '')}.handnote`;
}

/** Pre-beta.10 location, retained only for migrating existing annotations. */
export function legacyAnnotationPath(mdPath: string, folder = ANNOTATION_FOLDER): string {
  const base = mdPath.replace(/\.md$/i, '').replace(/^\/+/, '');
  return `${folder}/${base}.handnote`;
}

/** Map a child path when an enclosing folder is renamed; unrelated paths are unchanged. */
export function relocatedChild(path: string, oldFolder: string, newFolder: string): string {
  return path.startsWith(oldFolder + '/') ? newFolder + path.slice(oldFolder.length) : path;
}

/** The parent folder of a vault path ('' for the vault root). */
export function parentFolder(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}
