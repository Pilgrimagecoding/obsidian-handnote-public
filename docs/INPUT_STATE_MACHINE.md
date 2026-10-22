# Input state machine (v0.2)

## 1. Root cause of the v0.1 touch bug (diagnosed 2026-10-18 from source)

**Symptom (iPad, user report):** with *Finger drawing = OFF* the Pencil works but fingers cannot pan
or zoom; with *Finger drawing = ON* fingers draw and page drags are taken as strokes.

**Code (v0.1 `src/editor/handnote-editor.ts`, `onPointerDown`):**

```ts
if (this.isDrawPointer(e)) { … beginStroke … return; }      // (1) drawing decided first
if (e.pointerType === 'touch') {
  const big = (e.width || 0) > 46 || (e.height || 0) > 46;  // (2) "palm" by contact size
  if (this.active || this.erase || performance.now() - this.lastPenUp < 250 || big) {
    this.ignoredPointers.add(e.pointerId);                  // (3) whole contact dropped
    return;
  }
  … start pan / pinch …
}
```

**Root cause — contact-size palm heuristic (2):** WebKit on iOS builds a touch `PointerEvent` with
`width = 2 × radiusX` and `height = 2 × radiusY`, where the radius is `UITouch.majorRadius`
(verified in WebKit source: `Source/WebCore/dom/ios/PointerEventIOS.cpp`,
`m_width(2 * event.radiusXAtIndex(index))`; `WKTouchEventsGestureRecognizer.mm` copies
`touch.majorRadius`). A normal fingertip therefore reports a "width" that regularly exceeds the
46 px threshold, so **ordinary finger contacts were classified as palms** and added to
`ignoredPointers`. Every later `pointermove` of that contact was ignored → no pan, no pinch, no
two-finger tap. The heuristic was never exercised by the automated tests, which dispatched touches
with `width`/`height` of 1–10 px.

**Contributing cause — order-dependent routing (1):** the drawing decision ran *before* any gesture
classification. With Finger drawing ON, the first finger always became ink immediately; a second
finger arriving later than 180 ms was then rejected as a palm (because `this.active` was set), so a
one-finger drag drew and pinch was effectively impossible.

**Why the Pencil was unaffected:** `pointerType === 'pen'` takes branch (1) and never reaches the
size check.

The exact `width` values your iPad reports are not known; v0.2 records them in the input
diagnostics (`Copy input diagnostics`) so the next test confirms the diagnosis with device data.

## 2. Fix

`src/input/input-router.ts` replaces the ad-hoc booleans with a single router that owns every
active pointer. Contact size is **no longer used to reject touches**. Palms are identified by
context instead (pen active / pen just lifted / another palm contact still down).

## 3. Model

Each pointer that goes down gets exactly one **owner** for its whole lifetime:

| Owner | Meaning |
|---|---|
| `ink` | draws a stroke (pen, mouse-left, or finger when finger drawing is on) |
| `erase` | whole-stroke eraser (eraser tool, or pen eraser button) |
| `nav` | finger used for navigation (pan / pinch / taps) |
| `palm` | ignored for its whole lifetime |
| `mouse-pan` | middle button or Space + left drag |

Router state (derived from the owners): `Idle`, `PenDrawing`, `MouseDrawing`, `TouchDrawing`,
`TouchPending`, `TouchPanning`, `TouchPinching`, `MousePanning`. Palm contacts can coexist with
`PenDrawing`.

### Rules

| Event | Condition | Result |
|---|---|---|
| pen down | no other ink | `ink`/`erase`; all current `nav` touches become `palm`; a pan that started < 500 ms ago is reverted (palm landed first) |
| pen down | another ink stroke active | ignored |
| touch down | pen active, or pen lifted < 300 ms ago, or another `palm` still down | `palm` |
| touch down | finger drawing ON, no other contacts | `ink` (tentative for 200 ms) |
| touch down | finger drawing ON, touch-ink active & tentative | abort that stroke (not saved), both fingers → `nav` (pinch) |
| touch down | finger drawing ON, touch-ink active & older | commit the stroke, both fingers → `nav` |
| touch down | otherwise | `nav` (`TouchPending` until it moves 7 px → `TouchPanning`; 2 contacts → `TouchPinching`) |
| mouse left down | Space held | `mouse-pan` |
| mouse left down | otherwise | `ink`/`erase` |
| mouse middle down | — | `mouse-pan` |
| pointerup | `ink` | commit stroke |
| pointercancel | pen/mouse `ink` | commit real samples (never lose Pencil ink); predicted points are never stored |
| pointercancel | tentative touch `ink` | abort (not saved) |
| lostpointercapture | owner still active | treated like pointercancel |
| 2 / 3 finger tap | all `nav`, no movement, < 320 ms, not after a pan | undo / redo |
| app hidden / blur / view reset | — | commit ink, clear every touch contact (prevents stale "palm" contacts from blocking navigation) |

One event is consumed by exactly one owner, so a pointer can never both draw and move the page.

### Navigation geometry

* **Pan:** `camera = startCamera − (finger − fingerStart) / zoom`, clamped by `constrainCamera`
  (vertical scrolling through all pages is always possible; horizontal pan when zoomed in).
* **Pinch:** zoom about the starting midpoint, then follow the midpoint (pan while pinching).
* Changing the number of fingers re-anchors the gesture from the current camera (no jumps).
* Inertia after a one-finger fling.

## 4. Desktop (Mouse-first)

Left drag draws · Space + left drag pans · middle drag pans · wheel scrolls (Shift = horizontal)
· Ctrl/Cmd + wheel zooms (trackpad pinch arrives as Ctrl+wheel in Chromium/Electron) · Windows pen
draws with pressure · keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo, 1–4 tools, E eraser,
PageUp/PageDown pages, Ctrl/Cmd + 0 fit width, Ctrl/Cmd + = / − zoom.

## 5. WebKit limits (stated honestly)

* WebKit exposes no "palm" flag, no `UITouch.estimatedProperties` updates, and no Pencil
  double-tap / squeeze to web content.
* `width`/`height` exist but are derived from a coarse `majorRadius`; they are recorded for
  diagnostics only.
* iPadOS system edge gestures (Control Center, Home) cannot be intercepted; strokes starting at the
  very edge may be taken by the system and arrive as `pointercancel` (ink is still committed).
