// Edition gate for a built main.js (docs/PUBLIC_PRIVATE_RELEASE_STRATEGY.md).
//   node scripts/check-edition.mjs <main.js> public|private
// public:  no CoMER weights, sources, hashes, worker messages or inference code may be inside.
// private: they must be inside, and the banner must say PRIVATE EDITION (so a private build is
//          recognisable and is never taken for a public one).
import { readFileSync } from 'node:fs';

/** Markers that only a build with CoMER local math recognition contains. */
export const COMER_MARKERS = [
  /\bCoMER\b/i, // name of the model (UI labels, licence text)
  /ink-on/i, // source of the ONNX export
  /kimseungdae/i, // owner of ink-on
  /2585994ee11fe2ed98065c555c4aae8ee9096209/, // pinned ink-on commit
  /encoder_int8\.onnx|decoder_int8\.onnx/, // weight files
  /272f17c7b120db61db6cd8d77e695d0139144044abd57d9b23284435a5d916fa/, // encoder SHA-256
  /658901d81ca3aa4b62b0da262e8fe67ebcfdac19cfb52ca2cfd076bebd481088/, // decoder SHA-256
  /1d75cbbea3bed558683d7e9c3b3c72069ef2143a155d5f8c610f85a281af000c/, // vocab SHA-256
  /load-math/, // worker message
  /encoder_features|pixel_values|idx2word/, // CoMER model inputs / vocabulary in the worker program
];

export function checkEdition(main, edition) {
  const found = COMER_MARKERS.filter((re) => re.test(main)).map((re) => String(re));
  const banner = main.slice(0, 400);
  const problems = [];
  if (edition === 'public') {
    if (found.length) problems.push(`public main.js contains CoMER markers: ${found.join(', ')}`);
    if (/PRIVATE EDITION/.test(banner)) problems.push('public main.js has the PRIVATE EDITION banner');
  } else {
    if (found.length < COMER_MARKERS.length) problems.push(`private main.js lacks CoMER markers: ${COMER_MARKERS.filter((re) => !re.test(main)).map(String).join(', ')}`);
    if (!/PRIVATE EDITION/.test(banner)) problems.push('private main.js has no PRIVATE EDITION banner');
  }
  return { problems, found };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, edition = 'public'] = process.argv.slice(2);
  const r = checkEdition(readFileSync(file, 'utf8'), edition);
  for (const p of r.problems) console.log(`  FAIL ${p}`);
  console.log(r.problems.length ? `EDITION CHECK (${edition}): FAIL` : `EDITION CHECK (${edition}): PASS (${r.found.length} CoMER markers)`);
  process.exit(r.problems.length ? 1 : 0);
}
