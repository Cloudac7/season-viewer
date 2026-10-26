import assert from 'node:assert/strict';
import test from 'node:test';
import { geoMercator } from 'd3-geo';
import { renderSpatialRaster, spatialCellAppearance } from './spatial-raster';
import type { SpatialFieldResult } from './spatial-field';
import { wgsToGcj } from './coordinates';

function fixture(): SpatialFieldResult {
  return {
    bounds: { west: 104, east: 104.2, south: 36, north: 36.2 }, step: 0.1, rows: 3, cols: 3,
    seasons: new Int8Array([3, 3, 3, 2, 2, 2, 1, 1, -1]),
    average: new Float32Array([0, 0, 0, 18, 18, 18, 25, 25, NaN]),
    status: new Uint8Array([0, 0, 0, 0, 1, 2, 0, 0, 0]),
    targets: new Int8Array([-1, -1, -1, -1, 3, 3, -1, -1, -1]),
  } as SpatialFieldResult;
}

test('spatial display preserves discrete seasonal and forecast colors, missing values and temperature bins', () => {
  const field = fixture(), options = { layer: 'season' as const, showTransitions: true, filter: 'all' as const };
  assert.deepEqual(spatialCellAppearance(field, 4, options), { fill: '#b7354f', opacity: 1 });
  assert.deepEqual(spatialCellAppearance(field, 5, options), { fill: '#8754b0', opacity: 1 });
  assert.deepEqual(spatialCellAppearance(field, 4, { ...options, showTransitions: false }), { fill: '#ed9b4e', opacity: 1 });
  assert.deepEqual(spatialCellAppearance(field, 4, { ...options, filter: 'winter' }), { fill: '#b7354f', opacity: 0.18 });
  assert.deepEqual(spatialCellAppearance(field, 3, { ...options, layer: 'temperature' }), { fill: '#bdd363', opacity: 1 });
  assert.equal(spatialCellAppearance(field, 8, options), null);
});

test('raster projection keeps WGS84 cells north-up in the GCJ display and leaves data gaps transparent', () => {
  const field = fixture(), projection = geoMercator().center([104.5, 36.5]).scale(610).translate([420, 271]);
  let written: Uint8ClampedArray | null = null;
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ imageSmoothingEnabled: true,
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image: { data: Uint8ClampedArray }) => { written = image.data; },
    }),
    toDataURL: () => 'data:image/png;base64,test',
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  try {
    const raster = renderSpatialRaster(field, { projection, layer: 'season', showTransitions: false, filter: 'all', pixelRatio: 3 });
    assert.ok(raster && written);
    const colorAt = (lon: number, lat: number) => {
      const xy = projection(wgsToGcj(lon, lat))!;
      const col = Math.floor((xy[0] - raster.x) / raster.width * canvas.width);
      const row = Math.floor((xy[1] - raster.y) / raster.height * canvas.height);
      return Array.from(written!.slice((row * canvas.width + col) * 4, (row * canvas.width + col) * 4 + 4));
    };
    assert.deepEqual(colorAt(104.1, 36), [119, 184, 229, 255]);
    assert.deepEqual(colorAt(104.1, 36.1), [237, 155, 78, 255]);
    assert.deepEqual(colorAt(104.1, 36.2), [244, 208, 91, 255]);
    assert.equal(colorAt(104.2, 36.2)[3], 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
