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

/**
 * A single 0.1° terrain cell occupies only a few device pixels on the national
 * map. Marching-squares smoothing turns such cells into conspicuous diamonds.
 * Apply a cartographic minimum area without changing either the underlying
 * grid classification or the rendered category colors.
 */
const MIN_MAPPED_CATEGORY_CELLS = 8;

function removeSmallComponents(mask: Uint8Array, rows: number, cols: number, minimumCells = MIN_MAPPED_CATEGORY_CELLS): Uint8Array {
  const result = mask.slice(), visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length), component = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++], row = Math.floor(index / cols), col = index % cols;
      component[size++] = index;
      for (let dr = -1; dr <= 1; dr++) {
        const nextRow = row + dr;
        if (nextRow < 0 || nextRow >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const nextCol = col + dc;
          if ((dr === 0 && dc === 0) || nextCol < 0 || nextCol >= cols) continue;
          const next = nextRow * cols + nextCol;
          if (!visited[next] && mask[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (size < minimumCells) {
      for (let index = 0; index < size; index++) result[component[index]] = 0;
    }
  }
  return result;
}

/**
 * Absorb small season islands into a neighbouring stable category. Removing
 * their masks without relabelling would leave pinholes in the surrounding
 * one-hot layer, which look like tiny colored diamonds after vector smoothing.
 */
function consolidateCategories(labels: Int8Array, valid: Uint8Array, rows: number, cols: number, dropUnresolved = false): Int8Array {
  const result = labels.slice(), visited = new Uint8Array(labels.length), componentAt = new Int32Array(labels.length);
  componentAt.fill(-1);
  const components: { label: number; cells: number[]; stable: boolean }[] = [];
  const queue = new Int32Array(labels.length);
  for (let start = 0; start < labels.length; start++) {
    if (!valid[start] || labels[start] < 0 || visited[start]) continue;
    const label = labels[start];
    let head = 0, tail = 0;
    const id = components.length, cells: number[] = [];
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++], row = Math.floor(index / cols), col = index % cols;
      cells.push(index);
      componentAt[index] = id;
      for (let dr = -1; dr <= 1; dr++) {
        const nextRow = row + dr;
        if (nextRow < 0 || nextRow >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const nextCol = col + dc;
          if ((dr === 0 && dc === 0) || nextCol < 0 || nextCol >= cols) continue;
          const next = nextRow * cols + nextCol;
          if (!visited[next] && valid[next] && labels[next] === label) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    components.push({ label, cells, stable: cells.length >= MIN_MAPPED_CATEGORY_CELLS });
  }

  for (let id = 0; id < components.length; id++) {
    const component = components[id];
    if (component.stable) continue;
    const stable = new Map<number, number>(), fallback = new Map<number, number>();
    for (const index of component.cells) {
      const row = Math.floor(index / cols), col = index % cols;
      for (let dr = -1; dr <= 1; dr++) {
        const nextRow = row + dr;
        if (nextRow < 0 || nextRow >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const nextCol = col + dc;
          if ((dr === 0 && dc === 0) || nextCol < 0 || nextCol >= cols) continue;
          const next = nextRow * cols + nextCol, neighbourId = componentAt[next];
          if (!valid[next] || neighbourId < 0 || neighbourId === id) continue;
          const neighbour = components[neighbourId];
          fallback.set(neighbour.label, (fallback.get(neighbour.label) ?? 0) + 1);
          if (neighbour.stable) stable.set(neighbour.label, (stable.get(neighbour.label) ?? 0) + 1);
        }
      }
    }
    const counts = stable.size ? stable : fallback;
    if (!counts.size) {
      if (dropUnresolved) for (const index of component.cells) result[index] = -1;
      continue;
    }
    const replacement = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    for (const index of component.cells) result[index] = replacement;
  }
  return result;
}

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
  const seasons = consolidateCategories(field.seasons, valid, rows, cols);
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
    const mask = removeSmallComponents(
      Uint8Array.from(valid, (present, index) => Number(!!present && predicate(index))),
      rows,
      cols,
    );
    if (!mask.some(Boolean)) return;
    // Use the same full-resolution marching-squares vertices as temperature.
    // The previous square cell cover and second corner-rounding pass made the
    // categorical boundary visibly coarser than the rolling-mean isotherms.
    layers.push({ ...layer, path: geometryPath(contour.thresholds([0.5])(Array.from(mask))[0], project, false) });
  };
  SPATIAL_SEASONS.forEach((season, seasonIndex) => addMask({ key: `season:${season}`, kind: 'season', season, fill: SEASONS[season].fill }, index => seasons[index] === seasonIndex));
  const transitionUnion = Uint8Array.from(valid, (present, index) => Number(!!present && (field.status[index] === 1 || field.status[index] === 2)));
  const compactTransitions = removeSmallComponents(transitionUnion, rows, cols);
  const transitionLabels = new Int8Array(size).fill(-1);
  compactTransitions.forEach((present, index) => {
    if (present && field.seasons[index] >= 0 && field.targets[index] >= 0) {
      transitionLabels[index] = field.seasons[index] * 16 + field.targets[index] * 4 + field.status[index] - 1;
    }
  });
  const transitions = consolidateCategories(transitionLabels, compactTransitions, rows, cols, true);
  SPATIAL_SEASONS.forEach((season, seasonIndex) => SPATIAL_SEASONS.forEach((target, targetIndex) => {
    if (season === target) return;
    ([1, 2] as const).forEach(status => {
      const label = seasonIndex * 16 + targetIndex * 4 + status - 1;
      addMask({ key: `transition:${season}:${target}:${status}`, kind: 'transition', season, target, status, fill: transitionColors(season, target)[status === 2 ? 'forecast' : 'pending'].fill }, index => transitions[index] === label);
    });
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
    note: `部署时生成平滑矢量分级面。季节与换季按独立类别掩膜描边，颜色不插值，并省略小于 ${MIN_MAPPED_CATEGORY_CELLS} 个 0.1° 显示格的孤立类别碎斑；均温按连续气温等值面分档。各类图层使用同一套轮廓网格和完整顶点，边界为显示近似，点击读数仍使用原始格点；缺测区域保持空缺。` };
}
