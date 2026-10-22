// `npm audit --json` → one GitHub annotation with the counts and the affected packages.
import { readFileSync } from 'node:fs';

let a;
try {
  a = JSON.parse(readFileSync(process.argv[2] ?? 'audit.json', 'utf8'));
} catch (e) {
  console.log(`::error title=npm audit did not run::${String(e.message).slice(0, 300)}`);
  process.exit(0);
}
const v = a.metadata?.vulnerabilities ?? {};
const pkgs = Object.entries(a.vulnerabilities ?? {}).map(([name, x]) => `${name} (${x.severity}${x.isDirect ? ', direct' : ''}${x.via?.[0]?.title ? `: ${x.via[0].title}` : ''})`);
const deps = a.metadata?.dependencies ?? {};
console.log(`::notice title=npm audit::critical ${v.critical ?? 0}, high ${v.high ?? 0}, moderate ${v.moderate ?? 0}, low ${v.low ?? 0}; prod deps ${deps.prod ?? '?'}, dev deps ${deps.dev ?? '?'}${pkgs.length ? ' — ' + pkgs.join('; ').slice(0, 900) : ''}`);
