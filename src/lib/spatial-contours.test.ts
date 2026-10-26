import assert from 'node:assert/strict';
import test from 'node:test';
import { geoMercator } from 'd3-geo';
import { generateSpatialContours } from './spatial-contours';
import { wgsToGcj } from './coordinates';
import { SPATIAL_SEASONS } from './spatial-field';
import type { SpatialFieldResult } from './spatial-field';
import { temperatureColor } from './field';

function fixture(): SpatialFieldResult {
  const size = 25;
  return { bounds: { west: 100, east: 100.4, south: 30, north: 30.4 }, step: 0.1, rows: 5, cols: 5, date: '2026-10-25',
    seasons: Int8Array.from([0,0,1,1,2, 0,0,1,2,2, 0,3,3,2,2, 3,3,2,2,1, 3,3,2,1,1]),
    targets: new Int8Array(size).fill(-1), average: Float32Array.from({ length: size }, (_, index) => 4.9 + index * 1.21), temperature: new Float32Array(size), status: new Uint8Array(size), expectedDays: new Int8Array(size), transitionDays: new Uint8Array(size), estimated: new Uint8Array(size),
    metadata: { method: 'daily-temperature-bilinear-with-elevation-correction', lapseRateCPerMeter: 0.0065, weatherGridStep: 1, displayGridStep: 0.1, weatherUpdatedAt: null,
      terrainSource: { name: 'Test DEM', url: '', documentation: '', attribution: '', retrievedAt: '', crs: 'EPSG:4326', sourceZoom: 6, resampling: 'test', note: '' }, evaluatedAt: '2026-10-26T00:00:00Z', validCells: size, missingCells: 0, pendingCells: 0, forecastCells: 0, note: '' } };
}

/** Read emitted SVG geometry, including quadratic arcs, as a browser fill would. */
function contains(path: string, point: number[]): boolean {
  const tokens = path.match(/[MLQZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const rings: number[][][] = [];
  let current: number[][] = [], cursor = [0, 0], index = 0;
  const coordinate = () => [Number(tokens[index++]), Number(tokens[index++])];
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') { current = [coordinate()]; cursor = current[0]; }
    else if (command === 'L') { cursor = coordinate(); current.push(cursor); }
    else if (command === 'Q') {
      const control = coordinate(), end = coordinate(), start = cursor;
      for (let step = 1; step <= 12; step++) {
        const t = step / 12;
        current.push([0, 1].map(axis => (1 - t) ** 2 * start[axis] + 2 * (1 - t) * t * control[axis] + t ** 2 * end[axis]));
      }
      cursor = end;
    } else if (command === 'Z') { rings.push(current); current = []; }
    else throw new Error(`Unsupported path command ${command}`);
  }
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}
const projection = geoMercator().center([104.5, 36.5]).scale(610).translate([420, 271]);
const pointAt = (field: SpatialFieldResult, index: number) => projection(wgsToGcj(field.bounds.west + index % field.cols * field.step, field.bounds.south + Math.floor(index / field.cols) * field.step))!;

test('categorical vector smoothing preserves every sample class, including four-class junctions', () => {
  const field = fixture(), assets = generateSpatialContours(field);
  assert.ok(assets.layers.some(layer => layer.kind === 'season' && layer.path.includes('Q')));
  field.seasons.forEach((seasonIndex, index) => {
    const containing = assets.layers.filter(layer => layer.kind === 'season' && contains(layer.path, pointAt(field, index)));
    assert.deepEqual(containing.map(layer => layer.season), [SPATIAL_SEASONS[seasonIndex]], `sample ${index}`);
  });
  assert.ok(assets.layers.filter(layer => layer.kind === 'season').every(layer => layer.underlayPath));
});

test('validity clip keeps an interior data hole empty despite neighboring smooth surfaces', () => {
  const field = fixture();
  field.seasons[12] = -1; field.average[12] = NaN;
  const assets = generateSpatialContours(field);
  assert.equal(contains(assets.validPath, pointAt(field, 12)), false);
  for (const index of [6,7,8,11,13,16,17,18]) assert.equal(contains(assets.validPath, pointAt(field, index)), true);
  assert.equal(/NaN|Infinity/.test(JSON.stringify(assets)), false);
});

test('continuous temperature isotherms preserve fixed-band sample colors without transition colors', () => {
  const field = fixture();
  field.status[2] = 2; field.targets[2] = 3;
  const layers = generateSpatialContours(field).layers.filter(layer => layer.kind === 'temperature');
  field.average.forEach((average, index) => {
    let fill: string | undefined;
    layers.forEach(layer => { if (contains(layer.path, pointAt(field, index))) fill = layer.fill; });
    assert.equal(fill, temperatureColor(average), `temperature ${average}`);
  });
  assert.ok(layers.every(layer => !layer.season && !layer.target && !layer.status));
});

test('pending and forecast masks stay distinct, while a wholly missing frame has no fills', () => {
  const field = fixture();
  field.status[1] = 1; field.targets[1] = 1;
  field.status[2] = 2; field.targets[2] = 2;
  const layers = generateSpatialContours(field).layers.filter(layer => layer.kind === 'transition');
  assert.deepEqual(layers.map(layer => layer.status).sort(), [1, 2]);
  assert.notEqual(layers[0].fill, layers[1].fill);
  field.seasons.fill(-1); field.average.fill(NaN);
  const missing = generateSpatialContours(field);
  assert.equal(missing.validPath, '');
  assert.equal(missing.layers.length, 0);
});
