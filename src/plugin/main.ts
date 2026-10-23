import {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  finishRenderMath,
  loadMathJax,
  normalizePath,
  renderMath,
  requestUrl,
  type App,
  type Editor,
  getLanguage,
} from 'obsidian';
import { serializeDocument } from '../document/codec';
import { createDocument, defaultBackground, paperById, PAPER_PRESETS, type BackgroundKind } from '../document/model';
import { GeometryCache } from '../document/geometry-cache';
import { renderPageToCanvas } from '../rendering/paint';
import { pageToSvg } from '../rendering/svg-export';
import { preloadImages, setImageResolver } from '../rendering/items-paint';
import { languageOf, setLanguage, t } from '../ui/i18n';
import { AIService } from '../ai/service';
import { myscriptHttp, obsidianHttp, renderAISettings, secretStorage, secretsSupported } from './ai-settings';
import type { AIBridge } from '../editor/handnote-editor';
import type { RecognitionBridge } from '../editor/convert-flow';
import { HandwritingRecognitionService } from '../recognition/service';
import { renderFormula, setMathEngine } from '../rendering/formula';
import { HandFont } from './hand-font';
import { renderRecognitionSettings } from './rec-settings';
import { LocalRecognition } from '../local';
import { openSelfTest, renderLocalSettings } from './local-settings';
import { runSelfTest, selfTestReport } from '../local/selftest';
import { imageMime } from './mime';
import { RecoveryStore } from '../storage/recovery';
import { defaultEditorSettings } from '../editor/settings';
import { EmbedManager } from './embed';
import { sanitizePluginSettings, type HandNotePluginSettings } from './plugin-settings';
import { EXTENSION, HandNoteView, VIEW_TYPE } from './view';
import { DocumentImporter, IMPORT_EXTENSIONS } from './import';
import { ensureDocPage } from '../rendering/doc-layer';

export default class HandNotePlugin extends Plugin {
  /** Markdown embeds of handwritten notes (exposed for tests: mount counter). */
  embeds!: EmbedManager;
  settings!: HandNotePluginSettings;
  recovery!: RecoveryStore;
  ai!: AIService;
  recognition!: HandwritingRecognitionService;
  local!: LocalRecognition;
  handFont!: HandFont;
  importer!: DocumentImporter;
  private settingsTimer: number | null = null;

  async onload(): Promise<void> {
    this.settings = sanitizePluginSettings(await this.loadData());
    // persist a freshly generated device id right away
    await this.saveData(this.settings);
    const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.recovery = new RecoveryStore(this.app.vault.adapter, dir, this.settings.backupsPerNote);

    // Images in notes are vault attachments; load them as blob URLs (same-origin, so PNG export
    // and canvas reads are not blocked by a tainted canvas).
    const blobUrls: string[] = [];
    setImageResolver(async (src) => {
      if (src.startsWith('data:')) return src;
      const f = this.app.vault.getAbstractFileByPath(normalizePath(src));
      if (!(f instanceof TFile)) throw new Error(`missing image ${src}`);
      const buf = await this.app.vault.readBinary(f);
      const url = URL.createObjectURL(new Blob([buf], { type: imageMime(f.extension) }));
      blobUrls.push(url);
      return url;
    });
    this.register(() => {
      for (const u of blobUrls) URL.revokeObjectURL(u);
      setImageResolver(async (s) => s);
    });
    // the interface language Obsidian reports (Settings → General → Language)
    setLanguage(languageOf(getLanguage()));
    this.ai = new AIService({
      settings: () => this.settings.ai,
      saveSettings: (a) => {
        this.settings.ai = a;
        this.queueSaveSettings();
      },
      getSecret: (name) => secretStorage(this.app)?.getSecret(name) ?? null,
      secretsSupported: secretsSupported(this.app),
      http: obsidianHttp,
    });
    // on-device recognition: model packs are downloaded only on request (Obsidian's requestUrl —
    // no CORS, desktop and mobile), verified, and kept in this device's IndexedDB
    // requestUrl has no timeout of its own: a mirror that hangs must not block the others
    const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(`timeout (${Math.round(ms / 1000)} s)`)), ms))]);
    this.local = new LocalRecognition(
      async (url, bytes) => {
        // scaled to the file: 20 s + 100 KB/s (a 16 MB model: ~3 min; a font subset: ~20 s)
        const r = await within(requestUrl({ url, method: 'GET', throw: false }), 20000 + (bytes ?? 8e6) / 100);
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer;
      },
      undefined,
      {},
      async (url) => {
        const t0 = performance.now();
        const r = await within(requestUrl({ url, method: 'HEAD', throw: false }), 8000);
        // any HTTP answer below 500 means the host is reachable from this network
        if (!r.status || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        return performance.now() - t0;
      },
    );
    void this.local.refresh();
    this.register(() => this.local.dispose());
    this.recognition = new HandwritingRecognitionService({
      local: this.local,
      ai: this.ai,
      settings: () => this.settings.ai,
      recognition: () => this.settings.ai.recognition,
      getSecret: (name) => secretStorage(this.app)?.getSecret(name) ?? null,
      secretsSupported: secretsSupported(this.app),
      http: myscriptHttp(),
    });
    // formulas: Obsidian's own MathJax (loaded on demand; CHTML output snapshotted onto the canvas)
    setMathEngine({
      render: async (latex) => {
        await loadMathJax();
        const MJ = (window as unknown as { MathJax?: { tex2chtmlPromise?: (s: string, o: { display: boolean }) => Promise<HTMLElement> } }).MathJax;
        if (MJ?.tex2chtmlPromise) return MJ.tex2chtmlPromise(latex, { display: true });
        return renderMath(latex, true);
      },
      finish: () => finishRenderMath(),
    });
    this.register(() => setMathEngine(null));
    this.handFont = new HandFont(this.app.vault.adapter, dir);
    void this.handFont.load();
    this.registerView(VIEW_TYPE, (leaf) => new HandNoteView(leaf, this));
    try {
      this.registerExtensions([EXTENSION], VIEW_TYPE);
    } catch (e) {
      // Another plugin (or a previous instance during hot reload) already claimed the extension.
      console.warn('HandNote: could not register .handnote extension', e);
    }

    this.addRibbonIcon('pen-tool', 'New handwritten note', () => void this.createAndOpen());
    this.importer = new DocumentImporter(this);
    this.addCommand({
      id: 'import-document',
      name: 'Import document (PDF, Word, PowerPoint, Excel) for annotation',
      callback: () => this.importer.open(this.app.workspace.getActiveViewOfType(HandNoteView)),
    });

    this.addCommand({
      id: 'create',
      name: 'New handwritten note',
      callback: () => void this.createAndOpen(),
    });
    this.addCommand({
      id: 'local-selftest',
      name: 'Local recognition self-test (on this device)',
      callback: () => openSelfTest(this.app, this.local),
    });
    this.addCommand({
      id: 'create-in-folder',
      name: 'New handwritten note in the current folder',
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        void this.createInFolder(f?.parent ?? this.app.vault.getRoot());
      },
    });
    this.addCommand({
      id: 'embed-images',
      name: 'Embed attachment images into the current handwritten note',
      checkCallback: (checking) =>
        this.withView(checking, (v) => {
          void v.editor?.embedAttachmentImages().then((n) => new Notice(n ? `${t('embedImagesDone')}: ${n}` : t('embedImagesNone')));
        }),
    });
    // "New HandNote" next to New note / New folder in the file explorer menu (folders and the
    // vault root). Uses the official file-menu event — no DOM patching.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && IMPORT_EXTENSIONS.includes(file.extension.toLowerCase())) {
          menu.addItem((item) => item.setTitle(t('annotateInHandNote')).setIcon('pen-tool').onClick(() => this.importer.annotate(file)));
          return;
        }
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) => {
          item
            .setTitle(t('newHandNote'))
            .setIcon('pen-tool')
            .onClick(() => void this.createInFolder(file));
          try {
            item.setSection('action-primary');
          } catch {
            /* older Obsidian: default section */
          }
        });
      }),
    );
    this.addCommand({
      id: 'create-and-embed',
      name: 'Insert new handwritten note at cursor',
      editorCallback: (editor: Editor, view) => {
        const base = view.file ? view.file.basename : 'HandNote';
        new NameModal(this.app, base, (name) => void this.createAndEmbed(editor, view.file ?? null, name)).open();
      },
    });
    this.addCommand({
      id: 'undo',
      name: 'Undo (handwriting)',
      checkCallback: (checking) => this.withView(checking, (v) => v.editor?.undo()),
    });
    this.addCommand({
      id: 'redo',
      name: 'Redo (handwriting)',
      checkCallback: (checking) => this.withView(checking, (v) => v.editor?.redo()),
    });
    this.addCommand({
      id: 'export-png',
      name: 'Export current page as PNG',
      checkCallback: (checking) => this.withView(checking, (v) => void this.exportPage(v, 'png')),
    });
    this.addCommand({
      id: 'export-svg',
      name: 'Export current page as SVG',
      checkCallback: (checking) => this.withView(checking, (v) => void this.exportPage(v, 'svg')),
    });
    this.addCommand({
      id: 'toggle-hud',
      name: 'Toggle performance overlay',
      callback: () => {
        this.settings.editor.showHud = !this.settings.editor.showHud;
        this.queueSaveSettings();
        this.broadcastSettings(null);
      },
    });

    this.embeds = new EmbedManager(this);
    this.embeds.start();
    this.addSettingTab(new HandNoteSettingTab(this.app, this));

    // Flush unsaved strokes when the app is backgrounded (iPad home gesture, lock screen,
    // switching apps): timers do not run while iPadOS has the app suspended.
    const flushAll = () => {
      for (const v of this.views()) void v.flush();
    };
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll();
    });
    this.registerDomEvent(window, 'pagehide', flushAll);
    this.registerDomEvent(window, 'blur', flushAll);
    this.registerEvent(this.app.workspace.on('quit', flushAll));
  }

  onunload(): void {
    for (const v of this.views()) void v.flush();
    if (this.settingsTimer !== null) {
      window.clearTimeout(this.settingsTimer);
      void this.saveData(this.settings);
    }
  }

  /** Self-test report as text (E2E / support). */
  async runLocalSelfTest(): Promise<string> {
    return selfTestReport(await runSelfTest(this.local, () => undefined));
  }

  views(): HandNoteView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is HandNoteView => v instanceof HandNoteView);
  }

  private withView(checking: boolean, fn: (v: HandNoteView) => void): boolean {
    const v = this.app.workspace.getActiveViewOfType(HandNoteView);
    if (!v) return false;
    if (!checking) fn(v);
    return true;
  }

  queueSaveSettings(): void {
    if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
    this.settingsTimer = window.setTimeout(() => {
      this.settingsTimer = null;
      void this.saveData(this.settings);
    }, 500);
  }

  /** Push changed editor settings (tool, color, width...) to all open editors. */
  broadcastSettings(except: HandNoteView | null): void {
    for (const v of this.views()) if (v !== except) v.editor?.updateSettings(this.settings.editor);
  }

  // ---------------------------------------------------------------------------------------------
  // Creating notes
  // ---------------------------------------------------------------------------------------------

  private targetFolder(context: TFile | null): string {
    if (this.settings.newNoteFolder) return this.settings.newNoteFolder;
    const f = context ?? this.app.workspace.getActiveFile();
    return f?.parent?.path && f.parent.path !== '/' ? f.parent.path : '';
  }

  /** Path for a new note named after something (import): settings folder or next to `context`. */
  newNotePath(name: string, context: TFile | null): string {
    return this.uniquePath(this.targetFolder(context), name);
  }

  async ensureFolderOf(path: string): Promise<void> {
    const i = path.lastIndexOf('/');
    await this.ensureFolder(i > 0 ? path.slice(0, i) : '');
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    await this.app.vault.createFolder(path);
  }

  private uniquePath(folder: string, name: string): string {
    const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || 'HandNote';
    const prefix = folder ? `${folder}/` : '';
    let p = normalizePath(`${prefix}${clean}.${EXTENSION}`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(p)) {
      p = normalizePath(`${prefix}${clean} ${i}.${EXTENSION}`);
      i++;
    }
    return p;
  }

  async createNote(name: string, context: TFile | null): Promise<TFile> {
    const folder = this.targetFolder(context);
    await this.ensureFolder(folder);
    const path = this.uniquePath(folder, name);
    const s = this.settings.editor;
    const paper = paperById(s.newPagePaper);
    const doc = createDocument({
      width: paper.width,
      height: paper.height,
      background: defaultBackground(s.newPageBackground, s.newPaperTone),
      device: this.settings.deviceId,
    });
    return this.app.vault.create(path, serializeDocument(doc));
  }

  /** Create a note in a given folder (file explorer menu) and open it. */
  async createInFolder(folder: TFolder): Promise<void> {
    const stamp = formatStamp(new Date());
    const path = folder.isRoot() ? '' : folder.path;
    const file = await this.createNoteAt(path, `HandNote ${stamp}`);
    new Notice(t('newHandNoteCreated'));
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  private async createNoteAt(folder: string, name: string): Promise<TFile> {
    await this.ensureFolder(folder);
    const path = this.uniquePath(folder, name);
    const s = this.settings.editor;
    const paper = paperById(s.newPagePaper);
    const doc = createDocument({ width: paper.width, height: paper.height, background: defaultBackground(s.newPageBackground, s.newPaperTone), device: this.settings.deviceId });
    return this.app.vault.create(path, serializeDocument(doc));
  }

  /** What the editor sees of the AI service. */
  /** Diagnostics (tests / support): how a formula renders here — no content leaves the device. */
  async formulaInfo(latex: string): Promise<{ math: boolean; glyphs: number; rules: number; error: string | null; w: number; h: number }> {
    const d = await renderFormula(latex);
    return { math: d.math, glyphs: d.glyphs.length, rules: d.rules.length, error: d.error, w: d.w, h: d.h };
  }

  recognizerBridge(): RecognitionBridge {
    return {
      engineFor: (task) => this.recognition.engineFor(task),
      recognize: (task, input, signal, onStage) => this.recognition.recognize(task, input, signal, onStage),
      textFont: () => this.settings.ai.textFont,
      mapTheme: () => this.settings.ai.recognition.mapTheme,
      record: (run, ms, task) => this.recognition.record(run, ms, task),
      enableOffline: () => {
        this.settings.ai = { ...this.settings.ai, recognition: { ...this.settings.ai.recognition, offlineZh: true } };
        this.queueSaveSettings();
      },
      prefs: () => {
        const r = this.settings.ai.recognition;
        return { mode: r.convertMode, keepInk: r.keepInk, alwaysSend: r.myscriptAlwaysSend, prefetch: r.prefetch };
      },
      setAlwaysSend: (on) => {
        this.settings.ai = { ...this.settings.ai, recognition: { ...this.settings.ai.recognition, myscriptAlwaysSend: on } };
        this.queueSaveSettings();
      },
      warmUp: () => this.recognition.warmUp(),
      warmLocal: (task) => this.recognition.warmLocal(task),
      prepareText: (text) => this.local.fonts.ensure(text),
      englishMissingBytes: () => (this.local.available('text-en') ? this.local.missingBytes('text-en') : undefined),
      installEnglish: async (progress) => {
        await this.local.install('text-en', (p) => progress(`${t('localPackInstall')} ${p.done}/${p.total}`));
        this.recognition.clearCache();
      },
      fontMissingBytes: () => (this.local.available('font-hand') ? this.local.missingBytes('font-hand') : undefined),
      installFont: async (progress) => {
        await this.local.install('font-hand', (p) => progress(`${t('localPackInstall')} ${p.done}/${p.total}`));
      },
      localMissingBytes: (task) => {
        const id = task === 'math' ? 'math' : 'text-zh';
        return this.local.available(id) ? this.local.missingBytes(id) : undefined;
      },
      installLocal: async (task, progress) => {
        await this.local.install(task === 'math' ? 'math' : 'text-zh', (p) =>
          progress(t('localProgress').replace('{file}', p.file).replace('{done}', String(p.done + 1)).replace('{total}', String(Math.max(1, p.total))).replace('{host}', p.host)),
        );
        this.recognition.clearCache();
      },
      rtt: () => this.recognition.networkRtt(),
    };
  }

  aiBridge(): AIBridge {
    return {
      status: () => this.ai.status(),
      model: (task) => this.ai.model(task),
      label: () => this.ai.label(),
      textFont: () => this.settings.ai.textFont,
      run: (task, image, meta, signal) => this.ai.run(task, image, meta, signal),
    };
  }

  /** Open this plugin's settings tab (used by the editor when AI is not configured). */
  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    try {
      setting?.open();
      setting?.openTabById(this.manifest.id);
    } catch {
      new Notice(t('aiNotConfigured'));
    }
  }

  async createAndOpen(): Promise<void> {
    const stamp = formatStamp(new Date());
    const file = await this.createNote(`HandNote ${stamp}`, null);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  async createAndEmbed(editor: Editor, context: TFile | null, name: string): Promise<void> {
    const file = await this.createNote(name, context);
    const link = this.app.fileManager.generateMarkdownLink(file, context?.path ?? '');
    const embed = link.startsWith('!') ? link : `!${link}`;
    editor.replaceSelection(`${embed}\n`);
    new Notice(`Created ${file.name}`);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  // ---------------------------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------------------------

  async exportPage(view: HandNoteView, kind: 'png' | 'svg', index?: number): Promise<void> {
    const doc = view.getDocument();
    const file = view.file;
    if (!doc || !file || !view.editor) return;
    const idx = index ?? view.editor.currentPageIndex();
    const page = doc.pages[idx];
    if (!page) return;
    const folder = file.parent?.path && file.parent.path !== '/' ? `${file.parent.path}/` : '';
    let path = normalizePath(`${folder}${file.basename} p${idx + 1}.${kind}`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}${file.basename} p${idx + 1} (${i++}).${kind}`);
    const geo = view.editor.cache ?? new GeometryCache();
    if (kind === 'svg') {
      await this.app.vault.create(path, pageToSvg(page, geo));
    } else {
      const canvas = document.createElement('canvas');
      await preloadImages(page);
      await ensureDocPage(page, 3);
      renderPageToCanvas(canvas, page, geo, 3);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) {
        new Notice('HandNote: PNG export failed');
        return;
      }
      await this.app.vault.createBinary(path, await blob.arrayBuffer());
    }
    new Notice(`Exported ${path}`);
  }
}

function formatStamp(d: Date): string {
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

class NameModal extends Modal {
  constructor(
    app: App,
    private readonly initial: string,
    private readonly done: (name: string) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText('New handwritten note');
    const input = this.contentEl.createEl('input', { type: 'text', value: this.initial, cls: 'hn-name-input' });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.done(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Create', cls: 'mod-cta' }).onclick = submit;
    window.setTimeout(() => input.select(), 0);
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

class HandNoteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: HandNotePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();
    const save = () => {
      p.queueSaveSettings();
      p.broadcastSettings(null);
    };

    new Setting(containerEl).setName('New notes').setHeading();
    new Setting(containerEl)
      .setName('Folder for new handwritten notes')
      .setDesc('Leave empty to create them next to the active note. Avoid folders starting with "_" or "." — Remotely Save skips those by default.')
      .addText((t) =>
        t.setPlaceholder('e.g. Handwriting').setValue(s.newNoteFolder).onChange((v) => {
          s.newNoteFolder = v.trim().replace(/^\/+|\/+$/g, '');
          save();
        }),
      );
    new Setting(containerEl).setName('Paper size').addDropdown((d) => {
      for (const pp of PAPER_PRESETS) d.addOption(pp.id, pp.label);
      d.setValue(s.editor.newPagePaper).onChange((v) => {
        s.editor.newPagePaper = v;
        save();
      });
    });
    new Setting(containerEl).setName('Page background').addDropdown((d) => {
      for (const k of ['blank', 'ruled', 'grid', 'dots']) d.addOption(k, k[0].toUpperCase() + k.slice(1));
      d.setValue(s.editor.newPageBackground).onChange((v) => {
        s.editor.newPageBackground = v as BackgroundKind;
        save();
      });
    });

    new Setting(containerEl).setName('Input').setHeading();
    new Setting(containerEl)
      .setName('Input mode on this device')
      .setDesc('Auto picks Pen-first on iPad and Mouse-first on desktop. Stored only on this device, never in your notes.')
      .addDropdown((d) =>
        d
          .addOption('auto', 'Auto')
          .addOption('pen', 'Pen-first (Apple Pencil + fingers)')
          .addOption('mouse', 'Mouse-first (mouse, trackpad, keyboard)')
          .setValue(s.editor.inputMode)
          .onChange((v) => {
            s.editor.inputMode = v as 'auto' | 'pen' | 'mouse';
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Fountain pen variant')
      .setDesc('A = v0.1 Baseline, B = Experimental pressure engine. Existing strokes keep the engine they were written with.')
      .addDropdown((d) =>
        d
          .addOption('experimental', 'B · Experimental')
          .addOption('baseline', 'A · v0.1 Baseline')
          .setValue(s.editor.fountainVariant)
          .onChange((v) => {
            s.editor.fountainVariant = v === 'baseline' ? 'baseline' : 'experimental';
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Finger drawing')
      .setDesc('Off (recommended on iPad): only Apple Pencil draws; fingers scroll and zoom; palms are ignored.')
      .addToggle((t) =>
        t.setValue(s.editor.fingerDrawing).onChange((v) => {
          s.editor.fingerDrawing = v;
          save();
        }),
      );
    new Setting(containerEl)
      .setName('Two-finger tap to undo, three-finger tap to redo')
      .addToggle((t) =>
        t.setValue(s.editor.tapGestures).onChange((v) => {
          s.editor.tapGestures = v;
          save();
        }),
      );
    new Setting(containerEl)
      .setName(t('fingerDoubleTap'))
      .setDesc(t('fingerDoubleTapDesc'))
      .addToggle((tg) =>
        tg.setValue(s.editor.fingerDoubleTapEraser).onChange((v) => {
          s.editor.fingerDoubleTapEraser = v;
          save();
        }),
      );
    new Setting(containerEl)
      .setName('Predicted ink (experimental)')
      .setDesc('Extends the live stroke with the browser\'s predicted pointer positions when available. Never saved. Compare on and off on your iPad.')
      .addToggle((t) =>
        t.setValue(s.editor.usePrediction).onChange((v) => {
          s.editor.usePrediction = v;
          save();
        }),
      );
    new Setting(containerEl)
      .setName('Eraser size (screen pixels)')
      .addSlider((sl) =>
        sl
          .setLimits(4, 40, 1)
          .setValue(s.editor.eraserRadius)
          .setDynamicTooltip()
          .onChange((v) => {
            s.editor.eraserRadius = v;
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Performance overlay')
      .setDesc('Shows input interval, processing and render times. These are not pen-to-screen latency.')
      .addToggle((t) =>
        t.setValue(s.editor.showHud).onChange((v) => {
          s.editor.showHud = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Collect input diagnostics')
      .setDesc('Records pressure, sampling and touch sizes locally to calibrate the pens. Copy the report from the editor ⋯ menu. Nothing is uploaded.')
      .addToggle((t) =>
        t.setValue(s.editor.diagnostics).onChange((v) => {
          s.editor.diagnostics = v;
          save();
        }),
      );

    new Setting(containerEl).setName('Paper').setHeading();
    new Setting(containerEl).setName('Paper tone for new notes').addDropdown((d) =>
      d
        .addOption('white', 'White')
        .addOption('cream', 'Cream')
        .addOption('yellow', 'Pale yellow')
        .setValue(s.editor.newPaperTone)
        .onChange((v) => {
          s.editor.newPaperTone = v as 'white' | 'cream' | 'yellow';
          save();
        }),
    );
    new Setting(containerEl)
      .setName('Paper grain')
      .setDesc('A very light texture on screen. Exports stay clean.')
      .addToggle((t) =>
        t.setValue(s.editor.paperTexture).onChange((v) => {
          s.editor.paperTexture = v;
          save();
        }),
      );

    new Setting(containerEl).setName('Imported documents').setHeading();
    new Setting(containerEl)
      .setName('Folder for imported originals')
      .setDesc('A document picked from this device is kept once in this folder: the note stores only a reference to it and your annotations, never the file itself. Empty: the attachment location set in Obsidian. Files annotated where they already are in the vault are not copied.')
      .addText((t) =>
        t
          .setValue(s.importFolder)
          .onChange((v) => {
            s.importFolder = v.trim().replace(/^\/+|\/+$/g, '');
            save();
          }),
      );

    new Setting(containerEl).setName('Images').setHeading();
    new Setting(containerEl)
      .setName('Store inserted images')
      .setDesc('Inside the .handnote file (one file to sync; large images are downscaled to 2048 px) or as attachments in the vault. Existing notes are never converted automatically — use the command "Embed attachment images into the current handwritten note".')
      .addDropdown((d) =>
        d
          .addOption('embed', 'Inside the handwritten note')
          .addOption('attachment', 'As vault attachments')
          .setValue(s.editor.imageStorage)
          .onChange((v) => {
            s.editor.imageStorage = v === 'attachment' ? 'attachment' : 'embed';
            save();
          }),
      );

    // The AI section re-renders on its own (adding a provider, switching a model …): re-rendering
    // the whole tab used to jump the page back to the top on every toggle.
    const aiSection = containerEl.createDiv({ cls: 'hn-ai-section' });
    const renderAI = () => {
      const scroller = containerEl;
      const top = scroller.scrollTop;
      renderAISettings(aiSection, {
        app: this.app,
        settings: () => p.settings.ai,
        save: (a) => {
          p.settings.ai = a;
          p.queueSaveSettings();
        },
        service: p.ai,
        redraw: renderAI,
      });
      {
        // recognition (Convert) does not depend on the general AI switch: it comes first
        const recEl = createDiv({ cls: 'hn-rec-section' });
        aiSection.prepend(recEl);
        const localEl = createDiv({ cls: 'hn-local-section' });
        aiSection.prepend(localEl);
        renderLocalSettings(localEl, { local: p.local, redraw: renderAI, app: this.app, onChange: () => p.recognition.clearCache() });
        renderRecognitionSettings(recEl, {
          app: this.app,
          settings: () => p.settings.ai,
          save: (a) => {
            p.settings.ai = a;
            p.queueSaveSettings();
          },
          recognition: p.recognition,
          handFont: p.handFont,
          redraw: renderAI,
        });
      }
      scroller.scrollTop = top;
      window.requestAnimationFrame(() => (scroller.scrollTop = top));
    };
    renderAI();

    new Setting(containerEl).setName('Embeds').setHeading();
    new Setting(containerEl)
      .setName('Pages shown in a Markdown embed')
      .setDesc('0 = all pages')
      .addSlider((sl) =>
        sl
          .setLimits(0, 10, 1)
          .setValue(s.embedMaxPages)
          .setDynamicTooltip()
          .onChange((v) => {
            s.embedMaxPages = v;
            save();
          }),
      );
    new Setting(containerEl).setName('Open embeds in a new tab').addToggle((t) =>
      t.setValue(s.embedOpensNewTab).onChange((v) => {
        s.embedOpensNewTab = v;
        save();
      }),
    );

    new Setting(containerEl).setName('Safety').setHeading();
    new Setting(containerEl)
      .setName('Local backups per note')
      .setDesc('Before HandNote first overwrites a note in a session, the previous version is copied to the plugin folder on this device (not synced).')
      .addSlider((sl) =>
        sl
          .setLimits(1, 20, 1)
          .setValue(s.backupsPerNote)
          .setDynamicTooltip()
          .onChange((v) => {
            s.backupsPerNote = v;
            save();
          }),
      );
    new Setting(containerEl)
      .setName('Reset pen settings')
      .setDesc('Restore default width, pressure, smoothing and tapering for all pens.')
      .addButton((b) =>
        b.setButtonText('Reset').onClick(() => {
          const d = defaultEditorSettings();
          s.editor.pens = d.pens;
          save();
          new Notice('HandNote pen settings reset');
        }),
      );
    new Setting(containerEl).setName('Device id').setDesc(`${s.deviceId} — written into each saved revision to identify sync conflicts.`);
  }
}


