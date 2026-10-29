import assert from 'node:assert/strict';
import test from 'node:test';
import type { WeatherGridCatalog, WeatherGridSeries } from './spatial-grid';
import type { TerrainGrid } from './terrain';
import { addDays, classifyCity } from './season';
import { computeSpatialField, sampleGridCell, sampleTemperatureSeries, SPATIAL_SEASONS } from './spatial-field';
import type { SpatialFieldInput } from './spatial-field';

const date = '2026-10-25', issuedAt = '2026-10-26T00:00:00Z';
function fixture(values = Array(14).fill(15), future = Array(7).fill(15)): SpatialFieldInput {
  const nodes = [0, 1, 2, 3].map(index => ({ id: `r${Math.floor(index / 2)}c${index % 2}`, row: Math.floor(index / 2), col: index % 2, lon: 100 + index % 2, lat: 30 + Math.floor(index / 2) }));
  const catalog: WeatherGridCatalog = { version: 1, id: 'test-grid', crs: 'WGS84', step: 1, origin: [100, 30], rows: 2, cols: 2, nodes,
    source: { name: 'test', url: '', retrievedAt: issuedAt, boundarySha256: '', note: '' } };
  const terrain: TerrainGrid = { version: 1, source: { name: 'Test DEM', url: '', documentation: '', attribution: '', retrievedAt: issuedAt, crs: 'EPSG:4326', sourceZoom: 6, resampling: 'test', note: '' },
    bounds: { west: 100, east: 101, south: 30, north: 31 }, step: 0.5, rows: 3, cols: 3, heights: Array(9).fill(0) };
  const records: Record<string, WeatherGridSeries> = Object.fromEntries(nodes.map(node => [node.id, { lon: node.lon, lat: node.lat, elevation: 0, modelGrid: [node.lon, node.lat], updatedAt: issuedAt,
    days: values.map((mean, index) => ({ date: addDays(date, index - values.length + 1), mean })),
    forecast: { issuedAt, days: future.map((mean, index) => ({ date: addDays(date, index + 1), mean })) } }]));
  return { catalog, terrain, weather: { version: 1, source: 'open-meteo', timeZone: 'Asia/Shanghai', catalogId: catalog.id, updatedAt: issuedAt, records }, date, now: '2026-10-26T04:00:00Z' };
}

test('daily interpolation uses node elevation and DEM, allowing different seasons inside one weather cell', () => {
  const input = fixture();
  Object.values(input.weather.records).forEach(record => { record.elevation = 1000; });
  input.terrain.heights = [0, 1000, 2000, 0, 1000, 2000, 0, 1000, 2000];
  const valley = sampleGridCell(input, 100, 30.5)!, mountain = sampleGridCell(input, 101, 30.5)!;
  assert.equal(valley.days.at(-1)!.mean, 21.5);
  assert.equal(mountain.days.at(-1)!.mean, 8.5);
  assert.equal(valley.state!.season, 'autumn');
  assert.equal(mountain.state!.season, 'winter');
  const result = computeSpatialField(input);
  assert.equal(SPATIAL_SEASONS[result.seasons[3]], 'autumn');
  assert.equal(SPATIAL_SEASONS[result.seasons[5]], 'winter');
  assert.equal(result.metadata.lapseRateCPerMeter, 0.0065);
  assert.match(result.metadata.note, /未融合地面实况/);
});

test('bilinear interpolation operates on temperatures rather than season codes or colors', () => {
  const input = fixture();
  Object.values(input.weather.records).forEach((record, index) => record.days.forEach(day => { day.mean = (index + 1) * 10; }));
  const middle = sampleTemperatureSeries(input, 100.5, 30.5)!;
  assert.equal(middle.days.at(-1)!.mean, 25);
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.state!.season, 'summer');
  assert.equal(sampleTemperatureSeries(input, 99.99, 30.5), null);
});

test('missing a weather corner never bridges a hole, including zero-weight grid edges', () => {
  const input = fixture();
  delete input.weather.records.r1c1;
  assert.equal(sampleTemperatureSeries(input, 100.5, 30.5), null);
  assert.equal(sampleTemperatureSeries(input, 100, 30), null);
  const result = computeSpatialField(input);
  assert.equal(result.metadata.validCells, 0);
  assert.ok([...result.seasons].every(value => value === -1));
  assert.ok([...result.average].every(Number.isNaN));
});

test('a missing corner daily value remains missing and blocks nine-day confirmation', () => {
  const input = fixture();
  input.weather.records.r1c1.days[5].mean = null;
  const series = sampleTemperatureSeries(input, 100.5, 30.5)!;
  assert.equal(series.days[5].mean, null);
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.status, 'insufficient');
  input.weather.records.r1c1.days[5].mean = 15;
  input.weather.records.r1c1.days.splice(5, 1);
  assert.equal(sampleTemperatureSeries(input, 100.5, 30.5)!.days[5].mean, null);
  assert.equal(computeSpatialField(input).metadata.validCells, 0);
});

test('interpolated daily histories preserve the 10°C and 22°C boundaries', () => {
  for (const [temperature, expected] of [[9.999, 'winter'], [10, 'autumn'], [21.999, 'autumn'], [22, 'summer']] as const) {
    const input = fixture(Array(14).fill(temperature));
    const reading = sampleGridCell(input, 100.5, 30.5)!;
    assert.equal(reading.state!.season, expected);
    assert.equal(reading.state!.season, classifyCity(reading.state!.city, reading.days, date).season);
  }
});

test('forecast color status does not rewrite the actual season and expires on historical replay', () => {
  const input = fixture([15, 15, 15, 15, 15, 5, 5, 5, 5, 5], Array(7).fill(5));
  const reading = sampleGridCell(input, 100.5, 30.5)!;
  assert.equal(reading.state!.season, 'autumn');
  assert.equal(reading.state!.transition!.target, 'winter');
  assert.equal(reading.forecastTransition!.target, 'winter');
  assert.equal(reading.forecastTransition!.expectedDate, '2026-10-27');
  const result = computeSpatialField(input);
  assert.equal(SPATIAL_SEASONS[result.seasons[4]], 'autumn');
  assert.equal(SPATIAL_SEASONS[result.targets[4]], 'winter');
  assert.equal(result.status[4], 2);
  assert.equal(result.expectedDays[4], 2);
  assert.equal(result.transitionDays[4], 3);
  input.now = '2026-10-27T04:00:00Z';
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.forecastTransition, null);
  assert.equal(computeSpatialField(input).status[4], 1);
  input.now = '2026-10-26T04:00:00Z'; input.date = '2026-10-24';
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.forecastTransition, null);
});

test('incomplete future days cannot imply completion and old snapshots stay missing for a newer date', () => {
  const input = fixture([15, 15, 15, 15, 15, 5, 5, 5, 5, 5], Array(7).fill(5));
  input.weather.records.r1c1.forecast.days[6].mean = null;
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.forecastTransition, null);
  assert.equal(computeSpatialField(input).status[4], 1);
  input.date = '2026-10-26';
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.status, 'stale');
  assert.equal(computeSpatialField(input).seasons[4], -1);
});

test('a transition that starts wholly within the forecast does not enter either seasonal status', () => {
  const input = fixture(Array(14).fill(25), Array(7).fill(18));
  const reading = sampleGridCell(input, 100.5, 30.5)!;
  assert.equal(reading.state!.season, 'summer');
  assert.equal(reading.state!.transition, null);
  assert.equal(reading.forecastTransition, null);
  const result = computeSpatialField(input);
  assert.equal(result.status[4], 0);
  assert.equal(result.transitionDays[4], 0);
  assert.equal(result.expectedDays[4], 0);
});

test('retrieval-day temperature never becomes historical merely because the selected date advances', () => {
  const input = fixture();
  Object.values(input.weather.records).forEach(record => record.days.push({ date: '2026-10-26', mean: 30 }));
  input.date = '2026-10-26'; input.now = '2026-10-27T04:00:00Z';
  assert.equal(sampleTemperatureSeries(input, 100.5, 30.5)!.days.at(-1)!.date, '2026-10-25');
  assert.equal(sampleGridCell(input, 100.5, 30.5)!.status, 'stale');
  assert.equal(computeSpatialField(input).metadata.validCells, 0);
});
