/**
 * Ink on Markdown (0.12): where the annotations of a Markdown note are kept.
 *
 * The Markdown file is never written. Its ink lives in an ordinary `.handnote` file in a visible
 * folder of the vault (not a hidden "." folder: sync plugins such as Remotely Save skip those by
 * default), mirroring the note's path:
 *
 *   Courses/ML/Lecture 3.md  →  HandNote annotations/Courses/ML/Lecture 3.handnote
 */
export const ANNOTATION_FOLDER = 'HandNote annotations';

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

export function annotationPath(mdPath: string, folder = ANNOTATION_FOLDER): string {
  const base = mdPath.replace(/\.md$/i, '').replace(/^\/+/, '');
  return `${folder}/${base}.handnote`;
}

/** The parent folder of a vault path ('' for the vault root). */
export function parentFolder(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}
