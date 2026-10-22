import type { DataAdapter } from 'obsidian';

/**
 * Device-local safety net, stored inside the plugin folder (.obsidian/plugins/handnote/).
 *
 * With Remotely Save's syncConfigDir = false, nothing here is synced, so:
 *  - journal/  : the latest unsaved document state per note, written a moment after each change.
 *                Survives an Obsidian crash or iPadOS killing the app before the debounced save.
 *  - backups/  : the on-disk version of a note just before HandNote first overwrites it in a
 *                session (rolling window per note). Protects against a bad save or sync mishap.
 */
export interface JournalEntry {
  path: string;
  docId: string;
  /** Revision of the on-disk file this unsaved state was based on. */
  baseRevision: number;
  savedAt: number;
  content: string;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

export class RecoveryStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly dir: string,
    private readonly keepBackups = 5,
  ) {}

  private async ensure(sub: string): Promise<string> {
    const p = `${this.dir}/${sub}`;
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    if (!(await this.adapter.exists(p))) await this.adapter.mkdir(p);
    return p;
  }

  async writeJournal(entry: JournalEntry): Promise<void> {
    const d = await this.ensure('journal');
    await this.adapter.write(`${d}/${safeName(entry.docId)}.json`, JSON.stringify(entry));
  }

  async readJournal(docId: string): Promise<JournalEntry | null> {
    const p = `${this.dir}/journal/${safeName(docId)}.json`;
    try {
      if (!(await this.adapter.exists(p))) return null;
      const e = JSON.parse(await this.adapter.read(p)) as JournalEntry;
      return e && typeof e.content === 'string' ? e : null;
    } catch {
      return null;
    }
  }

  async clearJournal(docId: string): Promise<void> {
    const p = `${this.dir}/journal/${safeName(docId)}.json`;
    try {
      if (await this.adapter.exists(p)) await this.adapter.remove(p);
    } catch {
      /* ignore */
    }
  }

  async backup(docId: string, content: string): Promise<void> {
    if (!content.trim()) return;
    const d = await this.ensure('backups');
    const sub = `${d}/${safeName(docId)}`;
    if (!(await this.adapter.exists(sub))) await this.adapter.mkdir(sub);
    await this.adapter.write(`${sub}/${Date.now()}.handnote`, content);
    try {
      const list = await this.adapter.list(sub);
      const files = list.files.filter((f) => f.endsWith('.handnote')).sort();
      while (files.length > this.keepBackups) {
        const f = files.shift() as string;
        await this.adapter.remove(f);
      }
    } catch {
      /* pruning is best effort */
    }
  }
}
