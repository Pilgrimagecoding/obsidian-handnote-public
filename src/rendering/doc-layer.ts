/**
 * Imported document pages (0.9, format v6): the PDF / Office page painted under a page's ink.
 *
 * The note never contains the document's pixels. Pages are rasterized on demand, only when they
 * are on screen, at a resolution bucket that matches the zoom (power of two, capped), kept in a
 * small LRU cache with a pixel budget and released when they scroll away. Rendering is serial and
 * newest-first, so the page the user looks at comes first and a fast scroll does not queue up
 * hundreds of renders.
 *
 * The actual rasterizer is supplied by the host (`setDocRenderer`): in Obsidian it uses the PDF.js
 * that ships with Obsidian (no download, no CDN); tests use a stand-in.
 */
import type { DocSource, Page } from '../document/model';

export interface RenderedPage {
  /** Anything drawImage accepts (canvas, ImageBitmap). */
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Free the pixels early (ImageBitmap.close, canvas resize). Optional. */
  release?: () => void;
}

export interface DocPageRenderer {
  /** Rasterize page `n` (1-based) of `src` to about w × h device pixels. Reject with DocError. */
  render(src: DocSource, n: number, w: number, h: number, signal: AbortSignal): Promise<RenderedPage>;
}

/** A failure the page should show instead of the document (missing file, damaged file…). */
export class DocError extends Error {
  constructor(
    readonly code: 'missing' | 'damaged' | 'unsupported' | 'too-large' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'DocError';
  }
}

let renderer: DocPageRenderer | null = null;
const sources = new Map<string, DocSource>();
const listeners = new Set<() => void>();

export function setDocRenderer(r: DocPageRenderer | null): void {
  renderer = r;
  clearDocCache();
}

/** Make a note's sources known to the painter (by id; ids are random, so notes never collide). */
export function registerSources(map: Record<string, DocSource> | undefined): void {
  if (!map) return;
  for (const s of Object.values(map)) {
    const old = sources.get(s.id);
    sources.set(s.id, s);
    // a relinked / changed file: forget its failure and pixels
    if (old && (old.path !== s.path || old.sha256 !== s.sha256)) forgetSource(s.id);
  }
}

export function sourceById(id: string): DocSource | undefined {
  return sources.get(id);
}

/** Called after a page finished rendering (the editor / embeds repaint). */
export function onDocLayerReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error('HandNote: doc layer listener failed', e);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Cache
// ------------------------------------------------------------------------------------------------

interface Entry {
  key: string;
  src: string;
  n: number;
  bucket: number;
  page: RenderedPage;
  pixels: number;
  used: number;
}

/** Pixel budget for cached pages (≈ 4 bytes each): 24 MP ≈ 96 MB on a phone / iPad. */
let budget = 24_000_000;
/** Longest side of one rendered page (device px). */
export const MAX_RENDER_SIDE = 4096;

const cache = new Map<string, Entry>();
const failures = new Map<string, DocError>(); // by source id (whole file) or `${id}|${n}` (one page)
let queue: { key: string; src: string; n: number; bucket: number; w: number; h: number; asked: number }[] = [];
let running: { key: string; ctl: AbortController } | null = null;
let tick = 0;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** A render request not repeated for this long belongs to a page that scrolled away. */
const STALE_REQUEST_MS = 1500;

export function setDocCacheBudget(pixels: number): void {
  budget = Math.max(4_000_000, pixels);
  evict();
}

export function clearDocCache(): void {
  for (const e of cache.values()) e.page.release?.();
  cache.clear();
  onScreen.clear();
  wantSince.clear();
  failures.clear();
  queue = [];
  running?.ctl.abort();
  running = null;
}

/** Forget one source (relinked, re-imported): its pixels and failures. */
export function forgetSource(id: string): void {
  for (const [k, e] of cache) if (e.src === id) {
    e.page.release?.();
    cache.delete(k);
  }
  for (const k of [...failures.keys()]) if (k === id || k.startsWith(`${id}|`)) failures.delete(k);
  queue = queue.filter((q) => q.src !== id);
}

/** Record that a source cannot be read (checked by the host before any page asked). */
export function markSourceFailed(id: string, e: DocError): void {
  forgetSource(id);
  failures.set(id, e);
  emit();
}

export function docFailure(id: string, n?: number): DocError | undefined {
  return failures.get(id) ?? (n !== undefined ? failures.get(`${id}|${n}`) : undefined);
}

/** Cache statistics (diagnostics, tests). */
export function docCacheStats(): { pages: number; pixels: number; budget: number; queued: number; running: boolean } {
  let pixels = 0;
  for (const e of cache.values()) pixels += e.pixels;
  return { pages: cache.size, pixels, budget, queued: queue.length, running: !!running };
}

/** Resolution bucket (device px per page unit) for a zoom: a power of two in [0.5, 8], capped by MAX_RENDER_SIDE. */
export function bucketFor(pxPerUnit: number, pageW: number, pageH: number): number {
  let b = Math.pow(2, Math.ceil(Math.log2(Math.max(0.25, pxPerUnit) - 1e-9)));
  b = Math.min(8, Math.max(0.5, b));
  while (b > 0.5 && Math.max(pageW, pageH) * b > MAX_RENDER_SIDE) b /= 2;
  return b;
}

/** Pages painted recently (`${src}|${n}` → last time and the bucket wanted then). */
const onScreen = new Map<string, { at: number; bucket: number }>();
/** A page painted within this time counts as on screen. */
const ON_SCREEN_MS = 1200;
/** A sharper rendering is started only after the zoom stayed the same this long (no work while pinching). */
export const SETTLE_MS = 180;
const wantSince = new Map<string, number>();
let settleTimer: number | null = null;
const later = (fn: () => void, ms: number): number => window.setTimeout(fn, ms);

function visiblePages(at: number): number {
  let n = 0;
  for (const [k, v] of onScreen) {
    if (at - v.at <= ON_SCREEN_MS) n++;
    else onScreen.delete(k);
  }
  return n;
}

/**
 * Keep within the budget without ever taking away what is on screen: renderings of pages not
 * painted recently go first (oldest first), then sharper duplicates of on-screen pages; the
 * rendering an on-screen page shows and its cheapest fallback are kept (a page never drops back to
 * the grey "loading" state while it is being looked at — that was the flicker while zooming).
 */
function evict(): void {
  let total = 0;
  for (const e of cache.values()) total += e.pixels;
  if (total <= budget) return;
  const at = now();
  const keep = new Set<string>();
  const byPage = new Map<string, Entry[]>();
  for (const e of cache.values()) {
    const pk = `${e.src}|${e.n}`;
    const list = byPage.get(pk) ?? [];
    list.push(e);
    byPage.set(pk, list);
  }
  for (const [pk, list] of byPage) {
    const v = onScreen.get(pk);
    if (!v || at - v.at > ON_SCREEN_MS) continue;
    const exact = list.find((e) => e.bucket === v.bucket);
    const closest = list.reduce((a, b) => (Math.abs(Math.log2(b.bucket / v.bucket)) < Math.abs(Math.log2(a.bucket / v.bucket)) ? b : a));
    keep.add((exact ?? closest).key);
    keep.add(list.reduce((a, b) => (b.pixels < a.pixels ? b : a)).key);
  }
  const order = [...cache.values()].sort((a, b) => Number(keep.has(a.key)) - Number(keep.has(b.key)) || a.used - b.used);
  for (const e of order) {
    if (total <= budget) break;
    if (keep.has(e.key)) break;
    e.page.release?.();
    cache.delete(e.key);
    total -= e.pixels;
  }
}

function pump(): void {
  if (running || !renderer || !queue.length) return;
  // newest request first; drop requests nobody asked for again recently (scrolled away)
  const at = now();
  queue = queue.filter((q) => at - q.asked <= STALE_REQUEST_MS);
  queue.sort((a, b) => b.asked - a.asked);
  const job = queue.shift();
  if (!job) return;
  const src = sources.get(job.src);
  if (!src || cache.has(job.key) || failures.has(job.src) || failures.has(`${job.src}|${job.n}`)) {
    pump();
    return;
  }
  const ctl = new AbortController();
  running = { key: job.key, ctl };
  renderer
    .render(src, job.n, job.w, job.h, ctl.signal)
    .then((page) => {
      if (ctl.signal.aborted) {
        page.release?.();
        return;
      }
      cache.set(job.key, { key: job.key, src: job.src, n: job.n, bucket: job.bucket, page, pixels: page.width * page.height, used: ++tick });
      evict();
      emit();
    })
    .catch((err: unknown) => {
      if (ctl.signal.aborted) return;
      const e = err instanceof DocError ? err : new DocError('failed', String((err as Error)?.message ?? err));
      // a missing / damaged / unsupported file affects all its pages; other errors one page
      failures.set(e.code === 'failed' ? `${job.src}|${job.n}` : job.src, e);
      emit();
    })
    .finally(() => {
      if (running?.key === job.key) running = null;
      pump();
    });
}

/**
 * The best cached rendering of page `n` of source `id` for a zoom, and a render request for the
 * right resolution when it is missing. Returns null when nothing is cached yet.
 */
export function docPageImage(id: string, n: number, pageW: number, pageH: number, pxPerUnit: number): Entry | null {
  const at = now();
  let bucket = bucketFor(pxPerUnit, pageW, pageH);
  // all pages on screen together must fit in part of the budget: zoomed far in with several pages
  // visible, each is rendered a step less sharp instead of pushing the others out of the cache
  const share = (budget * 0.6) / Math.max(1, visiblePages(at) + (onScreen.has(`${id}|${n}`) ? 0 : 1));
  while (bucket > 0.5 && pageW * pageH * bucket * bucket > share) bucket /= 2;
  onScreen.set(`${id}|${n}`, { at, bucket });
  const key = `${id}|${n}|${bucket}`;
  const t = ++tick;
  let best: Entry | null = null;
  for (const e of cache.values()) {
    if (e.src !== id || e.n !== n) continue;
    if (e.bucket === bucket) {
      best = e;
      break;
    }
    // otherwise the closest available (a sharper one beats a blurrier one)
    if (!best || Math.abs(Math.log2(e.bucket / bucket)) < Math.abs(Math.log2(best.bucket / bucket)) || (e.bucket > best.bucket && Math.abs(Math.log2(e.bucket / bucket)) === Math.abs(Math.log2(best.bucket / bucket)))) best = e;
  }
  if (best) best.used = t;
  if ((!best || best.bucket !== bucket) && renderer && !failures.has(id) && !failures.has(`${id}|${n}`)) {
    // something is shown already: wait until the zoom settles before rendering a sharper one
    if (best) {
      const since = wantSince.get(key);
      for (const k of wantSince.keys()) if (k.startsWith(`${id}|${n}|`) && k !== key) wantSince.delete(k);
      if (since === undefined || at - since < SETTLE_MS) {
        if (since === undefined) wantSince.set(key, at);
        settleTimer ??= later(() => {
          settleTimer = null;
          emit();
        }, SETTLE_MS + 20);
        return best;
      }
    }
    wantSince.delete(key);
    const q = queue.find((x) => x.key === key);
    if (q) q.asked = at;
    else if (running?.key !== key) queue.push({ key, src: id, n, bucket, w: Math.round(pageW * bucket), h: Math.round(pageH * bucket), asked: at });
    pump();
  }
  return best;
}

/** Whether some rendering of a page is in the cache (thumbnails redraw once it is). */
export function docPageReady(id: string, n: number): boolean {
  for (const e of cache.values()) if (e.src === id && e.n === n) return true;
  return false;
}

export interface DocPaintText {
  loading: string;
  missing: string;
  failed: string;
}

let paintText: DocPaintText = { loading: 'Loading page {n}…', missing: 'Document not found: {name}', failed: 'This page could not be shown ({reason})' };

export function setDocPaintText(t: DocPaintText): void {
  paintText = t;
}

/**
 * Paint the imported page of `page` (if any) into a context whose transform maps page units.
 * Returns true when something was painted (the page or a placeholder).
 */
export function paintDocPage(ctx: CanvasRenderingContext2D, page: Page, pxPerUnit: number): boolean {
  const d = page.doc;
  if (!d) return false;
  const W = page.width;
  const H = page.height;
  const e = docPageImage(d.src, d.n, W, H, pxPerUnit);
  if (e) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(e.page.image, 0, 0, W, H);
    ctx.restore();
    return true;
  }
  const src = sources.get(d.src);
  const fail = docFailure(d.src, d.n);
  let msg: string;
  if (fail?.code === 'missing' || !src) msg = paintText.missing.replace('{name}', src?.name ?? '?');
  else if (fail) msg = paintText.failed.replace('{reason}', fail.message.slice(0, 80));
  else msg = paintText.loading.replace('{n}', String(d.n));
  ctx.save();
  ctx.fillStyle = fail || !src ? 'rgba(229, 72, 60, 0.06)' : 'rgba(0, 0, 0, 0.035)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = fail || !src ? '#b3261e' : '#8a8f98';
  const size = Math.max(9, Math.min(14, W / 40));
  ctx.font = `${size}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg.length > 90 ? msg.slice(0, 89) + '…' : msg, W / 2, H / 2, W - 24);
  ctx.restore();
  return true;
}

/**
 * Render the imported page of `page` at `pxPerUnit` now and wait for it (PNG export, embeds):
 * afterwards paintDocPage draws it instead of a placeholder. Resolves false when it cannot be
 * rendered (the placeholder with the reason is drawn then).
 */
export async function ensureDocPage(page: Page, pxPerUnit: number): Promise<boolean> {
  const d = page.doc;
  if (!d || !renderer) return false;
  const src = sources.get(d.src);
  if (!src || failures.has(d.src) || failures.has(`${d.src}|${d.n}`)) return false;
  const bucket = bucketFor(pxPerUnit, page.width, page.height);
  const key = `${d.src}|${d.n}|${bucket}`;
  if (cache.has(key)) return true;
  try {
    const r = await renderer.render(src, d.n, Math.round(page.width * bucket), Math.round(page.height * bucket), new AbortController().signal);
    cache.set(key, { key, src: d.src, n: d.n, bucket, page: r, pixels: r.width * r.height, used: ++tick });
    evict();
    return true;
  } catch (err) {
    const e = err instanceof DocError ? err : new DocError('failed', String((err as Error)?.message ?? err));
    failures.set(e.code === 'failed' ? `${d.src}|${d.n}` : d.src, e);
    return false;
  }
}
