import assert from 'node:assert/strict';
import test from 'node:test';
import { geoMercator } from 'd3-geo';
import { generateSpatialContours, temperatureLayerPaintOrder } from './spatial-contours';
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

function categoricalFixture(): SpatialFieldResult {
  const rows = 10, cols = 10, size = rows * cols, base = fixture();
  return {
    ...base,
    bounds: { west: 100, east: 100.9, south: 30, north: 30.9 }, step: 0.1, rows, cols, date: '2026-10-25',
    seasons: Int8Array.from({ length: size }, (_, index) => Math.floor(index / cols) < rows / 2 ? index % cols < cols / 2 ? 0 : 1 : index % cols < cols / 2 ? 2 : 3),
    targets: new Int8Array(size).fill(-1),
    average: Float32Array.from({ length: size }, (_, index) => 4.9 + index * 0.21),
    temperature: new Float32Array(size), status: new Uint8Array(size), expectedDays: new Int8Array(size), transitionDays: new Uint8Array(size), estimated: new Uint8Array(size),
    metadata: { ...base.metadata, validCells: size },
  };
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

test('categorical contours share the full-resolution isotherm grid without square covers', () => {
  const field = categoricalFixture(), assets = generateSpatialContours(field);
  field.seasons.forEach((seasonIndex, index) => {
    const containing = assets.layers.filter(layer => layer.kind === 'season' && contains(layer.path, pointAt(field, index)));
    assert.deepEqual(containing.map(layer => layer.season), [SPATIAL_SEASONS[seasonIndex]], `sample ${index}`);
  });
  assert.ok(assets.layers.filter(layer => layer.kind === 'season').every(layer => !layer.underlayPath));
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
    const point = pointAt(field, index);
    let fill = layers.find(layer => layer.minimum === null)!.fill;
    temperatureLayerPaintOrder(layers).forEach(({ surface, underlay }) => {
      const path = underlay ? surface.underlayPath ?? '' : surface.path;
      if (contains(path, point)) fill = surface.fill;
    });
    assert.equal(fill, temperatureColor(average), `temperature ${average} at sample ${index}`);
  });
  assert.ok(layers.every(layer => !layer.season && !layer.target && !layer.status));
});

test('temperature isotherms retain samples only slightly above a band boundary', () => {
  const field = fixture();
  field.average.fill(4.9);
  field.average[12] = 5.0001;
  const layer = generateSpatialContours(field).layers.find(surface => surface.key === 'temperature:5');
  assert.ok(layer);
  assert.equal(contains(layer.path, pointAt(field, 12)), true);
});

test('temperature edge fallback covers valid cells beside missing-data gaps', () => {
  const field = fixture();
  field.seasons[12] = -1; field.average[12] = Number.NaN;
  const layers = generateSpatialContours(field).layers.filter(layer => layer.kind === 'temperature');
  const temperatureLayers = layers.filter(layer => layer.minimum !== null);
  for (const index of [7, 11, 13, 17]) {
    const point = pointAt(field, index), average = field.average[index];
    for (const layer of temperatureLayers) {
      assert.equal(contains(layer.underlayPath ?? '', point), average >= layer.minimum!, `fallback ${layer.key} at sample ${index}`);
    }
    let fill = layers.find(layer => layer.minimum === null)!.fill;
    temperatureLayerPaintOrder(layers).forEach(({ surface, underlay }) => {
      const path = underlay ? surface.underlayPath ?? '' : surface.path;
      if (contains(path, point)) fill = surface.fill;
    });
    assert.equal(fill, temperatureColor(average), `edge temperature ${average} at sample ${index}`);
  }
});

test('pending and forecast masks stay distinct, while a wholly missing frame has no fills', () => {
  const field = categoricalFixture();
  for (let row = 2; row < 6; row++) {
    for (let col = 2; col < 5; col++) {
      const index = row * field.cols + col;
      field.status[index] = 1; field.targets[index] = 2;
    }
    for (let col = 5; col < 8; col++) {
      const index = row * field.cols + col;
      field.status[index] = 2; field.targets[index] = 2;
    }
  }
  const layers = generateSpatialContours(field).layers.filter(layer => layer.kind === 'transition');
  assert.deepEqual(layers.map(layer => layer.status).sort(), [1, 2]);
  assert.notEqual(layers[0].fill, layers[1].fill);
  field.seasons.fill(-1); field.average.fill(NaN);
  const missing = generateSpatialContours(field);
  assert.equal(missing.validPath, '');
  assert.equal(missing.layers.length, 0);
});

test('cartographic cleanup removes isolated categorical diamonds without hiding coherent regions', () => {
  const field = categoricalFixture();
  for (let row = 1; row < 5; row++) {
    for (let col = 1; col < 5; col++) {
      const index = row * field.cols + col;
      field.status[index] = 1; field.targets[index] = 2;
    }
  }
  const noise = field.seasons.length - 1;
  field.status[noise] = 1; field.targets[noise] = 2;
  const assets = generateSpatialContours(field), transitions = assets.layers.filter(layer => layer.kind === 'transition');
  assert.equal(transitions.length, 1);
  assert.equal(contains(transitions[0].path, pointAt(field, noise)), false);
  assert.equal(contains(transitions[0].path, pointAt(field, 2 * field.cols + 2)), true);
  for (const season of SPATIAL_SEASONS) {
    assert.equal(assets.layers.filter(layer => layer.kind === 'season' && layer.season === season).length, 1);
  }
});

test('small season islands retain their category without leaving pinholes', () => {
  const field = categoricalFixture(), noise = 0;
  field.seasons[noise] = 1;
  const assets = generateSpatialContours(field);
  for (let index = 0; index < field.seasons.length; index++) {
    const containing = assets.layers.filter(layer => layer.kind === 'season' && contains(layer.path, pointAt(field, index)));
    assert.equal(containing.length, 1, `sample ${index}`);
    if (index === noise) assert.equal(containing[0].season, SPATIAL_SEASONS[1]);
  }
});

test('tiny mountain winter zones retain their footprint and share a watertight boundary', () => {
  for (const cells of [[44], [44, 45, 54], [33, 34, 43, 44, 53, 54, 63]]) {
    const field = categoricalFixture();
    field.seasons.fill(2);
    for (const index of cells) field.seasons[index] = 3;
    const original = field.seasons.slice();
    const surfaces = generateSpatialContours(field).layers.filter(layer => layer.kind === 'season');
    assert.deepEqual(field.seasons, original);
    for (let index = 0; index < field.seasons.length; index++) {
      assert.deepEqual(surfaces.filter(layer => contains(layer.path, pointAt(field, index))).map(layer => layer.season),
        [SPATIAL_SEASONS[field.seasons[index]]], `zone ${cells.length}, sample ${index}`);
    }
    // A singleton's unsmoothed diamond reaches 0.5 cells from its center;
    // two low-pass passes used to reduce that to 0.125 cells.
    if (cells.length === 1) {
      const point = projection(wgsToGcj(field.bounds.west + 4.3 * field.step, field.bounds.south + 4 * field.step))!;
      assert.deepEqual(surfaces.filter(layer => contains(layer.path, point)).map(layer => layer.season), ['winter']);
    }
    for (let y = 2.17; y < 7; y += 0.23) for (let x = 2.13; x < 7; x += 0.23) {
      const point = projection(wgsToGcj(field.bounds.west + x * field.step, field.bounds.south + y * field.step))!;
      assert.equal(surfaces.filter(layer => contains(layer.path, point)).length, 1);
    }
  }
});

test('diagonal category junctions keep the surfaces filled without white pinholes', () => {
  const rows = 20, cols = 20, size = rows * cols, base = fixture();
  // Two stable autumn blocks that touch only at one corner. Truly ambiguous
  // for marching squares: resolving the two masks independently leaves a lens
  // between them that neither path fills, which renders as a white pinhole.
  const seasons = new Int8Array(size).fill(1);
  for (let row = 4; row <= 7; row++) for (let col = 4; col <= 7; col++) seasons[row * cols + col] = 2;
  for (let row = 8; row <= 11; row++) for (let col = 8; col <= 11; col++) seasons[row * cols + col] = 2;
  const field: SpatialFieldResult = {
    ...base,
    bounds: { west: 100, east: 101.9, south: 30, north: 31.9 }, step: 0.1, rows, cols, date: '2026-10-25',
    seasons,
    targets: new Int8Array(size).fill(-1),
    average: Float32Array.from({ length: size }, (_, index) => 10 + (index % cols) * 0.5),
    temperature: new Float32Array(size), status: new Uint8Array(size), expectedDays: new Int8Array(size), transitionDays: new Uint8Array(size), estimated: new Uint8Array(size),
    metadata: { ...base.metadata, validCells: size, missingCells: 0 },
  };
  const original = seasons.slice(), surfaces = generateSpatialContours(field).layers.filter(layer => layer.kind === 'season');
  // Display cleanup must never rewrite the sampled grid used by the readout.
  assert.deepEqual(field.seasons, original);
  const point = (x: number, y: number) => projection(wgsToGcj(field.bounds.west + (x - 0.5) * field.step, field.bounds.south + (y - 0.5) * field.step))!;
  for (let y = 7.55; y <= 8.45; y += 0.1) {
    for (let x = 7.55; x <= 8.45; x += 0.1) {
      const containing = surfaces.filter(layer => contains(layer.path, point(x, y)));
      assert.equal(containing.length, 1, `junction sample ${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }
  const autumn = surfaces.find(layer => layer.season === 'autumn')!;
  assert.equal(contains(autumn.path, point(5.5, 5.5)), true);
  assert.equal(contains(autumn.path, point(9.5, 9.5)), true);
});

test('generalized categorical boundaries still tile every interior point exactly once', () => {
  const rows = 24, cols = 24, size = rows * cols, base = fixture();
  // A curved two-category boundary exercises both diagonal crossings and arcs
  // without the separate multi-category junction case.
  const seasons = Int8Array.from({ length: size }, (_, index) => {
    const row = Math.floor(index / cols) - 12, col = index % cols - 12;
    return row * row + col * col < 49 ? 1 : 2;
  });
  const field: SpatialFieldResult = {
    ...base,
    bounds: { west: 100, east: 102.3, south: 30, north: 32.3 }, step: 0.1, rows, cols, date: '2026-10-25',
    seasons,
    targets: new Int8Array(size).fill(-1),
    average: Float32Array.from({ length: size }, (_, index) => 6 + (index % cols) * 0.4),
    temperature: new Float32Array(size), status: new Uint8Array(size), expectedDays: new Int8Array(size), transitionDays: new Uint8Array(size), estimated: new Uint8Array(size),
    metadata: { ...base.metadata, validCells: size, missingCells: 0 },
  };
  const surfaces = generateSpatialContours(field).layers.filter(layer => layer.kind === 'season');
  const point = (x: number, y: number) => projection(wgsToGcj(field.bounds.west + (x - 0.5) * field.step, field.bounds.south + (y - 0.5) * field.step))!;
  // Boundary generalization must not open seams between neighbours or let two
  // fills overlap, including around the curved rim.
  for (let y = 3.2; y <= 20.8; y += 0.19) {
    for (let x = 3.2; x <= 20.8; x += 0.19) {
      const containing = surfaces.filter(layer => contains(layer.path, point(x, y)));
      assert.equal(containing.length, 1, `sample ${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }
});

test('small transition classes are absorbed into the surrounding transition color', () => {
  const field = categoricalFixture();
  for (let row = 1; row < 5; row++) {
    for (let col = 1; col < 5; col++) {
      const index = row * field.cols + col;
      field.status[index] = 1; field.targets[index] = 2;
    }
  }
  const island = 2 * field.cols + 2;
  field.status[island] = 2;
  const transitions = generateSpatialContours(field).layers.filter(layer => layer.kind === 'transition');
  assert.deepEqual(transitions.map(layer => layer.status), [1]);
  assert.equal(contains(transitions[0].path, pointAt(field, island)), true);
});
