/**
 * Pure view-transform helpers for the map. Keeping the zoom maths in one place
 * lets the mouse wheel, the +/- buttons and the two-finger pinch share the same
 * behaviour and stay unit-testable without a DOM.
 */
export const MAP_VIEWBOX = { width: 840, height: 550, cx: 420, cy: 275 } as const;
export const MIN_ZOOM = 0.9;
export const MAX_ZOOM = 64;

export interface MapView { zoom: number; x: number; y: number }

export const clampZoom = (zoom: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

/**
 * Zoom to `nextZoom` while keeping the world point currently under the SVG
 * coordinate (sx, sy) pinned in place. This is the anchor shared by the wheel
 * and pinch gestures.
 */
export function zoomAboutPoint(view: MapView, nextZoom: number, sx: number, sy: number): MapView {
  const zoom = clampZoom(nextZoom), ratio = zoom / view.zoom;
  return {
    zoom,
    x: sx - MAP_VIEWBOX.cx - ratio * (sx - MAP_VIEWBOX.cx - view.x),
    y: sy - MAP_VIEWBOX.cy - ratio * (sy - MAP_VIEWBOX.cy - view.y),
  };
}

/**
 * Two-finger pinch: scale about the starting midpoint, then translate the map
 * so the midpoint follows the fingers to their current position.
 */
export function pinchView(view: MapView, nextZoom: number, from: { x: number; y: number }, to: { x: number; y: number }): MapView {
  const zoomed = zoomAboutPoint(view, nextZoom, from.x, from.y);
  return { ...zoomed, x: zoomed.x + (to.x - from.x), y: zoomed.y + (to.y - from.y) };
}

/** Exponential wheel response; positive deltaY (scroll down) zooms out. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015);
}
