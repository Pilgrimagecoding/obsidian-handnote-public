import * as obsidian from 'obsidian';
import { Setting, type App } from 'obsidian';
import type { AISettings } from '../ai/config';
import type { HandwritingRecognitionService } from '../recognition/service';
import { sanitizeRecognitionSettings, type RecognitionSettings } from '../recognition/settings';
import { t } from '../ui/i18n';
import { HAND_FONT, type HandFont } from './hand-font';
import type { MyScriptDiagnosis } from '../recognition/service';
import { secretsSupported } from './ai-settings';

type SecretComponentCtor = new (app: App, el: HTMLElement) => { setValue(v: string): unknown; onChange(cb: (v: string | null) => unknown): unknown };

export interface RecSettingsHost {
  app: App;
  settings(): AISettings;
  save(s: AISettings): void;
  recognition: HandwritingRecognitionService;
  handFont: HandFont;
  redraw(): void;
}

/** "Handwriting recognition" part of the AI settings: engine, MyScript BYOK, dictionary, font, timings. */
export function renderRecognitionSettings(el: HTMLElement, h: RecSettingsHost): void {
  const r = h.settings().recognition;
  const set = (patch: Partial<RecognitionSettings>, redraw = false) => {
    const cur = h.settings();
    h.save({ ...cur, recognition: sanitizeRecognitionSettings({ ...cur.recognition, ...patch }) });
    h.recognition.clearCache();
    if (redraw) h.redraw();
  };
  new Setting(el).setName(t('recConvertSection')).setHeading();
  el.createDiv({ cls: 'setting-item-description hn-ai-intro', text: t('recConvertIntro') });
  const et = h.recognition.engineFor('text');
  const em = h.recognition.engineFor('math');
  const name = (e: typeof et) => (e.ready ? (e.engine === 'local' ? `${t('engineLocal')} · ${e.label}` : e.engine === 'offline' ? t('engineOffline') : e.engine === 'myscript' ? 'MyScript' : `${t('engineVision')} · ${e.model}`) : `${t('aiNotReady')}`);
  el.createDiv({ cls: 'setting-item-description hn-ai-status hn-rec-status', text: `${t('convertText')}: ${name(et)} · ${t('convertMath')}: ${name(em)}` });
  new Setting(el)
    .setName(t('recEngine'))
    .setDesc(t('recEngineDesc'))
    .addDropdown((d) =>
      d
        .addOption('auto', t('recEngineAuto'))
        .addOption('myscript', t('recEngineMyScript'))
        .addOption('offline', t('recEngineOffline'))
        .addOption('vision', t('recEngineVision'))
        .setValue(r.engine)
        .onChange((v) => set({ engine: v as RecognitionSettings['engine'] }, true)),
    );
  new Setting(el)
    .setName(t('recConvertMode'))
    .setDesc(t('recConvertModeDesc'))
    .addDropdown((d) =>
      d
        .addOption('instant', t('recModeInstant'))
        .addOption('preview', t('recModePreview'))
        .setValue(r.convertMode)
        .onChange((v) => set({ convertMode: v as RecognitionSettings['convertMode'] })),
    );
  new Setting(el).setName(t('recKeepInk')).addToggle((tg) => tg.setValue(r.keepInk).onChange((v) => set({ keepInk: v })));
  new Setting(el)
    .setName(t('recOffline'))
    .setDesc(t('recOfflineDesc'))
    .addToggle((tg) => tg.setValue(r.offlineZh).onChange((v) => set({ offlineZh: v }, true)));
  new Setting(el)
    .setName(t('recVisionFallback'))
    .setDesc(t('recVisionFallbackDesc'))
    .addToggle((tg) => tg.setValue(r.visionFallback).onChange((v) => set({ visionFallback: v }, true)));
  new Setting(el)
    .setName(t('mapTheme'))
    .addDropdown((d) =>
      d
        .addOption('academic', t('themeAcademic'))
        .addOption('hand', t('themeHand'))
        .addOption('minimal', t('themeMinimal'))
        .setValue(r.mapTheme)
        .onChange((v) => set({ mapTheme: v as RecognitionSettings['mapTheme'] })),
    );
  new Setting(el)
    .setName(t('recLexicon'))
    .setDesc(t('recLexiconDesc'))
    .addTextArea((ta) => {
      ta.inputEl.rows = 5;
      ta.setValue(r.lexicon.join('\n')).onChange((v) => set({ lexicon: v.split('\n') }));
    });

  // ---- MyScript (optional, the user's own developer keys)
  const card = el.createDiv({ cls: 'hn-ai-card' });
  const ms = new Setting(card).setName(t('recMyScriptKeys'));
  ms.descEl.createDiv({ text: t('recMyScriptKeysDesc') });
  const a = ms.descEl.createEl('a', { text: 'developer.myscript.com', href: 'https://developer.myscript.com/' });
  a.setAttr('target', '_blank');
  a.setAttr('rel', 'noopener');
  const SC = (obsidian as unknown as { SecretComponent?: SecretComponentCtor }).SecretComponent;
  const secret = (name: string, value: string | undefined, apply: (v: string | undefined) => void) => {
    const st = new Setting(card).setName(name);
    if (SC && secretsSupported(h.app)) {
      st.addComponent((host: HTMLElement) => {
        const c = new SC(h.app, host);
        c.setValue(value ?? '');
        c.onChange((v) => apply((v ?? '').trim() || undefined));
        return c as unknown as obsidian.BaseComponent;
      });
    } else {
      st.setDisabled(true);
      st.descEl.createDiv({ cls: 'mod-warning', text: t('aiNoSecretStorage') });
    }
  };
  secret(t('recAppKey'), r.myscriptAppKeySecret, (v) => set({ myscriptAppKeySecret: v }, true));
  secret(t('recHmacKey'), r.myscriptHmacSecret, (v) => set({ myscriptHmacSecret: v }));
  new Setting(card).setName(t('recHost')).addText((tx) => tx.setValue(r.myscriptHost).onChange((v) => set({ myscriptHost: v.trim() })));
  new Setting(card).setName(t('recLang')).addDropdown((d) => {
    for (const l of ['zh_CN', 'zh_TW', 'en_US', 'en_GB', 'ja_JP', 'ko_KR', 'de_DE', 'fr_FR']) d.addOption(l, l);
    d.setValue(r.myscriptLang).onChange((v) => set({ myscriptLang: v }));
  });
  new Setting(card)
    .setName(t('recAlwaysSend'))
    .setDesc(t('recAlwaysSendDesc'))
    .addToggle((tg) => tg.setValue(r.myscriptAlwaysSend).onChange((v) => set({ myscriptAlwaysSend: v })));
  new Setting(card)
    .setName(t('recPrefetch'))
    .setDesc(t('recPrefetchDesc'))
    .addDropdown((d) =>
      d
        .addOption('off', t('recPrefetchOff'))
        .addOption('menu', t('recPrefetchMenu'))
        .addOption('lasso', t('recPrefetchLasso'))
        .setValue(r.prefetch)
        .onChange((v) => set({ prefetch: v as RecognitionSettings['prefetch'] })),
    );
  const test = new Setting(card).setName(t('recTestMyScript')).setDesc(t('recTestMyScriptDesc'));
  const res = test.descEl.createDiv({ cls: 'hn-ai-status' });
  test.addButton((b) =>
    b.setButtonText(t('recTestMyScript')).onClick(async () => {
      b.setDisabled(true);
      res.setText('…');
      try {
        const d = await h.recognition.testMyScript();
        res.setText(diagnosisText(d));
      } finally {
        b.setDisabled(false);
      }
    }),
  );

  // ---- font
  const fontRow = new Setting(el).setName(t('handFont'));
  fontRow.descEl.createDiv({ text: t('handFontDesc') });
  const state = fontRow.descEl.createDiv({ cls: 'hn-ai-status' });
  state.setText(h.handFont.loaded ? `${t('handFontReady')} · ${HAND_FONT.family} ${HAND_FONT.version} · ${HAND_FONT.license}` : t('handFontMissing'));
  if (h.handFont.loaded) {
    fontRow.addButton((b) =>
      b.setButtonText(t('handFontRemove')).onClick(async () => {
        await h.handFont.remove();
        h.redraw();
      }),
    );
  } else {
    fontRow.addButton((b) =>
      b.setButtonText(t('handFontDownload')).onClick(async () => {
        if (!window.confirm(t('handFontConfirm'))) return;
        b.setDisabled(true);
        state.setText('…');
        const res = await h.handFont.download();
        if (res !== 'ok') new obsidian.Notice(res === 'bad-hash' ? t('handFontBadHash') : t('handFontFailed'));
        h.redraw();
      }),
    );
  }

  // ---- measured timings (this session; durations only)
  const st = h.recognition.stats();
  const timing = new Setting(el).setName(t('recStats'));
  timing.setDesc(st.n ? `n=${st.n} · p50 ${(st.p50 / 1000).toFixed(1)} s · p95 ${(st.p95 / 1000).toFixed(1)} s (${t('convertTimeRequest')} p50 ${(st.req50 / 1000).toFixed(1)} s / p95 ${(st.req95 / 1000).toFixed(1)} s)` : t('recStatsNone'));
}

/** Plain-language result of the two-step MyScript check. */
export function diagnosisText(d: MyScriptDiagnosis): string {
  const reach = d.reachMs !== undefined && d.step !== 'network' ? `${t('recDiagReach')} ${d.host} ${d.reachMs} ms${d.version ? ` (v${d.version})` : ''}${d.via ? ` [${d.via}]` : ''}` : '';
  switch (d.step) {
    case 'done':
      return `${t('recTestOk')} · ${reach} · ${t('recDiagRecognize')} ${d.recognizeMs} ms${d.label ? ` · "${d.label}"` : ''}`;
    case 'config':
      return `${t('recTestFailed')}: ${t('recDiagConfig')}`;
    case 'network':
      return `${t('recTestFailed')}: ${t('recDiagNetwork').replace('{host}', d.host)} (${d.detail ?? ''}${d.reachMs !== undefined ? `, ${Math.round(d.reachMs / 1000)} s` : ''})`;
    case 'slow':
      return `${t('recTestFailed')}: ${reach} · ${t('recDiagSlow')} (${d.detail ?? ''})`;
    case 'auth':
      return `${t('recTestFailed')}: ${reach} · ${t('recDiagAuth')} (${d.status ?? ''} ${d.detail ?? ''})`;
    case 'quota':
      return `${t('recTestFailed')}: ${reach} · ${t('recDiagQuota')}`;
    default:
      return `${t('recTestFailed')}: ${reach} · ${d.detail ?? ''}`;
  }
}
