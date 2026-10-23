// 0.9: finger long press (context menu / paste) in the InputRouter, and the menu placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter, LONG_PRESS_MS, TOUCH_SLOP, type RouterHost, type RouterPointer } from '../../src/input/input-router';
import { clampZoom, type Camera } from '../../src/editor/camera';
import { placeMenu } from '../../src/ui/context-menu';

class Host implements RouterHost {
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  log: string[] = [];
  longPresses: RouterPointer[] = [];
  taps = 0;
  getCamera(): Camera {
    return { ...this.cam };
  }
  setCamera(c: Camera): Camera {
    this.cam = { x: c.x, y: c.y, zoom: clampZoom(c.zoom) };
    this.log.push('cam');
    return this.cam;
  }
  drawKindFor(): 'ink' | 'erase' {
    return 'ink';
  }
  canDrawAt(): boolean {
    return true;
  }
  inkBegin(p: RouterPointer): void {
    this.log.push(`inkBegin:${p.kind}`);
  }
  inkMove(): void {}
  inkEnd(_p: RouterPointer | null, commit: boolean): void {
    this.log.push(commit ? 'inkCommit' : 'inkDiscard');
  }
  eraseBegin(): void {}
  eraseMove(): void {}
  eraseEnd(): void {}
  navStart(): void {
    this.log.push('navStart');
  }
  navEnd(): void {
    this.log.push('navEnd');
  }
  undo(): void {
    this.log.push('undo');
  }
  redo(): void {
    this.log.push('redo');
  }
  tap(): void {
    this.taps++;
  }
  longPress(p: RouterPointer): void {
    this.longPresses.push(p);
  }
}

const P = (id: number, kind: RouterPointer['kind'], x: number, y: number, t: number): RouterPointer => ({
  id, kind, x, y, t, button: 0, buttons: 1, pressure: kind === 'pen' ? 0.4 : 0, width: kind === 'touch' ? 40 : 1, height: kind === 'touch' ? 40 : 1,
});

function setup(fingerDrawing = false) {
  const h = new Host();
  const r = new InputRouter(h, { fingerDrawing, tapGestures: true });
  return { h, r };
}

test('long press: one still finger held LONG_PRESS_MS opens the menu once; lifting is no tap and no pan', () => {
  const { h, r } = setup();
  assert.equal(r.down(P(1, 'touch', 100, 100, 0)), 'nav');
  r.move(P(1, 'touch', 102, 101, 200)); // below slop
  assert.equal(r.longPressCheck(1, LONG_PRESS_MS - 1), false, 'not yet');
  assert.equal(r.longPressCheck(1, LONG_PRESS_MS + 10), true);
  assert.equal(h.longPresses.length, 1);
  assert.equal(h.longPresses[0].x, 102);
  assert.equal(r.longPressCheck(1, LONG_PRESS_MS + 50), false, 'only once');
  const camBefore = { ...h.cam };
  r.move(P(1, 'touch', 160, 180, 700)); // dragging after the menu opened does not pan
  r.up(P(1, 'touch', 160, 180, 800));
  assert.deepEqual(h.cam, camBefore);
  assert.equal(h.taps, 0);
  assert.equal(r.contactCount, 0);
  assert.equal(r.state, 'Idle');
});

test('long press: a finger that moved beyond the slop (pan) is not a long press', () => {
  const { h, r } = setup();
  r.down(P(1, 'touch', 100, 100, 0));
  r.move(P(1, 'touch', 100 + TOUCH_SLOP + 2, 100, 100));
  assert.equal(r.longPressCheck(1, 900), false);
  assert.equal(h.longPresses.length, 0);
  r.up(P(1, 'touch', 120, 100, 950));
});

test('long press: two fingers (pinch / two-finger tap) never open the menu', () => {
  const { h, r } = setup();
  r.down(P(1, 'touch', 100, 100, 0));
  r.down(P(2, 'touch', 200, 100, 30));
  assert.equal(r.longPressCheck(1, 700), false);
  assert.equal(r.longPressCheck(2, 700), false);
  r.up(P(2, 'touch', 200, 100, 720));
  // the remaining finger was part of a two-finger gesture: still no long press
  assert.equal(r.longPressCheck(1, 1300), false);
  r.up(P(1, 'touch', 100, 100, 1310));
  assert.equal(h.longPresses.length, 0);
});

test('long press: never while the Pencil writes, and a palm next to the Pencil is no long press', () => {
  const { h, r } = setup();
  assert.equal(r.down(P(9, 'pen', 300, 300, 0)), 'ink');
  assert.equal(r.down(P(1, 'touch', 400, 500, 10)), 'palm');
  assert.equal(r.longPressCheck(1, 900), false);
  r.up(P(9, 'pen', 320, 320, 950));
  assert.equal(r.longPressCheck(1, 1600), false, 'a palm stays a palm');
  r.up(P(1, 'touch', 400, 500, 1700));
  assert.equal(h.longPresses.length, 0);
  assert.ok(h.log.includes('inkCommit'), 'the stroke is committed normally');
});

test('long press: a finger that lands right after the Pencil lifted (palm grace) is no long press', () => {
  const { h, r } = setup();
  r.down(P(9, 'pen', 300, 300, 0));
  r.up(P(9, 'pen', 310, 310, 100));
  assert.equal(r.down(P(1, 'touch', 400, 500, 150)), 'palm');
  assert.equal(r.longPressCheck(1, 800), false);
  assert.equal(h.longPresses.length, 0);
});

test('long press: the Pencil touching down after a long press still draws', () => {
  const { h, r } = setup();
  r.down(P(1, 'touch', 100, 100, 0));
  assert.equal(r.longPressCheck(1, 600), true);
  r.up(P(1, 'touch', 100, 100, 700));
  assert.equal(r.down(P(9, 'pen', 300, 300, 800)), 'ink');
  r.up(P(9, 'pen', 320, 320, 900));
  assert.ok(h.log.includes('inkCommit'));
});

test('long press: finger drawing ON — the finger draws, no long press', () => {
  const { h, r } = setup(true);
  assert.equal(r.down(P(1, 'touch', 100, 100, 0)), 'ink');
  assert.equal(r.longPressCheck(1, 900), false);
  r.up(P(1, 'touch', 100, 100, 950));
  assert.equal(h.longPresses.length, 0);
});

test('long press: a quick tap still taps; the late timer of a lifted finger does nothing', () => {
  const { h, r } = setup();
  r.down(P(1, 'touch', 100, 100, 0));
  r.up(P(1, 'touch', 100, 100, 120));
  assert.equal(h.taps, 1);
  assert.equal(r.longPressCheck(1, 600), false);
  assert.equal(h.longPresses.length, 0);
});

test('long press: two-finger undo is unaffected', () => {
  const { h, r } = setup();
  r.down(P(1, 'touch', 100, 100, 0));
  r.down(P(2, 'touch', 160, 100, 20));
  r.up(P(1, 'touch', 100, 100, 150));
  r.up(P(2, 'touch', 160, 100, 160));
  assert.ok(h.log.includes('undo'));
});

test('context menu placement: near the touch, never outside the root', () => {
  // room below-right: the menu opens at the finger (slightly offset)
  const a = placeMenu(100, 100, 200, 160, 1000, 800);
  assert.ok(a.left >= 100 && a.left <= 120 && a.top >= 100 && a.top <= 120, JSON.stringify(a));
  // bottom-right corner: flips up and left, inside an 8 px margin
  const b = placeMenu(990, 790, 200, 160, 1000, 800);
  assert.ok(b.left + 200 <= 992 && b.top + 160 <= 792, JSON.stringify(b));
  assert.ok(b.left >= 8 && b.top >= 8);
  // tiny root: clamped to the margin
  const c = placeMenu(50, 50, 400, 300, 300, 200);
  assert.equal(c.left, 8);
  assert.equal(c.top, 8);
});

// ---- system clipboard helpers ----
import { cleanPastedText, readSystemClipboard, samePlain, MAX_PASTE_TEXT } from '../../src/editor/system-clipboard';
import { clipPlainText } from '../../src/editor/lasso';
import type { Item } from '../../src/document/items';

const blob = (type: string, text = 'x') => new Blob([text], { type });
const item = (types: Record<string, Blob>) => ({ types: Object.keys(types), getType: async (t: string) => types[t] });

test('clipboard read: images win over text; SVG is never taken as an image', async () => {
  const r1 = await readSystemClipboard({ read: async () => [item({ 'text/plain': blob('text/plain', 'hi'), 'image/png': blob('image/png') })] });
  assert.equal(r1.kind, 'image');
  const r2 = await readSystemClipboard({ read: async () => [item({ 'image/svg+xml': blob('image/svg+xml', '<svg/>'), 'text/plain': blob('text/plain', 'caption') })] });
  assert.deepEqual(r2, { kind: 'text', text: 'caption' });
});

test('clipboard read: permission refused is reported as denied (never as success)', async () => {
  const deny = async () => {
    const e = new Error('The request is not allowed');
    e.name = 'NotAllowedError';
    throw e;
  };
  const r = await readSystemClipboard({ read: deny, readText: async () => 'should not be used' });
  assert.equal(r.kind, 'denied');
  const r2 = await readSystemClipboard({ readText: deny });
  assert.equal(r2.kind, 'denied');
});

test('clipboard read: falls back to readText, reports empty and unsupported honestly', async () => {
  const notImpl = async () => {
    throw new TypeError('not implemented');
  };
  assert.deepEqual(await readSystemClipboard({ read: notImpl, readText: async () => 'abc' }), { kind: 'text', text: 'abc' });
  assert.deepEqual(await readSystemClipboard({ readText: async () => '   ' }), { kind: 'empty' });
  assert.deepEqual(await readSystemClipboard({}), { kind: 'unsupported' });
  assert.deepEqual(await readSystemClipboard(undefined), { kind: 'unsupported' });
});

test('pasted text is cleaned (line endings, tabs, control characters) and capped', () => {
  assert.deepEqual(cleanPastedText('\r\na\tb\r\nc\u0007\n\n'), { text: 'a    b\nc', truncated: false });
  const long = cleanPastedText('x'.repeat(MAX_PASTE_TEXT + 5));
  assert.equal(long.text.length, MAX_PASTE_TEXT);
  assert.equal(long.truncated, true);
});

test('HandNote copy stamp: the same plain text pastes the objects, other text does not', () => {
  assert.equal(samePlain('Neural networks\r\n', 'Neural networks'), true);
  assert.equal(samePlain('', ''), true);
  assert.equal(samePlain('other', 'Neural networks'), false);
  assert.equal(samePlain('x', null), false);
  const items = [
    { id: 'b', type: 'text', x: 0, y: 50, w: 10, h: 10, created: 0, text: 'second', size: 12, color: '#000', font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true },
    { id: 'a', type: 'text', x: 0, y: 10, w: 10, h: 10, created: 0, text: 'first', size: 12, color: '#000', font: 'sans', bold: false, italic: false, align: 'left', autoWidth: true },
    { id: 'f', type: 'formula', x: 0, y: 90, w: 10, h: 10, created: 0, latex: 'a^2', color: '#000', size: 12 },
  ] as Item[];
  assert.equal(clipPlainText(items), 'first\nsecond\n$$a^2$$');
  assert.equal(clipPlainText([]), '');
});
