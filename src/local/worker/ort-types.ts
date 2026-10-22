/** The small part of ONNX Runtime Web the recognition worker uses (the runtime is built into main.js). */
export interface OrtTensor {
  readonly data: Float32Array | BigInt64Array | Uint8Array | Int32Array;
  readonly dims: readonly number[];
}
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface Ort {
  env: { wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean }; logLevel?: string };
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: 'float32' | 'int64' | 'bool', data: Float32Array | BigInt64Array | Uint8Array, dims: number[]) => OrtTensor;
}

export const sessionOptions = () => ({ executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
