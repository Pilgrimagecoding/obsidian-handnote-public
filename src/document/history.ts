import type { HandNoteDocument, Page, PageBackground, Stroke } from './model';
import type { Item } from './items';

export interface PageProps {
  width: number;
  height: number;
  background: PageBackground;
}

/**
 * Undo/redo as reversible operations on the document. Operations reference pages by id (not by
 * index) so they stay valid when pages are added or removed around them.
 */
export type Op =
  | { kind: 'add-strokes'; pageId: string; strokes: Stroke[] }
  | { kind: 'remove-strokes'; pageId: string; removed: { index: number; stroke: Stroke }[] }
  | { kind: 'add-page'; index: number; page: Page }
  | { kind: 'remove-page'; index: number; page: Page }
  /** Replace a page's stroke list (partial eraser: strokes split into fragments). */
  | { kind: 'set-strokes'; pageId: string; before: Stroke[]; after: Stroke[] }
  /** Replace a page's item list (text / image / shape edits). Items are immutable values. */
  | { kind: 'set-items'; pageId: string; before: Item[]; after: Item[] }
  /** Change page size / template. */
  | { kind: 'set-page'; pageId: string; before: PageProps; after: PageProps }
  /** Reorder: move a page from index `from` to index `to` (page navigator). */
  | { kind: 'move-page'; pageId: string; from: number; to: number }
  | { kind: 'batch'; ops: Op[] };

export interface ApplyResult {
  /** Pages whose content changed. */
  pages: string[];
  /** True when the page list itself changed. */
  structural: boolean;
}

function findPage(doc: HandNoteDocument, id: string): Page | undefined {
  return doc.pages.find((p) => p.id === id);
}

function merge(results: ApplyResult[]): ApplyResult {
  return { pages: results.flatMap((r) => r.pages), structural: results.some((r) => r.structural) };
}

function movePage(doc: HandNoteDocument, id: string, to: number): ApplyResult {
  const idx = doc.pages.findIndex((p) => p.id === id);
  if (idx < 0) return { pages: [], structural: false };
  const [page] = doc.pages.splice(idx, 1);
  doc.pages.splice(Math.max(0, Math.min(to, doc.pages.length)), 0, page);
  return { pages: [id], structural: true };
}

function setPage(doc: HandNoteDocument, id: string, props: PageProps): ApplyResult {
  const page = findPage(doc, id);
  if (!page) return { pages: [], structural: false };
  page.width = props.width;
  page.height = props.height;
  page.background = { ...props.background };
  return { pages: [page.id], structural: true };
}

export function applyOp(doc: HandNoteDocument, op: Op): ApplyResult {
  switch (op.kind) {
    case 'set-strokes': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      page.strokes = op.after.slice();
      return { pages: [page.id], structural: false };
    }
    case 'set-items': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      page.items = op.after.slice();
      return { pages: [page.id], structural: false };
    }
    case 'set-page':
      return setPage(doc, op.pageId, op.after);
    case 'move-page':
      return movePage(doc, op.pageId, op.to);
    case 'batch':
      return merge(op.ops.map((o) => applyOp(doc, o)));
    case 'add-strokes': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      const existing = new Set(page.strokes.map((s) => s.id));
      for (const s of op.strokes) if (!existing.has(s.id)) page.strokes.push(s);
      return { pages: [page.id], structural: false };
    }
    case 'remove-strokes': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      const ids = new Set(op.removed.map((r) => r.stroke.id));
      page.strokes = page.strokes.filter((s) => !ids.has(s.id));
      return { pages: [page.id], structural: false };
    }
    case 'add-page': {
      if (doc.pages.some((p) => p.id === op.page.id)) return { pages: [], structural: false };
      const idx = Math.max(0, Math.min(op.index, doc.pages.length));
      doc.pages.splice(idx, 0, op.page);
      return { pages: [op.page.id], structural: true };
    }
    case 'remove-page': {
      const idx = doc.pages.findIndex((p) => p.id === op.page.id);
      if (idx < 0 || doc.pages.length <= 1) return { pages: [], structural: false };
      doc.pages.splice(idx, 1);
      return { pages: [op.page.id], structural: true };
    }
  }
}

export function invertOp(doc: HandNoteDocument, op: Op): ApplyResult {
  switch (op.kind) {
    case 'set-strokes': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      page.strokes = op.before.slice();
      return { pages: [page.id], structural: false };
    }
    case 'set-items': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      page.items = op.before.slice();
      return { pages: [page.id], structural: false };
    }
    case 'set-page':
      return setPage(doc, op.pageId, op.before);
    case 'move-page':
      return movePage(doc, op.pageId, op.from);
    case 'batch':
      return merge([...op.ops].reverse().map((o) => invertOp(doc, o)));
    case 'add-strokes': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      const ids = new Set(op.strokes.map((s) => s.id));
      page.strokes = page.strokes.filter((s) => !ids.has(s.id));
      return { pages: [page.id], structural: false };
    }
    case 'remove-strokes': {
      const page = findPage(doc, op.pageId);
      if (!page) return { pages: [], structural: false };
      // reinsert at the original z-order positions (ascending index order)
      const sorted = [...op.removed].sort((a, b) => a.index - b.index);
      for (const r of sorted) {
        if (page.strokes.some((s) => s.id === r.stroke.id)) continue;
        page.strokes.splice(Math.min(r.index, page.strokes.length), 0, r.stroke);
      }
      return { pages: [page.id], structural: false };
    }
    case 'add-page': {
      const idx = doc.pages.findIndex((p) => p.id === op.page.id);
      if (idx < 0 || doc.pages.length <= 1) return { pages: [], structural: false };
      doc.pages.splice(idx, 1);
      return { pages: [op.page.id], structural: true };
    }
    case 'remove-page': {
      if (doc.pages.some((p) => p.id === op.page.id)) return { pages: [], structural: false };
      doc.pages.splice(Math.min(op.index, doc.pages.length), 0, op.page);
      return { pages: [op.page.id], structural: true };
    }
  }
}

export class History {
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  constructor(private readonly limit = 300) {}

  /** Apply a new operation and record it. */
  push(doc: HandNoteDocument, op: Op): ApplyResult {
    const r = applyOp(doc, op);
    this.undoStack.push(op);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return r;
  }

  /** Record an operation whose effect has already been applied to the document. */
  record(op: Op): void {
    this.undoStack.push(op);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(doc: HandNoteDocument): ApplyResult | null {
    const op = this.undoStack.pop();
    if (!op) return null;
    this.redoStack.push(op);
    return invertOp(doc, op);
  }

  redo(doc: HandNoteDocument): ApplyResult | null {
    const op = this.redoStack.pop();
    if (!op) return null;
    this.undoStack.push(op);
    return applyOp(doc, op);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
