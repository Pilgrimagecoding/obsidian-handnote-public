import { Modal, Notice, Setting, type App } from 'obsidian';
import type { LocalRecognition } from '../local';
import { PACKS, packBytes, type PackId } from '../local/manifest';
import { runSelfTest, selfTestReport } from '../local/selftest';
import { t } from '../ui/i18n';

export interface LocalSettingsHost {
  app: App;
  local: LocalRecognition;
  redraw(): void;
  onChange(): void;
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/** Settings → Local recognition: packs (size, licence, download / delete) and the self-test. */
export function renderLocalSettings(el: HTMLElement, h: LocalSettingsHost): void {
  const lang = t('pen') === '笔' ? 'zh' : 'en';
  new Setting(el).setName(t('localSection')).setHeading();
  el.createDiv({ cls: 'setting-item-description hn-ai-intro', text: t('localIntro') });
  if (h.local.storageBlocked) el.createDiv({ cls: 'hn-local-blocked mod-warning', text: t('localStorageBlocked') });
  if (h.local.unsupported()) el.createDiv({ cls: 'hn-local-blocked mod-warning', text: t('localUnsupported') });
  const rows: [PackId, string][] = [
    ['math', t('convertMath')],
    ['text-zh', t('convertText')],
    ['text-en', 'English'],
    ['runtime', 'Runtime'],
    ['font-hand', 'Font'],
  ];
  for (const [id] of rows) {
    const pack = PACKS[id];
    if (!h.local.available(id) && !h.local.state(id)?.have && !(id === 'runtime' && h.local.runtimeBuiltIn)) continue;
    const st = h.local.state(id);
    const s = new Setting(el).setName(pack.title[lang]);
    const builtIn = id === 'runtime' && h.local.runtimeBuiltIn;
    const status = builtIn ? (h.local.unsupported() ? t('localUnsupportedShort') : `${t('localPackBuiltIn')} · ${mb(st?.bytes ?? 0)}`) : st?.installed ? `${t('localPackInstalled')} · ${mb(st.bytes)}` : st?.damaged.length ? t('localPackDamaged') : `${t('localPackMissing')} · ${mb(packBytes(id, false))}`;
    s.descEl.createDiv({ text: `${status} · v${pack.version}` });
    s.descEl.createDiv({ cls: 'hn-local-licence', text: `${t('localPackLicence')}: ${pack.licence[lang]}` });
    const prog = s.descEl.createDiv({ cls: 'hn-ai-status' });
    if (!st?.installed && h.local.available(id)) {
      s.addButton((b) =>
        b
          .setButtonText(`${t('localPackInstall')} (${mb(h.local.missingBytes(id))})`)
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              prog.setText(t('localProbing'));
              await h.local.install(id, (p) => p.host === 'probing mirrors' ? prog.setText(t('localProbing')) : prog.setText(t('localProgress').replace('{file}', p.file).replace('{done}', String(p.done + 1)).replace('{total}', String(Math.max(1, p.total))).replace('{host}', p.host)));
              h.onChange();
              h.redraw();
            } catch (e) {
              const msg = String((e as Error)?.message ?? e);
              prog.setText(msg === 'storage-blocked' ? t('localStorageBlocked') : `${t('localInstallFailed')}: ${msg.slice(0, 300)}`);
              b.setDisabled(false);
              b.setButtonText(t('localInstallRetry'));
            }
          }),
      );
    }
    if (!builtIn && (st?.installed || (st?.have ?? 0) > 0)) {
      s.addButton((b) =>
        b
          .setButtonText(t('localPackDelete'))
          .setWarning()
          .onClick(async () => {
            await h.local.remove(id);
            h.onChange();
            h.redraw();
          }),
      );
    }
  }
  // offline / blocked networks: import the same files from this device (verified by SHA-256)
  const imp = new Setting(el).setName(t('localImport')).setDesc(t('localImportDesc'));
  const res = imp.descEl.createDiv({ cls: 'hn-ai-status' });
  imp.addButton((b) =>
    b.setButtonText(t('localImportPick')).onClick(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = async () => {
        const files = await Promise.all(Array.from(input.files ?? []).map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
        const r = await h.local.importFiles(files);
        res.setText(`✔ ${r.accepted.join(', ') || '—'}${r.rejected.length ? ` · ✘ ${r.rejected.join(', ')}` : ''}`);
        h.onChange();
        window.setTimeout(() => h.redraw(), 1500);
      };
      input.click();
    }),
  );
  const test = new Setting(el).setName(t('localSelfTest')).setDesc(t('localSelfTestDesc'));
  test.addButton((b) => b.setButtonText(t('localSelfTestRun')).onClick(() => openSelfTest(h.app, h.local)));
}

/** Self-test modal (also the command "Local recognition self-test"). Copy-able report. */
export function openSelfTest(app: App, local: LocalRecognition): void {
  const m = new Modal(app);
  m.titleEl.setText(t('localSelfTest'));
  const pre = m.contentEl.createEl('pre', { cls: 'hn-selftest' });
  const copy = m.contentEl.createEl('button', { text: t('localSelfTestCopy') });
  copy.disabled = true;
  let report = '';
  copy.onclick = () => void navigator.clipboard.writeText(report).then(() => new Notice('✔'));
  m.open();
  void runSelfTest(local, (l) => pre.appendText(`${l.ok === true ? '✔' : l.ok === false ? '✘' : '·'} ${l.key}: ${l.value}\n`))
    .then((lines) => {
      report = selfTestReport(lines);
      copy.disabled = false;
    })
    .catch((e) => pre.appendText(`✘ ${String((e as Error)?.message ?? e)}\n`));
}
