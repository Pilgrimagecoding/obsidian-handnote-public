import { peekHeader } from '../document/codec';

/**
 * Sync-safety decisions, kept free of Obsidian APIs so they can be unit tested.
 *
 * HandNote never overwrites a file whose on-disk revision is not the one this editor loaded (or
 * last wrote). That happens when Remotely Save (or any other sync) delivers a version written on
 * another device while this editor still has unsaved strokes. In that case the on-disk version is
 * preserved as a conflict copy before the local version is written, so neither side is lost.
 */

export type SaveDecision =
  | { action: 'write' }
  | { action: 'conflict'; reason: string }
  | { action: 'missing' };

export function decideSave(diskText: string | null, expected: { docId: string; revision: number }): SaveDecision {
  if (diskText === null) return { action: 'missing' };
  if (diskText.trim() === '') return { action: 'write' }; // brand-new empty file
  const h = peekHeader(diskText);
  if (h.id === null || h.revision === null) return { action: 'conflict', reason: 'on-disk file is not readable' };
  if (h.id !== expected.docId) return { action: 'conflict', reason: 'file was replaced by a different note' };
  if (h.revision !== expected.revision) {
    return {
      action: 'conflict',
      reason: `file changed on disk (revision ${h.revision}, expected ${expected.revision}${h.device ? `, device ${h.device}` : ''})`,
    };
  }
  return { action: 'write' };
}

/** What to do when the file changes on disk while it is open. */
export type ExternalChangeDecision = 'ignore-own-write' | 'reload' | 'keep-local-and-resolve-on-save';

export function decideExternalChange(
  diskText: string,
  state: { lastWrittenRevision: number; docId: string; dirty: boolean },
): ExternalChangeDecision {
  const h = peekHeader(diskText);
  if (h.id === state.docId && h.revision === state.lastWrittenRevision) return 'ignore-own-write';
  return state.dirty ? 'keep-local-and-resolve-on-save' : 'reload';
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** "folder/Name.handnote" -> "folder/Name (conflict 2026-10-18 1532).handnote" */
export function conflictCopyPath(path: string, date: Date, exists: (p: string) => boolean, tag = 'conflict'): string {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  let candidate = `${dir}${base} (${tag} ${stamp})${ext}`;
  let i = 2;
  while (exists(candidate)) {
    candidate = `${dir}${base} (${tag} ${stamp} ${i})${ext}`;
    i++;
  }
  return candidate;
}

export function randomDeviceId(): string {
  const a = Math.floor(Math.random() * 0xffffffff).toString(36);
  const b = Date.now().toString(36);
  return `dev-${b}-${a}`;
}
