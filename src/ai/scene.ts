/**
 * HandNote Editable Scene Representation (schema version 1).
 *
 * The only shape in which model output may enter HandNote. A model answer is parsed as JSON and
 * then validated here field by field: unknown fields are dropped, numbers are range-checked,
 * strings are length-limited and stripped of control characters, ids must be unique and every
 * relation must point at an existing object. Nothing in a scene is ever executed, fetched or
 * rendered as HTML/SVG — text is painted with canvas fillText, shapes come from a fixed whitelist,
 * and colours/URLs are not accepted from the model at all.
 *
 * Coordinates are normalized to the uploaded image: (0, 0) = top-left, (1, 1) = bottom-right.
 */

import { stripControl } from '../utils/text';

export const SCENE_SCHEMA_VERSION = 1;

export const SCENE_LIMITS = {
  maxObjects: 300,
  maxTextPerObject: 2000,
  maxTotalText: 20000,
  maxPointsPerConnector: 50,
  maxIdLength: 40,
  maxWarnings: 20,
  maxResponseChars: 300_000,
  /** Coordinates may overshoot the image slightly (strokes at the border). */
  coordMin: -0.1,
  coordMax: 1.1,
};

export type SceneShapeKind = 'rect' | 'roundrect' | 'ellipse' | 'triangle' | 'diamond';
export const SCENE_SHAPES: SceneShapeKind[] = ['rect', 'roundrect', 'ellipse', 'triangle', 'diamond'];

export type BBox = [number, number, number, number];

export interface SceneText {
  id: string;
  type: 'text';
  bbox: BBox;
  text: string;
  /** Number of lines the text occupies in the image (layout hint). */
  lines?: number;
  confidence?: number;
}

export interface SceneFormula {
  id: string;
  type: 'formula';
  bbox: BBox;
  latex: string;
  confidence?: number;
}

export interface SceneShape {
  id: string;
  type: 'shape';
  shape: SceneShapeKind;
  bbox: BBox;
  label?: string;
  confidence?: number;
}

export interface SceneConnector {
  id: string;
  type: 'connector';
  points: [number, number][];
  from?: string;
  to?: string;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  curved?: boolean;
  dashed?: boolean;
  label?: string;
  confidence?: number;
}

export interface SceneMindNode {
  id: string;
  type: 'mindmap_node';
  bbox: BBox;
  text: string;
  parent?: string;
  confidence?: number;
}

export interface SceneGroup {
  id: string;
  type: 'group';
  children: string[];
}

export interface SceneImageRegion {
  id: string;
  type: 'image';
  bbox: BBox;
}

export type SceneObject = SceneText | SceneFormula | SceneShape | SceneConnector | SceneMindNode | SceneGroup | SceneImageRegion;

export interface SceneRelation {
  type: 'parent' | 'label' | 'connects';
  from: string;
  to: string;
}

export interface EditableScene {
  schemaVersion: number;
  sourceSelectionId: string;
  sourceBounds: { x: number; y: number; w: number; h: number };
  objects: SceneObject[];
  relations: SceneRelation[];
  warnings: string[];
  confidence: number | null;
  unresolvedItems: { bbox?: BBox; reason: string }[];
}

export interface SceneValidation {
  scene: EditableScene;
  /** Problems that made objects or relations be dropped. */
  dropped: string[];
}

export class SceneError extends Error {}

// ------------------------------------------------------------------------------------------------

/** Extract the JSON object from a model answer (tolerates ```json fences and leading prose). */
export function extractJson(text: string): unknown {
  if (typeof text !== 'string') throw new SceneError('response is not text');
  if (text.length > SCENE_LIMITS.maxResponseChars) throw new SceneError('response too large');
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new SceneError('no JSON object in response');
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new SceneError('response is not valid JSON');
  }
}


export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = stripControl(v, true, true).replace(/\r\n?/g, '\n').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function coord(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  if (n < SCENE_LIMITS.coordMin || n > SCENE_LIMITS.coordMax) return null;
  return Math.min(1, Math.max(0, n));
}

function bbox(v: unknown): BBox | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const x = coord(v[0]);
  const y = coord(v[1]);
  const w = num(v[2]);
  const h = num(v[3]);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0 || w > 1.2 || h > 1.2) return null;
  return [x, y, Math.min(w, 1 - x || w), Math.min(h, 1 - y || h)];
}

function conf(v: unknown): number | undefined {
  const n = num(v);
  return n === null ? undefined : Math.min(1, Math.max(0, n));
}

function id(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!s || s.length > SCENE_LIMITS.maxIdLength || !/^[\w.:-]+$/.test(s)) return null;
  return s;
}

/**
 * Validate a parsed model answer. Throws SceneError when the answer is unusable as a whole
 * (wrong type, unsupported version); otherwise returns a clean scene plus a list of what was dropped.
 */
export function validateScene(raw: unknown, ctx: { selectionId: string; bounds: { x: number; y: number; w: number; h: number } }): SceneValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SceneError('scene is not an object');
  const r = raw as Record<string, unknown>;
  const version = num(r.schemaVersion) ?? SCENE_SCHEMA_VERSION;
  if (version !== SCENE_SCHEMA_VERSION) throw new SceneError(`unsupported schemaVersion ${version}`);
  const dropped: string[] = [];
  const objects: SceneObject[] = [];
  const ids = new Set<string>();
  let totalText = 0;
  const takeText = (v: unknown, max = SCENE_LIMITS.maxTextPerObject): string | null => {
    const s = cleanText(v, max);
    if (s === null) return null;
    if (totalText + s.length > SCENE_LIMITS.maxTotalText) return null;
    totalText += s.length;
    return s;
  };
  const list = Array.isArray(r.objects) ? r.objects : [];
  if (list.length > SCENE_LIMITS.maxObjects) dropped.push(`${list.length - SCENE_LIMITS.maxObjects} objects over the limit`);
  for (const o of list.slice(0, SCENE_LIMITS.maxObjects)) {
    if (!o || typeof o !== 'object') {
      dropped.push('non-object entry');
      continue;
    }
    const v = o as Record<string, unknown>;
    const oid = id(v.id);
    if (!oid || ids.has(oid)) {
      dropped.push(`object with missing/duplicate id (${String(v.id)})`);
      continue;
    }
    const c = conf(v.confidence);
    let out: SceneObject | null = null;
    switch (v.type) {
      case 'text': {
        const b = bbox(v.bbox);
        const text = takeText(v.text);
        if (b && text) out = { id: oid, type: 'text', bbox: b, text, ...(num(v.lines) ? { lines: Math.min(200, Math.max(1, Math.round(num(v.lines) as number))) } : {}), ...(c !== undefined ? { confidence: c } : {}) };
        break;
      }
      case 'formula': {
        const b = bbox(v.bbox);
        const latex = takeText(v.latex);
        if (b && latex) out = { id: oid, type: 'formula', bbox: b, latex, ...(c !== undefined ? { confidence: c } : {}) };
        break;
      }
      case 'shape': {
        const b = bbox(v.bbox);
        const kind = SCENE_SHAPES.includes(v.shape as SceneShapeKind) ? (v.shape as SceneShapeKind) : null;
        if (b && kind) {
          const label = takeText(v.label, 500);
          out = { id: oid, type: 'shape', shape: kind, bbox: b, ...(label ? { label } : {}), ...(c !== undefined ? { confidence: c } : {}) };
        }
        break;
      }
      case 'connector': {
        const pts: [number, number][] = [];
        if (Array.isArray(v.points)) {
          for (const p of v.points.slice(0, SCENE_LIMITS.maxPointsPerConnector)) {
            if (!Array.isArray(p) || p.length !== 2) continue;
            const x = coord(p[0]);
            const y = coord(p[1]);
            if (x !== null && y !== null) pts.push([x, y]);
          }
        }
        if (pts.length >= 2) {
          const label = takeText(v.label, 500);
          out = {
            id: oid,
            type: 'connector',
            points: pts,
            ...(id(v.from) ? { from: id(v.from) as string } : {}),
            ...(id(v.to) ? { to: id(v.to) as string } : {}),
            arrowStart: v.arrowStart === true,
            arrowEnd: v.arrowEnd === true,
            curved: v.curved === true,
            dashed: v.dashed === true,
            ...(label ? { label } : {}),
            ...(c !== undefined ? { confidence: c } : {}),
          };
        }
        break;
      }
      case 'mindmap_node': {
        const b = bbox(v.bbox);
        const text = takeText(v.text, 500);
        if (b && text) out = { id: oid, type: 'mindmap_node', bbox: b, text, ...(id(v.parent) ? { parent: id(v.parent) as string } : {}), ...(c !== undefined ? { confidence: c } : {}) };
        break;
      }
      case 'group': {
        const children = Array.isArray(v.children) ? (v.children.map(id).filter(Boolean) as string[]).slice(0, SCENE_LIMITS.maxObjects) : [];
        if (children.length) out = { id: oid, type: 'group', children };
        break;
      }
      case 'image': {
        const b = bbox(v.bbox);
        if (b) out = { id: oid, type: 'image', bbox: b };
        break;
      }
      default:
        dropped.push(`unknown object type "${String(v.type)}"`);
        continue;
    }
    if (!out) {
      dropped.push(`invalid ${String(v.type)} object ${oid}`);
      continue;
    }
    ids.add(oid);
    objects.push(out);
  }
  // references must point at existing objects
  for (const o of objects) {
    if (o.type === 'connector') {
      if (o.from && !ids.has(o.from)) {
        dropped.push(`connector ${o.id}: unknown from "${o.from}"`);
        delete o.from;
      }
      if (o.to && !ids.has(o.to)) {
        dropped.push(`connector ${o.id}: unknown to "${o.to}"`);
        delete o.to;
      }
    } else if (o.type === 'mindmap_node' && o.parent && (!ids.has(o.parent) || o.parent === o.id)) {
      dropped.push(`node ${o.id}: unknown parent "${o.parent}"`);
      delete o.parent;
    } else if (o.type === 'group') {
      o.children = o.children.filter((c) => ids.has(c) && c !== o.id);
    }
  }
  // break parent cycles (a → b → a)
  const byId = new Map(objects.map((o) => [o.id, o]));
  for (const o of objects) {
    if (o.type !== 'mindmap_node') continue;
    const seen = new Set<string>([o.id]);
    let p = o.parent;
    while (p) {
      if (seen.has(p)) {
        dropped.push(`node ${o.id}: parent cycle`);
        delete o.parent;
        break;
      }
      seen.add(p);
      const n = byId.get(p);
      p = n && n.type === 'mindmap_node' ? n.parent : undefined;
    }
  }
  const relations: SceneRelation[] = [];
  if (Array.isArray(r.relations)) {
    for (const rel of r.relations.slice(0, SCENE_LIMITS.maxObjects * 2)) {
      if (!rel || typeof rel !== 'object') continue;
      const v = rel as Record<string, unknown>;
      const type = v.type === 'parent' || v.type === 'label' || v.type === 'connects' ? v.type : null;
      const from = id(v.from);
      const to = id(v.to);
      if (type && from && to && ids.has(from) && ids.has(to)) relations.push({ type, from, to });
      else dropped.push('invalid relation');
    }
  }
  const warnings: string[] = [];
  if (Array.isArray(r.warnings)) for (const w of r.warnings.slice(0, SCENE_LIMITS.maxWarnings)) {
    const s = cleanText(w, 300);
    if (s) warnings.push(s);
  }
  const unresolvedItems: { bbox?: BBox; reason: string }[] = [];
  if (Array.isArray(r.unresolvedItems)) for (const u of r.unresolvedItems.slice(0, SCENE_LIMITS.maxWarnings)) {
    if (!u || typeof u !== 'object') continue;
    const v = u as Record<string, unknown>;
    const reason = cleanText(v.reason, 300) ?? 'unresolved';
    const b = bbox(v.bbox);
    unresolvedItems.push(b ? { bbox: b, reason } : { reason });
  }
  return {
    scene: {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sourceSelectionId: ctx.selectionId,
      sourceBounds: { ...ctx.bounds },
      objects,
      relations,
      warnings,
      confidence: conf(r.confidence) ?? null,
      unresolvedItems,
    },
    dropped,
  };
}
