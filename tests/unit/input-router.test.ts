import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter, type RouterHost, type RouterPointer, PEN_GRACE_MS } from '../../src/input/input-router';
import { clampZoom, type Camera } from '../../src/editor/camera';

/** Fake editor: records every action the router requests. */
class FakeHost implements RouterHost {
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  log: string[] = [];
  committed = 0;
  discarded = 0;
  inkPoints = 0;
  erased = 0;
  readOnly = false;
  eraser = false;
  getCamera(): Camera {
    return { ...this.cam };
  }
  setCamera(c: Camera): Camera {
    this.cam = { x: c.x, y: c.y, zoom: clampZoom(c.zoom) };
    return this.cam;
  }
  drawKindFor(p: RouterPointer): 'ink' | 'erase' {
    return this.eraser || (p.kind === 'pen' && (p.buttons & 32) !== 0) ? 'erase' : 'ink';
  }
  canDrawAt(): boolean {
    return !this.readOnly;
  }
  inkBegin(p: RouterPointer): void {
    this.log.push(`inkBegin:${p.kind}`);
    this.inkPoints++;
  }
  inkMove(): void {
    this.inkPoints++;
  }
  inkEnd(_p: RouterPointer | null, commit: boolean): void {
    this.log.push(commit ? 'inkCommit' : 'inkDiscard');
    if (commit) this.committed++;
    else this.discarded++;
  }
  eraseBegin(): void {
    this.log.push('eraseBegin');
  }
  eraseMove(): void {
    this.erased++;
  }
  eraseEnd(): void {
    this.log.push('eraseEnd');
  }
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
}

let clock = 1000;
function ptr(id: number, kind: RouterPointer['kind'], x: number, y: number, extra: Partial<RouterPointer> = {}): RouterPointer {
  return {
    id,
    kind,
    x,
    y,
    t: clock,
    button: 0,
    buttons: 1,
    pressure: kind === 'pen' ? 0.4 : kind === 'touch' ? 0 : 0.5,
    // realistic iPad finger contact: WebKit reports 2 × UITouch.majorRadius (often > 46 px)
    width: kind === 'touch' ? 52 : 1,
    height: kind === 'touch' ? 52 : 1,
    ...extra,
  };
}
const tick = (ms: number) => (clock += ms);

function setup(opts: Partial<{ fingerDrawing: boolean; tapGestures: boolean }> = {}) {
  const host = new FakeHost();
  const r = new InputRouter(host, { fingerDrawing: false, tapGestures: true, ...opts });
  return { host, r };
}

/** Drag a pointer from (x0,y0) by (dx,dy) in n steps of 8 ms. */
function drag(r: InputRouter, id: number, kind: RouterPointer['kind'], x0: number, y0: number, dx: number, dy: number, n = 10, up = true) {
  r.down(ptr(id, kind, x0, y0));
  for (let i = 1; i <= n; i++) {
    tick(8);
    r.move(ptr(id, kind, x0 + (dx * i) / n, y0 + (dy * i) / n));
  }
  if (up) r.up(ptr(id, kind, x0 + dx, y0 + dy, { buttons: 0 }));
}

// ---------------------------------------------------------------------------------------------
// 11.1 iPad input
// ---------------------------------------------------------------------------------------------

test('pen down/move/up creates, extends and commits one stroke', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 100, 100));
  assert.equal(r.state, 'PenDrawing');
  for (let i = 0; i < 5; i++) {
    tick(4);
    r.move(ptr(1, 'pen', 100 + i, 100));
  }
  r.up(ptr(1, 'pen', 105, 100, { buttons: 0 }));
  assert.equal(host.committed, 1);
  assert.equal(host.inkPoints, 6);
  assert.equal(r.state, 'Idle');
});

test('REGRESSION v0.1: finger drawing OFF — a normal (wide) finger contact pans the page', () => {
  const { host, r } = setup({ fingerDrawing: false });
  drag(r, 7, 'touch', 300, 400, 0, -120);
  assert.equal(host.committed + host.discarded, 0, 'finger never draws');
  assert.ok(Math.abs(host.cam.y - 120) < 1e-9, `camera panned down the document (y=${host.cam.y})`);
  assert.ok(host.log.includes('navStart') && host.log.includes('navEnd'));
});

test('finger drawing OFF — two fingers pinch-zoom about the midpoint', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'touch', 200, 300));
  r.down(ptr(2, 'touch', 400, 300));
  assert.equal(r.state, 'TouchPinching');
  for (let i = 1; i <= 10; i++) {
    tick(8);
    r.move(ptr(1, 'touch', 200 - i * 10, 300));
    r.move(ptr(2, 'touch', 400 + i * 10, 300));
  }
  assert.ok(Math.abs(host.cam.zoom - 2) < 0.01, `zoom ${host.cam.zoom}`);
  // world point under the midpoint (300,300) stays fixed: world = s/zoom + cam
  const wx = 300 / host.cam.zoom + host.cam.x;
  const wy = 300 / host.cam.zoom + host.cam.y;
  assert.ok(Math.abs(wx - 300) < 1e-6 && Math.abs(wy - 300) < 1e-6, `midpoint fixed (${wx}, ${wy})`);
  r.up(ptr(1, 'touch', 100, 300));
  r.up(ptr(2, 'touch', 500, 300));
  assert.equal(host.committed, 0, 'pinch never draws');
  assert.ok(!host.log.includes('undo'), 'a moving pinch is not a tap');
});

test('two-finger pinch while moving pans with the midpoint', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'touch', 200, 300));
  r.down(ptr(2, 'touch', 300, 300));
  for (let i = 1; i <= 5; i++) {
    tick(8);
    r.move(ptr(1, 'touch', 200, 300 - i * 20));
    r.move(ptr(2, 'touch', 300, 300 - i * 20));
  }
  assert.ok(Math.abs(host.cam.zoom - 1) < 1e-9);
  assert.ok(Math.abs(host.cam.y - 100) < 1e-6, `two-finger pan y=${host.cam.y}`);
});

test('finger drawing ON — one finger draws, pinch still navigates and aborts a young stroke', () => {
  const { host, r } = setup({ fingerDrawing: true });
  drag(r, 1, 'touch', 100, 100, 50, 0);
  assert.equal(host.committed, 1, 'one finger drew');
  tick(400);
  r.down(ptr(2, 'touch', 200, 300));
  tick(60);
  r.down(ptr(3, 'touch', 400, 300)); // second finger within 200 ms
  assert.equal(host.discarded, 1, 'tentative stroke discarded, not saved');
  assert.equal(r.state, 'TouchPinching');
  for (let i = 1; i <= 5; i++) {
    tick(8);
    r.move(ptr(2, 'touch', 200 - i * 20, 300));
    r.move(ptr(3, 'touch', 400 + i * 20, 300));
  }
  assert.ok(host.cam.zoom > 1.3, `zoomed ${host.cam.zoom}`);
  assert.equal(host.committed, 1, 'no extra stroke from the pinch');
});

test('finger drawing ON — second finger after an established stroke commits it, then pinches', () => {
  const { host, r } = setup({ fingerDrawing: true });
  r.down(ptr(1, 'touch', 100, 100));
  for (let i = 1; i <= 40; i++) {
    tick(8);
    r.move(ptr(1, 'touch', 100 + i, 100));
  }
  r.down(ptr(2, 'touch', 300, 300));
  assert.equal(host.committed, 1);
  assert.equal(r.state, 'TouchPinching');
});

test('pen active + palm touch: no extra stroke, no page movement', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 100, 400));
  tick(10);
  r.down(ptr(9, 'touch', 300, 600, { width: 120, height: 90 }));
  for (let i = 1; i <= 30; i++) {
    tick(8);
    r.move(ptr(1, 'pen', 100 + i * 3, 400));
    r.move(ptr(9, 'touch', 300 + i * 2, 600 + i * 3));
  }
  r.up(ptr(1, 'pen', 190, 400));
  r.up(ptr(9, 'touch', 360, 690));
  assert.equal(host.committed, 1);
  assert.deepEqual(host.cam, { x: 0, y: 0, zoom: 1 });
  assert.equal(r.stats.palm, 1);
});

test('palm first, then pen: the palm never moves the page (pan reverted) and the pen draws', () => {
  const { host, r } = setup();
  r.down(ptr(9, 'touch', 300, 600));
  for (let i = 1; i <= 5; i++) {
    tick(8);
    r.move(ptr(9, 'touch', 300, 600 + i * 4)); // palm settles and slides 20 px
  }
  assert.ok(host.cam.y !== 0, 'palm briefly panned');
  tick(30);
  r.down(ptr(1, 'pen', 100, 400));
  assert.deepEqual(host.cam, { x: 0, y: 0, zoom: 1 }, 'pan reverted when the pen landed');
  for (let i = 1; i <= 10; i++) {
    tick(8);
    r.move(ptr(9, 'touch', 300, 620 + i * 5));
    r.move(ptr(1, 'pen', 100 + i * 3, 400));
  }
  assert.deepEqual(host.cam, { x: 0, y: 0, zoom: 1 }, 'palm stays inert while writing');
  r.up(ptr(1, 'pen', 130, 400));
  assert.equal(host.committed, 1);
});

test('pen lifted, palm still down and shifting: no navigation until the palm lifts', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 100, 400));
  tick(10);
  r.down(ptr(9, 'touch', 300, 600));
  tick(50);
  r.up(ptr(1, 'pen', 120, 400));
  tick(PEN_GRACE_MS + 200);
  r.down(ptr(10, 'touch', 320, 640)); // palm shifts: new contact while the old palm is down
  drag(r, 10, 'touch', 320, 640, 0, 80, 5);
  assert.deepEqual(host.cam, { x: 0, y: 0, zoom: 1 });
  r.up(ptr(9, 'touch', 300, 600));
  tick(100);
  drag(r, 11, 'touch', 300, 500, 0, -60);
  assert.ok(Math.abs(host.cam.y - 60) < 1e-9, 'after the palm lifts, one finger pans again');
});

test('touch right after pen-up (within grace) is treated as palm', () => {
  const { host, r } = setup();
  drag(r, 1, 'pen', 100, 100, 30, 0);
  tick(50);
  drag(r, 2, 'touch', 300, 300, 0, 100);
  assert.deepEqual(host.cam, { x: 0, y: 0, zoom: 1 });
  tick(PEN_GRACE_MS);
  drag(r, 3, 'touch', 300, 300, 0, 100);
  assert.ok(Math.abs(host.cam.y + 100) < 1e-9, `after the grace period fingers pan (y=${host.cam.y})`);
});

test('touch pan does not trigger undo; two-finger tap does; three-finger tap redoes', () => {
  const { host, r } = setup();
  drag(r, 1, 'touch', 100, 100, 0, 50);
  assert.ok(!host.log.includes('undo'));
  tick(500);
  r.down(ptr(2, 'touch', 100, 100));
  r.down(ptr(3, 'touch', 180, 100));
  tick(80);
  r.up(ptr(2, 'touch', 100, 100));
  r.up(ptr(3, 'touch', 180, 100));
  assert.equal(host.log.filter((l) => l === 'undo').length, 1);
  tick(500);
  r.down(ptr(4, 'touch', 100, 100));
  r.down(ptr(5, 'touch', 160, 100));
  r.down(ptr(6, 'touch', 220, 100));
  tick(80);
  for (const id of [4, 5, 6]) r.up(ptr(id, 'touch', 100, 100));
  assert.equal(host.log.filter((l) => l === 'redo').length, 1);
  // taps disabled
  r.setOptions({ tapGestures: false });
  tick(500);
  r.down(ptr(7, 'touch', 100, 100));
  r.down(ptr(8, 'touch', 180, 100));
  tick(80);
  r.up(ptr(7, 'touch', 100, 100));
  r.up(ptr(8, 'touch', 180, 100));
  assert.equal(host.log.filter((l) => l === 'undo').length, 1);
});

test('one finger to two and back re-anchors without jumps', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'touch', 300, 300));
  for (let i = 1; i <= 5; i++) {
    tick(8);
    r.move(ptr(1, 'touch', 300, 300 - i * 10));
  }
  const afterPan = { ...host.cam };
  r.down(ptr(2, 'touch', 400, 250));
  tick(8);
  r.move(ptr(2, 'touch', 400, 250)); // no movement: camera must not jump
  assert.deepEqual(host.cam, afterPan);
  r.up(ptr(2, 'touch', 400, 250));
  tick(8);
  r.move(ptr(1, 'touch', 300, 250)); // same position: no jump after re-anchoring
  assert.deepEqual(host.cam, afterPan);
  tick(8);
  r.move(ptr(1, 'touch', 300, 230));
  assert.ok(Math.abs(host.cam.y - (afterPan.y + 20)) < 1e-9);
});

test('pointercancel: pen ink is committed, tentative finger ink is discarded, state recovers', () => {
  const { host, r } = setup({ fingerDrawing: true });
  r.down(ptr(1, 'pen', 10, 10));
  tick(30);
  r.move(ptr(1, 'pen', 20, 10));
  r.cancel(ptr(1, 'pen', 20, 10));
  assert.equal(host.committed, 1, 'Pencil ink survives a system cancel');
  assert.equal(r.state, 'Idle');
  tick(PEN_GRACE_MS + 10);
  r.down(ptr(2, 'touch', 50, 50));
  tick(40);
  r.cancel(ptr(2, 'touch', 55, 50));
  assert.equal(host.discarded, 1);
  assert.equal(r.contactCount, 0);
});

test('lost pointer capture leaves no stale state', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 10, 10));
  r.lostCapture(1, clock + 5);
  assert.equal(host.committed, 1);
  assert.equal(r.state, 'Idle');
  tick(PEN_GRACE_MS + 10);
  r.down(ptr(2, 'touch', 10, 10));
  r.lostCapture(2, clock + 5);
  assert.equal(r.contactCount, 0);
  drag(r, 3, 'touch', 100, 100, 0, 40);
  assert.ok(Math.abs(host.cam.y + 40) < 1e-9, 'navigation works after a lost capture');
});

test('reset() (app hidden) commits ink and clears contacts so a lost palm cannot block navigation', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 10, 10));
  r.down(ptr(9, 'touch', 300, 300));
  r.reset();
  assert.equal(host.committed, 1);
  assert.equal(r.contactCount, 0);
  tick(PEN_GRACE_MS + 10);
  drag(r, 3, 'touch', 100, 100, 0, 40);
  assert.ok(Math.abs(host.cam.y + 40) < 1e-9, `y=${host.cam.y}`);
});

test('stale contacts (no events for a long time) are dropped', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 10, 10));
  r.down(ptr(9, 'touch', 300, 300)); // palm whose pointerup is never delivered
  r.up(ptr(1, 'pen', 10, 10));
  tick(10_000);
  drag(r, 3, 'touch', 100, 100, 0, 40);
  assert.ok(Math.abs(host.cam.y + 40) < 1e-9, `y=${host.cam.y}`);
});

test('pen eraser button erases; eraser tool erases with the pen', () => {
  const { host, r } = setup();
  drag(r, 1, 'pen', 10, 10, 30, 0);
  assert.equal(host.committed, 1);
  r.down(ptr(2, 'pen', 10, 10, { buttons: 33 }));
  r.move(ptr(2, 'pen', 20, 10, { buttons: 33 }));
  r.up(ptr(2, 'pen', 20, 10, { buttons: 0 }));
  assert.ok(host.log.includes('eraseBegin') && host.log.includes('eraseEnd'));
  assert.equal(host.erased, 1);
});

test('read-only document: pen does not draw', () => {
  const { host, r } = setup();
  host.readOnly = true;
  drag(r, 1, 'pen', 10, 10, 30, 0);
  assert.equal(host.committed, 0);
});

test('a new Pencil contact ends a stroke whose pointerup was lost (no frozen editor)', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 10, 10)); // its pointerup never arrives
  r.down(ptr(2, 'pen', 50, 50));
  assert.equal(host.committed, 1, 'lost stroke committed, not dropped');
  assert.equal(r.state, 'PenDrawing');
  r.up(ptr(2, 'pen', 50, 50));
  r.up(ptr(1, 'pen', 12, 10)); // a late event for the old pointer is ignored
  assert.equal(host.committed, 2);
  assert.equal(r.state, 'Idle');
});

test('a silent pen (lost pointerup) does not block finger navigation forever', () => {
  const { host, r } = setup();
  r.down(ptr(1, 'pen', 10, 10));
  tick(200);
  r.down(ptr(5, 'touch', 300, 300));
  assert.equal(r.ownerOf(5), 'palm', 'palm while the pen is really drawing');
  r.up(ptr(5, 'touch', 300, 300));
  tick(5000);
  assert.equal(r.down(ptr(6, 'touch', 300, 300)), 'nav', 'stale pen released, finger navigates');
  assert.equal(host.committed, 1);
});

test('finger stroke yields to the Pencil (finger drawing ON)', () => {
  const { host, r } = setup({ fingerDrawing: true });
  r.down(ptr(1, 'touch', 10, 10));
  tick(50);
  r.down(ptr(2, 'pen', 100, 100));
  assert.equal(host.discarded, 1, 'tentative finger stroke discarded');
  assert.equal(r.state, 'PenDrawing');
  r.up(ptr(2, 'pen', 110, 100));
  assert.equal(host.committed, 1);
});

// ---------------------------------------------------------------------------------------------
// 11.2 Desktop input
// ---------------------------------------------------------------------------------------------

test('mouse left drag draws and never creates touch gesture state', () => {
  const { host, r } = setup();
  drag(r, 1, 'mouse', 100, 100, 50, 20);
  assert.equal(host.committed, 1);
  assert.ok(!host.log.includes('navStart'));
});

test('Space + left drag pans; middle drag pans; neither draws', () => {
  const { host, r } = setup();
  r.setSpace(true);
  drag(r, 1, 'mouse', 100, 100, -40, -60);
  r.setSpace(false);
  assert.equal(host.committed, 0);
  assert.ok(Math.abs(host.cam.x - 40) < 1e-9 && Math.abs(host.cam.y - 60) < 1e-9, JSON.stringify(host.cam));
  r.down(ptr(2, 'mouse', 100, 100, { button: 1, buttons: 4 }));
  r.move(ptr(2, 'mouse', 100, 50, { button: -1, buttons: 4 }));
  r.up(ptr(2, 'mouse', 100, 50, { button: 1, buttons: 0 }));
  assert.ok(Math.abs(host.cam.y - 110) < 1e-9);
  assert.equal(host.committed, 0);
  assert.equal(r.state, 'Idle');
});

test('pen tablet: Space + pen drag pans instead of drawing; pen middle button pans', () => {
  const { host, r } = setup();
  r.setSpace(true);
  assert.equal(r.down(ptr(1, 'pen', 100, 100)), 'mouse-pan');
  assert.equal(r.ownerOf(1), 'mouse-pan');
  assert.equal(r.state, 'MousePanning');
  for (let i = 1; i <= 10; i++) {
    tick(8);
    r.move(ptr(1, 'pen', 100 - 4 * i, 100 - 6 * i));
  }
  r.up(ptr(1, 'pen', 60, 40, { buttons: 0 }));
  r.setSpace(false);
  assert.equal(host.committed, 0);
  assert.ok(Math.abs(host.cam.x - 40) < 1e-9 && Math.abs(host.cam.y - 60) < 1e-9, JSON.stringify(host.cam));
  assert.equal(r.state, 'Idle');
  assert.equal(r.ownerOf(1), undefined);
  // a side button mapped to the middle button
  r.down(ptr(2, 'pen', 100, 100, { button: 1, buttons: 4 }));
  r.move(ptr(2, 'pen', 100, 50, { button: -1, buttons: 4 }));
  r.up(ptr(2, 'pen', 100, 50, { button: 1, buttons: 0 }));
  assert.ok(Math.abs(host.cam.y - 110) < 1e-9);
  assert.equal(host.committed, 0);
  // Space released: the pen draws again
  drag(r, 3, 'pen', 0, 0, 40, 40);
  assert.equal(host.committed, 1);
});

test('right mouse button is not consumed', () => {
  const { r } = setup();
  assert.equal(r.down(ptr(1, 'mouse', 10, 10, { button: 2, buttons: 2 })), null);
});

test('Windows pen draws with pressure like the Pencil', () => {
  const { host, r } = setup();
  drag(r, 1, 'pen', 0, 0, 40, 40);
  assert.equal(host.committed, 1);
  assert.equal(host.log[0], 'inkBegin:pen');
});
