import * as obsidian from 'obsidian';
import { Modal, Setting, type App } from 'obsidian';
import { AIService } from '../ai/service';
import { QWEN_REGIONS } from '../ai/providers';
import {
  DEFAULT_BASE_URL,
  MODEL_ID_RE,
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABEL,
  SUGGESTED_MODELS,
  defaultModelEntries,
  defaultProfiles,
  isAllowedBaseUrl,
  newEntityId,
  type AIModelEntry,
  type AIProfile,
  type AISettings,
} from '../ai/config';
import { AI_TASKS, AIError, type AITask, type HttpFn, type ProviderId, type ProviderType } from '../ai/types';
import { t } from '../ui/i18n';

/**
 * Obsidian side of the AI layer: SecretStorage access (with a version check — never a plaintext
 * fallback), requestUrl transport and the settings UI (simple mode + advanced).
 */

interface SecretStorageLike {
  getSecret(id: string): string | null;
  listSecrets?(): string[];
}

export function secretStorage(app: App): SecretStorageLike | null {
  const ss = (app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
  return ss && typeof ss.getSecret === 'function' ? ss : null;
}

type SecretComponentCtor = new (app: App, el: HTMLElement) => { setValue(v: string): unknown; onChange(cb: (v: string | null) => unknown): unknown };

function secretComponentCtor(): SecretComponentCtor | null {
  const c = (obsidian as unknown as { SecretComponent?: SecretComponentCtor }).SecretComponent;
  return typeof c === 'function' ? c : null;
}

/** Secret storage needs Obsidian 1.11.4+ (SecretStorage + SecretComponent.setValue). */
export function secretsSupported(app: App): boolean {
  return !!secretStorage(app) && !!secretComponentCtor();
}

/** requestUrl (no CORS restrictions, works on iOS); errors come back as status codes, not throws. */
export const obsidianHttp: HttpFn = async (req) => {
  try {
    // Content-Type goes in `contentType` only (a duplicate header can confuse some servers)
    const headers = { ...req.headers };
    const contentType = headers['Content-Type'];
    delete headers['Content-Type'];
    const res = await obsidian.requestUrl({ url: req.url, method: req.method, headers, body: req.body, ...(contentType ? { contentType } : {}), throw: false });
    return { status: res.status, text: res.text, via: 'requestUrl' };
  } catch (e) {
    // network failure (offline, DNS, TLS): never include headers in the message
    throw new AIError('network', `network error: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
};

export function providerLabel(id: ProviderId): string {
  return PROVIDER_TYPE_LABEL[id] ?? id;
}

/** Where to create a key (official consoles). */
const KEY_HELP: Partial<Record<ProviderType, string>> = {
  qwen: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  deepseek: 'https://platform.deepseek.com/api_keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/apikey',
};

const TASK_LABEL: Record<AITask, string> = {
  handwriting: 'aiHandwriting',
  diagram: 'aiDiagram',
  'image-text': 'aiImageText',
  mindmap: 'aiMindmap',
};

export interface AISettingsHost {
  app: App;
  settings(): AISettings;
  save(s: AISettings): void;
  service: AIService;
  /** Re-render the AI section only (keeps the settings page scroll position). */
  redraw(): void;
}

function keyStatus(el: HTMLElement, h: AISettingsHost, p: AIProfile): void {
  const r = h.service.profileReady(p);
  const span = el.createSpan({ cls: r.ready ? 'hn-ai-ok' : 'hn-ai-missing' });
  if (p.type === 'mock') span.setText(t('aiNoKeyNeeded'));
  else span.setText(r.ready ? `${t('aiConfigured')} · ${p.secretName}` : r.reason === 'no-endpoint' ? t('aiNoEndpoint') : t('aiNotSet'));
}

/** "AI" section of the plugin settings tab (Excalidraw-style provider + model lists). */
export function renderAISettings(containerEl: HTMLElement, h: AISettingsHost): void {
  containerEl.empty();
  const s = h.settings();
  const set = (patch: Partial<AISettings>, redraw = false) => {
    h.save({ ...h.settings(), ...patch });
    if (redraw) h.redraw();
  };
  new Setting(containerEl).setName(t('aiHeading')).setHeading();
  containerEl.createDiv({ cls: 'setting-item-description hn-ai-intro', text: t('aiIntro') });
  const supported = secretsSupported(h.app);
  if (!supported) containerEl.createDiv({ cls: 'setting-item-description mod-warning hn-ai-warn', text: t('aiNoSecretStorage') });

  new Setting(containerEl)
    .setName(t('aiEnable'))
    .setDesc(t('aiEnableDesc'))
    .addToggle((tg) => tg.setValue(s.enabled).onChange((v) => set({ enabled: v }, true)));
  if (!s.enabled) return;

  const u = s.usage;
  new Setting(containerEl)
    .setName(t('aiUsage'))
    .setDesc(t('aiUsageDesc'))
    .addButton((b) => b.setButtonText(`${t('aiUsageButton')}: ${u.totalRequests} / ${u.totalInputTokens + u.totalOutputTokens}`).onClick(() => new UsageModal(h).open()));
  new Setting(containerEl)
    .setName(t('aiVerbose'))
    .setDesc(t('aiVerboseDesc'))
    .addToggle((tg) => tg.setValue(s.verboseLog).onChange((v) => set({ verboseLog: v })));

  // ---- provider profiles
  const card = containerEl.createDiv({ cls: 'hn-ai-card' });
  new Setting(card)
    .setName(t('aiProviders'))
    .setDesc(t('aiProvidersDesc'))
    .addExtraButton((b) =>
      b
        .setIcon('plus-circle')
        .setTooltip(t('aiProviderAdd'))
        .onClick(() => new ProfileModal(h, null).open()),
    )
    .addExtraButton((b) =>
      b
        .setIcon('rotate-ccw')
        .setTooltip(t('aiProviderRestore'))
        .onClick(() => {
          // keep the user's own profiles and chosen secrets; re-add missing defaults
          const cur = h.settings();
          const profiles = [...cur.profiles];
          for (const d of defaultProfiles()) if (!profiles.some((p) => p.id === d.id)) profiles.push(d);
          set({ profiles }, true);
        }),
    );
  for (const p of s.profiles) {
    const row = new Setting(card).setName(p.name);
    const desc = row.descEl;
    desc.createDiv({ text: `${t('aiType')}: ${PROVIDER_TYPE_LABEL[p.type]}` });
    const api = desc.createDiv({ text: 'API: ' });
    keyStatus(api, h, p);
    row.addExtraButton((b) => b.setIcon('pencil').setTooltip(t('aiProviderEdit')).onClick(() => new ProfileModal(h, p).open()));
    row.addExtraButton((b) =>
      b
        .setIcon('trash')
        .setTooltip(t('aiProviderRemove'))
        .onClick(() => {
          const used = h.settings().modelEntries.filter((m) => m.profileId === p.id);
          const remove = () => {
            const cur = h.settings();
            const modelEntries = cur.modelEntries.filter((m) => m.profileId !== p.id);
            const taskModels = { ...cur.taskModels };
            for (const k of Object.keys(taskModels) as AITask[]) if (!modelEntries.some((m) => m.id === taskModels[k])) delete taskModels[k];
            set({ profiles: cur.profiles.filter((x) => x.id !== p.id), modelEntries, taskModels, defaultModel: modelEntries.some((m) => m.id === cur.defaultModel) ? cur.defaultModel : (modelEntries[0]?.id ?? '') }, true);
          };
          if (used.length) new ConfirmModal(h.app, `${t('aiProviderRemoveConfirm')} ${used.map((m) => m.name).join(', ')}`, remove).open();
          else remove();
        }),
    );
  }

  // ---- models
  const modelSetting = (name: string, desc: string, current: string, onPick: (id: string) => void, allowDefault: boolean) => {
    const st = new Setting(containerEl).setName(name);
    st.descEl.createDiv({ text: desc });
    const entry = s.modelEntries.find((m) => m.id === current) ?? (allowDefault ? undefined : s.modelEntries.find((m) => m.id === s.defaultModel));
    if (entry) {
      const prof = s.profiles.find((p) => p.id === entry.profileId);
      const info = st.descEl.createDiv({ cls: 'hn-ai-model-info' });
      info.createDiv({ text: `${t('aiProvider')}: ${prof ? `${prof.name} (${PROVIDER_TYPE_LABEL[prof.type]})` : '—'}` });
      if (prof) {
        const k = info.createDiv({ text: 'API key: ' });
        keyStatus(k, h, prof);
      }
      info.createDiv({ text: `${t('aiModelId')}: ${entry.model}` });
      info.createDiv({ text: `Endpoint: ${entry.endpoint || (prof ? prof.baseUrl || DEFAULT_BASE_URL[prof.type] || '—' : '—')}` });
      const mm = info.createDiv({ text: `${t('aiMultimodal')}: ` });
      mm.createSpan({ cls: entry.multimodal ? 'hn-ai-ok' : 'hn-ai-missing', text: entry.multimodal ? t('aiYes') : t('aiNoVisionWarn') });
    }
    st.addDropdown((d) => {
      if (allowDefault) d.addOption('', t('aiSameAsDefault'));
      for (const m of s.modelEntries) d.addOption(m.id, m.name);
      d.setValue(allowDefault ? current : entry?.id ?? '').onChange((v) => onPick(v));
    });
    return { st, entry };
  };
  const def = modelSetting(t('aiModels'), t('aiModelsDesc'), s.defaultModel, (id) => set({ defaultModel: id }, true), false);
  def.st
    .addExtraButton((b) =>
      b
        .setIcon('pencil')
        .setTooltip(t('aiModelEdit'))
        .onClick(() => def.entry && new ModelModal(h, def.entry).open()),
    )
    .addExtraButton((b) =>
      b
        .setIcon('plus-circle')
        .setTooltip(t('aiModelAdd'))
        .onClick(() => new ModelModal(h, null).open()),
    )
    .addExtraButton((b) =>
      b
        .setIcon('trash')
        .setTooltip(t('aiModelRemove'))
        .onClick(() => {
          const cur = h.settings();
          if (!def.entry || cur.modelEntries.length <= 1) return;
          const modelEntries = cur.modelEntries.filter((m) => m.id !== def.entry?.id);
          const taskModels = { ...cur.taskModels };
          for (const k of Object.keys(taskModels) as AITask[]) if (taskModels[k] === def.entry.id) delete taskModels[k];
          set({ modelEntries, taskModels, defaultModel: modelEntries[0].id }, true);
        }),
    )
    .addExtraButton((b) =>
      b
        .setIcon('rotate-ccw')
        .setTooltip(t('aiModelRestore'))
        .onClick(() => {
          const cur = h.settings();
          const modelEntries = [...cur.modelEntries];
          for (const d of defaultModelEntries()) if (!modelEntries.some((m) => m.id === d.id) && cur.profiles.some((p) => p.id === d.profileId)) modelEntries.push(d);
          set({ modelEntries }, true);
        }),
    );

  // per-task routing (optional): e.g. an OCR model for handwriting, a reasoning model for diagrams
  for (const task of AI_TASKS) {
    modelSetting(
      `${t('aiModelFor')} ${t(TASK_LABEL[task])}`,
      t('aiModelForDesc'),
      s.taskModels[task] ?? '',
      (id) => {
        const taskModels = { ...h.settings().taskModels };
        if (id) taskModels[task] = id;
        else delete taskModels[task];
        set({ taskModels }, true);
      },
      true,
    ).st.settingEl.addClass('hn-ai-task-model');
  }

  const status = containerEl.createDiv({ cls: 'setting-item-description hn-ai-status' });
  const st = h.service.status();
  status.setText(st.ready ? `${t('aiReady')} · ${h.service.label()} · ${h.service.model('handwriting')}` : `${t('aiNotReady')}: ${reasonText(st.reason)}`);
  new Setting(containerEl)
    .setName(t('aiTest'))
    .setDesc(t('aiTestDesc'))
    .addButton((b) =>
      b.setButtonText(t('aiTestButton')).onClick(async () => {
        b.setDisabled(true);
        status.setText(t('aiTesting'));
        try {
          const r = await h.service.test();
          status.setText(`OK · ${r.model} · ${r.ms} ms`);
        } catch (e) {
          status.setText(`${t('aiTestFailed')}: ${e instanceof AIError ? e.message : 'error'}`);
        } finally {
          b.setDisabled(false);
        }
      }),
    );

  new Setting(containerEl).setName(t('aiTextStyle')).addDropdown((d) =>
    d
      .addOption('hand', t('aiTextHand'))
      .addOption('sans', t('aiTextSans'))
      .setValue(s.textFont)
      .onChange((v) => set({ textFont: v === 'sans' ? 'sans' : 'hand' })),
  );
  const num = (name: string, desc: string, value: number, lo: number, hi: number, apply: (n: number) => void) =>
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((tx) => {
        tx.inputEl.type = 'number';
        tx.setValue(String(value)).onChange((v) => {
          const x = Math.round(Number(v));
          if (Number.isFinite(x)) apply(Math.max(lo, Math.min(hi, x)));
        });
      });
  num(t('aiMaxTokens'), t('aiMaxTokensDesc'), s.maxOutputTokens, 256, 32000, (v) => set({ maxOutputTokens: v }));
  num(t('aiTimeout'), '', s.timeoutSec, 10, 300, (v) => set({ timeoutSec: v }));
  new Setting(containerEl)
    .setName(t('aiRetries'))
    .setDesc(t('aiRetriesDesc'))
    .addDropdown((d) =>
      d
        .addOption('0', '0')
        .addOption('1', '1')
        .addOption('2', '2')
        .setValue(String(s.maxRetries))
        .onChange((v) => set({ maxRetries: Number(v) })),
    );
  num(t('aiDailyLimit'), t('aiDailyLimitDesc'), s.dailyLimit, 0, 10000, (v) => set({ dailyLimit: v }));
}

function reasonText(r?: string): string {
  const k: Record<string, string> = {
    disabled: 'aiReasonDisabled',
    'no-key': 'aiReasonNoKey',
    'no-model': 'aiReasonNoModel',
    'no-endpoint': 'aiNoEndpoint',
    'model-not-multimodal': 'aiNoVisionWarn',
    'secret-storage-unsupported': 'aiNoSecretStorage',
    'hosted-unavailable': 'aiReasonHosted',
  };
  return r && k[r] ? t(k[r]) : (r ?? '');
}

// ------------------------------------------------------------------------------------------------
// Dialogs
// ------------------------------------------------------------------------------------------------

class ProfileModal extends Modal {
  private draft: AIProfile;
  private error!: HTMLElement;

  constructor(
    private readonly h: AISettingsHost,
    private readonly original: AIProfile | null,
  ) {
    super(h.app);
    this.draft = original ? { ...original } : { id: '', name: '', type: 'openai', baseUrl: '' };
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('hn-ai-modal');
    this.titleEl.setText(this.original ? t('aiProviderEdit') : t('aiProviderAdd'));
    const d = this.draft;
    new Setting(contentEl)
      .setName(t('aiProfileName'))
      .setDesc(t('aiProfileNameDesc'))
      .addText((tx) => tx.setPlaceholder('e.g. OpenAI').setValue(d.name).onChange((v) => (d.name = v.trim())));
    new Setting(contentEl)
      .setName(t('aiProviderType'))
      .setDesc(t('aiProviderTypeDesc'))
      .addDropdown((dd) => {
        for (const ty of PROVIDER_TYPES) dd.addOption(ty, PROVIDER_TYPE_LABEL[ty]);
        dd.setValue(d.type).onChange((v) => {
          d.type = v as ProviderType;
          d.baseUrl = '';
          this.render();
        });
      });
    if (d.type !== 'mock') {
      const key = new Setting(contentEl).setName('API key');
      key.descEl.createDiv({ text: t('aiKeyDesc') });
      const help = KEY_HELP[d.type];
      if (help) {
        const a = key.descEl.createEl('a', { text: t('aiKeyWhere'), href: help });
        a.setAttr('target', '_blank');
        a.setAttr('rel', 'noopener');
      }
      const SC = secretComponentCtor();
      if (SC && secretsSupported(this.h.app)) {
        key.addComponent((el: HTMLElement) => {
          const c = new SC(this.h.app, el);
          c.setValue(d.secretName ?? '');
          c.onChange((v) => {
            const name = (v ?? '').trim();
            if (name) d.secretName = name;
            else delete d.secretName;
          });
          return c as unknown as obsidian.BaseComponent;
        });
      } else {
        key.setDisabled(true);
        key.descEl.createDiv({ cls: 'mod-warning', text: t('aiNoSecretStorage') });
      }
      if (d.type === 'qwen') {
        new Setting(contentEl)
          .setName(t('aiRegion'))
          .setDesc(t('aiRegionDesc'))
          .addDropdown((dd) =>
            dd
              .addOption('cn', '中国内地 (北京) · dashscope.aliyuncs.com')
              .addOption('intl', 'International (Singapore) · dashscope-intl.aliyuncs.com')
              .addOption('custom', t('aiCustomUrl'))
              .setValue(!d.baseUrl ? 'cn' : d.baseUrl === QWEN_REGIONS['intl-singapore'] ? 'intl' : d.baseUrl === QWEN_REGIONS['cn-beijing'] ? 'cn' : 'custom')
              .onChange((v) => {
                d.baseUrl = v === 'intl' ? QWEN_REGIONS['intl-singapore'] : v === 'cn' ? '' : d.baseUrl || 'https://';
                this.render();
              }),
          );
      }
      new Setting(contentEl)
        .setName('Base URL')
        .setDesc(d.type === 'openai-compatible' ? t('aiBaseUrlCompatDesc') : `${t('aiBaseUrlDesc')} ${DEFAULT_BASE_URL[d.type]}`)
        .addText((tx) => tx.setPlaceholder(DEFAULT_BASE_URL[d.type] || 'https://…/v1').setValue(d.baseUrl ?? '').onChange((v) => (d.baseUrl = v.trim())));
    }
    this.error = contentEl.createDiv({ cls: 'hn-ai-error' });
    const result = contentEl.createDiv({ cls: 'setting-item-description hn-ai-status' });
    const foot = new Setting(contentEl);
    foot.addButton((b) =>
      b.setButtonText(t('aiTestButton')).onClick(async () => {
        const model = this.h.settings().modelEntries.find((m) => m.profileId === d.id)?.model ?? SUGGESTED_MODELS[d.type][0];
        if (!model) {
          result.setText(t('aiTestNeedsModel'));
          return;
        }
        b.setDisabled(true);
        result.setText(t('aiTesting'));
        try {
          const r = await this.h.service.testWith({ ...d, baseUrl: d.baseUrl || '' }, { model });
          result.setText(`OK · ${r.model} · ${r.ms} ms`);
        } catch (e) {
          result.setText(`${t('aiTestFailed')}: ${e instanceof AIError ? e.message : 'error'}`);
        } finally {
          b.setDisabled(false);
        }
      }),
    );
    foot.addButton((b) => b.setButtonText(t('cancel')).onClick(() => this.close()));
    foot.addButton((b) =>
      b
        .setButtonText('OK')
        .setCta()
        .onClick(() => this.save()),
    );
  }

  private save(): void {
    const d = this.draft;
    const cur = this.h.settings();
    if (!d.name) return void this.error.setText(t('aiNameRequired'));
    if (cur.profiles.some((p) => p.name === d.name && p.id !== this.original?.id)) return void this.error.setText(t('aiNameTaken'));
    if (d.baseUrl && !isAllowedBaseUrl(d.baseUrl, d.type)) return void this.error.setText(t('aiBadUrl'));
    if (d.type === 'openai-compatible' && !d.baseUrl) return void this.error.setText(t('aiNoEndpoint'));
    const profiles = [...cur.profiles];
    if (this.original) {
      const i = profiles.findIndex((p) => p.id === this.original?.id);
      profiles[i] = { ...d };
    } else {
      profiles.push({ ...d, id: newEntityId(d.type, profiles) });
    }
    // a model entry of this profile whose provider type changed keeps working only with a valid id
    this.h.save({ ...cur, profiles });
    this.close();
    this.h.redraw();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ModelModal extends Modal {
  private draft: AIModelEntry;
  private error!: HTMLElement;

  constructor(
    private readonly h: AISettingsHost,
    private readonly original: AIModelEntry | null,
  ) {
    super(h.app);
    const first = h.settings().profiles[0];
    this.draft = original ? { ...original } : { id: '', name: '', profileId: first?.id ?? '', model: '', multimodal: true };
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('hn-ai-modal');
    this.titleEl.setText(this.original ? t('aiModelEdit') : t('aiModelAdd'));
    const d = this.draft;
    const s = this.h.settings();
    const prof = s.profiles.find((p) => p.id === d.profileId);
    new Setting(contentEl)
      .setName(t('aiEntryName'))
      .setDesc(t('aiEntryNameDesc'))
      .addText((tx) => tx.setPlaceholder('e.g. qwen3-vl-plus').setValue(d.name).onChange((v) => (d.name = v.trim())));
    new Setting(contentEl)
      .setName(t('aiProvider'))
      .setDesc(t('aiEntryProviderDesc'))
      .addDropdown((dd) => {
        for (const p of s.profiles) dd.addOption(p.id, `${p.name} (${PROVIDER_TYPE_LABEL[p.type]})`);
        dd.setValue(d.profileId).onChange((v) => {
          d.profileId = v;
          this.render();
        });
      });
    const sugg = prof ? SUGGESTED_MODELS[prof.type] : [];
    new Setting(contentEl)
      .setName(t('aiModelId'))
      .setDesc(`${t('aiModelIdDesc')}${sugg.length ? ` ${t('aiSuggested')}: ${sugg.join(', ')}` : ''}`)
      .addText((tx) => {
        tx.setPlaceholder(sugg[0] ?? 'model-id')
          .setValue(d.model)
          .onChange((v) => {
            d.model = v.trim();
            if (!d.name || d.name === this.original?.model) d.name = d.model;
          });
        if (sugg.length) {
          const listId = `hn-models-${Math.random().toString(36).slice(2, 8)}`;
          const dl = contentEl.createEl('datalist');
          dl.id = listId;
          for (const m of sugg) dl.createEl('option', { value: m });
          tx.inputEl.setAttr('list', listId);
        }
      });
    new Setting(contentEl)
      .setName(t('aiEndpoint'))
      .setDesc(`${t('aiEndpointDesc')} ${prof ? prof.baseUrl || DEFAULT_BASE_URL[prof.type] || '—' : ''}`)
      .addText((tx) => tx.setPlaceholder(t('aiDerived')).setValue(d.endpoint ?? '').onChange((v) => {
        const x = v.trim();
        if (x) d.endpoint = x;
        else delete d.endpoint;
      }));
    new Setting(contentEl)
      .setName(t('aiMultimodal'))
      .setDesc(t('aiMultimodalDesc'))
      .addToggle((tg) => tg.setValue(d.multimodal).onChange((v) => (d.multimodal = v)));
    this.error = contentEl.createDiv({ cls: 'hn-ai-error' });
    const foot = new Setting(contentEl);
    foot.addButton((b) => b.setButtonText(t('cancel')).onClick(() => this.close()));
    foot.addButton((b) =>
      b
        .setButtonText('OK')
        .setCta()
        .onClick(() => this.save()),
    );
  }

  private save(): void {
    const d = this.draft;
    const cur = this.h.settings();
    const prof = cur.profiles.find((p) => p.id === d.profileId);
    if (!prof) return void this.error.setText(t('aiPickProvider'));
    if (!d.model || !MODEL_ID_RE.test(d.model)) return void this.error.setText(t('aiBadModelId'));
    if (!d.name) d.name = d.model;
    if (cur.modelEntries.some((m) => m.name === d.name && m.id !== this.original?.id)) return void this.error.setText(t('aiNameTaken'));
    if (d.endpoint && !isAllowedBaseUrl(d.endpoint, prof.type)) return void this.error.setText(t('aiBadUrl'));
    const modelEntries = [...cur.modelEntries];
    let defaultModel = cur.defaultModel;
    if (this.original) {
      const i = modelEntries.findIndex((m) => m.id === this.original?.id);
      modelEntries[i] = { ...d };
    } else {
      const id = newEntityId('m', modelEntries);
      modelEntries.push({ ...d, id });
      if (!defaultModel) defaultModel = id;
    }
    this.h.save({ ...cur, modelEntries, defaultModel });
    this.close();
    this.h.redraw();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onYes: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t('cancel')).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t('delete'))
          .setWarning()
          .onClick(() => {
            this.close();
            this.onYes();
          }),
      );
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

class UsageModal extends Modal {
  constructor(private readonly h: AISettingsHost) {
    super(h.app);
  }
  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(t('aiUsage'));
    const s = this.h.settings();
    const u = s.usage;
    contentEl.createEl('p', { text: `${t('aiToday')}: ${u.day ? u.requests : 0} · ${u.inputTokens} in / ${u.outputTokens} out` });
    contentEl.createEl('p', { text: `${t('aiTotal')}: ${u.totalRequests} (${u.failures} ${t('aiFailed')}) · ${u.totalInputTokens} in / ${u.totalOutputTokens} out` });
    const tbl = contentEl.createEl('table', { cls: 'hn-ai-usage' });
    const hr = tbl.createEl('tr');
    for (const x of [t('aiModels'), t('aiRequests'), 'in', 'out', t('aiFailed')]) hr.createEl('th', { text: x });
    for (const [name, m] of Object.entries(s.usageByModel)) {
      const r = tbl.createEl('tr');
      for (const x of [name, m.requests, m.inputTokens, m.outputTokens, m.failures]) r.createEl('td', { text: String(x) });
    }
    contentEl.createEl('p', { cls: 'setting-item-description', text: t('aiUsageNote') });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText(t('aiReset')).onClick(() => {
        this.h.save({ ...this.h.settings(), usage: { day: '', requests: 0, inputTokens: 0, outputTokens: 0, totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, failures: 0 }, usageByModel: {} });
        this.close();
        this.h.redraw();
      }),
    );
  }
  onClose(): void {
    this.contentEl.empty();
  }
}


/**
 * Transport for MyScript Cloud: the browser `fetch` first — the same path MyScript's own web SDK
 * (iinkTS) uses, with CORS headers served by MyScript and a real abort — then Obsidian's
 * requestUrl when fetch is refused (e.g. CORS on this platform).
 */
export function myscriptHttp(timeoutMs = 25000): HttpFn {
  return async (req) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    try {
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: 'omit', mode: 'cors', ...(ctrl ? { signal: ctrl.signal } : {}) });
      return { status: res.status, text: await res.text(), via: 'fetch' };
    } catch (e) {
      if (ctrl?.signal.aborted) throw new AIError('timeout', `no answer within ${Math.round(timeoutMs / 1000)} s (fetch)`);
      // fetch refused (CORS / platform): try Obsidian's own request API
      const r = await obsidianHttp(req);
      return { ...r, via: `requestUrl (fetch: ${String((e as Error)?.message ?? e).slice(0, 60)})` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
