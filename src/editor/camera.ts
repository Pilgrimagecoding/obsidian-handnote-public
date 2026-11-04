/** Camera: screen = (world - (x, y)) * zoom, screen origin at the viewport's top-left corner. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.25;
/** 0.12: up to 2400 % (GoodNotes-like close-ups); ink is vector and re-rendered at the zoom. */
export const MAX_ZOOM = 24;
/** Whiteboards zoom out further to see everything at once (0.11). */
export const BOARD_MIN_ZOOM = 0.1;
/** Whiteboard coordinates stay within ±BOARD_LIMIT units (same limit as the file format). */
export const BOARD_CAMERA_LIMIT = 1e6;

export function clampZoom(z: number, min = MIN_ZOOM): number {
  return Math.min(MAX_ZOOM, Math.max(min, z));
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

/** Zoom to `zoom` keeping the world point under screen point (sx, sy) fixed. */
export function zoomAt(cam: Camera, zoom: number, sx: number, sy: number, min = MIN_ZOOM): Camera {
  const z = clampZoom(zoom, min);
  const w = screenToWorld(cam, sx, sy);
  return { x: w.x - sx / z, y: w.y - sy / z, zoom: z };
}

/**
 * Keep the document reachable: at least `margin` screen px of the document must stay visible
 * horizontally, and vertical scrolling stops a little past the first/last page.
 */
export function constrainCamera(
  cam: Camera,
  view: { w: number; h: number },
  doc: { minX: number; maxX: number; height: number },
): Camera {
  const z = clampZoom(cam.zoom);
  const docW = (doc.maxX - doc.minX) * z;
  let x = cam.x;
  if (docW <= view.w) {
    // center horizontally when the document is narrower than the view
    x = doc.minX - (view.w / z - (doc.maxX - doc.minX)) / 2;
  } else {
    const minX = doc.minX - 40 / z;
    const maxX = doc.maxX - view.w / z + 40 / z;
    x = Math.min(maxX, Math.max(minX, x));
  }
  const minY = -view.h / z * 0.5;
  const maxY = doc.height - view.h / z * 0.5;
  const y = Math.min(maxY, Math.max(minY, cam.y));
  return { x, y, zoom: z };
}

/** CSS transform that maps a bitmap rendered at camera `from` so it appears as seen from `to`. */
export function previewTransform(from: Camera, to: Camera): { k: number; tx: number; ty: number } {
  const k = to.zoom / from.zoom;
  return { k, tx: (from.x - to.x) * to.zoom, ty: (from.y - to.y) * to.zoom };
}

/** A whiteboard has no edges: only the zoom range and the coordinate limit apply. */
export function constrainBoardCamera(cam: Camera): Camera {
  const z = clampZoom(cam.zoom, BOARD_MIN_ZOOM);
  const L = BOARD_CAMERA_LIMIT;
  return { x: Math.min(L, Math.max(-L, cam.x)), y: Math.min(L, Math.max(-L, cam.y)), zoom: z };
}
