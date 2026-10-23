import { clampZoom, zoomAt, type Camera } from '../editor/camera';

/**
 * InputRouter: decides, for every pointer, what it is allowed to do — draw, erase, navigate, or
 * nothing (palm) — and drives the camera for navigation. It has no DOM or Obsidian dependency so it
 * can be tested exhaustively in Node (tests/unit/input-router.test.ts).
 *
 * See docs/INPUT_STATE_MACHINE.md for the rules and the v0.1 root cause this replaces.
 */

export type PointerKind = 'pen' | 'touch' | 'mouse';

/** Normalized pointer event (viewport-local CSS px, ms timestamps). */
export interface RouterPointer {
  id: number;
  kind: PointerKind;
  x: number;
  y: number;
  t: number;
  button: number;
  buttons: number;
  pressure: number;
  width: number;
  height: number;
}

export type Owner = 'ink' | 'erase' | 'nav' | 'palm' | 'mouse-pan';

export type RouterState =
  | 'Idle'
  | 'PenDrawing'
  | 'MouseDrawing'
  | 'TouchDrawing'
  | 'TouchPending'
  | 'TouchPanning'
  | 'TouchPinching'
  | 'MousePanning';

export interface RouterOptions {
  fingerDrawing: boolean;
  tapGestures: boolean;
}

/** What the router asks the editor to do. */
export interface RouterHost {
  getCamera(): Camera;
  /** Apply a camera; the host clamps it and returns what was applied. */
  setCamera(c: Camera): Camera;
  /** Tool for a draw pointer: 'ink' or 'erase' (eraser tool / pen eraser button). */
  drawKindFor(p: RouterPointer): 'ink' | 'erase';
  /** False when the document is read-only or the point is not on/near a page. */
  canDrawAt(p: RouterPointer): boolean;
  inkBegin(p: RouterPointer): void;
  inkMove(p: RouterPointer, raw: Event | null): void;
  /** commit=true stores the stroke; commit=false discards it (tentative finger stroke). */
  inkEnd(p: RouterPointer | null, commit: boolean): void;
  eraseBegin(p: RouterPointer): void;
  eraseMove(p: RouterPointer, raw: Event | null): void;
  eraseEnd(): void;
  navStart(): void;
  navEnd(velocity: { vx: number; vy: number } | null): void;
  undo(): void;
  redo(): void;
  /** Diagnostics hook (optional). */
  classified?(p: RouterPointer, owner: Owner, reason: string): void;
  /** A quick one-finger tap that did not move (object tools select / create with it). */
  tap?(p: RouterPointer): void;
  /**
   * One finger held still on the page for LONG_PRESS_MS (finger navigation only): the host opens
   * its context menu there. The finger is consumed — it no longer pans, and lifting it is no tap.
   */
  longPress?(p: RouterPointer): void;
}

interface Contact {
  p: RouterPointer;
  owner: Owner;
  downAt: number;
  lastAt: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface NavAnchor {
  cam: Camera;
  midX: number;
  midY: number;
  dist: number;
  count: number;
}

export const TOUCH_SLOP = 7;
export const PEN_GRACE_MS = 300;
export const TENTATIVE_MS = 200;
export const PAN_REVERT_MS = 500;
export const TAP_MAX_MS = 320;
/** A finger held still this long (and within TOUCH_SLOP) is a long press. */
export const LONG_PRESS_MS = 500;
export const STALE_CONTACT_MS = 6000;
/** A drawing pen that sent nothing for this long is treated as lifted (its pointerup was lost). */
export const STALE_PEN_MS = 4000;

export class InputRouter {
  private contacts = new Map<number, Contact>();
  private drawId: number | null = null; // pointer owning ink/erase
  private drawKind: 'ink' | 'erase' | null = null;
  private drawStartedAt = 0;
  private lastPenUpAt = -Infinity;
  private anchor: NavAnchor | null = null;
  private navStartCam: Camera | null = null;
  private navStartedAt = 0;
  private navMoved = false;
  private panned = false;
  private tap: { t0: number; max: number; moved: boolean } | null = null;
  private history: { t: number; x: number; y: number }[] = [];
  private spaceDown = false;
  private mousePan: { id: number; x: number; y: number; cam: Camera } | null = null;
  /** Counters for diagnostics. */
  readonly stats = { pen: 0, touchNav: 0, touchInk: 0, palm: 0, mouse: 0, cancels: 0, tentativeAborts: 0, lifted: 0 };

  constructor(
    private readonly host: RouterHost,
    private opts: RouterOptions,
  ) {}

  setOptions(o: Partial<RouterOptions>): void {
    this.opts = { ...this.opts, ...o };
  }

  setSpace(down: boolean): void {
    this.spaceDown = down;
  }

  get state(): RouterState {
    if (this.mousePan) return 'MousePanning';
    if (this.drawId !== null) {
      const c = this.contacts.get(this.drawId);
      if (c?.p.kind === 'pen') return 'PenDrawing';
      if (c?.p.kind === 'mouse') return 'MouseDrawing';
      return 'TouchDrawing';
    }
    const nav = this.navContacts();
    if (nav.length >= 2) return 'TouchPinching';
    if (nav.length === 1) return this.panned ? 'TouchPanning' : 'TouchPending';
    return 'Idle';
  }

  /**
   * The host's timer fired LONG_PRESS_MS after a finger went down: if that finger is still the only
   * contact, has not moved beyond TOUCH_SLOP and no pen / palm / second finger is involved, it
   * becomes a long press (returns true and calls host.longPress). The router itself has no timers,
   * so this stays deterministic in tests.
   */
  longPressCheck(id: number, t: number): boolean {
    const c = this.contacts.get(id);
    if (!c || c.owner !== 'nav' || c.p.kind !== 'touch' || c.moved) return false;
    if (this.contacts.size !== 1 || this.drawId !== null || this.mousePan) return false;
    if (t - c.downAt < LONG_PRESS_MS) return false;
    if (this.tap && (this.tap.max > 1 || this.tap.moved)) return false;
    // consume the finger: no pan, no tap when it lifts; the camera has not moved (below slop)
    c.owner = 'palm';
    this.tap = null;
    this.endNav(false);
    this.host.classified?.(c.p, 'palm', 'long-press');
    this.host.longPress?.({ ...c.p, t });
    return true;
  }

  ownerOf(id: number): Owner | undefined {
    return this.contacts.get(id)?.owner;
  }

  get contactCount(): number {
    return this.contacts.size;
  }

  // ---------------------------------------------------------------------------------------------

  down(p: RouterPointer): Owner | null {
    this.dropStale(p.t);
    if (this.contacts.has(p.id)) return this.contacts.get(p.id)!.owner; // duplicate down
    if (p.kind === 'pen') return this.penDown(p);
    if (p.kind === 'mouse') return this.mouseDown(p);
    return this.touchDown(p);
  }

  move(p: RouterPointer, raw: Event | null = null): void {
    if (this.mousePan && p.id === this.mousePan.id) {
      const m = this.mousePan;
      const z = m.cam.zoom;
      this.host.setCamera({ ...m.cam, x: m.cam.x - (p.x - m.x) / z, y: m.cam.y - (p.y - m.y) / z });
      return;
    }
    const c = this.contacts.get(p.id);
    if (!c) return;
    c.p = p;
    c.lastAt = p.t;
    if (!c.moved && Math.hypot(p.x - c.startX, p.y - c.startY) >= TOUCH_SLOP) c.moved = true;
    switch (c.owner) {
      case 'ink':
        this.host.inkMove(p, raw);
        return;
      case 'erase':
        this.host.eraseMove(p, raw);
        return;
      case 'nav':
        if (c.moved && this.tap) this.tap.moved = true;
        this.updateNav(p.t);
        return;
      default:
        return; // palm / unknown: consumed, no effect
    }
  }

  up(p: RouterPointer): void {
    this.finish(p, false);
  }

  cancel(p: RouterPointer): void {
    this.stats.cancels++;
    this.finish(p, true);
  }

  /** lostpointercapture: if the pointer is still owned, end it like a cancel. */
  lostCapture(id: number, t: number): void {
    const c = this.contacts.get(id);
    if (c) this.finish({ ...c.p, t }, true);
    else if (this.mousePan?.id === id) this.mousePan = null;
  }

  /**
   * Nothing touches the screen any more (a touchend / touchcancel with no touches left), yet
   * contacts are still open: their pointerup / pointercancel never came (iOS drops them when the
   * keyboard opens, an element under the finger goes away, a system gesture starts…). Left open,
   * they made the page ignore input until it was scrolled. Only FINGER contacts that have been
   * silent for a while are ended (without a tap). Never the pen: iPadOS sends touchcancel for the
   * Pencil's touches while its pointer events go on (0.7.0-beta.7 ended every stroke there — the
   * strokes were cut after a few samples); a pen that really went silent is handled by
   * dropStalePen. Returns how many were lifted.
   */
  liftAll(t: number, silentMs = 250): number {
    let n = 0;
    for (const c of [...this.contacts.values()]) {
      if (c.p.kind !== 'touch' || t - c.lastAt < silentMs || c.p.id === this.drawId) continue;
      this.finish({ ...c.p, t }, true);
      n++;
    }
    if (n) this.stats.lifted += n;
    return n;
  }

  /** App hidden, view unloaded, orientation change: commit ink, forget every contact. */
  reset(): void {
    if (this.drawId !== null) this.endDraw(null, true);
    if (this.navContacts().length) this.host.navEnd(null);
    this.contacts.clear();
    this.anchor = null;
    this.tap = null;
    this.mousePan = null;
    this.panned = false;
    this.spaceDown = false;
  }

  // ---------------------------------------------------------------------------------------------

  private register(p: RouterPointer, owner: Owner, reason: string): Owner {
    this.contacts.set(p.id, { p, owner, downAt: p.t, lastAt: p.t, startX: p.x, startY: p.y, moved: false });
    this.host.classified?.(p, owner, reason);
    return owner;
  }

  private penDown(p: RouterPointer): Owner | null {
    if (this.drawId !== null) {
      const cur = this.contacts.get(this.drawId);
      // A finger stroke in progress yields to the Pencil (finger drawing ON + Pencil).
      if (cur && cur.p.kind === 'touch') {
        this.endDraw(null, p.t - this.drawStartedAt > TENTATIVE_MS);
        cur.owner = 'palm';
      } else if (!cur || cur.p.kind === 'pen') {
        // There is only one Pencil: a new pen contact means the previous one has lifted and its
        // pointerup / pointercancel never arrived. Without this the router stayed in PenDrawing
        // forever — every later Pencil stroke became a "second pointer" and every finger a palm,
        // i.e. the editor looked frozen.
        this.endDraw(null, true);
        if (cur) this.contacts.delete(cur.p.id);
      } else {
        return this.register(p, 'palm', 'second-draw-pointer');
      }
    }
    // Palm landed before the pen: every navigating finger becomes a palm, and a pan that just
    // started is reverted so the page does not slide under the hand.
    const nav = this.navContacts();
    if (nav.length) {
      if (this.navStartCam && this.panned && p.t - this.navStartedAt < PAN_REVERT_MS) this.host.setCamera(this.navStartCam);
      for (const c of nav) c.owner = 'palm';
      this.endNav(false);
    }
    if (!this.host.canDrawAt(p)) return this.register(p, 'palm', 'not-drawable');
    this.stats.pen++;
    return this.beginDraw(p, 'pen');
  }

  private mouseDown(p: RouterPointer): Owner | null {
    this.stats.mouse++;
    if (p.button === 1 || (p.button === 0 && this.spaceDown)) {
      this.mousePan = { id: p.id, x: p.x, y: p.y, cam: this.host.getCamera() };
      this.host.navStart();
      this.host.classified?.(p, 'mouse-pan', p.button === 1 ? 'middle-button' : 'space-drag');
      return 'mouse-pan';
    }
    if (p.button !== 0) return null; // right button etc.: not handled
    if (this.drawId !== null || !this.host.canDrawAt(p)) return null;
    return this.beginDraw(p, 'mouse');
  }

  private touchDown(p: RouterPointer): Owner {
    this.dropStalePen(p.t);
    const penActive = this.drawId !== null && this.contacts.get(this.drawId)?.p.kind === 'pen';
    if (penActive) return this.palm(p, 'pen-active');
    if (p.t - this.lastPenUpAt < PEN_GRACE_MS) return this.palm(p, 'pen-just-lifted');
    if (this.hasPalm()) return this.palm(p, 'palm-cluster');

    // Finger drawing: second finger turns a young finger stroke into a pinch.
    const draw = this.drawId !== null ? this.contacts.get(this.drawId) : undefined;
    if (draw && draw.p.kind === 'touch') {
      const tentative = p.t - this.drawStartedAt <= TENTATIVE_MS;
      if (tentative) this.stats.tentativeAborts++;
      this.endDraw(null, !tentative);
      draw.owner = 'nav';
      this.register(p, 'nav', tentative ? 'second-finger-abort-stroke' : 'second-finger-after-stroke');
      this.stats.touchNav++;
      this.beginNavGesture(p.t);
      return 'nav';
    }
    if (draw) return this.palm(p, 'mouse-drawing'); // mouse drawing + touch: ignore touch

    if (this.opts.fingerDrawing && this.navContacts().length === 0 && this.host.canDrawAt(p)) {
      this.stats.touchInk++;
      return this.beginDraw(p, 'touch');
    }
    this.stats.touchNav++;
    this.register(p, 'nav', 'finger-navigation');
    this.beginNavGesture(p.t);
    return 'nav';
  }

  private palm(p: RouterPointer, reason: string): Owner {
    this.stats.palm++;
    return this.register(p, 'palm', reason);
  }

  private beginDraw(p: RouterPointer, _src: PointerKind): Owner {
    const kind = this.host.drawKindFor(p);
    this.register(p, kind, `${p.kind}-draw`);
    this.drawId = p.id;
    this.drawKind = kind;
    this.drawStartedAt = p.t;
    if (kind === 'erase') this.host.eraseBegin(p);
    else this.host.inkBegin(p);
    return kind;
  }

  private endDraw(p: RouterPointer | null, commit: boolean): void {
    const id = this.drawId;
    if (id === null) return;
    const c = this.contacts.get(id);
    this.drawId = null;
    if (this.drawKind === 'erase') this.host.eraseEnd();
    else this.host.inkEnd(p, commit);
    this.drawKind = null;
    if (c?.p.kind === 'pen') this.lastPenUpAt = p?.t ?? c.lastAt;
  }

  private finish(p: RouterPointer, cancelled: boolean): void {
    if (this.mousePan && p.id === this.mousePan.id) {
      this.mousePan = null;
      this.host.navEnd(null);
      return;
    }
    const c = this.contacts.get(p.id);
    if (!c) return;
    if (c.owner === 'ink' || c.owner === 'erase') {
      if (this.drawId === p.id) {
        // Pen / mouse ink is always committed, even on cancel (system gesture, app switch).
        // A cancelled finger stroke that is still tentative is discarded.
        const tentativeTouch = c.p.kind === 'touch' && cancelled && p.t - this.drawStartedAt <= TENTATIVE_MS;
        if (tentativeTouch) this.stats.tentativeAborts++;
        this.endDraw(cancelled ? null : p, !tentativeTouch);
      }
      this.contacts.delete(p.id);
      return;
    }
    if (c.owner === 'nav') {
      const wasMoved = c.moved;
      this.contacts.delete(p.id);
      const remaining = this.navContacts();
      if (remaining.length === 0) {
        const tap = this.tap;
        const velocity = this.panned && !cancelled ? this.velocity(p.t) : null;
        this.endNav(true, velocity);
        if (tap && !tap.moved && !wasMoved && !cancelled && p.t - tap.t0 <= TAP_MAX_MS) {
          if (tap.max === 1) this.host.tap?.(p);
          else if (this.opts.tapGestures && tap.max === 2) this.host.undo();
          else if (this.opts.tapGestures && tap.max === 3) this.host.redo();
        }
        this.tap = null;
      } else {
        this.anchor = this.makeAnchor(); // re-anchor with the remaining finger(s)
      }
      return;
    }
    this.contacts.delete(p.id); // palm
  }

  // ---------------------------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------------------------

  private navContacts(): Contact[] {
    const out: Contact[] = [];
    for (const c of this.contacts.values()) if (c.owner === 'nav') out.push(c);
    return out;
  }

  private hasPalm(): boolean {
    for (const c of this.contacts.values()) if (c.owner === 'palm') return true;
    return false;
  }

  private beginNavGesture(t: number): void {
    const n = this.navContacts().length;
    if (n === 1 || !this.navStartCam) {
      this.navStartCam = this.host.getCamera();
      this.navStartedAt = t;
      this.navMoved = false;
      this.panned = false;
      this.history = [];
      this.host.navStart();
    }
    if (!this.tap) this.tap = { t0: t, max: n, moved: false };
    else this.tap.max = Math.max(this.tap.max, n);
    this.anchor = this.makeAnchor();
  }

  private makeAnchor(): NavAnchor | null {
    const nav = this.navContacts();
    if (!nav.length) return null;
    const a = nav[0].p;
    const b = nav.length > 1 ? nav[1].p : null;
    return {
      cam: this.host.getCamera(),
      midX: b ? (a.x + b.x) / 2 : a.x,
      midY: b ? (a.y + b.y) / 2 : a.y,
      dist: b ? Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) : 0,
      count: nav.length,
    };
  }

  private updateNav(t: number): void {
    const nav = this.navContacts();
    const an = this.anchor;
    if (!an || !nav.length) return;
    if (nav.length !== an.count) {
      this.anchor = this.makeAnchor();
      return;
    }
    if (!nav.some((c) => c.moved)) return; // below slop: no jitter on a resting finger
    this.navMoved = true;
    if (nav.length === 1) {
      const p = nav[0].p;
      const z = an.cam.zoom;
      this.panned = true;
      this.host.setCamera({ ...an.cam, x: an.cam.x - (p.x - an.midX) / z, y: an.cam.y - (p.y - an.midY) / z });
      this.history.push({ t, x: p.x, y: p.y });
      while (this.history.length > 2 && t - this.history[0].t > 90) this.history.shift();
    } else {
      const a = nav[0].p;
      const b = nav[1].p;
      const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const zoom = clampZoom(an.cam.zoom * (dist / an.dist));
      const z = zoomAt(an.cam, zoom, an.midX, an.midY);
      this.panned = true;
      this.history = [];
      this.host.setCamera({ ...z, x: z.x - (midX - an.midX) / z.zoom, y: z.y - (midY - an.midY) / z.zoom });
    }
  }

  private endNav(notify: boolean, velocity: { vx: number; vy: number } | null = null): void {
    const had = this.navStartCam !== null;
    this.anchor = null;
    this.navStartCam = null;
    this.panned = false;
    this.history = [];
    if (had && notify) this.host.navEnd(this.navMoved ? velocity : null);
    else if (had) this.host.navEnd(null);
    this.navMoved = false;
  }

  private velocity(t: number): { vx: number; vy: number } | null {
    const h = this.history;
    if (h.length < 2) return null;
    const a = h[0];
    const b = h[h.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0 || t - b.t > 60) return null;
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  /** End a pen stroke whose pointer went silent (lost pointerup) so touch navigation recovers. */
  private dropStalePen(t: number): void {
    if (this.drawId === null) return;
    const c = this.contacts.get(this.drawId);
    if (!c) {
      this.endDraw(null, true);
      return;
    }
    if (c.p.kind === 'pen' && t - c.lastAt > STALE_PEN_MS) {
      this.endDraw(null, true);
      this.contacts.delete(c.p.id);
    }
  }

  /** Forget contacts that have produced no event for a long time (lost pointerup). */
  private dropStale(t: number): void {
    for (const [id, c] of this.contacts) {
      if (id === this.drawId) continue;
      if (t - c.lastAt > STALE_CONTACT_MS) this.contacts.delete(id);
    }
  }
}
