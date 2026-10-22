import type { ModelPack } from '../local/manifest';
import type { Ort } from '../local/worker/ort-types';

/** A math candidate from a local math model (LaTeX tokens + length-normalised log score). */
export interface MathCandidate {
  tokens: string[];
  score: number;
}

/** Local math recognition, present only in the private edition (`@edition/math`). */
export interface MathEdition {
  /** the downloadable model pack (files, pinned hashes, sources, licence text) */
  pack: ModelPack;
  /** long and short names shown in the UI */
  model: string;
  label: string;
  /** worker message that loads the model files (handled by `@edition/math-worker`) */
  loadMessage: string;
  /** development only: file name → path under ./local-assets (ink lab, tests) */
  devAssets: Record<string, string>;
}

/** Math model inside the recognition worker (`@edition/math-worker`). */
export interface MathEngine {
  /** worker message that loads the model files (the same as MathEdition.loadMessage) */
  readonly loadMessage: string;
  load(files: Record<string, ArrayBuffer>): Promise<void>;
  loaded(): boolean;
  recognize(tensor: Float32Array, h: number, w: number, mask: Uint8Array, beamWidth: number, maxSteps: number, sureScore: number): Promise<{ candidates: MathCandidate[]; encMs: number; decMs: number; beamRun: boolean }>;
  release(): Promise<void>;
}

export type MathEngineFactory = (ort: Ort, now: () => number) => MathEngine;
