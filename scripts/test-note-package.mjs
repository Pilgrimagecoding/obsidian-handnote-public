import esbuild from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, stat, copyFile, open } from 'node:fs/promises';
import { openAsBlob, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
await mkdir('build/package-tests', { recursive: true });
await esbuild.build({ stdin: { contents: `export { NotePackages, bindPackageSources } from './src/storage/note-package'; export { serializeDocument, parseDocument } from './src/document/codec'; export { createDocument } from './src/document/model';`, resolveDir: process.cwd() }, outfile: 'build/package-tests/module.cjs', bundle: true, format: 'cjs', platform: 'node', external: ['fs', 'obsidian'], logLevel: 'silent' });
const compiled = await readFile('build/package-tests/module.cjs', 'utf8');
const nativeRequire = createRequire(import.meta.url);
function runtime(isDesktopApp = true, fsLoader = () => nativeRequire('fs')) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'obsidian') return { Platform: { isDesktopApp, isMobile: !isDesktopApp } };
    if (name === 'fs') return fsLoader();
    throw new Error(`Unexpected module: ${name}`);
  }, module, module.exports);
  return module.exports;
}
const { NotePackages, bindPackageSources, createDocument, serializeDocument, parseDocument } = runtime();
async function fixture(Packages = NotePackages) {
  const root = await mkdtemp(path.resolve('build/package-tests/case-'));
  let appended = 0;
  const full = p => path.join(root, p);
  const adapter = {
    getFullPath: full,
    stat: async p => { try { const s = await stat(full(p)); return { type: 'file', size: s.size, mtime: s.mtimeMs }; } catch { return null; } },
    read: p => readFile(full(p), 'utf8'),
    readBinary: async p => { const b = await readFile(full(p)); return b.buffer.slice(b.byteOffset,b.byteOffset+b.length); },
    appendBinary: async (p,b) => { appended += b.byteLength; await appendFile(full(p), new Uint8Array(b)); },
    copy: (a,b) => copyFile(full(a),full(b)),
  };
  const app = { vault: { adapter, modifyBinary: (f,b) => writeFile(full(f.path),new Uint8Array(b)) } };
  const doc = createDocument(), text = serializeDocument(doc), file = { path: 'note.handnote' };
  await writeFile(full(file.path), text);
  const store = new Packages(app);
  return { root, full, adapter, app, doc, text, file, store, appended: () => appended };
}

test('package roundtrip retains original bytes; annotations append without duplicating the source', async () => {
  const f = await fixture(); await f.store.ensure(f.file);
  const raw = new Uint8Array(16 * 1024 * 1024); for(let i=0;i<raw.length;i++) raw[i]=i%251;
  const name = 'sources/original.pdf'; await f.store.add(f.file.path,[{name,blob:new Blob([raw])}]);
  const before = f.appended(), size = (await f.adapter.stat(f.file.path)).size;
  f.doc.revision++; const text = serializeDocument(f.doc); await f.store.write(f.file.path,text,f.text);
  assert.ok(f.appended()-before<10000,'autosave appends only the note checkpoint');
  assert.ok((await f.adapter.stat(f.file.path)).size-size<10000);
  const fresh = new NotePackages(f.app);
  assert.equal(await fresh.read(f.file.path),text);
  assert.deepEqual(new Uint8Array(await fresh.entry(f.file.path,name)),raw);
  const prior = (await f.adapter.stat(f.file.path)).size;
  await fresh.add(f.file.path,[{name,blob:new Blob([raw])}]);
  assert.ok((await f.adapter.stat(f.file.path)).size-prior<10000,'reimport reuses immutable entry');
});

test('cancel and partial append retain the last complete note and source', async () => {
  const f=await fixture(); await f.store.ensure(f.file);
  await f.store.add(f.file.path,[{name:'sources/keep.pdf',blob:new Blob(['original'])}]);
  const ctl=new AbortController(), append=f.adapter.appendBinary;
  f.adapter.appendBinary=async(p,b)=>{await append(p,b); if(b.byteLength>100000)ctl.abort();};
  await assert.rejects(f.store.add(f.file.path,[{name:'sources/cancel.pdf',blob:new Blob([new Uint8Array(8*1024*1024)])}],ctl.signal),{name:'AbortError'});
  f.adapter.appendBinary=append;
  assert.equal(await new NotePackages(f.app).read(f.file.path),f.text);
  assert.equal(new TextDecoder().decode(await f.store.entry(f.file.path,'sources/keep.pdf')),'original');
  await append(f.file.path,new Uint8Array(5*1024*1024).buffer); // simulated process death mid-append
  assert.equal(await new NotePackages(f.app).read(f.file.path),f.text);
});

test('stale writer cannot overwrite synchronized note; conflict copy remains self-contained after rename', async()=>{
  const f=await fixture(); await f.store.ensure(f.file); await f.store.add(f.file.path,[{name:'sources/keep.pdf',blob:new Blob(['original'])}]);
  const other=new NotePackages(f.app); await other.read(f.file.path);
  f.doc.revision++;const newest=serializeDocument(f.doc);await f.store.write(f.file.path,newest,f.text);
  await assert.rejects(other.write(f.file.path,f.text+' ',f.text),/changed/);
  assert.equal(await other.read(f.file.path),newest);
  await other.copy(f.file.path,'renamed.handnote',newest);
  assert.equal(new TextDecoder().decode(await new NotePackages(f.app).entry('renamed.handnote','sources/keep.pdf')),'original');
  f.doc.sources={s:{id:'s',kind:'pdf',path:'old.handnote',name:'original.pdf',size:8,sha256:'',pages:1,imported:1,entry:'sources/keep.pdf',containerId:f.doc.id}};
  f.doc.pages[0].doc={src:'s',n:1};
  const parsed=parseDocument(serializeDocument(f.doc)).doc; bindPackageSources(parsed,'renamed.handnote');
  assert.equal(parsed.sources.s.path,'renamed.handnote'); assert.equal(parsed.sources.s.entry,'sources/keep.pdf');
});

test('mobile range reads open a large container without decoding its source as text',async()=>{
  const f=await fixture();await f.store.ensure(f.file);await f.store.add(f.file.path,[{name:'sources/raw.pdf',blob:new Blob([new Uint8Array(9*1024*1024)])}]);
  const { NotePackages: MobilePackages } = runtime(false, () => { throw new Error('Mobile must never request fs'); });
  // Keep getFullPath: iPad has this API too, which caused the beta.12 regression.
  f.adapter.getResourcePath=()=> 'https://fixture.invalid/note';
  f.adapter.readBinary=async()=>{throw new Error('Range support must avoid a full binary read');};
  const originalFetch=globalThis.fetch;let readBytes=0;
  globalThis.fetch=async(_url,opts)=>{const [start,end]=opts.headers.Range.slice(6).split('-').map(Number);const bytes=new Uint8Array(end-start+1); const fd=await open(f.full(f.file.path),'r');try{await fd.read(bytes,0,bytes.length,start);}finally{await fd.close();} readBytes+=bytes.length;return new Response(bytes,{status:206,headers:{'content-range':`bytes ${start}-${end}/${(await f.adapter.stat(f.file.path)).size}`}});};
  try {assert.equal(await new MobilePackages(f.app).read(f.file.path),f.text); assert.ok(readBytes<5*1024*1024);}finally{globalThis.fetch=originalFetch;}
});

test('iPad getFullPath plus require shim: old notes and packages open, save and reopen without Node', async()=>{
  let nodeCalls=0;
  const { NotePackages: MobilePackages }=runtime(false,()=>{nodeCalls++;return undefined;});
  const f=await fixture(MobilePackages), originalFetch=globalThis.fetch;
  f.adapter.getResourcePath=()=> 'capacitor://localhost/note.handnote';
  globalThis.fetch=async()=>{throw new Error('Resource URL unavailable');};
  try {
    const before=await readFile(f.full(f.file.path));
    assert.equal(await f.store.read(f.file.path),f.text);
    assert.deepEqual(await readFile(f.full(f.file.path)),before,'opening an old note does not modify it');
    await f.store.ensure(f.file);
    await f.store.add(f.file.path,[{name:'sources/original.pdf',blob:new Blob(['original bytes'])}]);
    f.doc.revision++;const next=serializeDocument(f.doc);
    await f.store.write(f.file.path,next,f.text);
    const reopened=new MobilePackages(f.app);
    assert.equal(await reopened.read(f.file.path),next);
    assert.equal(new TextDecoder().decode(await reopened.entry(f.file.path,'sources/original.pdf')),'original bytes');
    assert.equal(nodeCalls,0,'mobile does not even probe fs');
  } finally {globalThis.fetch=originalFetch;}
});

test('desktop without usable fs safely falls back; native file errors are not swallowed',async()=>{
  for(const loader of [()=>undefined,()=>({}),()=>{throw new Error('Module unavailable');}]){
    const {NotePackages: FallbackPackages}=runtime(true,loader), f=await fixture(FallbackPackages);
    assert.equal(await f.store.read(f.file.path),f.text);
    await f.store.ensure(f.file);
    assert.equal(await new FallbackPackages(f.app).read(f.file.path),f.text);
  }
  const {NotePackages: BrokenNative}=runtime(true,()=>({promises:{open:async()=>{throw new Error('Permission denied');}}}));
  const f=await fixture(BrokenNative),before=await readFile(f.full(f.file.path));
  await assert.rejects(f.store.read(f.file.path),/Permission denied/);
  assert.deepEqual(await readFile(f.full(f.file.path)),before);
});

if(process.env.HN_LARGE_PACKAGE){
 test('400 MiB original PDF: package, reopen, append ink, extract exact original',async()=>{
   const source=process.env.HN_LARGE_PACKAGE;assert.ok(existsSync(source));const f=await fixture();await f.store.ensure(f.file);
   const blob=await openAsBlob(source);await f.store.add(f.file.path,[{name:'sources/original.pdf',blob}]);
   const before=f.appended();f.doc.revision++;await f.store.write(f.file.path,serializeDocument(f.doc),f.text);assert.ok(f.appended()-before<10000);
   const data=await new NotePackages(f.app).entry(f.file.path,'sources/original.pdf');
   const expected=createHash('sha256');const original=await openAsBlob(source);for await(const chunk of original.stream())expected.update(chunk);
   assert.equal(createHash('sha256').update(new Uint8Array(data)).digest('hex'),expected.digest('hex'));
   console.log('400 MiB self-contained fixture:',f.full(f.file.path));
 });
}


test('a missing embedded original is not silently committed over a synchronized package',async()=>{
 const f=await fixture();await f.store.ensure(f.file);
 f.doc.sources={s:{id:'s',kind:'pdf',path:f.file.path,name:'missing.pdf',size:8,sha256:'',pages:1,imported:1,entry:'sources/missing.pdf',containerId:f.doc.id}};f.doc.pages[0].doc={src:'s',n:1};
 await assert.rejects(f.store.write(f.file.path,serializeDocument(f.doc),f.text),/original is missing/);
 assert.equal(await new NotePackages(f.app).read(f.file.path),f.text);
});
