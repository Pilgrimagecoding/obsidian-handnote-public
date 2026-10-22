// Turns `eslint -f json` output into GitHub annotations (one per rule, with examples) and a job
// summary, so the results can be read through the GitHub API without downloading logs.
import { readFileSync, appendFileSync } from 'node:fs';

const file = process.argv[2] ?? 'eslint.json';
let results;
try {
  results = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.log(`::error title=ESLint did not run::${String(e.message).slice(0, 300)}`);
  process.exit(0);
}
const byRule = new Map();
let errors = 0;
let warnings = 0;
for (const r of results) {
  for (const m of r.messages) {
    const rule = m.ruleId ?? (m.fatal ? 'parse-error' : 'unknown');
    if (m.severity === 2) errors++;
    else warnings++;
    const e = byRule.get(rule) ?? { rule, errors: 0, warnings: 0, at: [] };
    if (m.severity === 2) e.errors++;
    else e.warnings++;
    if (e.at.length < 6) e.at.push(`${r.filePath.replace(process.cwd() + '/', '')}:${m.line}:${m.column} ${m.message.replace(/\s+/g, ' ').slice(0, 160)}`);
    byRule.set(rule, e);
  }
}
const rules = [...byRule.values()].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
// GitHub keeps only ~10 annotations per level and step: the complete list goes out as a few large
// notices (every finding: rule, severity, file:line:col, message)
const all = [];
for (const r of results) for (const m of r.messages) all.push(`${m.severity === 2 ? 'E' : 'W'} ${m.ruleId ?? 'parse'} ${r.filePath.replace(process.cwd() + '/', '')}:${m.line} ${m.message.replace(/\s+/g, ' ').slice(0, 50)}`);
const chunks = [];
let cur = '';
for (const l of all) {
  if (cur.length + l.length > 3800) {
    chunks.push(cur);
    cur = '';
  }
  cur += (cur ? ' ¶ ' : '') + l;
}
if (cur) chunks.push(cur);
chunks.slice(0, 9).forEach((c, i) => console.log(`::notice title=ESLint findings ${i + 1}/${chunks.length}::${c}`));
console.log(`::notice title=ESLint totals::${errors} errors, ${warnings} warnings, ${rules.length} rules, ${results.length} files — ${rules.map((e) => `${e.rule} ${e.errors}/${e.warnings}`).join(', ')}`);
for (const e of rules.slice(0, 0)) {
  const level = e.errors ? 'error' : 'warning';
  console.log(`::${level} title=ESLint ${e.rule} (${e.errors} errors, ${e.warnings} warnings)::${e.at.join(' | ')}`);
}
const md = ['## ESLint (eslint-plugin-obsidianmd recommended)', '', `${errors} errors, ${warnings} warnings`, '', '| rule | errors | warnings | examples |', '|---|---|---|---|', ...rules.map((e) => `| ${e.rule} | ${e.errors} | ${e.warnings} | ${e.at.slice(0, 2).join('<br>')} |`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(md);
