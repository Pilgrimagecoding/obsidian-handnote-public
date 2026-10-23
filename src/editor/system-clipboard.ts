/**
 * The system clipboard (text and images copied in other apps).
 *
 * Two ways in, both standard web APIs (no private iOS interface):
 *  - the `paste` event (Ctrl/Cmd+V, Edit → Paste): its DataTransfer is readable without any prompt;
 *  - `navigator.clipboard.read()` / `readText()` from a tap in HandNote's own menu. On iPadOS /
 *    iOS (WebKit) the call must happen inside the tap, and the system then shows its own small
 *    "Paste" button that the user confirms; if the user dismisses it, or the platform refuses, the
 *    promise rejects and HandNote says so instead of pretending.
 *
 * HandNote's own copies (strokes, objects) stay in the in-memory clipboard of the lasso; the plain
 * text of a copy is also written to the system clipboard, and that text is remembered as a stamp so
 * pasting it back into HandNote restores the full objects (see `samePlain`).
 */

export type ClipboardContent =
  | { kind: 'image'; images: Blob[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  | { kind: 'denied'; message: string }
  | { kind: 'unsupported' };

/** Longest pasted text kept (characters); more is cut with a notice. */
export const MAX_PASTE_TEXT = 20000;
/** Largest pasted image (bytes) accepted. */
export const MAX_PASTE_IMAGE = 25 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif', 'image/tiff'];

interface ClipboardLike {
  read?: () => Promise<{ types: readonly string[]; getType(t: string): Promise<Blob> }[]>;
  readText?: () => Promise<string>;
}

function isImageType(t: string): boolean {
  return t.startsWith('image/') && t !== 'image/svg+xml'; // SVG could carry scripts: not accepted
}

/** What the user can paste from a clipboard event (no prompt involved). */
export function fromDataTransfer(dt: DataTransfer | null): ClipboardContent {
  if (!dt) return { kind: 'unsupported' };
  const images: Blob[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === 'file' && isImageType(it.type)) {
      const f = it.getAsFile();
      if (f) images.push(f);
    }
  }
  if (!images.length) for (const f of Array.from(dt.files ?? [])) if (isImageType(f.type)) images.push(f);
  if (images.length) return { kind: 'image', images };
  const text = dt.getData('text/plain');
  if (text && text.trim()) return { kind: 'text', text };
  return { kind: 'empty' };
}

/**
 * Read the system clipboard. Call it synchronously from a tap handler (iOS user-gesture rule): the
 * first await happens inside this function, after the platform call has been made.
 */
export async function readSystemClipboard(clip: ClipboardLike | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined): Promise<ClipboardContent> {
  if (!clip || (!clip.read && !clip.readText)) return { kind: 'unsupported' };
  let denied: string | null = null;
  if (clip.read) {
    try {
      const items = await clip.read();
      const images: Blob[] = [];
      let text: string | null = null;
      for (const item of items) {
        const img = item.types.find((t) => isImageType(t) && IMAGE_TYPES.includes(t)) ?? item.types.find(isImageType);
        if (img) {
          images.push(await item.getType(img));
          continue;
        }
        if (text === null && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
      if (images.length) return { kind: 'image', images };
      if (text && text.trim()) return { kind: 'text', text };
      if (items.length) return { kind: 'empty' };
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') denied = String((err as Error)?.message || name);
      // other errors (TypeError: not implemented for these types…): try readText below
    }
  }
  if (clip.readText && denied === null) {
    try {
      const text = await clip.readText();
      return text && text.trim() ? { kind: 'text', text } : { kind: 'empty' };
    } catch (err) {
      denied = String((err as Error)?.message || (err as { name?: string })?.name || 'denied');
    }
  }
  return denied !== null ? { kind: 'denied', message: denied } : { kind: 'empty' };
}

/** Normalize pasted text: line endings, control characters, length limit. */
export function cleanPastedText(raw: string): { text: string; truncated: boolean } {
  let s = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  // strip control characters except the newline
  s = Array.from(s)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 10 || (c >= 32 && c !== 127);
    })
    .join('');
  s = s.replace(/^\n+|\n+$/g, '');
  const truncated = s.length > MAX_PASTE_TEXT;
  return { text: truncated ? s.slice(0, MAX_PASTE_TEXT) : s, truncated };
}

/** True when the clipboard text is the plain text HandNote itself wrote for its last copy. */
export function samePlain(text: string, stamp: string | null): boolean {
  if (stamp === null) return false;
  const norm = (x: string) => x.replace(/\r\n?/g, '\n').trim();
  return norm(text) === norm(stamp);
}
