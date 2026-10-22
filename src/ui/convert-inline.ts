import type { TextToken } from '../recognition/types';
import { el } from './dom';
import { t } from './i18n';
import { onTap } from './tap';

/**
 * In-place conversion UI (MyScript Notes style): no dialog in the way.
 *
 *  - `InlineProgress`: a small pill under the selection while the recognizer works (Cancel ✕).
 *  - `ResultBar`: after the ink became text / a formula, a floating bar under the result: the
 *    recognised words as chips — the uncertain ones (with candidates) are marked; tap one to pick
 *    another reading — plus Edit, Restore ink and Close. Writing on the page dismisses it.
 */

export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function place(node: HTMLElement, box: ScreenBox, host: HTMLElement): void {
  const vw = host.clientWidth || window.innerWidth;
  const vh = host.clientHeight || window.innerHeight;
  const bw = node.offsetWidth || 160;
  const bh = node.offsetHeight || 40;
  let top = box.y + box.h + 12;
  if (top + bh > vh - 8) top = Math.max(8, box.y - bh - 12);
  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(Math.max(8, Math.min(vw - bw - 8, box.x + box.w / 2 - bw / 2)))}px`;
}

function stop(b: HTMLElement): void {
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
}

function btn(parent: HTMLElement, cls: string, label: string, run: () => void, title?: string): HTMLButtonElement {
  const b = el('button', cls, parent, label);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  stop(b);
  onTap(b, () => run());
  return b;
}

export class InlineProgress {
  readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly time: HTMLElement;
  private readonly t0 = performance.now();
  private tick: number;

  constructor(
    private readonly host: HTMLElement,
    box: ScreenBox | null,
    engine: string,
    onCancel: () => void,
  ) {
    this.el = el('div', 'hn-conv-pill hn-ov-int', host);
    this.el.setAttribute('role', 'status');
    el('span', 'hn-conv-pill-spin', this.el);
    this.label = el('span', 'hn-conv-pill-label', this.el, `${t('convertRecognizing')} · ${engine}`);
    this.time = el('span', 'hn-conv-pill-time', this.el, '');
    btn(this.el, 'hn-conv-pill-cancel', '✕', () => onCancel(), t('aiCancel'));
    this.tick = window.setInterval(() => {
      this.time.textContent = `${((performance.now() - this.t0) / 1000).toFixed(1)} s`;
    }, 100);
    this.move(box);
  }

  detail(text: string): void {
    if (text) this.label.dataset.detail = text;
    else delete this.label.dataset.detail;
  }

  move(box: ScreenBox | null): void {
    if (box) place(this.el, box, this.host);
  }

  close(): void {
    window.clearInterval(this.tick);
    this.el.remove();
  }
}

export interface ResultLine {
  text: string;
  /** word / character tokens with candidates (MyScript JIIX words, offline characters) */
  tokens?: TextToken[];
  /** whole-line alternatives (used when there are no tokens) */
  alternatives: string[];
}

export interface ResultBarModel {
  kind: 'text' | 'math';
  lines: ResultLine[];
  /** LaTeX of a converted formula */
  latex?: string;
  /** e.g. "MyScript · 0.9 s" */
  info: string;
  hand: boolean;
  /** Line `i` now reads `text` (a candidate was picked). */
  onLine(i: number, text: string): void;
  onEdit(): void;
  /** Bring the handwriting back (removes the result) — null when there is nothing to restore. */
  onRestore: (() => void) | null;
  onClose(): void;
  /** Offer the Excalidraw hand font (pack not installed yet). */
  font?: { label: string; run(progress: (text: string) => void): Promise<void> };
  /** Offer the English recognition model (an English line was read without it). */
  english?: { label: string; run(progress: (text: string) => void): Promise<void> };
}

/** Floating bar under a converted result: candidates, edit, restore ink. */
export class ResultBar {
  readonly el: HTMLElement;
  private open: { line: number; token: number } | null = null;
  private lines: ResultLine[];

  constructor(
    private readonly host: HTMLElement,
    private readonly m: ResultBarModel,
  ) {
    this.lines = m.lines.map((l) => ({ ...l, tokens: l.tokens?.map((x) => ({ ...x, candidates: [...x.candidates] })), alternatives: [...l.alternatives] }));
    this.el = el('div', 'hn-conv-result hn-ov-int', host);
    this.el.dataset.kind = m.kind;
    this.render();
  }

  /** Tokens of a line; a line without tokens is one token whose candidates are its alternatives. */
  private tokensOf(i: number): TextToken[] {
    const l = this.lines[i];
    if (l.tokens?.length) return l.tokens;
    l.tokens = [{ text: l.text, candidates: l.alternatives.filter((a) => a !== l.text).slice(0, 5) }];
    return l.tokens;
  }

  private render(): void {
    const root = this.el;
    root.textContent = '';
    if (this.m.kind === 'text') {
      const words = el('div', `hn-conv-rwords${this.m.hand ? ' is-hand' : ''}`, root);
      this.lines.forEach((_, i) => {
        const row = el('div', 'hn-conv-rline', words);
        this.tokensOf(i).forEach((tk, k) => {
          if (!tk.text.trim()) {
            el('span', 'hn-conv-space', row);
            return;
          }
          const b = btn(row, `hn-conv-rtoken${tk.candidates.length ? ' has-cands' : ''}${this.open?.line === i && this.open.token === k ? ' is-open' : ''}`, tk.text, () => {
            if (!tk.candidates.length) return;
            this.open = this.open?.line === i && this.open.token === k ? null : { line: i, token: k };
            this.render();
          });
          b.dataset.line = String(i);
        });
      });
      if (this.open) {
        const { line, token } = this.open;
        const tk = this.tokensOf(line)[token];
        const list = el('div', 'hn-conv-rcands', root);
        for (const c of tk.candidates.slice(0, 6)) {
          btn(list, `hn-conv-rcand${this.m.hand ? ' is-hand' : ''}`, c, () => {
            const old = tk.text;
            tk.text = c;
            tk.candidates = [old, ...tk.candidates.filter((x) => x !== c && x !== old)];
            const l = this.lines[line];
            l.text = this.tokensOf(line).map((x) => x.text).join('').trim();
            this.open = null;
            this.m.onLine(line, l.text);
            this.render();
          });
        }
      }
    } else {
      el('code', 'hn-conv-rlatex', root, this.m.latex ?? '');
    }
    const foot = el('div', 'hn-conv-rfoot', root);
    const info = el('span', 'hn-conv-rinfo', foot, this.m.info);
    for (const key of ['english', 'font'] as const) {
      const f = this.m[key];
      if (!f) continue;
      const b = btn(foot, `hn-conv-rbtn hn-conv-r${key}`, f.label, () => {
        b.disabled = true;
        f.run((text) => (info.textContent = text)).then(
          () => {
            this.m[key] = undefined;
            this.render();
          },
          (e: unknown) => {
            b.disabled = false;
            info.textContent = String((e as Error)?.message ?? e).slice(0, 80);
          },
        );
      });
    }
    btn(foot, 'hn-conv-rbtn hn-conv-redit', this.m.kind === 'text' ? t('edit') : t('formulaEdit'), () => this.m.onEdit());
    if (this.m.onRestore) btn(foot, 'hn-conv-rbtn hn-conv-restore', t('convertRestoreInk'), () => this.m.onRestore?.());
    btn(foot, 'hn-conv-rbtn hn-conv-rclose', '✕', () => this.m.onClose(), t('close'));
  }

  move(box: ScreenBox | null): void {
    if (box) place(this.el, box, this.host);
  }

  close(): void {
    this.el.remove();
  }
}
