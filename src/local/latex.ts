/**
 * Math-model token sequences → LaTeX. Deterministic repairs of common decoder slips (unbalanced braces,
 * missing / extra \frac and \sqrt arguments) and a structural check used to pick the first
 * well-formed beam candidate and to flag uncertain results. Same idea as common latex-repair
 * (Apache-2.0); independent implementation.
 */

function balance(t: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const x of t) {
    if (x === '{') depth++;
    else if (x === '}') {
      if (!depth) continue;
      depth--;
    }
    out.push(x);
  }
  while (depth-- > 0) out.push('}');
  return out;
}

/** Index after one argument starting at i (a braced group or a single token). */
function argEnd(t: string[], i: number): number {
  if (i >= t.length) return i;
  if (t[i] !== '{') return i + 1;
  let d = 0;
  for (let k = i; k < t.length; k++) {
    if (t[k] === '{') d++;
    else if (t[k] === '}' && --d === 0) return k + 1;
  }
  return t.length;
}

function fixArgs(t: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.length; ) {
    const x = t[i];
    if (x === '\\frac' || x === '\\sqrt') {
      const need = x === '\\frac' ? 2 : 1;
      out.push(x);
      let k = i + 1;
      for (let a = 0; a < need; a++) {
        if (k >= t.length || t[k] === '}') {
          out.push('{', '}');
          continue;
        }
        const e = argEnd(t, k);
        const arg = t.slice(k, e);
        if (arg[0] === '{') out.push(...fixArgs(arg));
        else out.push('{', ...fixArgs(arg), '}');
        k = e;
      }
      // a third braced group right after \frac is a decoder slip: drop it
      while (x === '\\frac' && t[k] === '{' && argEnd(t, k) - k <= 2) k = argEnd(t, k);
      i = k;
      continue;
    }
    out.push(x);
    i++;
  }
  return out;
}

export function repairTokens(tokens: string[]): string[] {
  const t = tokens.filter((x) => x && !x.startsWith('<'));
  return fixArgs(balance(t));
}

export function tokensToLatex(tokens: string[]): string {
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

/** Well-formed: non-empty, balanced, no empty groups, no dangling operator / script. */
export function isWellFormed(tokens: string[]): boolean {
  if (!tokens.length) return false;
  let d = 0;
  for (let i = 0; i < tokens.length; i++) {
    const x = tokens[i];
    if (x === '{') {
      d++;
      if (tokens[i + 1] === '}') return false;
    } else if (x === '}' && --d < 0) return false;
  }
  if (d !== 0) return false;
  const last = tokens[tokens.length - 1];
  if (['+', '-', '=', '^', '_', '\\frac', '\\sqrt', '\\times', '\\div', '\\cdot'].includes(last)) return false;
  if (['^', '_', '='].includes(tokens[0])) return false;
  return true;
}

/** Compact LaTeX from tokens: "x ^ { 2 }" → "x^{2}"; a space only where a command needs one. */
export function compactLatex(tokens: string[]): string {
  let out = '';
  for (const t of tokens) {
    if (out && /\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z0-9]/.test(t)) out += ' ';
    out += t;
  }
  return out;
}
