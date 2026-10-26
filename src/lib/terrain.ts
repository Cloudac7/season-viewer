/** A geographic height grid. Rows run south to north; columns west to east. */
export interface TerrainGrid {
  version: 1;
  source: {
    name: string;
    url: string;
    documentation: string;
    attribution: string;
    retrievedAt: string;
    crs: 'EPSG:4326';
    sourceZoom: number;
    resampling: string;
    note: string;
    tiles?: { z: number; x: number; y: number; sha256: string }[];
  };
  bounds: { west: number; east: number; south: number; north: number };
  step: number;
  rows: number;
  cols: number;
  heights: number[];
}

export function validateTerrainGrid(value: unknown): value is TerrainGrid {
  if (!value || typeof value !== 'object') return false;
  const grid = value as TerrainGrid;
  if (grid.version !== 1 || !grid.source || grid.source.crs !== 'EPSG:4326' ||
    !grid.bounds || !Number.isFinite(grid.step) || grid.step <= 0 ||
    !Number.isInteger(grid.rows) || grid.rows < 2 || !Number.isInteger(grid.cols) || grid.cols < 2 ||
    !Array.isArray(grid.heights) || grid.heights.length !== grid.rows * grid.cols) return false;
  const { west, east, south, north } = grid.bounds;
  if (![west, east, south, north].every(Number.isFinite) || west < -180 || east > 180 ||
    south < -90 || north > 90 || east <= west || north <= south ||
    Math.abs(west + (grid.cols - 1) * grid.step - east) > 1e-7 ||
    Math.abs(south + (grid.rows - 1) * grid.step - north) > 1e-7) return false;
  return grid.heights.every(height => typeof height === 'number' && Number.isFinite(height) && height >= -12000 && height <= 9000);
}

/** Bilinear sampling in WGS84, returning null rather than extending the grid. */
export function sampleTerrain(grid: TerrainGrid, longitude: number, latitude: number): number | null {
  const { west, east, south, north } = grid.bounds;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < west || longitude > east ||
    latitude < south || latitude > north) return null;
  const col = Math.max(0, Math.min(grid.cols - 1, (longitude - west) / grid.step));
  const row = Math.max(0, Math.min(grid.rows - 1, (latitude - south) / grid.step));
  const c0 = Math.min(grid.cols - 2, Math.floor(col)), r0 = Math.min(grid.rows - 2, Math.floor(row));
  const x = col - c0, y = row - r0;
  const lower = grid.heights[r0 * grid.cols + c0] * (1 - x) + grid.heights[r0 * grid.cols + c0 + 1] * x;
  const upper = grid.heights[(r0 + 1) * grid.cols + c0] * (1 - x) + grid.heights[(r0 + 1) * grid.cols + c0 + 1] * x;
  return lower * (1 - y) + upper * y;
}
