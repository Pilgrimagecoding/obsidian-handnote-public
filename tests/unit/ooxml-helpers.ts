// Test helpers for the Office import tests: a ZIP writer (stored or deflated entries), minimal
// .docx packages, and a deterministic text measurer (no canvas in Node).
import { deflateRawSync } from 'node:zlib';
import type { Measurer } from '../../src/import/flow';

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function writeZip(files: Record<string, string | Uint8Array>, opts: { deflate?: boolean; lieSize?: Record<string, number> } = {}): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const [name, v] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = typeof v === 'string' ? enc.encode(v) : v;
    const crc = crc32(d);
    const body = opts.deflate ? new Uint8Array(deflateRawSync(d)) : d;
    const method = opts.deflate ? 8 : 0;
    const size = opts.lieSize?.[name] ?? d.length;
    const lh = new Uint8Array(30 + n.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, n.length, true);
    lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, off, true);
    ch.set(n, 46);
    locals.push(lh, body);
    central.push(ch);
    off += lh.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, off, true);
  const all = [...locals, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

export const CT_DOCX = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

/** A .docx whose body is `bodyXml` (w: elements); extra parts may be added. */
export function docx(bodyXml: string, extra: Record<string, string | Uint8Array> = {}, opts: { deflate?: boolean; prolog?: string } = {}): Uint8Array {
  return writeZip(
    {
      '[Content_Types].xml': CT_DOCX,
      '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${opts.prolog ?? ''}<w:document ${W}><w:body>${bodyXml}</w:body></w:document>`,
      ...extra,
    },
    { deflate: opts.deflate },
  );
}

export const para = (text: string, pPr = '', rPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export const sect = (wTw = 11906, hTw = 16838, mar = 1440) => `<w:sectPr><w:pgSz w:w="${wTw}" w:h="${hTw}"/><w:pgMar w:top="${mar}" w:right="${mar}" w:bottom="${mar}" w:left="${mar}"/></w:sectPr>`;

/** Fixed-width measurer: Latin = 0.5 em, CJK / full-width = 1 em. */
export const fixedMeasurer: Measurer = {
  width(text: string, font: string): number {
    const z = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 11);
    let w = 0;
    for (const ch of text) w += /[⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? z : z * 0.5;
    return w;
  },
};

const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = (rels: [string, string, string][]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${/^https?:/.test(target) ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;

/**
 * A minimal .pptx: one master (clrMap, txStyles), one blank layout, a theme with known colours,
 * and the given slides (`<p:sld>` inner XML of each `p:spTree`, plus optional extra slide attributes,
 * background and relationships).
 */
export function pptx(slides: { tree: string; attrs?: string; bg?: string; rels?: [string, string, string][] }[], extra: Record<string, string | Uint8Array> = {}, size: [number, number] = [9144000, 6858000]): Uint8Array {
  const tree = (inner: string) => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld>`;
  const lvl = (sz: number, extraP = '') => `<a:lvl1pPr marL="0" indent="0"${extraP}><a:defRPr sz="${sz}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`;
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    '_rels/.rels': REL([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS_P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${size[0]}" cy="${size[1]}"/><p:defaultTextStyle>${lvl(1800)}</p:defaultTextStyle></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': REL([['rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => [`rIdS${i + 1}`, 'slide', `slides/slide${i + 1}.xml`] as [string, string, string])]),
    'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0"?><p:sldMaster ${NS_P}>${tree('')}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:txStyles><p:titleStyle>${lvl(4400, ' algn="ctr"')}</p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="–"/><a:defRPr sz="2800"/></a:lvl2pPr></p:bodyStyle><p:otherStyle>${lvl(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': REL([['rIdT', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0"?><p:sldLayout ${NS_P}>${tree('<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr></p:sp>')}</p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': REL([['rIdM', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': `<?xml version="1.0"?><a:theme ${NS_P} name="T"><a:themeElements><a:clrScheme name="T"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="T"><a:lnStyleLst><a:ln w="9525"/><a:ln w="25400"/><a:ln w="38100"/></a:lnStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
    ...extra,
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld ${NS_P}${s.attrs ? ' ' + s.attrs : ''}>${s.bg ? `<p:cSld><p:bg>${s.bg}</p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.tree}</p:spTree></p:cSld>` : tree(s.tree)}</p:sld>`;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = REL([['rIdL', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(s.rels ?? [])]);
  });
  return writeZip(files);
}

/** A shape on a slide: box in inches, optional fill / geometry / text body. */
export const sp = (o: { x: number; y: number; w: number; h: number; prst?: string; fill?: string; ln?: string; rot?: number; ph?: string; text?: string; body?: string; xfrm?: boolean }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="9" name="s"/><p:cNvSpPr/><p:nvPr>${o.ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr>${o.xfrm === false ? '' : `<a:xfrm${o.rot ? ` rot="${o.rot * 60000}"` : ''}><a:off x="${o.x * 914400}" y="${o.y * 914400}"/><a:ext cx="${o.w * 914400}" cy="${o.h * 914400}"/></a:xfrm>`}${o.prst ? `<a:prstGeom prst="${o.prst}"><a:avLst/></a:prstGeom>` : ''}${o.fill ?? ''}${o.ln ?? ''}</p:spPr>${o.body ?? (o.text !== undefined ? `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${o.text}</a:t></a:r></a:p></p:txBody>` : '')}</p:sp>`;

/**
 * A minimal compound file (the .doc / .xls / .ppt container) with the given streams. Streams are
 * padded to 4096 bytes so no mini stream is needed. Sector size 512, version 3.
 */
export function writeCfb(streams: Record<string, Uint8Array>, opts: { loopFirstStream?: boolean } = {}): Uint8Array {
  const SS = 512;
  const END = 0xfffffffe;
  const names = Object.keys(streams);
  const datas = names.map((n) => {
    const d = streams[n];
    const size = Math.max(4096, d.length);
    const out = new Uint8Array(Math.ceil(size / SS) * SS);
    out.set(d);
    return { data: out, size };
  });
  const dirEntries = names.length + 1;
  const dirSectors = Math.ceil((dirEntries * 128) / SS);
  const dataSectors = datas.reduce((a, d) => a + d.data.length / SS, 0);
  let fatSectors = 1;
  while (fatSectors * (SS / 4) < fatSectors + dirSectors + dataSectors) fatSectors++;
  const total = fatSectors + dirSectors + dataSectors;
  const fat = new Uint32Array(fatSectors * (SS / 4)).fill(0xffffffff);
  for (let i = 0; i < fatSectors; i++) fat[i] = 0xfffffffd;
  const dirStart = fatSectors;
  for (let i = 0; i < dirSectors; i++) fat[dirStart + i] = i === dirSectors - 1 ? END : dirStart + i + 1;
  let next = dirStart + dirSectors;
  const starts: number[] = [];
  for (const [k, d] of datas.entries()) {
    const n = d.data.length / SS;
    starts.push(next);
    for (let i = 0; i < n; i++) fat[next + i] = i === n - 1 ? (opts.loopFirstStream && k === 0 ? next : END) : next + i + 1;
    next += n;
  }
  const out = new Uint8Array(SS * (1 + total));
  const dv = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(0x18, 0x3e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, fatSectors, true);
  dv.setUint32(0x30, dirStart, true);
  dv.setUint32(0x38, 4096, true);
  dv.setUint32(0x3c, END, true);
  dv.setUint32(0x44, END, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, i < fatSectors ? i : 0xffffffff, true);
  const sec = (n: number) => SS * (n + 1);
  for (let i = 0; i < fat.length; i++) dv.setUint32(sec(0) + i * 4, fat[i], true);
  const entry = (idx: number, name: string, type: number, start: number, size: number) => {
    const o = sec(dirStart) + idx * 128;
    for (let i = 0; i < name.length; i++) dv.setUint16(o + i * 2, name.charCodeAt(i), true);
    dv.setUint16(o + 0x40, (name.length + 1) * 2, true);
    out[o + 0x42] = type;
    dv.setUint32(o + 0x44, 0xffffffff, true);
    dv.setUint32(o + 0x48, 0xffffffff, true);
    dv.setUint32(o + 0x4c, 0xffffffff, true);
    dv.setUint32(o + 0x74, start, true);
    dv.setUint32(o + 0x78, size, true);
  };
  entry(0, 'Root Entry', 5, END, 0);
  names.forEach((n, i) => {
    entry(i + 1, n, 2, starts[i], datas[i].size + (opts.loopFirstStream && i === 0 ? 8192 : 0));
    out.set(datas[i].data, sec(starts[i]));
  });
  return out;
}
