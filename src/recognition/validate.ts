import { cleanText, extractJson } from '../ai/scene';
import type { DiagramEdgeIn, DiagramNodeIn, DiagramShape, MindTreeNode, RecResult, RecTask, TextLineResult } from './types';

/**
 * Strict validation of recognition answers (vision models, MyScript, mock). Unknown fields are
 * dropped, strings are cleaned and length-limited, trees are depth/size-limited, edges must point
 * at existing nodes. Nothing here is executed or rendered as HTML — results become plain strings
 * and numbers in HandNote's own objects.
 */

export const REC_LIMITS = {
  maxLines: 200,
  maxLineChars: 400,
  maxAlternatives: 5,
  maxLatexChars: 4000,
  maxNodes: 300,
  maxDepth: 8,
  maxNodeChars: 200,
  maxEdges: 600,
  maxWarnings: 10,
};

export class RecError extends Error {
  constructor(
    readonly code: 'empty' | 'invalid-json' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'RecError';
  }
}

const str = (v: unknown, max: number): string | null => cleanText(v, max);

function warnings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const w of v) {
    const s = str(w, 200);
    if (s) out.push(s);
    if (out.length >= REC_LIMITS.maxWarnings) break;
  }
  return out;
}

function alternatives(v: unknown, main: string): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const a of v) {
    const s = str(a, REC_LIMITS.maxLineChars);
    if (s && s !== main && !out.includes(s)) out.push(s);
    if (out.length >= REC_LIMITS.maxAlternatives) break;
  }
  return out;
}

function confidence(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined;
}

/** LaTeX from a model: strip $…$ / \[…\] / ```latex fences; keep it a plain string. */
export function cleanLatex(v: unknown): string | null {
  let s = str(v, REC_LIMITS.maxLatexChars);
  if (!s) return null;
  s = s.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```$/, '').trim();
  s = s.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').replace(/^\\\[([\s\S]*)\\\]$/, '$1').replace(/^\\\(([\s\S]*)\\\)$/, '$1');
  s = s.trim();
  return s || null;
}

function tree(v: unknown, depth: number, budget: { n: number }): MindTreeNode | null {
  if (!v || typeof v !== 'object' || budget.n <= 0) return null;
  const o = v as Record<string, unknown>;
  const text = str(o.text ?? o.topic ?? o.title, REC_LIMITS.maxNodeChars);
  if (!text) return null;
  budget.n--;
  const children: MindTreeNode[] = [];
  if (depth < REC_LIMITS.maxDepth && Array.isArray(o.children)) {
    for (const c of o.children) {
      const t = tree(c, depth + 1, budget);
      if (t) children.push(t);
      if (budget.n <= 0) break;
    }
  }
  return { text, children };
}

const SHAPES: DiagramShape[] = ['rect', 'roundrect', 'ellipse', 'diamond', 'parallelogram'];

/** Parse and validate a model / engine answer for a task. Throws RecError. */
export function validateRecognition(task: RecTask, raw: unknown): RecResult {
  if (raw === null || raw === undefined || raw === '') throw new RecError('empty', 'empty answer');
  let o: Record<string, unknown>;
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new RecError('empty', 'empty answer');
    try {
      o = extractJson(raw) as Record<string, unknown>;
    } catch (e) {
      throw new RecError('invalid-json', (e as Error).message);
    }
  } else o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new RecError('invalid-result', 'not an object');
  const warn = warnings(o.warnings);
  switch (task) {
    case 'text':
    case 'image-text': {
      const src = Array.isArray(o.lines) ? o.lines : typeof o.text === 'string' ? String(o.text).split('\n') : [];
      const lines: TextLineResult[] = [];
      for (const l of src) {
        const obj = typeof l === 'string' ? { text: l } : (l as Record<string, unknown>);
        const text = str(obj?.text, REC_LIMITS.maxLineChars);
        if (!text) continue;
        lines.push({ text, alternatives: alternatives(obj.alternatives ?? obj.candidates, text), confidence: confidence(obj.confidence) });
        if (lines.length >= REC_LIMITS.maxLines) break;
      }
      if (!lines.length) throw new RecError('empty', 'no text recognised');
      return { task, lines, warnings: warn };
    }
    case 'math': {
      const latex = cleanLatex(o.latex);
      if (!latex) throw new RecError('empty', 'no formula recognised');
      const alts: string[] = [];
      if (Array.isArray(o.alternatives)) {
        for (const a of o.alternatives) {
          const l = cleanLatex(a);
          if (l && l !== latex && !alts.includes(l)) alts.push(l);
          if (alts.length >= REC_LIMITS.maxAlternatives) break;
        }
      }
      return { task, latex, alternatives: alts, warnings: warn };
    }
    case 'mindmap': {
      const root = tree(o.root ?? o, 0, { n: REC_LIMITS.maxNodes });
      if (!root) throw new RecError('empty', 'no mind map recognised');
      return { task, root, warnings: warn };
    }
    case 'diagram': {
      const nodes: DiagramNodeIn[] = [];
      const ids = new Set<string>();
      for (const n of Array.isArray(o.nodes) ? o.nodes : []) {
        const r = n as Record<string, unknown>;
        const id = str(r?.id, 40);
        if (!id || ids.has(id)) continue;
        const text = str(r.text ?? r.label, REC_LIMITS.maxNodeChars) ?? '';
        const shape = SHAPES.includes(r.shape as DiagramShape) ? (r.shape as DiagramShape) : 'roundrect';
        const node: DiagramNodeIn = { id, text, shape };
        if (Array.isArray(r.pos) && r.pos.length === 2 && r.pos.every((x) => typeof x === 'number' && Number.isFinite(x))) node.pos = [Math.max(0, Math.min(1, r.pos[0] as number)), Math.max(0, Math.min(1, r.pos[1] as number))];
        ids.add(id);
        nodes.push(node);
        if (nodes.length >= REC_LIMITS.maxNodes) break;
      }
      if (!nodes.length) throw new RecError('empty', 'no diagram recognised');
      const edges: DiagramEdgeIn[] = [];
      for (const e of Array.isArray(o.edges) ? o.edges : []) {
        const r = e as Record<string, unknown>;
        const from = str(r?.from, 40);
        const to = str(r?.to, 40);
        if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) continue;
        const arrow = r.arrow === 'both' || r.arrow === 'none' ? r.arrow : 'end';
        const edge: DiagramEdgeIn = { from, to, arrow };
        const label = str(r.label, 80);
        if (label) edge.label = label;
        if (r.dashed === true) edge.dashed = true;
        edges.push(edge);
        if (edges.length >= REC_LIMITS.maxEdges) break;
      }
      return { task, nodes, edges, direction: o.direction === 'LR' ? 'LR' : 'TB', warnings: warn };
    }
  }
}

/** Count the nodes of a tree. */
export function treeSize(n: MindTreeNode): number {
  return 1 + n.children.reduce((a, c) => a + treeSize(c), 0);
}
