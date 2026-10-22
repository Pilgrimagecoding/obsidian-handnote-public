import type { AIErrorCode } from '../ai/types';
import type { EngineInfo } from '../recognition/service';
import type { RecStage, RecTask } from '../recognition/types';
import type { FormulaItem, Item } from '../document/items';
import { paintItem } from '../rendering/items-paint';
import { formulaBoxSize, hasMathEngine, renderFormula } from '../rendering/formula';
import { fromMarkdown, toMarkdown, type MapLayoutId, type MapThemeId, type MindNode } from '../mindmap/model';
import { fitMindMap } from '../mindmap/paint';
import { Modal } from './ai-panels';
import { el } from './dom';
import { setHnIcon } from './icons';
import { t } from './i18n';
import { onTap } from './tap';

// ------------------------------------------------------------------------------------------------
// Convert menu (lasso bar)
// ------------------------------------------------------------------------------------------------

export interface ConvertMenuModel {
  engine(task: RecTask): EngineInfo;
  hasInk: boolean;
  hasImages: boolean;
  onTask(task: RecTask): void;
  onShape(): void;
}

function engineHint(e: EngineInfo): string {
  if (e.engine === 'mock') return t('engineMock');
  if (e.engine === 'offline') return `${t('engineOffline')} · ${t('engineNoUpload')}`;
  if (e.engine === 'local') return `${t('engineLocal')} · ${e.label} · ${t('engineNoUpload')}`;
  if (e.engine === 'myscript') return `MyScript · ${t('engineInk')}`;
  return `${t('engineVision')} · ${e.label || e.model}`;
}

function menuRow(card: HTMLElement, task: string, icon: string, label: string, hint: string, enabled: boolean, run: () => void): HTMLButtonElement {
  const b = el('button', 'hn-list-row hn-ai-row', card);
  b.type = 'button';
  b.dataset.task = task;
  b.disabled = !enabled;
  setHnIcon(el('span', 'hn-row-icon', b), icon);
  const txt = el('span', 'hn-ai-row-text', b);
  el('span', 'hn-row-label', txt, label);
  el('span', 'hn-row-hint', txt, hint);
  onTap(b, () => run());
  return b;
}

/**
 * Convert (lasso): Text / Math / Shape — digital-ink recognition of the strokes themselves
 * (MyScript or the offline Chinese engine) and the local shape recognizer. Never a chat model
 * unless the user explicitly allowed it as a fallback.
 */
export function renderConvertMenu(host: HTMLElement, m: ConvertMenuModel): void {
  host.textContent = '';
  el('div', 'hn-pop-title', host, t('convertMenu'));
  const card = el('div', 'hn-list hn-card', host);
  const hint = (task: RecTask, base: string) => {
    const e = m.engine(task);
    return e.ready ? `${base} · ${engineHint(e)}` : `${base} · ${t(e.reason === 'local-math-not-included' ? 'localMathNotIncludedShort' : e.reason === 'local-unsupported' ? 'localUnsupportedShort' : e.reason === 'local-math-missing' || e.reason === 'local-text-missing' ? 'localNotInstalled' : e.reason === 'math-needs-myscript' || e.reason === 'math-not-offline' ? 'engineMathMissing' : 'engineMissingShort')}`;
  };
  menuRow(card, 'text', 'text-lines', t('convertText'), hint('text', t('convertTextHint')), m.hasInk, () => m.onTask('text'));
  menuRow(card, 'math', 'formula', t('convertMath'), hint('math', t('convertMathHint')), m.hasInk, () => m.onTask('math'));
  menuRow(card, 'shape', 'to-shape', t('convertShape'), t('convertShapeHint'), m.hasInk, () => m.onShape());
}

export interface AIToolsMenuModel {
  engine(task: RecTask): EngineInfo;
  hasInk: boolean;
  hasImages: boolean;
  onTask(task: RecTask): void;
  onLocal(op: 'tidy' | 'align-left' | 'align-center' | 'distribute-v'): void;
  onSetup(): void;
}

/** AI tools (lasso): structure understanding with a general vision model + offline tidy tools. */
export function renderAIToolsMenu(host: HTMLElement, m: AIToolsMenuModel): void {
  host.textContent = '';
  el('div', 'hn-pop-title', host, t('aiToolsMenu'));
  el('div', 'hn-row-hint hn-ai-note', host, t('aiToolsNote'));
  const card = el('div', 'hn-list hn-card', host);
  const ready = m.engine('mindmap').ready;
  const hint = (base: string) => (ready ? `${base} · ${engineHint(m.engine('mindmap'))}` : base);
  menuRow(card, 'mindmap', 'mind-map', t('convertMindmap'), hint(t('convertMindmapHint')), m.hasInk || m.hasImages, () => m.onTask('mindmap'));
  menuRow(card, 'diagram', 'flowchart', t('convertDiagram'), hint(t('convertDiagramHint')), m.hasInk || m.hasImages, () => m.onTask('diagram'));
  menuRow(card, 'image-text', 'image', t('convertImageText'), hint(t('convertImageTextHint')), m.hasImages, () => m.onTask('image-text'));
  if (!ready) {
    const note = el('div', 'hn-row-hint hn-ai-note', host, t('errNotConfigured'));
    note.setAttribute('role', 'note');
    const b = el('button', 'hn-action', host, t('settingsSection'));
    b.type = 'button';
    onTap(b, () => m.onSetup());
  } else if (m.engine('mindmap').engine === 'mock') {
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
// Consent, progress, errors
// ------------------------------------------------------------------------------------------------

function button(parent: HTMLElement, label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el('button', `hn-action ${cls}`.trim(), parent, label);
  b.type = 'button';
  onTap(b, () => run());
  return b;
}

function facts(parent: HTMLElement): (k: string, v: string) => void {
  const dl = el('div', 'hn-ai-facts', parent);
  return (k, v) => {
    const r = el('div', 'hn-ai-fact', dl);
    el('span', 'hn-ai-fact-k', r, k);
    el('span', 'hn-ai-fact-v', r, v);
  };
}

export interface ConvertConsent {
  engine: EngineInfo;
  /** Picture that will be uploaded (image engines) or a preview of the ink. */
  preview: HTMLCanvasElement;
  strokes: number;
  bytes: number;
  /** Offer a saved "don't ask again" (digital-ink engines with the user's own keys). */
  offerAlways?: boolean;
}

/** What exactly leaves the device; resolves {ok, remember}. */
export function convertConsent(root: HTMLElement, c: ConvertConsent): Promise<{ ok: boolean; remember: boolean; always: boolean }> {
  return new Promise((resolve) => {
    let answered = false;
    let remember: HTMLInputElement | null = null;
    const done = (ok: boolean) => {
      if (answered) return;
      answered = true;
      const r = !!remember?.checked;
      m.close();
      // ink engines (MyScript): the box means "don't ask again" (saved; can be undone in Settings)
      resolve({ ok, remember: ok && r, always: ok && r && !!c.offerAlways });
    };
    const m = new Modal(root, 'hn-ai-consent', t('aiConsentTitle'), () => done(false));
    const mock = c.engine.engine === 'mock';
    el('div', 'hn-row-hint', m.body, c.engine.sends === 'ink' ? t('convertConsentInk') : t('convertConsentImage'));
    const pv = el('div', 'hn-ai-upload-preview', m.body);
    c.preview.classList.add('hn-ai-upload-img');
    pv.appendChild(c.preview);
    const f = facts(m.body);
    f(t('aiProvider'), c.engine.label || '—');
    f(t('aiModel'), c.engine.model || '—');
    f(t('aiUpload'), c.engine.sends === 'ink' ? `${t('convertStrokes')}: ${c.strokes}` : `${c.preview.width}×${c.preview.height}`);
    f(t('aiSize'), `${Math.max(1, Math.round(c.bytes / 1024))} KB`);
    f(t('aiCost'), mock ? '0' : t('aiCostUnknown'));
    if (mock) el('div', 'hn-row-hint hn-ai-note', m.body, t('aiMockNote'));
    const row = el('label', 'hn-row hn-ai-confirm', m.body);
    remember = el('input', 'hn-switch', row);
    remember.type = 'checkbox';
    if (c.offerAlways) row.classList.add('hn-conv-always');
    el('span', 'hn-row-label', row, c.offerAlways ? t('convertAlwaysSend') : t('convertRemember'));
    const foot = el('div', 'hn-row hn-foot', m.body);
    button(foot, t('aiCancel'), '', () => done(false));
    const send = button(foot, t('aiSend'), 'is-primary hn-ai-send', () => done(true));
    window.requestAnimationFrame(() => send.focus({ preventScroll: true }));
  });
}

const STAGE_KEY: Record<RecStage['name'], string> = { prepare: 'stagePrepare', encode: 'stageEncode', request: 'stageRequest', parse: 'stageParse', build: 'stageBuild', preview: 'stageBuild' };

export interface ProgressHandle {
  stage(name: RecStage['name']): void;
  /** Extra line under the stage (offline engine: "line 2 / 5"). */
  detail(text: string): void;
  close(): void;
}

/** Immediate feedback: the current stage, elapsed time and Cancel. */
export function convertProgress(root: HTMLElement, onCancel: () => void): ProgressHandle {
  const m = new Modal(root, 'hn-ai-progress', t('convertMenu'), () => onCancel());
  el('div', 'hn-spinner', m.body);
  const label = el('div', 'hn-row-label hn-conv-stage', m.body, t('stagePrepare'));
  const detail = el('div', 'hn-row-hint hn-conv-detail', m.body, '');
  const time = el('div', 'hn-row-hint hn-conv-elapsed', m.body, '');
  const t0 = performance.now();
  const tick = window.setInterval(() => {
    time.textContent = `${t('convertElapsed')} ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  }, 100);
  const foot = el('div', 'hn-row hn-foot', m.body);
  button(foot, t('aiCancel'), 'hn-ai-cancel', () => m.close());
  return {
    stage: (n) => {
      label.textContent = t(STAGE_KEY[n]);
      label.dataset.stage = n;
    },
    detail: (text) => {
      detail.textContent = text;
    },
    close: () => {
      window.clearInterval(tick);
      // closing programmatically must not count as a cancel
      const back = m.el.parentElement;
      back?.remove();
    },
  };
}

const ERR_KEY: Partial<Record<AIErrorCode, string>> = {
  timeout: 'errTimeout',
  empty: 'errEmpty',
  truncated: 'errTruncated',
  auth: 'errAuth',
  'rate-limit': 'errRateLimit',
  quota: 'errQuota',
  network: 'errNetwork',
  'bad-response': 'errBadResponse',
  'invalid-scene': 'errInvalid',
  'too-large': 'errTooLarge',
  provider: 'errProvider',
  'not-configured': 'errNotConfigured',
  limit: 'errTooLarge',
};

export function errorMessage(code: AIErrorCode): string {
  return t(ERR_KEY[code] ?? 'errProvider');
}

/** A typed error with a user-triggered retry (never automatic for possibly-billed requests). */
export function convertError(root: HTMLElement, code: AIErrorCode, detail: string, a: { onRetry?: () => void; onSettings?: () => void }): Modal {
  const m = new Modal(root, 'hn-conv-error', t('convertErrTitle'));
  m.el.dataset.code = code;
  el('div', 'hn-row-label hn-conv-err-msg', m.body, errorMessage(code));
  if (detail) el('div', 'hn-row-hint hn-conv-err-detail', m.body, detail.slice(0, 240));
  if (a.onRetry) el('div', 'hn-row-hint', m.body, t('convertRetryNote'));
  const foot = el('div', 'hn-row hn-foot', m.body);
  button(foot, t('close'), '', () => m.close());
  if (a.onSettings && (code === 'auth' || code === 'not-configured' || code === 'timeout')) {
    button(foot, t('convertOpenSettings'), '', () => {
      m.close();
      a.onSettings?.();
    });
  }
  if (a.onRetry) {
    button(foot, t('convertRetry'), 'is-primary hn-conv-retry', () => {
      m.close();
      a.onRetry?.();
    });
  }
  return m;
}

/** No suitable engine: say which one is missing and how to get it (never a fake result). */
export function engineMissing(
  root: HTMLElement,
  task: RecTask,
  reason: string,
  a: { onSettings(): void; onEnableOffline?: () => void; installBytes?: number; onInstall?: (progress: (text: string) => void) => Promise<void>; onTypeLatex?: () => void },
): Modal {
  const local = reason === 'local-math-missing' || reason === 'local-text-missing';
  const unsupported = reason === 'local-unsupported';
  const notIncluded = reason === 'local-math-not-included';
  const m = new Modal(root, 'hn-conv-missing', t(notIncluded ? 'localMathNotIncludedTitle' : unsupported ? 'localUnsupportedTitle' : local ? 'localMissingTitle' : 'engineMissingTitle'));
  m.el.dataset.reason = reason;
  const msg = notIncluded ? 'localMathNotIncluded' : unsupported ? 'localUnsupported' : local ? (task === 'math' ? 'localMissingMath' : 'localMissingText') : task === 'math' ? 'engineMissingMath' : reason === 'offline-disabled' ? 'engineMissingOffline' : task === 'text' ? 'engineMissingText' : 'errNotConfigured';
  el('div', 'hn-row-label hn-conv-err-msg', m.body, t(msg));
  if (local && a.installBytes !== undefined) el('div', 'hn-row-hint hn-conv-install-size', m.body, t('localInstallSize').replace('{mb}', (a.installBytes / 1048576).toFixed(1)));
  if (!notIncluded) el('div', 'hn-row-hint', m.body, t(local ? 'localMissingHow' : 'engineMissingHow'));
  const status = el('div', 'hn-row-hint hn-conv-install-status', m.body, '');
  const foot = el('div', 'hn-row hn-foot', m.body);
  button(foot, t('close'), '', () => m.close());
  // math without a recognizer: the formula can always be typed as LaTeX
  if (a.onTypeLatex && task === 'math') {
    button(foot, t('typeLatex'), `hn-conv-type-latex${notIncluded ? ' is-primary' : ''}`, () => {
      m.close();
      a.onTypeLatex?.();
    });
  }
  if (a.onEnableOffline && task === 'text') {
    button(foot, t('engineEnableOffline'), 'hn-conv-enable-offline', () => {
      m.close();
      a.onEnableOffline?.();
    });
  }
  if (local && a.onInstall) {
    const b = button(foot, t('localInstallNow').replace('{mb}', ((a.installBytes ?? 0) / 1048576).toFixed(1)), 'is-primary hn-conv-install', () => {
      b.disabled = true;
      status.textContent = t('localInstalling');
      a.onInstall?.((text) => (status.textContent = text)).then(
        () => {
          const back = m.el.parentElement;
          back?.remove();
        },
        (e: unknown) => {
          b.disabled = false;
          b.textContent = t('localInstallRetry');
          status.textContent = `${t('localInstallFailed')}: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
          status.classList.add('mod-warning');
        },
      );
    });
  } else {
    button(foot, t('convertOpenSettings'), `${notIncluded ? '' : 'is-primary '}hn-conv-open-settings`, () => {
      m.close();
      a.onSettings();
    });
  }
  return m;
}

// ------------------------------------------------------------------------------------------------
// Previews
// ------------------------------------------------------------------------------------------------

export type ApplyMode = 'keep' | 'replace';

function panes(m: Modal, source: HTMLCanvasElement): HTMLElement {
  const p = el('div', 'hn-ai-panes', m.body);
  const left = el('div', 'hn-ai-pane', p);
  el('div', 'hn-pane-title', left, t('convertOriginal'));
  source.classList.add('hn-ai-pane-canvas');
  left.appendChild(source);
  const right = el('div', 'hn-ai-pane', p);
  el('div', 'hn-pane-title', right, t('convertResult'));
  return right;
}

function applyFoot(m: Modal, canReplace: boolean, onApply: (mode: ApplyMode) => void): void {
  const btns = el('div', 'hn-row hn-foot hn-conv-apply', m.body);
  button(btns, t('aiCancel'), '', () => m.close());
  if (canReplace) {
    button(btns, t('convertReplace'), 'hn-ai-replace', () => {
      m.close();
      onApply('replace');
    });
  }
  button(btns, t('convertKeep'), 'is-primary hn-ai-keep', () => {
    m.close();
    onApply('keep');
  });
}

function runFacts(m: Modal, info: string): void {
  if (info) el('div', 'hn-row-hint hn-conv-facts', m.body, info);
}

/** Paint items (page units) fitted into a canvas. */
export function drawItemsFit(cv: HTMLCanvasElement, items: Item[], w: number, h: number): void {
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (!items.length) return;
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
  const pad = 10;
  const k = Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0), 4);
  const ox = (w - (x1 - x0) * k) / 2 - x0 * k;
  const oy = (h - (y1 - y0) * k) / 2 - y0 * k;
  ctx.setTransform(k, 0, 0, k, ox, oy);
  for (const it of items) if (it.type !== 'text' && it.type !== 'formula') paintItem(ctx, it);
  for (const it of items) if (it.type === 'text' || it.type === 'formula') paintItem(ctx, it);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export interface TextPreviewModel {
  lines: { text: string; alternatives: string[]; tokens?: { text: string; candidates: string[] }[] }[];
  source: HTMLCanvasElement;
  font: 'hand' | 'sans';
  canReplace: boolean;
  info: string;
  warnings?: string[];
  onApply(lines: string[], font: 'hand' | 'sans', mode: ApplyMode): void;
}

function warningText(w: string): string {
  return w.startsWith('i18n:') ? t(w.slice(5)) : w;
}

/**
 * Text preview: every line is editable; words (MyScript) or characters (offline engine) with
 * other readings are chips — tap one to see its candidates and swap it in (MyScript-style
 * correction without retyping).
 */
export function textPreview(root: HTMLElement, p: TextPreviewModel): Modal {
  const m = new Modal(root, 'hn-ai-preview hn-conv-text', t('convertPreviewText'));
  const right = panes(m, p.source);
  // text preview: one centred source pane (the result is edited below)
  right.parentElement?.classList.add('is-single');
  right.remove();
  el('div', 'hn-section-title', m.body, t('convertLines'));
  const list = el('div', 'hn-conv-lines', m.body);
  const inputs: HTMLInputElement[] = [];
  let font = p.font;
  const applyFont = () => {
    for (const i of inputs) i.classList.toggle('is-hand', font === 'hand');
    list.querySelectorAll('.hn-conv-tokens').forEach((x) => x.classList.toggle('is-hand', font === 'hand'));
  };
  p.lines.forEach((l) => {
    const row = el('div', 'hn-conv-line', list);
    const tokens = l.tokens?.map((x) => ({ text: x.text, candidates: [...x.candidates] }));
    let tokRow: HTMLElement | null = null;
    let cands: HTMLElement | null = null;
    const inp = el('input', 'hn-input hn-conv-line-input', row);
    const renderTokens = () => {
      if (!tokens || !tokRow) return;
      tokRow.textContent = '';
      tokens.forEach((tk, i) => {
        if (!tk.text.trim()) {
          el('span', 'hn-conv-space', tokRow as HTMLElement, ' ');
          return;
        }
        const b = el('button', `hn-conv-token${tk.candidates.length ? ' has-cands' : ''}`, tokRow as HTMLElement, tk.text);
        b.type = 'button';
        b.dataset.index = String(i);
        onTap(b, () => {
          cands?.remove();
          if (!tk.candidates.length) return;
          cands = el('div', 'hn-conv-cands', row);
          el('span', 'hn-row-hint', cands, `${t('convertAlternatives')}:`);
          for (const c of tk.candidates) {
            const cb = el('button', 'hn-chip hn-conv-cand', cands, c);
            cb.type = 'button';
            onTap(cb, () => {
              const old = tk.text;
              tk.text = c;
              tk.candidates = [old, ...tk.candidates.filter((x) => x !== c)];
              inp.value = tokens.map((x) => x.text).join('');
              cands?.remove();
              cands = null;
              renderTokens();
            });
          }
        });
      });
    };
    if (tokens?.some((x) => x.candidates.length)) {
      tokRow = el('div', 'hn-conv-tokens', row);
      row.insertBefore(tokRow, inp);
      renderTokens();
    }
    inp.type = 'text';
    inp.value = l.text;
    inp.spellcheck = false;
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    // typing by hand detaches the chips from the text
    inp.addEventListener('input', () => {
      tokRow?.remove();
      cands?.remove();
      tokRow = null;
    });
    inputs.push(inp);
    if (l.alternatives.length) {
      const alts = el('div', 'hn-conv-alts', row);
      el('span', 'hn-row-hint', alts, `${t('convertAlternatives')}:`);
      for (const a of l.alternatives.slice(0, 3)) {
        const chip = el('button', 'hn-chip hn-conv-alt', alts, a);
        chip.type = 'button';
        onTap(chip, () => {
          const cur = inp.value;
          inp.value = a;
          chip.textContent = cur;
          tokRow?.remove();
          tokRow = null;
        });
      }
    }
  });
  if (p.warnings?.length) {
    const ul = el('ul', 'hn-ai-notes hn-conv-warnings', m.body);
    for (const w of p.warnings.slice(0, 4)) el('li', '', ul, warningText(w));
  }
  const st = el('div', 'hn-row hn-conv-style', m.body);
  el('span', 'hn-row-label', st, t('convertStyle'));
  const seg = el('div', 'hn-seg', st);
  const opt = (v: 'sans' | 'hand', label: string) => {
    const b = el('button', 'hn-seg-btn', seg, label);
    b.type = 'button';
    b.dataset.font = v;
    const sync = () => seg.querySelectorAll('.hn-seg-btn').forEach((x) => x.classList.toggle('is-active', (x as HTMLElement).dataset.font === font));
    onTap(b, () => {
      font = v;
      sync();
      applyFont();
    });
    sync();
  };
  opt('sans', t('styleStandard'));
  opt('hand', t('styleHand'));
  applyFont();
  runFacts(m, p.info);
  applyFoot(m, p.canReplace, (mode) => p.onApply(inputs.map((i) => i.value), font, mode));
  return m;
}

export interface MathPreviewModel {
  latex: string;
  alternatives: string[];
  source: HTMLCanvasElement;
  color: string;
  canReplace: boolean;
  info: string;
  onApply(latex: string, mode: ApplyMode): void;
  onCopy(latex: string): void;
}

/** Formula preview / editor: rendered result + editable LaTeX (also used to edit a formula item). */
export function mathPreview(root: HTMLElement, p: MathPreviewModel, editOnly = false): Modal {
  const m = new Modal(root, `hn-ai-preview hn-conv-math${editOnly ? ' is-edit' : ''}`, editOnly ? t('formulaTitle') : t('convertPreviewMath'));
  const right = editOnly ? el('div', 'hn-ai-pane hn-conv-math-pane', m.body) : panes(m, p.source);
  const cv = el('canvas', 'hn-ai-pane-canvas hn-ai-result', right);
  const err = el('div', 'hn-row-hint hn-conv-latex-err', m.body, '');
  if (!hasMathEngine()) el('div', 'hn-row-hint hn-ai-note', m.body, t('formulaNoMath'));
  el('div', 'hn-section-title', m.body, t('latexSource'));
  const ta = el('textarea', 'hn-input hn-conv-latex', m.body);
  ta.value = p.latex;
  ta.spellcheck = false;
  ta.rows = Math.min(8, Math.max(2, p.latex.split('\n').length + 1));
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  let seq = 0;
  const render = async () => {
    const my = ++seq;
    const latex = ta.value.trim();
    const d = await renderFormula(latex || ' ');
    if (my !== seq) return;
    err.textContent = d.error ? `${t('latexError')}: ${d.error}` : '';
    const size = 28;
    const box = formulaBoxSize(d, size);
    const it: FormulaItem = { id: 'pv', type: 'formula', latex: latex || ' ', color: p.color, size, x: 0, y: 0, w: box.w, h: box.h, created: 0 };
    drawItemsFit(cv, [it], 520, Math.min(260, Math.max(90, box.h + 24)));
  };
  void render();
  let timer = 0;
  ta.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void render(), 180);
  });
  if (p.alternatives.length) {
    const alts = el('div', 'hn-conv-alts', m.body);
    el('span', 'hn-row-hint', alts, `${t('convertAlternatives')}:`);
    for (const a of p.alternatives.slice(0, 3)) {
      const chip = el('button', 'hn-chip hn-conv-alt', alts, a.length > 40 ? `${a.slice(0, 40)}…` : a);
      chip.type = 'button';
      onTap(chip, () => {
        ta.value = a;
        void render();
      });
    }
  }
  runFacts(m, p.info);
  const tools = el('div', 'hn-row hn-conv-tools', m.body);
  button(tools, t('latexCopy'), 'hn-conv-copy', () => p.onCopy(ta.value.trim()));
  if (editOnly) {
    const foot = el('div', 'hn-row hn-foot', m.body);
    button(foot, t('aiCancel'), '', () => m.close());
    button(foot, t('done'), 'is-primary hn-conv-done', () => {
      const v = ta.value.trim();
      m.close();
      if (v) p.onApply(v, 'keep');
    });
  } else {
    applyFoot(m, p.canReplace, (mode) => {
      const v = ta.value.trim();
      if (v) p.onApply(v, mode);
    });
  }
  return m;
}

export interface MapPreviewModel {
  root: MindNode;
  theme: MapThemeId;
  layout: MapLayoutId;
  source: HTMLCanvasElement;
  canReplace: boolean;
  info: string;
  onApply(root: MindNode, theme: MapThemeId, layout: MapLayoutId, mode: ApplyMode): void;
}

function segmented<T extends string>(parent: HTMLElement, label: string, options: [T, string][], value: T, onChange: (v: T) => void): void {
  const row = el('div', 'hn-row', parent);
  el('span', 'hn-row-label', row, label);
  const seg = el('div', 'hn-seg', row);
  let cur = value;
  const sync = () => seg.querySelectorAll('.hn-seg-btn').forEach((x) => x.classList.toggle('is-active', (x as HTMLElement).dataset.v === cur));
  for (const [v, l] of options) {
    const b = el('button', 'hn-seg-btn', seg, l);
    b.type = 'button';
    b.dataset.v = v;
    onTap(b, () => {
      cur = v;
      sync();
      onChange(v);
    });
  }
  sync();
}

export const THEME_OPTIONS = (): [MapThemeId, string][] => [
  ['academic', t('themeAcademic')],
  ['hand', t('themeHand')],
  ['minimal', t('themeMinimal')],
];
export const LAYOUT_OPTIONS = (): [MapLayoutId, string][] => [
  ['balanced', t('layoutBalanced')],
  ['right', t('layoutRight')],
];

/** Original | structure; the outline is editable before anything is applied. */
export function mindmapPreview(root: HTMLElement, p: MapPreviewModel): Modal {
  const m = new Modal(root, 'hn-ai-preview hn-conv-map', t('convertPreviewMindmap'));
  const right = panes(m, p.source);
  const cv = el('canvas', 'hn-ai-pane-canvas hn-ai-result', right);
  let tree = p.root;
  let theme = p.theme;
  let layout = p.layout;
  const draw = () => {
    const it = fitMindMap({ id: 'pv', type: 'mindmap', root: tree, theme, layout, scale: 1, x: 0, y: 0, w: 0, h: 0, created: 0 });
    drawItemsFit(cv, [it], Math.max(320, p.source.width), Math.max(220, p.source.height));
  };
  draw();
  segmented(m.body, t('mapTheme'), THEME_OPTIONS(), theme, (v) => {
    theme = v;
    draw();
  });
  segmented(m.body, t('mapLayout'), LAYOUT_OPTIONS(), layout, (v) => {
    layout = v;
    draw();
  });
  el('div', 'hn-section-title', m.body, t('outlineEdit'));
  const ta = el('textarea', 'hn-input hn-conv-outline', m.body);
  ta.value = toMarkdown(tree);
  ta.rows = Math.min(14, Math.max(4, ta.value.split('\n').length + 1));
  ta.spellcheck = false;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Tab') {
      // indent / outdent the current line like an outliner
      e.preventDefault();
      const s = ta.selectionStart;
      const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
      if (e.shiftKey) {
        if (ta.value.startsWith('  ', ls)) {
          ta.value = ta.value.slice(0, ls) + ta.value.slice(ls + 2);
          ta.selectionStart = ta.selectionEnd = Math.max(ls, s - 2);
        }
      } else {
        ta.value = `${ta.value.slice(0, ls)}  ${ta.value.slice(ls)}`;
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
      ta.dispatchEvent(new Event('input'));
    }
  });
  ta.addEventListener('input', () => {
    const n = fromMarkdown(ta.value);
    if (n) {
      tree = n;
      draw();
    }
  });
  runFacts(m, p.info);
  applyFoot(m, p.canReplace, (mode) => p.onApply(tree, theme, layout, mode));
  return m;
}

export interface DiagramPreviewModel {
  build(theme: MapThemeId): Item[];
  source: HTMLCanvasElement;
  theme: MapThemeId;
  canReplace: boolean;
  info: string;
  warnings: string[];
  mermaid(items: Item[]): string;
  onCopy(text: string): void;
  onApply(items: Item[], mode: ApplyMode): void;
}

export function diagramPreview(root: HTMLElement, p: DiagramPreviewModel): Modal {
  const m = new Modal(root, 'hn-ai-preview hn-conv-diagram', t('convertPreviewDiagram'));
  const right = panes(m, p.source);
  const cv = el('canvas', 'hn-ai-pane-canvas hn-ai-result', right);
  let theme = p.theme;
  let items = p.build(theme);
  const draw = () => drawItemsFit(cv, items, Math.max(320, p.source.width), Math.max(220, p.source.height));
  draw();
  segmented(m.body, t('mapTheme'), THEME_OPTIONS(), theme, (v) => {
    theme = v;
    items = p.build(theme);
    draw();
  });
  if (p.warnings.length) {
    const ul = el('ul', 'hn-ai-notes', m.body);
    for (const w of p.warnings.slice(0, 6)) el('li', '', ul, w);
  }
  runFacts(m, p.info);
  const tools = el('div', 'hn-row hn-conv-tools', m.body);
  button(tools, t('diagramCopyMermaid'), 'hn-conv-mermaid', () => p.onCopy(p.mermaid(items)));
  applyFoot(m, p.canReplace, (mode) => p.onApply(items, mode));
  return m;
}
