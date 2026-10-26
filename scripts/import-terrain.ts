import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { validateTerrainGrid } from '../src/lib/terrain';
import type { TerrainGrid } from '../src/lib/terrain';
import { gcjToWgs } from '../src/lib/coordinates';
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';

// Reproducible public DEM extraction; raw source PNGs stay in the ignored cache.
// z6 is roughly 1.4–2.4 km per pixel across China, averaged to a 0.1° grid.
const zoom = 6, tileSize = 256, worldSize = tileSize * 2 ** zoom;
const bounds = { west: 73, east: 136, south: 18, north: 54 }, step = 0.1;
const cols = Math.round((bounds.east - bounds.west) / step) + 1;
const rows = Math.round((bounds.north - bounds.south) / step) + 1;
const cache = new URL('../data-sources/terrain/', import.meta.url);
const output = new URL('../public/data/terrain.json', import.meta.url);
const base = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
// Rasterize the local display boundary once per latitude, after converting its
// GCJ-02 coordinates back to WGS84. Scanlines handle polygon holes without
// doing millions of expensive spherical point-in-polygon tests.
const boundaryBytes = await readFile(new URL('../public/data/china.json', import.meta.url));
const boundary = JSON.parse(boundaryBytes.toString()) as FeatureCollection<Polygon | MultiPolygon, { name: string }>;
const polygons = boundary.features.filter(feature => !!feature.properties.name).flatMap(feature =>
  feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates
).map(polygon => {
  const rings = polygon.map(ring => ring.map(([lon, lat]) => gcjToWgs(lon, lat)));
  const latitudes = rings.flat().map(point => point[1]);
  return { rings, south: Math.min(...latitudes), north: Math.max(...latitudes) };
});
const landScanlines = new Map<number, [number, number][]>();
function isLand(lon: number, lat: number): boolean {
  const key = Math.round(lat * 1e6);
  let intervals = landScanlines.get(key);
  if (!intervals) {
    intervals = [];
    for (const polygon of polygons) {
      if (lat < polygon.south || lat > polygon.north) continue;
      const cuts: number[] = [];
      for (const ring of polygon.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if ((a[1] > lat) !== (b[1] > lat)) cuts.push(a[0] + (lat - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      cuts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i += 2) intervals.push([cuts[i], cuts[i + 1]]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    intervals = merged;
    landScanlines.set(key, intervals);
  }
  return intervals.some(([left, right]) => lon >= left && lon <= right);
}
const toPixel = (lon: number, lat: number): [number, number] => [
  (lon + 180) / 360 * worldSize - 0.5,
  (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * worldSize - 0.5,
];
const [left, top] = toPixel(bounds.west - step / 2, bounds.north + step / 2);
const [right, bottom] = toPixel(bounds.east + step / 2, bounds.south - step / 2);
const tiles = new Map<string, PNG>();
const provenance: NonNullable<TerrainGrid['source']['tiles']> = [];
const jobs: { x: number; y: number }[] = [];
for (let y = Math.floor(top / tileSize); y <= Math.floor((bottom + 1) / tileSize); y++) {
  for (let x = Math.floor(left / tileSize); x <= Math.floor((right + 1) / tileSize); x++) jobs.push({ x, y });
}
await mkdir(cache, { recursive: true });
let next = 0, completed = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length) {
    const { x, y } = jobs[next++], file = new URL(`${zoom}-${x}-${y}.png`, cache);
    let bytes: Buffer;
    try { bytes = await readFile(file); }
    catch {
      let downloaded: Buffer | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(`${base}${zoom}/${x}/${y}.png`, { signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          downloaded = Buffer.from(await response.arrayBuffer());
          PNG.sync.read(downloaded);
          await writeFile(file, downloaded);
          break;
        } catch (error) { if (attempt === 2) throw new Error(`Terrain ${zoom}/${x}/${y}: ${String(error)}`); }
      }
      if (!downloaded) throw new Error(`Terrain ${zoom}/${x}/${y} not downloaded`);
      bytes = downloaded;
    }
    const png = PNG.sync.read(bytes);
    if (png.width !== tileSize || png.height !== tileSize) throw new Error(`Unexpected tile dimensions: ${x}/${y}`);
    tiles.set(`${x}/${y}`, png);
    provenance.push({ z: zoom, x, y, sha256: createHash('sha256').update(bytes).digest('hex') });
    completed++;
    if (completed % 20 === 0 || completed === jobs.length) console.log(`Terrain tiles ${completed}/${jobs.length}`);
  }
}));

function pixelHeight(x: number, y: number): number {
  const tile = tiles.get(`${Math.floor(x / tileSize)}/${Math.floor(y / tileSize)}`);
  if (!tile) throw new Error(`DEM pixel outside downloaded tiles: ${x}/${y}`);
  const offset = ((y % tileSize) * tileSize + x % tileSize) * 4;
  if (tile.data[offset + 3] !== 255) throw new Error(`Missing DEM pixel: ${x}/${y}`);
  return tile.data[offset] * 256 + tile.data[offset + 1] + tile.data[offset + 2] / 256 - 32768;
}
function interpolatedHeight(lon: number, lat: number): number {
  const [px, py] = toPixel(lon, lat), x0 = Math.floor(px), y0 = Math.floor(py), x = px - x0, y = py - y0;
  return (pixelHeight(x0, y0) * (1 - x) + pixelHeight(x0 + 1, y0) * x) * (1 - y) +
    (pixelHeight(x0, y0 + 1) * (1 - x) + pixelHeight(x0 + 1, y0 + 1) * x) * y;
}
const heights: number[] = [];
for (let row = 0; row < rows; row++) {
  const latitude = bounds.south + row * step;
  for (let col = 0; col < cols; col++) {
    const longitude = bounds.west + col * step;
    const centerIsLand = isLand(longitude, latitude);
    let sum = 0, weights = 0, landSamples = 0;
    // Equal-angle subsamples are weighted by cos(latitude) for surface area.
    for (let sy = 0; sy < 5; sy++) for (let sx = 0; sx < 5; sx++) {
      const lat = latitude + ((sy + 0.5) / 5 - 0.5) * step;
      const lon = longitude + ((sx + 0.5) / 5 - 0.5) * step;
      if (centerIsLand && !isLand(lon, lat)) continue;
      landSamples++;
      const weight = Math.cos(lat * Math.PI / 180);
      sum += interpolatedHeight(lon, lat) * weight; weights += weight;
    }
    if (!weights) throw new Error(`No valid land samples at ${longitude}/${latitude}`);
    const average = Math.round(sum / weights);
    // Coarse source pixels can blend a small island with ETOPO bathymetry.
    // Normalize negative coastal fringe means to sea level; inland depressions
    // (a full land footprint, e.g. Turpan) retain their measured negative DEM.
    heights.push(average < 0 && (!centerIsLand || landSamples < 25) ? 0 : average);
  }
}
const grid: TerrainGrid = {
  version: 1,
  source: {
    name: 'Mapzen / Tilezen Terrain Tiles',
    url: 'https://registry.opendata.aws/terrain-tiles/',
    documentation: 'https://github.com/tilezen/joerd/blob/master/docs/formats.md',
    attribution: 'SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey. Global ETOPO1 terrain data: DOC/NOAA/NESDIS/NCEI, National Centers for Environmental Information, NESDIS, NOAA, U.S. Department of Commerce. Mapzen / Tilezen.',
    retrievedAt: new Date().toISOString(), crs: 'EPSG:4326', sourceZoom: zoom,
    resampling: '0.1° footprint, 5×5 area-weighted bilinear source samples; rounded to whole metres. China land centers average land sub-samples only; negative coastal-fringe means and negative elevations outside the China land mask are set to sea level (0 m).',
    note: `WGS84 geographic DEM, metres. Row 0 is south; columns run west to east. Approximately 10 km terrain sampling is a display support grid, not 10 km temperature observations. China land mask: local DataV/Amap province boundary (GCJ-02 converted to WGS84), SHA256 ${createHash('sha256').update(boundaryBytes).digest('hex')}; offshore bathymetry is suppressed while below-sea-level China land is retained. Foreign terrain is not a supported display area. Source dates and resolution vary by dataset.`,
    tiles: provenance.sort((a, b) => a.x - b.x || a.y - b.y),
  }, bounds, step, rows, cols, heights,
};
if (!validateTerrainGrid(grid)) throw new Error('Generated terrain grid failed validation');
const temporary = new URL('../public/data/terrain.tmp.json', import.meta.url);
await writeFile(temporary, JSON.stringify(grid));
await rename(temporary, output);
console.log(`DEM ${cols}×${rows}; ${heights.length.toLocaleString()} points; ${JSON.stringify(grid).length.toLocaleString()} bytes`);
