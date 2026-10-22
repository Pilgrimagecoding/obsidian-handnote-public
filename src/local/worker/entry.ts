import { start } from './program';

// exposed for the bootstrap module that imports ONNX Runtime Web and then calls it
// `self` is the worker scope
(self as unknown as { __hnLocalStart: typeof start }).__hnLocalStart = start;
