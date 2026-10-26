import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sampleTerrain, validateTerrainGrid } from './terrain';
import type { TerrainGrid } from './terrain';

test('terrain sampling respects south-to-north storage, edges and out-of-bounds', () => {
  const grid = {
    version: 1, source: { crs: 'EPSG:4326' }, bounds: { west: 100, east: 101, south: 30, north: 31 },
    step: 1, rows: 2, cols: 2, heights: [0, 100, 200, 300],
  } as TerrainGrid;
  assert.ok(validateTerrainGrid(grid));
  assert.equal(sampleTerrain(grid, 100, 30), 0);
  assert.equal(sampleTerrain(grid, 101, 31), 300);
  assert.equal(sampleTerrain(grid, 100.5, 30.5), 150);
  assert.equal(sampleTerrain(grid, 99.99, 30), null);
  assert.equal(sampleTerrain(grid, 100, NaN), null);
  assert.equal(validateTerrainGrid({ ...grid, heights: [0, 1, 2] }), false);
  assert.equal(validateTerrainGrid({ ...grid, heights: [0, 1, NaN, 3] }), false);
  assert.equal(validateTerrainGrid({ ...grid, step: 0.5 }), false);
});

test('public DEM contains real plateau, basin and ocean elevation differences', async () => {
  const grid: unknown = JSON.parse(await readFile(new URL('../../public/data/terrain.json', import.meta.url), 'utf8'));
  assert.ok(validateTerrainGrid(grid));
  const tibet = sampleTerrain(grid, 88, 32)!, tarim = sampleTerrain(grid, 83, 40)!, eastPlain = sampleTerrain(grid, 116, 35)!;
  assert.ok(tibet > 4000, `Tibetan plateau ${tibet} m`);
  assert.ok(tarim > 500 && tarim < 1600, `Tarim basin ${tarim} m`);
  assert.ok(eastPlain < 200, `East China plain ${eastPlain} m`);
  assert.ok(tibet - tarim > 2500);
  assert.equal(sampleTerrain(grid, 127, 22), 0, 'Ocean bathymetry is converted to sea level');
  assert.ok(sampleTerrain(grid, 89.2, 42.8)! < 0, 'Below-sea-level land in Turpan is retained');
  assert.ok(grid.source.tiles && grid.source.tiles.length > 50);
});
