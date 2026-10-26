import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { Polygon } from 'geojson';
import { buildGridLocations, countyGridLocation, lookupGridLocation, validGridLocations } from './grid-location';
import type { GridLocationLattice, ProvinceBoundaries } from './grid-location';
import type { CountyBoundaries, CountyCatalog, CountyUnit } from './counties';
import { wgsToGcj } from './coordinates';

const unit: CountyUnit = {
  id: '110101', name: '东城区', province: '北京市', provinceCode: 110000, city: '北京市', cityCode: 110000,
  kind: 'county', region: '华北', display: wgsToGcj(116.4, 39.9), lon: 116.4, lat: 39.9, pointMethod: 'test',
};
function rectangle(west: number, south: number, east: number, north: number): Polygon {
  return { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]].map(([x, y]) => wgsToGcj(x, y))] };
}
const grid: GridLocationLattice = { bounds: { west: 116, east: 118, south: 39, north: 41 }, rows: 21, cols: 21, step: .1 };
const catalog = { version: 1, source: {}, units: [unit] } as CountyCatalog;
const boundaries: CountyBoundaries = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: unit.id }, geometry: rectangle(116.2, 39.7, 116.7, 40.1) }] };
const provinces: ProvinceBoundaries = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { adcode: 110000, name: '北京市' }, geometry: rectangle(116.1, 39.2, 117, 40.5) }] };

test('grid locations use containing county and a constant-time precomputed lookup', () => {
  const index = buildGridLocations({ grid, catalog, boundaries, provinces });
  assert.equal(validGridLocations(index), true);
  assert.equal(lookupGridLocation(index, 116.4, 39.9)?.id, unit.id);
  assert.equal(lookupGridLocation(index, 116.4, 39.9)?.title, '北京市 · 东城区');
  assert.equal(lookupGridLocation(index, 116.4, 39.9)?.kind, 'county');
  assert.equal(lookupGridLocation(index, 116.8, 40.3)?.kind, 'province');
  assert.equal(lookupGridLocation(index, 117.5, 39.9), null, 'offshore/outside points must not borrow the nearest county');
  assert.equal(lookupGridLocation(index, 100, 39.9), null);
  assert.equal(lookupGridLocation(index, NaN, 39.9), null);
});

test('holes do not inherit a surrounding county and reversed rings retain containment', () => {
  const shape = rectangle(116.2, 39.7, 116.7, 40.1);
  shape.coordinates.push(rectangle(116.3, 39.8, 116.5, 40).coordinates[0]);
  const withHole: CountyBoundaries = { ...boundaries, features: [{ ...boundaries.features[0], geometry: shape }] };
  const index = buildGridLocations({ grid, catalog, boundaries: withHole, provinces });
  assert.equal(lookupGridLocation(index, 116.4, 39.9)?.kind, 'province');
  assert.equal(lookupGridLocation(index, 116.6, 39.9)?.kind, 'county');
  for (const ring of shape.coordinates) ring.reverse();
  const reversed = buildGridLocations({ grid, catalog, boundaries: withHole, provinces });
  assert.deepEqual(reversed.cells, index.cells);
});

test('titles avoid duplicate municipality and undivided-city names', () => {
  assert.equal(countyGridLocation(unit).title, '北京市 · 东城区');
  const dongguan = countyGridLocation({ ...unit, id: '441900', name: '东莞市', province: '广东省', city: '东莞市', kind: 'undivided-city' });
  assert.equal(dongguan.title, '广东省 · 东莞市');
  assert.equal(dongguan.county, '');
  assert.equal(dongguan.kind, 'undivided-city');
});

test('location asset validation rejects invalid references and grid extents', () => {
  const index = buildGridLocations({ grid, catalog, boundaries, provinces });
  const broken = structuredClone(index); broken.cells[0] = index.units.length + 1;
  assert.equal(validGridLocations(broken), false);
  const shifted = structuredClone(index); shifted.bounds.east += 1;
  assert.equal(validGridLocations(shifted), false);
  const short = structuredClone(index); short.cells.pop();
  assert.equal(validGridLocations(short), false);
});

test('real county boundaries locate mainland representatives and Taiwan falls back to its province', () => {
  const realCatalog = JSON.parse(readFileSync(new URL('../../public/data/counties.json', import.meta.url), 'utf8')) as CountyCatalog;
  const topology = JSON.parse(readFileSync(new URL('../../public/data/counties.topo.json', import.meta.url), 'utf8')) as Topology<{ counties: GeometryCollection<{ id: string }> }>;
  const realBoundaries = feature(topology, topology.objects.counties) as CountyBoundaries;
  const realProvinces = JSON.parse(readFileSync(new URL('../../public/data/china.json', import.meta.url), 'utf8')) as ProvinceBoundaries;
  const samples = ['110101', '330106', '540102', '441900'].map(id => realCatalog.units.find(county => county.id === id)!);
  for (const sample of samples) {
    const onePoint: GridLocationLattice = { bounds: { west: sample.lon, east: sample.lon, south: sample.lat, north: sample.lat }, rows: 1, cols: 1, step: .1 };
    const index = buildGridLocations({ grid: onePoint, catalog: realCatalog, boundaries: realBoundaries, provinces: realProvinces });
    assert.equal(lookupGridLocation(index, sample.lon, sample.lat)?.id, sample.id, sample.name);
  }
  const taiwan: GridLocationLattice = { bounds: { west: 121, east: 121, south: 23.8, north: 23.8 }, rows: 1, cols: 1, step: .1 };
  const taiwanIndex = buildGridLocations({ grid: taiwan, catalog: realCatalog, boundaries: realBoundaries, provinces: realProvinces });
  assert.deepEqual(lookupGridLocation(taiwanIndex, 121, 23.8), { id: '710000', province: '台湾省', city: '', county: '', title: '台湾省', kind: 'province' });
});
