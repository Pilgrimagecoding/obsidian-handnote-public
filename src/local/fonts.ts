import { fontsChanged, setHandFontStack } from '../rendering/items-paint';
import { FONT_FILES } from './font-pack.generated';
import type { ModelStore } from './store';

/**
 * Excalidraw's hand-drawn fonts for converted text and the "hand" style — Excalifont (Latin,
 * Cyrillic, Greek) and Xiaolai (Chinese / Japanese / Korean), SIL OFL 1.1 — from the optional
 * font pack in this device's storage.
 *
 * The pack holds 216 subsets split by Unicode range (as Excalidraw ships them). Only the subsets a
 * text actually uses are read and registered (FontFace with its unicode-range), so memory stays
 * small; when new subsets arrive, `fontsChanged()` makes the editors redraw.
 */

export const HAND_FAMILIES = { latin: 'HN Excalifont', cjk: 'HN Xiaolai' };

type Range = [number, number];

function parseRange(r: string): Range[] {
  return r.split(',').map((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
    const lo = parseInt(a, 16);
    return [lo, b ? parseInt(b, 16) : lo] as Range;
  });
}

interface Subset {
  family: string;
  name: string;
  range: string;
  ranges: Range[];
}

export class HandFonts {
  private subsets: Subset[] = FONT_FILES.map((f) => ({ family: f.family === 'excalifont' ? HAND_FAMILIES.latin : HAND_FAMILIES.cjk, name: f.name, range: f.range, ranges: parseRange(f.range) }));
  private faces = new Map<string, FontFace>();
  private loading = new Map<string, Promise<void>>();
  private docs = new Set<Document>();
  private seen = new Set<number>();
  private active = false;

  constructor(private readonly models: ModelStore) {}

  /** Use the pack (installed) or stop using it. */
  enable(on: boolean): void {
    this.active = on;
    setHandFontStack(on ? [HAND_FAMILIES.latin, HAND_FAMILIES.cjk] : [], on ? (t) => void this.ensure(t) : null);
    if (!on) {
      for (const d of this.docs) for (const f of this.faces.values()) d.fonts.delete(f);
      this.faces.clear();
      this.seen.clear();
    }
    fontsChanged();
  }

  get enabled(): boolean {
    return this.active;
  }

  attach(doc: Document): void {
    if (this.docs.has(doc)) return;
    this.docs.add(doc);
    for (const f of this.faces.values()) doc.fonts.add(f);
  }

  /** Subsets (Latin and CJK) that cover `text`. */
  private needed(text: string): Subset[] {
    const out = new Set<Subset>();
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      if (cp < 0x20 || this.seen.has(cp)) continue;
      this.seen.add(cp);
      for (const s of this.subsets) if (s.ranges.some(([a, b]) => cp >= a && cp <= b)) out.add(s);
    }
    return [...out].filter((s) => !this.faces.has(s.name));
  }

  /** Load the subsets `text` needs (resolves when they are usable; never throws). */
  async ensure(text: string): Promise<void> {
    if (!this.active) return;
    const todo = this.needed(text);
    if (!todo.length) return;
    let added = false;
    await Promise.all(
      todo.map((s) => {
        let p = this.loading.get(s.name);
        if (!p) {
          p = (async () => {
            try {
              const data = await this.models.file('font-hand', s.name);
              const face = new FontFace(s.family, data, { unicodeRange: s.range, display: 'swap' });
              await face.load();
              this.faces.set(s.name, face);
              this.attach(document);
              for (const d of this.docs) d.fonts.add(face);
              added = true;
            } catch (e) {
              console.warn('[HandNote] font subset not loaded', s.name, e);
            }
          })();
          this.loading.set(s.name, p);
        }
        return p;
      }),
    );
    if (added) fontsChanged();
  }
}
