#!/usr/bin/env node
/**
 * Developer helper (run on a computer with normal internet access; Node 18+, no other tools):
 *
 *   node scripts/fetch-local-assets.mjs
 *
 * Downloads the third-party files that HandNote's local (on-device) recognition is developed and
 * tested with, verifies them, and writes them to ./local-assets/ (git-ignored):
 *
 *   onnxruntime-web 1.24.2 (MIT, npm registry; tarball checked against the registry's sha512)
 *     → local-assets/ort/  (WASM runtime + JS glue only)
 *   PP-OCRv5_mobile_rec ONNX (Apache-2.0, official PaddleOCR download, Baidu BOS; Hugging Face
 *     mirror as fallback) → local-assets/ppocrv5-mobile-rec/
 *   PP-OCRv5 dictionary (Apache-2.0, PaddleOCR GitHub) → local-assets/ppocrv5-mobile-rec/
 *   private edition only: the local math model (src/private/dev/assets.mjs, skipped when that
 *     file is not there, e.g. in the public source)
 *
 * Nothing is uploaded. Prints SHA-256 of every file (also written to local-assets/SHA256SUMS.txt).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';

const OUT = 'local-assets';
const ORT_VERSION = '1.24.2';
const sums = [];

async function get(url, label) {
  process.stdout.write(`↓ ${label} … `);
  const t0 = Date.now();
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`${(buf.length / 1048576).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return buf;
}

async function getFirst(urls, label) {
  let last;
  for (const u of urls) {
    try {
      return await get(u, `${label} (${new URL(u).host})`);
    } catch (e) {
      last = e;
      console.log(`  failed: ${e.message}`);
    }
  }
  throw last;
}

function save(rel, buf) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  const h = createHash('sha256').update(buf).digest('hex');
  sums.push(`${h}  ${rel}  ${buf.length}`);
}

/** Minimal ustar reader: [{ name, data }] */
function untar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 500) ? `${str(345, 500)}/` : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === '0' || type === '\0') out.push({ name, data });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function ort() {
  const meta = JSON.parse((await get(`https://registry.npmjs.org/onnxruntime-web/${ORT_VERSION}`, `onnxruntime-web ${ORT_VERSION} metadata`)).toString('utf8'));
  const tgz = await get(meta.dist.tarball, 'onnxruntime-web tarball');
  const [algo, b64] = meta.dist.integrity.split('-');
  const got = createHash(algo).update(tgz).digest('base64');
  if (got !== b64) throw new Error('onnxruntime-web tarball integrity mismatch');
  console.log(`  integrity ${algo} OK`);
  const keep = /^package\/(LICENSE|package\.json|README\.md|dist\/(ort\.wasm\.min\.mjs|ort\.wasm\.bundle\.min\.mjs|ort\.min\.js|ort-wasm-simd-threaded\.(wasm|mjs)))$/;
  for (const f of untar(gunzipSync(tgz))) if (keep.test(f.name)) save(`ort/${f.name.replace(/^package\//, '')}`, f.data);
}

async function ppocr() {
  const tar = await getFirst(
    [
      'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
      'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx',
    ],
    'PP-OCRv5_mobile_rec ONNX',
  );
  if (tar.subarray(257, 262).toString() === 'ustar') {
    for (const f of untar(tar)) {
      const base = f.name.split('/').pop();
      if (/^(inference\.onnx|inference\.yml|.*\.txt)$/.test(base)) save(`ppocrv5-mobile-rec/${base}`, f.data);
    }
  } else save('ppocrv5-mobile-rec/inference.onnx', tar);
  const dict = await getFirst(
    ['https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_dict.txt', 'https://github.com/PaddlePaddle/PaddleOCR/raw/main/ppocr/utils/dict/ppocrv5_dict.txt'],
    'PP-OCRv5 dictionary',
  );
  save('ppocrv5-mobile-rec/ppocrv5_dict.txt', dict);
  const lic = await getFirst(['https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/LICENSE', 'https://github.com/PaddlePaddle/PaddleOCR/raw/main/LICENSE'], 'PaddleOCR LICENSE');
  save('ppocrv5-mobile-rec/LICENSE', lic);
}

async function ppocrEn() {
  const tar = await getFirst(
    [
      'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv5_mobile_rec_onnx_infer.tar',
      'https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx',
    ],
    'en_PP-OCRv5_mobile_rec ONNX',
  );
  if (tar.subarray(257, 262).toString() === 'ustar') {
    for (const f of untar(tar)) {
      const base = f.name.split('/').pop();
      if (/^(inference\.onnx|inference\.yml)$/.test(base)) save(`en-ppocrv5-mobile-rec/${base}`, f.data);
    }
  } else save('en-ppocrv5-mobile-rec/inference.onnx', tar);
  const dict = await getFirst(
    ['https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_en_dict.txt', 'https://github.com/PaddlePaddle/PaddleOCR/raw/main/ppocr/utils/dict/ppocrv5_en_dict.txt'],
    'PP-OCRv5 English dictionary',
  );
  save('en-ppocrv5-mobile-rec/en_dict.txt', dict);
}

/** Excalidraw font mirrors: which of them this network reaches (one small subset each). */
async function fontMirrors() {
  const c = 'bee01e3a12812c930109aa91242658709480bbf3';
  const f = 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2';
  for (const u of [
    `https://cdn.jsdelivr.net/gh/excalidraw/excalidraw@${c}/packages/excalidraw/fonts/${f}`,
    `https://raw.githubusercontent.com/excalidraw/excalidraw/${c}/packages/excalidraw/fonts/${f}`,
    `https://fastly.jsdelivr.net/gh/excalidraw/excalidraw@${c}/packages/excalidraw/fonts/${f}`,
    `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/${f}`,
    `https://registry.npmmirror.com/@excalidraw/excalidraw/0.18.0/files/dist/prod/fonts/${f}`,
  ]) {
    try {
      const b = await get(u, `font mirror ${new URL(u).host}`);
      console.log(`  sha256 ${createHash('sha256').update(b).digest('hex').slice(0, 16)}…`);
    } catch (e) {
      console.log(`  ✗ ${new URL(u).host}: ${e.message}`);
    }
  }
}

// private edition only: the local math model (the public source has no src/private)
const privateAssets = existsSync('src/private/dev/assets.mjs') ? await import('../src/private/dev/assets.mjs') : null;

mkdirSync(OUT, { recursive: true });
const steps = [
  ['onnxruntime-web', ort],
  ['PP-OCRv5', ppocr],
  ...(privateAssets ? [['math model (private edition)', () => privateAssets.fetchMathAssets({ save, getFirst })]] : []),
  ['PP-OCRv5 English', ppocrEn],
  ['Excalidraw fonts: mirror check only', fontMirrors],
];
// node scripts/fetch-local-assets.mjs en fonts   → only those steps
const only = process.argv.slice(2);
if (only.length) steps.splice(0, steps.length, ...steps.filter(([n]) => only.some((o) => n.toLowerCase().includes(o.toLowerCase()))));
let failed = 0;
for (const [name, fn] of steps) {
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e.message}`);
  }
}
const prev = existsSync(join(OUT, 'SHA256SUMS.txt')) ? readFileSync(join(OUT, 'SHA256SUMS.txt'), 'utf8') : '';
// keep the lines of files not downloaded this time
const merged = new Map(prev.split('\n').filter(Boolean).map((l) => [l.split(/\s+/)[1], l]));
for (const l of sums) merged.set(l.split(/\s+/)[1], l);
writeFileSync(join(OUT, 'SHA256SUMS.txt'), [...merged.values()].join('\n') + '\n');
console.log('\n' + sums.join('\n'));
console.log(failed ? `\n${failed} step(s) failed — run again to retry.` : `\nDone: ${OUT}/ (git-ignored).${prev ? ' (previous SHA256SUMS replaced)' : ''}`);
process.exit(failed ? 1 : 0);
