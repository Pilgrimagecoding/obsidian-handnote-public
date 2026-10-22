import type { AITask } from '../ai/types';
import type { EditableScene } from '../ai/scene';
import type { Item } from '../document/items';
import { paintItem } from '../rendering/items-paint';
import { el } from './dom';
import { setHnIcon } from './icons';
import { t } from './i18n';
import { onTap } from './tap';

/** AI menu of the lasso bar: recognition tasks (need a provider) and local tidy tools (offline). */
export interface AIMenuModel {
  ready: boolean;
  mock: boolean;
  hasImages: boolean;
  onTask(task: AITask): void;
  onLocal(op: 'tidy' | 'align-left' | 'align-center' | 'distribute-v'): void;
  onSetup(): void;
}

export function renderAIMenu(host: HTMLElement, m: AIMenuModel): void {
  host.textContent = '';
  el('div', 'hn-pop-title', host, t('aiMenu'));
  const card = el('div', 'hn-list hn-card', host);
  const row = (icon: string, label: string, hint: string, run: () => void, disabled = false) => {
    const b = el('button', 'hn-list-row hn-ai-row', card);
    b.type = 'button';
    b.disabled = disabled;
    setHnIcon(el('span', 'hn-row-icon', b), icon);
    const txt = el('span', 'hn-ai-row-text', b);
    el('span', 'hn-row-label', txt, label);
    el('span', 'hn-row-hint', txt, hint);
    onTap(b, () => run());
    return b;
  };
  row('to-text', t('aiHandwriting'), t('aiHandwritingHint'), () => m.onTask('handwriting')).dataset.task = 'handwriting';
  row('to-shape', t('aiDiagram'), t('aiDiagramHint'), () => m.onTask('diagram')).dataset.task = 'diagram';
  row('image', t('aiImageText'), t('aiImageTextHint'), () => m.onTask('image-text'), !m.hasImages).dataset.task = 'image-text';
  row('mind-map', t('aiMindmap'), t('aiMindmapHint'), () => m.onTask('mindmap')).dataset.task = 'mindmap';
  if (!m.ready) {
    const note = el('div', 'hn-row-hint hn-ai-note', host, t('aiNotConfigured'));
    note.setAttribute('role', 'note');
    const b = el('button', 'hn-action', host, t('settingsSection'));
    b.type = 'button';
    onTap(b, () => m.onSetup());
  } else if (m.mock) {
    el('div', 'hn-row-hint hn-ai-note', host, t('aiMockNote'));
  }
  el('div', 'hn-section-title', host, t('aiLocalTidy'));
  const loc = el('div', 'hn-ai-local', host);
  const tool = (icon: string, label: string, op: 'tidy' | 'align-left' | 'align-center' | 'distribute-v') => {
    const b = el('button', 'hn-btn hn-ai-local-btn', loc);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.op = op;
    setHnIcon(el('span', 'hn-ic', b), icon);
    el('span', 'hn-btn-label', b, label);
    onTap(b, () => m.onLocal(op));
  };
  tool('sparkles', t('tidy'), 'tidy');
  tool('align-left-objs', t('alignLeft'), 'align-left');
  tool('align-h', t('alignCenterH'), 'align-center');
  tool('distribute-v', t('distributeV'), 'distribute-v');
}

// ------------------------------------------------------------------------------------------------
// Modal (inside the editor, works in Obsidian and in the lab)
// ------------------------------------------------------------------------------------------------

export class Modal {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private readonly back: HTMLElement;
  private closed = false;
  constructor(root: HTMLElement, cls: string, titleText: string, private readonly onClose?: () => void) {
    this.back = el('div', 'hn-modal-back', root);
    this.el = el('div', `hn-modal ${cls}`, this.back);
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    el('div', 'hn-pop-title', this.el, titleText);
    this.body = el('div', 'hn-modal-body', this.el);
    this.back.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      e.stopPropagation();
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.back.remove();
    this.onClose?.();
  }
  get isClosed(): boolean {
    return this.closed;
  }
}

function button(parent: HTMLElement, label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el('button', `hn-action ${cls}`.trim(), parent, label);
  b.type = 'button';
  onTap(b, () => run());
  return b;
}

export interface ConsentInfo {
  task: AITask;
  provider: string;
  model: string;
  image: HTMLCanvasElement;
  bytes: number;
  mock: boolean;
}

/** Show exactly what will be uploaded; resolves true when the user presses Send. */
export function confirmUpload(root: HTMLElement, info: ConsentInfo): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v: boolean) => {
      if (answered) return;
      answered = true;
      m.close();
      resolve(v);
    };
    const m = new Modal(root, 'hn-ai-consent', t('aiConsentTitle'), () => done(false));
    el('div', 'hn-row-hint', m.body, t('aiConsentScope'));
    const pv = el('div', 'hn-ai-upload-preview', m.body);
    const img = info.image;
    img.classList.add('hn-ai-upload-img');
    pv.appendChild(img);
    const dl = el('div', 'hn-ai-facts', m.body);
    const fact = (k: string, v: string) => {
      const r = el('div', 'hn-ai-fact', dl);
      el('span', 'hn-ai-fact-k', r, k);
      el('span', 'hn-ai-fact-v', r, v);
    };
    fact(t('aiProvider'), info.provider);
    fact(t('aiModel'), info.model);
    fact(t('aiUpload'), `PNG ${img.width}×${img.height}`);
    fact(t('aiSize'), `${(info.bytes / 1024).toFixed(0)} KB`);
    fact(t('aiCost'), info.mock ? '0' : t('aiCostUnknown'));
    if (info.mock) el('div', 'hn-row-hint hn-ai-note', m.body, t('aiMockNote'));
    const foot = el('div', 'hn-row hn-foot', m.body);
    button(foot, t('aiCancel'), '', () => done(false));
    const send = button(foot, t('aiSend'), 'is-primary hn-ai-send', () => done(true));
    window.requestAnimationFrame(() => send.focus({ preventScroll: true }));
  });
}

/** Progress with a Cancel button. */
export function progressModal(root: HTMLElement, onCancel: () => void): Modal {
  const m = new Modal(root, 'hn-ai-progress', t('aiRunning'));
  el('div', 'hn-spinner', m.body);
  const foot = el('div', 'hn-row hn-foot', m.body);
  button(foot, t('aiCancel'), 'hn-ai-cancel', () => {
    onCancel();
    m.close();
  });
  return m;
}

export interface PreviewModel {
  scene: EditableScene;
  items: Item[];
  source: HTMLCanvasElement;
  dropped: string[];
  canReplace: boolean;
  onApply(mode: 'keep' | 'replace'): void;
}

/** Original selection next to the converted objects; nothing changes until the user applies. */
export function previewModal(root: HTMLElement, p: PreviewModel): Modal {
  const m = new Modal(root, 'hn-ai-preview', t('aiPreviewTitle'));
  const panes = el('div', 'hn-ai-panes', m.body);
  const left = el('div', 'hn-ai-pane', panes);
  p.source.classList.add('hn-ai-pane-canvas');
  left.appendChild(p.source);
  const right = el('div', 'hn-ai-pane', panes);
  const cv = el('canvas', 'hn-ai-pane-canvas hn-ai-result', right);
  drawItems(cv, p.items, p.source.width, p.source.height);
  const facts = el('div', 'hn-ai-facts', m.body);
  const f = (k: string, v: string) => {
    const r = el('div', 'hn-ai-fact', facts);
    el('span', 'hn-ai-fact-k', r, k);
    el('span', 'hn-ai-fact-v', r, v);
  };
  f(t('aiObjects'), String(p.items.length));
  if (p.scene.confidence !== null) f(t('aiConfidence'), `${Math.round(p.scene.confidence * 100)}%`);
  const notes = [...p.scene.warnings, ...p.scene.unresolvedItems.map((u) => `${t('aiUnresolved')}: ${u.reason}`), ...p.dropped.slice(0, 5)];
  if (notes.length) {
    el('div', 'hn-section-title', m.body, t('aiWarnings'));
    const ul = el('ul', 'hn-ai-notes', m.body);
    for (const n of notes.slice(0, 10)) el('li', '', ul, n);
  }
  const foot = el('div', 'hn-ai-apply', m.body);
  let confirmRow: HTMLElement | null = null;
  let cb: HTMLInputElement | null = null;
  if (p.canReplace) {
    confirmRow = el('label', 'hn-row hn-ai-confirm', m.body);
    cb = el('input', 'hn-switch', confirmRow);
    cb.type = 'checkbox';
    el('span', 'hn-row-label', confirmRow, t('aiReplaceConfirm'));
  }
  const btns = el('div', 'hn-row hn-foot', m.body);
  button(btns, t('aiCancel'), '', () => m.close());
  if (p.canReplace) {
    const rep = button(btns, t('aiApplyReplace'), 'is-danger hn-ai-replace', () => {
      if (!cb?.checked) return;
      m.close();
      p.onApply('replace');
    });
    rep.disabled = true;
    cb?.addEventListener('change', () => (rep.disabled = !cb?.checked));
  }
  button(btns, t('aiApplyKeep'), 'is-primary hn-ai-keep', () => {
    m.close();
    p.onApply('keep');
  });
  void foot;
  return m;
}

/** Render converted items (page units) scaled into a canvas of the source image's size. */
function drawItems(cv: HTMLCanvasElement, items: Item[], w: number, h: number): void {
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx || !items.length) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w);
    y1 = Math.max(y1, it.y + it.h);
  }
  const pad = 8;
  const k = Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(k, 0, 0, k, pad - x0 * k, pad - y0 * k);
  for (const it of items) if (it.type !== 'text') paintItem(ctx, it);
  for (const it of items) if (it.type === 'text') paintItem(ctx, it);
}
