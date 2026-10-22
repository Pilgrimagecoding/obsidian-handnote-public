// Build edition (see src/edition/globals.d.ts and docs/PUBLIC_PRIVATE_RELEASE_STRATEGY.md).
//   HN_EDITION=public  (default) — no local math model: @edition/* → src/edition/public/ (stubs)
//   HN_EDITION=private           — with the local math model: @edition/* → src/private/edition/ (private repo only)
import { existsSync } from 'node:fs';
import path from 'node:path';

export const EDITION = process.env.HN_EDITION === 'private' ? 'private' : 'public';

export function editionOptions(edition = EDITION) {
  const priv = edition === 'private';
  const dir = path.resolve(priv ? 'src/private/edition' : 'src/edition/public');
  if (priv && !existsSync(path.join(dir, 'math.ts'))) throw new Error('HN_EDITION=private needs src/private/edition (private repository only)');
  return {
    define: { __HN_PRIVATE__: priv ? 'true' : 'false' },
    alias: { '@edition/math': path.join(dir, 'math.ts'), '@edition/math-worker': path.join(dir, 'math-worker.ts') },
  };
}
