// 0.12 rendering: zoom range (up to 2400 %).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_MIN_ZOOM, MAX_ZOOM, MIN_ZOOM, clampZoom, screenToWorld, zoomAt } from '../../src/editor/camera';

test('zoom: up to 24× (pages and whiteboards), down to 25 % (pages) / 10 % (whiteboards)', () => {
  assert.equal(MAX_ZOOM, 24);
  assert.equal(clampZoom(30), 24);
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(0.01, BOARD_MIN_ZOOM), BOARD_MIN_ZOOM);
  // zooming in to the limit keeps the point under the fingers fixed
  const cam = { x: 100, y: 200, zoom: 2 };
  const before = screenToWorld(cam, 300, 400);
  const z = zoomAt(cam, 100, 300, 400);
  assert.equal(z.zoom, 24);
  const after = screenToWorld(z, 300, 400);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
});
