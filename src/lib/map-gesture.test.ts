import { test } from 'node:test';
import assert from 'node:assert/strict';
import {clampZoom, pinchView, wheelZoomFactor, zoomAboutPoint} from './map-gesture';
import type {MapView} from './map-gesture';

test('clampZoom keeps the map within its operating range', () => {
  assert.equal(clampZoom(0.1), 0.9);
  assert.equal(clampZoom(999), 64);
  assert.equal(clampZoom(4), 4);
});

test('zoomAboutPoint keeps the world point under the anchor fixed', () => {
  const view: MapView = {zoom: 2, x: 30, y: -20};
  const anchor = {x: 200, y: 300};
  const next = zoomAboutPoint(view, 4, anchor.x, anchor.y);
  // The screen position of the anchored world point is invariant to the zoom.
  const worldX = (anchor.x - 420 - view.x) / view.zoom + 420;
  const screenX = (worldX - 420) * next.zoom + 420 + next.x;
  assert.ok(Math.abs(screenX - anchor.x) < 1e-9);
  assert.equal(next.zoom, 4);
});

test('pinchView anchors on the start midpoint then follows the fingers', () => {
  const view: MapView = {zoom: 1, x: 0, y: 0};
  const direct = zoomAboutPoint(view, 2, 100, 120);
  const moved = pinchView(view, 2, {x: 100, y: 120}, {x: 130, y: 150});
  assert.ok(Math.abs(moved.x - (direct.x + 30)) < 1e-9);
  assert.ok(Math.abs(moved.y - (direct.y + 30)) < 1e-9);
});

test('pinchView clamps the resulting zoom', () => {
  const view: MapView = {zoom: 50, x: 0, y: 0};
  assert.equal(pinchView(view, 500, {x: 0, y: 0}, {x: 0, y: 0}).zoom, 64);
});

test('wheelZoomFactor is symmetric around zero delta', () => {
  assert.ok(Math.abs(wheelZoomFactor(0) - 1) < 1e-9);
  assert.ok(wheelZoomFactor(100) < 1 && wheelZoomFactor(-100) > 1);
});
