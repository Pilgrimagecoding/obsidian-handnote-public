/**
 * Mind map model (Xmind-style). A mind map is ONE page item whose content is a tree; positions are
 * never stored — they are computed by the local layout (layout.ts) from the tree, the theme and
 * the layout direction. Text, branches and colours therefore cannot overlap or drift apart, and
 * editing the tree (add / delete / move a topic, collapse) re-flows the map deterministically.
 */

import { stripControl } from '../utils/text';

export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
  /** Children hidden (shown as a +N badge). */
  collapsed?: boolean;
}

export type MapThemeId = 'academic' | 'hand' | 'minimal';
export type MapLayoutId = 'balanced' | 'right';

export const MAP_THEMES: MapThemeId[] = ['academic', 'hand', 'minimal'];
export const MAP_LAYOUTS: MapLayoutId[] = ['balanced', 'right'];

export const MAP_LIMITS = { maxNodes: 500, maxDepth: 12, maxText: 300 };

let seq = 0;
export function nodeId(): string {
  seq = (seq + 1) % 1e6;
  return `m${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Plain tree (e.g. from recognition) → model nodes with ids. */
export function fromTree(t: { text: string; children: { text: string; children: unknown[] }[] }): MindNode {
  const conv = (n: { text: string; children: unknown[] }): MindNode => ({
    id: nodeId(),
    text: n.text,
    children: (n.children as { text: string; children: unknown[] }[]).map(conv),
  });
  return conv(t);
}

export function countNodes(n: MindNode): number {
  return 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
}

export function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export function findParent(root: MindNode, id: string): MindNode | null {
  for (const c of root.children) {
    if (c.id === id) return root;
    const f = findParent(c, id);
    if (f) return f;
  }
  return null;
}

export function isDescendant(root: MindNode, ancestorId: string, id: string): boolean {
  const a = findNode(root, ancestorId);
  return !!a && a.id !== id && !!findNode(a, id);
}

/** Deep copy with the same ids. */
export function cloneTree(n: MindNode): MindNode {
  return { ...n, children: n.children.map(cloneTree) };
}

/** Immutable update: returns a new tree where `id` was replaced by fn(node). */
export function updateNode(root: MindNode, id: string, fn: (n: MindNode) => MindNode): MindNode {
  if (root.id === id) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const n = updateNode(c, id, fn);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...root, children } : root;
}

export function setText(root: MindNode, id: string, text: string): MindNode {
  const v = stripControl(text).slice(0, MAP_LIMITS.maxText);
  return updateNode(root, id, (n) => ({ ...n, text: v }));
}

export function addChild(root: MindNode, parentId: string, text: string): { root: MindNode; id: string } {
  const id = nodeId();
  return { root: updateNode(root, parentId, (n) => ({ ...n, collapsed: false, children: [...n.children, { id, text, children: [] }] })), id };
}

/** New sibling right after `id` (the root has no siblings: a child is added instead). */
export function addSibling(root: MindNode, id: string, text: string): { root: MindNode; id: string } {
  const p = findParent(root, id);
  if (!p) return addChild(root, id, text);
  const nid = nodeId();
  return {
    root: updateNode(root, p.id, (n) => {
      const i = n.children.findIndex((c) => c.id === id);
      const children = [...n.children];
      children.splice(i + 1, 0, { id: nid, text, children: [] });
      return { ...n, children };
    }),
    id: nid,
  };
}

/** Remove a topic and its subtree (the root cannot be removed). */
export function removeNode(root: MindNode, id: string): MindNode {
  const p = findParent(root, id);
  if (!p) return root;
  return updateNode(root, p.id, (n) => ({ ...n, children: n.children.filter((c) => c.id !== id) }));
}

/** Move a topic under a new parent at an index (no cycles; the root stays the root). */
export function moveNode(root: MindNode, id: string, newParentId: string, index = -1): MindNode {
  if (id === root.id || id === newParentId || isDescendant(root, id, newParentId)) return root;
  const node = findNode(root, id);
  if (!node) return root;
  const without = removeNode(root, id);
  return updateNode(without, newParentId, (n) => {
    const children = [...n.children];
    const at = index < 0 || index > children.length ? children.length : index;
    children.splice(at, 0, node);
    return { ...n, collapsed: false, children };
  });
}

export function toggleCollapsed(root: MindNode, id: string): MindNode {
  return updateNode(root, id, (n) => (n.children.length ? { ...n, collapsed: !n.collapsed } : n));
}

/** Markdown outline (copy / insert into a note). */
export function toMarkdown(root: MindNode): string {
  const out: string[] = [`# ${root.text}`];
  const walk = (n: MindNode, depth: number) => {
    for (const c of n.children) {
      out.push(`${'  '.repeat(depth)}- ${c.text.replace(/\n/g, ' ')}`);
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out.join('\n');
}

/** Mermaid `mindmap` diagram (Obsidian renders it in Markdown). */
export function toMermaidMindmap(root: MindNode): string {
  const esc = (s: string) => s.replace(/[()[\]{}]/g, ' ').replace(/\n/g, ' ').trim() || '…';
  const out: string[] = ['mindmap', `  root((${esc(root.text)}))`];
  const walk = (n: MindNode, depth: number) => {
    for (const c of n.children) {
      out.push(`${'  '.repeat(depth + 2)}${esc(c.text)}`);
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out.join('\n');
}

/** Markdown outline → tree (paste an outline to create a map). */
export function fromMarkdown(md: string): MindNode | null {
  const lines = md.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  let rootText = lines[0].replace(/^#+\s*/, '').replace(/^[-*+]\s*/, '').trim();
  let start = 1;
  if (!/^#/.test(lines[0]) && /^\s*[-*+]/.test(lines[0])) {
    rootText = 'Topic';
    start = 0;
  }
  const root: MindNode = { id: nodeId(), text: rootText || 'Topic', children: [] };
  const stack: { node: MindNode; indent: number }[] = [{ node: root, indent: -1 }];
  for (const l of lines.slice(start)) {
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(l);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const node: MindNode = { id: nodeId(), text: m[2].trim().slice(0, MAP_LIMITS.maxText), children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent });
  }
  return root;
}
