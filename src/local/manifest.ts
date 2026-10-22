/**
 * Optional on-device recognition packs (the runtime itself is built into main.js; the other packs
 * are downloaded): each file is
 * downloaded on request (after the user saw the size), verified by SHA-256 and kept in this
 * device's IndexedDB — never in a note, never in the vault, so sync plugins never copy it.
 *
 * Every file has several mirrors of the SAME bytes (official source first); the hash decides, not
 * the host. A file whose hash is unknown (empty) cannot be installed.
 */
import { MATH_EDITION } from '@edition/math';
import { FONT_COMMIT, FONT_FILES } from './font-pack.generated';

export interface PackFile {
  /** name inside the pack */
  name: string;
  bytes: number;
  sha256: string;
  urls: string[];
}

export interface ModelPack {
  id: PackId;
  version: string;
  title: { zh: string; en: string };
  /** licence of code / weights, shown before download */
  licence: { zh: string; en: string };
  files: PackFile[];
  /** other packs this one needs */
  needs: PackId[];
}

export type PackId = 'runtime' | 'math' | 'text-zh' | 'text-en' | 'font-hand';

export const ORT_VERSION = '1.24.2';

/**
 * Local math recognition is part of the PRIVATE edition only. In the public edition the
 * "math" pack has no files, no sources and cannot be installed; formulas are typed as LaTeX or
 * recognised by MyScript (the user's own keys).
 */
export const LOCAL_MATH = __HN_PRIVATE__ && !!MATH_EDITION;

const MATH_NOT_INCLUDED: ModelPack = {
  id: 'math',
  version: '',
  title: { zh: '本地公式识别（本版本未包含）', en: 'Local math recognition (not included in this edition)' },
  licence: { zh: '本版本未包含', en: 'not included in this edition' },
  files: [],
  needs: ['runtime'],
};

// npmmirror first: reachable and fast in mainland China and elsewhere; the installer probes all
// mirrors first anyway and starts with the fastest that answers
const npmFile = (path: string) => [
  `https://registry.npmmirror.com/onnxruntime-web/${ORT_VERSION}/files/dist/${path}`,
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${path}`,
  `https://unpkg.com/onnxruntime-web@${ORT_VERSION}/dist/${path}`,
  `https://fastly.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${path}`,
];

const PADDLE_REF = 'dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf';

// en_PP-OCRv5_mobile_rec ONNX: pinned from the official BOS archive (fetched on the user's PC, 2026-10-21)
const EN_ONNX_BYTES = 7848423;
const EN_ONNX_SHA = 'b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f';

const fontUrls = (family: 'excalifont' | 'xiaolai', name: string) => {
  const dir = family === 'excalifont' ? 'Excalifont' : 'Xiaolai';
  const path = `packages/excalidraw/fonts/${dir}/${name}`;
  return [
    // the published npm package ships the same hashed subsets
    `https://registry.npmmirror.com/@excalidraw/excalidraw/0.18.0/files/dist/prod/fonts/${dir}/${name}`,
    `https://cdn.jsdelivr.net/gh/excalidraw/excalidraw@${FONT_COMMIT}/${path}`,
    `https://raw.githubusercontent.com/excalidraw/excalidraw/${FONT_COMMIT}/${path}`,
    `https://fastly.jsdelivr.net/gh/excalidraw/excalidraw@${FONT_COMMIT}/${path}`,
    `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/${dir}/${name}`,
  ];
};

export const PACKS: Record<PackId, ModelPack> = {
  runtime: {
    id: 'runtime',
    version: ORT_VERSION,
    title: { zh: '本地识别运行库（ONNX Runtime Web）', en: 'Local recognition runtime (ONNX Runtime Web)' },
    licence: { zh: 'MIT（Microsoft）', en: 'MIT (Microsoft)' },
    files: [
      { name: 'ort.wasm.bundle.min.mjs', bytes: 72787, sha256: '3f8c055f038d84b3d48d9e2da56019f60ab4f75764a067d54d48bd9199bcb4fc', urls: npmFile('ort.wasm.bundle.min.mjs') },
      { name: 'ort-wasm-simd-threaded.wasm', bytes: 12303130, sha256: '175fabe412fc7fd1376e3178861a47ebfdc30cedb3b2c3f6bb72c37d96c26f73', urls: npmFile('ort-wasm-simd-threaded.wasm') },
    ],
    needs: [],
  },
  math: __HN_PRIVATE__ && MATH_EDITION ? MATH_EDITION.pack : MATH_NOT_INCLUDED,
  'text-zh': {
    id: 'text-zh',
    version: 'PP-OCRv5_mobile_rec',
    title: { zh: '本地中文文字识别（PP-OCRv5 移动版）', en: 'Local Chinese text recognition (PP-OCRv5 mobile)' },
    licence: { zh: 'Apache-2.0（PaddleOCR）。这是图像 OCR：HandNote 把每行笔迹渲染成图片后识别。', en: 'Apache-2.0 (PaddleOCR). Image OCR: HandNote renders each line of ink to a picture first.' },
    files: [
      {
        name: 'inference.onnx',
        bytes: 16534782,
        sha256: 'da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092',
        urls: ['https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar#tar=inference.onnx', 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx', 'https://hf-mirror.com/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx'],
      },
      {
        name: 'ppocrv5_dict.txt',
        bytes: 74012,
        sha256: 'd1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b',
        urls: [`https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/${PADDLE_REF}/ppocr/utils/dict/ppocrv5_dict.txt`, `https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@${PADDLE_REF}/ppocr/utils/dict/ppocrv5_dict.txt`],
      },
    ],
    needs: ['runtime'],
  },
  'text-en': {
    id: 'text-en',
    version: 'en_PP-OCRv5_mobile_rec',
    title: { zh: '本地英文文字识别（PP-OCRv5 英文版）', en: 'Local English text recognition (PP-OCRv5 English)' },
    licence: { zh: 'Apache-2.0（PaddleOCR）。英文行自动改用此模型（手写英文更准）。', en: 'Apache-2.0 (PaddleOCR). Used automatically for English lines (better on handwritten English).' },
    files: [
      {
        name: 'en_inference.onnx',
        bytes: EN_ONNX_BYTES,
        sha256: EN_ONNX_SHA,
        urls: ['https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv5_mobile_rec_onnx_infer.tar#tar=inference.onnx', 'https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx', 'https://hf-mirror.com/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx'],
      },
      {
        name: 'ppocrv5_en_dict.txt',
        bytes: 1416,
        sha256: 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6',
        urls: [`https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/${PADDLE_REF}/ppocr/utils/dict/ppocrv5_en_dict.txt`, `https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@${PADDLE_REF}/ppocr/utils/dict/ppocrv5_en_dict.txt`],
      },
    ],
    needs: ['runtime'],
  },
  'font-hand': {
    id: 'font-hand',
    version: `excalidraw@${FONT_COMMIT.slice(0, 7)}`,
    title: { zh: 'Excalidraw 手写字体（Excalifont + 小赖）', en: 'Excalidraw hand-drawn fonts (Excalifont + Xiaolai)' },
    licence: { zh: 'SIL Open Font License 1.1（Excalidraw / LXGW），按字符区间分片，只在用到时加载', en: 'SIL Open Font License 1.1 (Excalidraw / LXGW); split by character ranges, loaded only when used' },
    files: FONT_FILES.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256, urls: fontUrls(f.family, f.name) })),
    needs: [],
  },
};

export function packBytes(id: PackId, withNeeds = true): number {
  const p = PACKS[id];
  const own = p.files.reduce((a, f) => a + f.bytes, 0);
  return own + (withNeeds ? p.needs.reduce((a, n) => a + packBytes(n, false), 0) : 0);
}

/** A pack can be installed only when every file's hash is pinned. */
export function packPinned(id: PackId): boolean {
  return PACKS[id].files.length > 0 && PACKS[id].files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0);
}
