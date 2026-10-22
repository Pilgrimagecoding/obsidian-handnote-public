import { normalizePath, requestUrl, type DataAdapter } from 'obsidian';
import { setHandFont } from '../rendering/items-paint';

/**
 * Optional handwriting-style font: LXGW WenKai Lite (霞鹜文楷 轻便版), SIL Open Font License 1.1,
 * https://github.com/lxgw/LxgwWenKai-Lite — Chinese (simplified + traditional) and Latin.
 *
 * Nothing is downloaded unless the user presses "Download font" in the settings. The file is
 * fetched from the pinned GitHub release, its SHA-256 is checked against the value below (any
 * other content is discarded) and it is stored in the plugin folder. It is then loaded with the
 * FontFace API; the "hand" text style and the hand-drawn theme use it first.
 */

export const HAND_FONT = {
  family: 'LXGW WenKai Lite',
  version: '1.522',
  url: 'https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.522/LXGWWenKaiLite-Regular.ttf',
  sha256: '140c99ba4e28e817cec49bf82a0c5fcdc4fe633fb9dfda16d0ee8d59a8545f15',
  bytes: 13872424,
  file: 'LXGWWenKaiLite-Regular.ttf',
  license: 'SIL Open Font License 1.1',
};

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class HandFont {
  private face: FontFace | null = null;
  private docs = new WeakSet<Document>();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly dir: string,
  ) {}

  private get path(): string {
    return normalizePath(`${this.dir}/fonts/${HAND_FONT.file}`);
  }

  async installed(): Promise<boolean> {
    try {
      return await this.adapter.exists(this.path);
    } catch {
      return false;
    }
  }

  get loaded(): boolean {
    return !!this.face;
  }

  /** Load the installed font (startup). Never throws. */
  async load(): Promise<boolean> {
    try {
      if (!(await this.installed())) return false;
      const buf = await this.adapter.readBinary(this.path);
      if (buf.byteLength !== HAND_FONT.bytes) return false;
      return this.register(buf);
    } catch (e) {
      console.warn('HandNote: hand font not loaded', e);
      return false;
    }
  }

  private async register(buf: ArrayBuffer): Promise<boolean> {
    const face = new FontFace(HAND_FONT.family, buf, { style: 'normal', weight: '400', display: 'swap' });
    await face.load();
    this.face = face;
    this.attach(document);
    setHandFont(HAND_FONT.family);
    return true;
  }

  /** Make the font available in another window (popout editors). */
  attach(doc: Document): void {
    if (!this.face || this.docs.has(doc)) return;
    try {
      doc.fonts.add(this.face);
      this.docs.add(doc);
    } catch {
      /* ignore */
    }
  }

  /** Download (after the user's consent), verify, store, load. */
  async download(): Promise<'ok' | 'bad-hash' | 'failed'> {
    try {
      const res = await requestUrl({ url: HAND_FONT.url, method: 'GET', throw: false });
      if (res.status !== 200) return 'failed';
      const buf = res.arrayBuffer;
      if ((await sha256Hex(buf)) !== HAND_FONT.sha256) return 'bad-hash';
      const folder = normalizePath(`${this.dir}/fonts`);
      if (!(await this.adapter.exists(folder))) await this.adapter.mkdir(folder);
      await this.adapter.writeBinary(this.path, buf);
      return (await this.register(buf)) ? 'ok' : 'failed';
    } catch (e) {
      console.warn('HandNote: font download failed', e);
      return 'failed';
    }
  }

  async remove(): Promise<void> {
    try {
      if (await this.installed()) await this.adapter.remove(this.path);
    } catch {
      /* ignore */
    }
    if (this.face) {
      try {
        document.fonts.delete(this.face);
      } catch {
        /* ignore */
      }
    }
    this.face = null;
    setHandFont(null);
  }
}
