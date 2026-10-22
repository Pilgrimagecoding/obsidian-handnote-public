import { defaultEditorSettings, sanitizeEditorSettings, type EditorSettings } from '../editor/settings';
import { randomDeviceId } from '../storage/sync-guard';
import { defaultAISettings, sanitizeAISettings, type AISettings } from '../ai/service';

export interface HandNotePluginSettings {
  editor: EditorSettings;
  /** Folder for new notes; empty = same folder as the active note (or vault root). */
  newNoteFolder: string;
  /** Pages rendered in a Markdown embed preview (0 = all). */
  embedMaxPages: number;
  /** Open the editor in a new tab when an embed is tapped. */
  embedOpensNewTab: boolean;
  backupsPerNote: number;
  /** Random id of this device, written into each saved revision. Never synced (data.json). */
  deviceId: string;
  /** AI conversion settings. Holds only the *names* of secrets, never an API key. */
  ai: AISettings;
}

export function defaultPluginSettings(): HandNotePluginSettings {
  return {
    editor: defaultEditorSettings(),
    newNoteFolder: '',
    embedMaxPages: 3,
    embedOpensNewTab: true,
    backupsPerNote: 5,
    deviceId: randomDeviceId(),
    ai: defaultAISettings(),
  };
}

export function sanitizePluginSettings(raw: unknown): HandNotePluginSettings {
  const d = defaultPluginSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<HandNotePluginSettings>;
  return {
    editor: sanitizeEditorSettings(r.editor),
    newNoteFolder: typeof r.newNoteFolder === 'string' ? r.newNoteFolder.replace(/^\/+|\/+$/g, '') : '',
    embedMaxPages: typeof r.embedMaxPages === 'number' && r.embedMaxPages >= 0 ? Math.floor(r.embedMaxPages) : d.embedMaxPages,
    embedOpensNewTab: r.embedOpensNewTab !== false,
    backupsPerNote: typeof r.backupsPerNote === 'number' && r.backupsPerNote >= 1 ? Math.min(50, Math.floor(r.backupsPerNote)) : d.backupsPerNote,
    deviceId: typeof r.deviceId === 'string' && r.deviceId.length > 4 ? r.deviceId : d.deviceId,
    ai: sanitizeAISettings(r.ai),
  };
}
