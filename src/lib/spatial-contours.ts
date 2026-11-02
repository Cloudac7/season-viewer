import { contours } from 'd3-contour';
import { geoMercator } from 'd3-geo';
import type { MultiPolygon, Position } from 'geojson';
import { SEASONS } from '../data';
import type { Season } from '../types';
import { wgsToGcj } from './coordinates';
import { TEMPERATURE_BANDS } from './field';
import { transitionColors } from './map-status';
import { SPATIAL_SEASONS } from './spatial-field';
import type { SpatialFieldResult } from './spatial-field';

export interface SpatialContourLayer {
  key: string;
  kind: 'season' | 'transition' | 'temperature';
  season?: Season;
  target?: Season;
  status?: 1 | 2;
  fill: string;
  path: string;
  /** Optional sampled-cell cover for exact categories at joins and valid-data edges. */
  underlayPath?: string;
  minimum?: number | null;
}

export interface SpatialContours {
  version: 1;
  projection: 'season-atlas-mercator-v1';
  validPath: string;
  layers: SpatialContourLayer[];
  note: string;
}

export function temperatureLayerPaintOrder(layers: readonly SpatialContourLayer[]): { surface: SpatialContourLayer; underlay: boolean }[] {
  return [
    ...layers.filter(surface => surface.minimum === null).map(surface => ({ surface, underlay: false })),
    ...layers.filter(surface => surface.minimum !== null).map(surface => ({ surface, underlay: false })),
    ...layers.filter(surface => surface.minimum !== null && surface.underlayPath).map(surface => ({ surface, underlay: true })),
  ];
}

/** Shared with CountyMap. Assets are generated at deploy time, never in React. */
export const SPATIAL_CONTOUR_PROJECTION = 'season-atlas-mercator-v1';
type Point = [number, number];

function rounded(value: number): string { return String(Math.round(value * 100) / 100); }

function ringPath(ring: Position[], project: (point: Point) => Point, roundCoordinates = true): string {
  let points = ring.slice(0, -1).map(point => [point[0], point[1]] as Point);
  if (points.length < 3) return '';
  // Preserve the marching-squares vertices. Even apparently collinear points
  // can be topology junctions in self-touching rings around missing data.
  const coordinate = (point: Point) => project(point).map(value => roundCoordinates ? rounded(value) : String(value)).join(' ');
  return `M${points.map(coordinate).join('L')}Z`;
}

function geometryPath(geometry: MultiPolygon, project: (point: Point) => Point, roundCoordinates = true): string {
  return geometry.coordinates.map(polygon => polygon.map(ring => ringPath(ring, project, roundCoordinates)).join('')).join('');
}

/** Build compact cell runs for the temperature edge fallback; never fill a hole. */
function rowRunsPath(mask: Uint8Array, rows: number, cols: number, project: (point: Point) => Point): string {
  const segments: string[] = [];
  for (let row = 0; row < rows; row++) {
    let col = 0;
    while (col < cols) {
      if (!mask[row * cols + col]) { col++; continue; }
      const start = col;
      while (col + 1 < cols && mask[row * cols + col + 1]) col++;
      const corners: Point[] = [[start, row], [col + 1, row], [col + 1, row + 1], [start, row + 1]];
      segments.push(`M${corners.map(point => project(point).map(rounded).join(' ')).join('L')}Z`);
      col++;
    }
  }
  return segments.join('');
}

/**
 * Build fixed-color vector surfaces once before deployment. Season IDs are
 * one-hot masks, never continuous values. Only temperature thresholds are
 * interpolated. A separate unsmoothed validity clip preserves missing holes.
 */
export function generateSpatialContours(field: SpatialFieldResult): SpatialContours {
  const { rows, cols } = field, size = rows * cols;
  if (rows < 2 || cols < 2 || field.seasons.length !== size || field.average.length !== size) throw new Error('格点维度与等值面输入不一致');
  const projection = geoMercator().center([104.5, 36.5]).scale(610).translate([420, 271]);
  const project = ([x, y]: Point): Point => projection(wgsToGcj(field.bounds.west + (x - 0.5) * field.step, field.bounds.south + (y - 0.5) * field.step))!;
  const contour = contours().size([cols, rows]).smooth(true);
  const valid = Uint8Array.from(field.seasons, (season, index) => Number(season >= 0 && season < SPATIAL_SEASONS.length && Number.isFinite(field.average[index])));
  const validPath = geometryPath(contour.thresholds([0.5])(Array.from(valid))[0], project);
  // Isotherm rings can terminate at the edge of their finite grid. A one-cell
  // fallback along valid-data edges preserves exact sampled colors and is
  // painted above the interpolated contours.
  const edge = Uint8Array.from(valid, (present, index) => {
    if (!present) return 0;
    const row = Math.floor(index / cols), col = index % cols;
    return Number(row === 0 || row === rows - 1 || col === 0 || col === cols - 1 ||
      !valid[index - 1] || !valid[index + 1] || !valid[index - cols] || !valid[index + cols]);
  });
  const layers: SpatialContourLayer[] = [];
  const addMask = (layer: Omit<SpatialContourLayer, 'path' | 'underlayPath'>, predicate: (index: number) => boolean) => {
    const mask = Uint8Array.from(valid, (present, index) => Number(!!present && predicate(index)));
    if (!mask.some(Boolean)) return;
    // Use the same full-resolution marching-squares vertices as temperature.
    // The previous square cell cover and second corner-rounding pass made the
    // categorical boundary visibly coarser than the rolling-mean isotherms.
    layers.push({ ...layer, path: geometryPath(contour.thresholds([0.5])(Array.from(mask))[0], project, false) });
  };
  SPATIAL_SEASONS.forEach((season, seasonIndex) => addMask({ key: `season:${season}`, kind: 'season', season, fill: SEASONS[season].fill }, index => field.seasons[index] === seasonIndex));
  SPATIAL_SEASONS.forEach((season, seasonIndex) => SPATIAL_SEASONS.forEach((target, targetIndex) => {
    if (season === target) return;
    ([1, 2] as const).forEach(status => addMask({ key: `transition:${season}:${target}:${status}`, kind: 'transition', season, target, status, fill: transitionColors(season, target)[status === 2 ? 'forecast' : 'pending'].fill }, index => field.seasons[index] === seasonIndex && field.targets[index] === targetIndex && field.status[index] === status));
  }));
  if (validPath) {
    // The first temperature band covers valid land; higher thresholds are
    // painted above it, giving shared continuous isotherms and exact colors.
    layers.push({ key: 'temperature:base', kind: 'temperature', fill: TEMPERATURE_BANDS[0].fill, minimum: null, path: validPath });
    const temperatures = Array.from(field.average, (value, index) => valid[index] ? value : NaN);
    const thresholds = TEMPERATURE_BANDS.flatMap(band => band.min === null ? [] : [band.min]);
    const surfaces = contour.thresholds(thresholds)(temperatures);
    surfaces.forEach((surface, index) => {
      const threshold = thresholds[index];
      const edgeMask = Uint8Array.from(edge, (isEdge, cell) => Number(!!isEdge && field.average[cell] >= threshold));
      const underlayPath = rowRunsPath(edgeMask, rows, cols, project);
      if (!surface.coordinates.length && !underlayPath) return;
      // True continuous threshold interpolation already removes pixel steps.
      // Do not round these vertices: an isotherm can lie arbitrarily close to
      // a node whose value is just above/below a band boundary.
      layers.push({ key: `temperature:${threshold}`, kind: 'temperature', minimum: threshold, fill: TEMPERATURE_BANDS[index + 1].fill, path: surface.coordinates.length ? geometryPath(surface, project, false) : '', ...(underlayPath ? { underlayPath } : {}) });
    });
  }
  return { version: 1, projection: SPATIAL_CONTOUR_PROJECTION, validPath, layers,
    note: '部署时生成平滑矢量分级面。季节按独立类别掩膜描边，颜色不插值；均温按连续气温等值面分档。两类图层使用同一套 0.1° 轮廓网格和完整顶点，边界为显示近似，点击读数仍使用原始格点；缺测区域保持空缺。' };
}
