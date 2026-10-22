// Bundles tests/bench/ink-bench.ts and runs it: offline engine (+ MyScript with your keys and --yes).
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
await esbuild.build({ entryPoints: ['tests/bench/ink-bench.ts'], outfile: 'build/bench/ink-bench.mjs', bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'warning' });
const r = spawnSync(process.execPath, ['build/bench/ink-bench.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
