/**
 * A small, strict-enough XML reader for Office Open XML parts (0.9 import).
 *
 * Why not DOMParser: this one has no DTD or external-entity support at all (nothing can be fetched or
 * expanded), it runs in Node for the tests, and it caps size and depth. Only the five predefined
 * entities and numeric character references are decoded. Namespaces are kept as written
 * (`w:p`, `a:t`) — OOXML always uses the standard prefixes in practice; `local()` strips them where
 * a part might use another prefix.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Text directly inside this element (concatenated, entities decoded). */
  text: string;
}

export const XML_LIMITS = { maxBytes: 64 * 1024 * 1024, maxDepth: 256, maxNodes: 2_000_000 };

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return ENT[e] ?? m;
  });
}

export class XmlError extends Error {}

export function parseXml(src: string): XNode {
  if (src.length > XML_LIMITS.maxBytes) throw new XmlError('XML part too large');
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  let i = 0;
  let nodes = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      if (e < 0) throw new XmlError('unterminated processing instruction');
      i = e + 2;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlError('unterminated comment');
      i = e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlError('unterminated CDATA');
      top.text += src.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) throw new XmlError('DOCTYPE / DTD is not allowed');
    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) throw new XmlError('unterminated tag');
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      const cur = stack.pop();
      if (!cur || cur === root || cur.name !== name) throw new XmlError(`mismatched </${name}>`);
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) throw new XmlError('bad tag');
    const node: XNode = { name: m[1], attrs: parseAttrs(inner.slice(m[1].length)), children: [], text: '' };
    if (++nodes > XML_LIMITS.maxNodes) throw new XmlError('too many XML elements');
    top.children.push(node);
    if (!selfClose) {
      stack.push(node);
      if (stack.length > XML_LIMITS.maxDepth) throw new XmlError('XML nested too deeply');
    }
  }
  if (stack.length !== 1) throw new XmlError('unclosed elements');
  const docEl = root.children[0];
  if (!docEl) throw new XmlError('empty XML');
  return docEl;
}

function findTagEnd(s: string, from: number): number {
  let q: string | null = null;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return k;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** Local name without the namespace prefix. */
export function local(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export function kids(n: XNode | undefined, name: string): XNode[] {
  if (!n) return [];
  return n.children.filter((c) => c.name === name);
}

export function kid(n: XNode | undefined, name: string): XNode | undefined {
  return n?.children.find((c) => c.name === name);
}

/** Depth-first search for descendants with a name (does not descend into matches). */
export function find(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else find(c, name, out);
  }
  return out;
}

export function attr(n: XNode | undefined, name: string): string | undefined {
  return n?.attrs[name];
}

export function num(v: string | undefined, fb = 0): number {
  if (v === undefined) return fb;
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}
