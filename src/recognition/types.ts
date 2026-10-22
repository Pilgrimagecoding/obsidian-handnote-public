/**
 * Handwriting recognition contracts (MyScript-style "convert" flow).
 *
 * The recognition layer only *reads* content: text lines, a LaTeX formula, a mind-map tree or a
 * node/edge graph. It never decides positions, sizes or colours — HandNote's local layout and theme
 * code does that (ink-analysis.ts, mindmap/, diagram/). That split is what keeps converted text and
 * shapes from overlapping, and it keeps model answers small (fast, cheap).
 *
 * Provider answers are untrusted: they are parsed into these types by `validate.ts` before anything
 * reaches the document.
 */

export type RecTask = 'text' | 'math' | 'mindmap' | 'diagram' | 'image-text';
export const REC_TASKS: RecTask[] = ['text', 'math', 'mindmap', 'diagram', 'image-text'];

/** One stroke as recognition input (page units, ms from the stroke group start). */
export interface InkStrokeIn {
  id: string;
  xs: number[];
  ys: number[];
  ts: number[];
  ps: number[];
}

/** A line of handwriting found by local ink analysis (page units). */
export interface InkLine {
  index: number;
  strokeIds: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A word (MyScript) or a character (offline Chinese) with its other possible readings. */
export interface TextToken {
  text: string;
  /** Other readings, best first (the chosen text is not repeated). */
  candidates: string[];
}

export interface TextLineResult {
  text: string;
  /** Other readings, best first (word / line candidates). */
  alternatives: string[];
  confidence?: number;
  /** Word / character level candidates, in order; joined they give `text`. Digital-ink engines only. */
  tokens?: TextToken[];
}

export interface TextResult {
  task: 'text' | 'image-text';
  lines: TextLineResult[];
  warnings: string[];
}

export interface MathResult {
  task: 'math';
  latex: string;
  alternatives: string[];
  warnings: string[];
}

export interface MindTreeNode {
  text: string;
  children: MindTreeNode[];
}

export interface MindMapResult {
  task: 'mindmap';
  root: MindTreeNode;
  warnings: string[];
}

export type DiagramShape = 'rect' | 'roundrect' | 'ellipse' | 'diamond' | 'parallelogram';

export interface DiagramNodeIn {
  id: string;
  text: string;
  shape: DiagramShape;
  /** Rough position in the drawing (0..1) — only used to keep the user's reading order. */
  pos?: [number, number];
}

export interface DiagramEdgeIn {
  from: string;
  to: string;
  label?: string;
  arrow: 'end' | 'both' | 'none';
  dashed?: boolean;
}

export interface DiagramResult {
  task: 'diagram';
  nodes: DiagramNodeIn[];
  edges: DiagramEdgeIn[];
  /** Main direction of the drawing. */
  direction: 'TB' | 'LR';
  warnings: string[];
}

export type RecResult = TextResult | MathResult | MindMapResult | DiagramResult;

/**
 * Recognition technologies — deliberately kept apart:
 *  - 'myscript' / 'offline': digital-ink recognition (the strokes themselves: x, y, t, order);
 *  - 'vision': a general vision-language model reading a picture of the selection;
 *  - 'local': on-device models (ONNX Runtime Web, WASM) reading the strokes re-rendered from the
 *    saved ink — a math model (private edition) for math, PP-OCRv5 for Chinese text lines; nothing leaves the device;
 *  - 'mock': offline demo answers (lab / tests only, never presented as real recognition).
 */
export type RecEngine = 'myscript' | 'offline' | 'local' | 'vision' | 'mock';

/** Measured stages of one conversion (ms). Only durations and sizes — never content. */
export interface RecStage {
  name: 'prepare' | 'encode' | 'request' | 'parse' | 'build' | 'preview';
  ms: number;
}

export interface RecRun {
  result: RecResult;
  engine: RecEngine;
  model: string;
  stages: RecStage[];
  /** Bytes sent (image or ink JSON). */
  bytes: number;
  usage: { inputTokens?: number; outputTokens?: number };
  /** Served from the local cache (same selection, same task, same model): no request made. */
  cached: boolean;
  /** Local models: false when the result is uncertain — show it with candidates instead of replacing the ink. */
  confident?: boolean;
}
