import type { GeoProjection } from 'd3-geo';
import { SEASONS } from '../data';
import type { Season } from '../types';
import { gcjToWgs, wgsToGcj } from './coordinates';
import { temperatureColor } from './field';
import { transitionColors } from './map-status';
import { SPATIAL_SEASONS } from './spatial-field';
import type { SpatialFieldResult } from './spatial-field';

export interface SpatialRasterOptions {
  projection: GeoProjection;
  layer: 'season' | 'temperature';
  showTransitions: boolean;
  filter: Season | 'all';
  width?: number;
  height?: number;
  pixelRatio?: number;
}
export interface ProjectedSpatialRaster { url: string; x: number; y: number; width: number; height: number }
type ColorOptions = Pick<SpatialRasterOptions, 'layer' | 'showTransitions' | 'filter'>;

/** Season categories and transition classes are never averaged into a color. */
export function spatialCellAppearance(field: SpatialFieldResult, index: number, options: ColorOptions): { fill: string; opacity: number } | null {
  const season = SPATIAL_SEASONS[field.seasons[index]];
  if (!season || !Number.isFinite(field.average[index])) return null;
  const target = SPATIAL_SEASONS[field.targets[index]];
  let fill = options.layer === 'temperature' ? temperatureColor(field.average[index]) : SEASONS[season].fill;
  if (options.showTransitions && target && field.status[index] > 0) {
    fill = transitionColors(season, target)[field.status[index] === 2 ? 'forecast' : 'pending'].fill;
  }
  return { fill, opacity: options.filter === 'all' || season === options.filter ? 1 : 0.18 };
}

interface RasterMapping {
  x: number; y: number; width: number; height: number;
  pixelWidth: number; pixelHeight: number; indices: Int32Array;
}
const mappingCache = new WeakMap<GeoProjection, Map<string, RasterMapping>>();

function rasterMapping(field: SpatialFieldResult, options: SpatialRasterOptions): RasterMapping | null {
  const { projection } = options;
  if (!projection.invert) return null;
  const viewportWidth = options.width ?? 840, viewportHeight = options.height ?? 550;
  const ratio = Math.max(1, Math.min(3, options.pixelRatio ?? 2));
  // Projection instances can be reconfigured, so include their current settings
  // rather than relying only on object identity.
  const key = JSON.stringify([field.bounds, field.step, field.rows, field.cols, viewportWidth, viewportHeight, ratio,
    projection.scale(), projection.translate(), projection.center(), projection.rotate(), projection.angle(), projection.reflectX(), projection.reflectY()]);
  let cache = mappingCache.get(projection);
  const previous = cache?.get(key);
  if (previous) return previous;
  const { west, east, south, north } = field.bounds, half = field.step / 2;
  const edge: [number, number][] = [];
  for (let i = 0; i <= 32; i++) {
    const longitude = west - half + (east - west + field.step) * i / 32;
    const latitude = south - half + (north - south + field.step) * i / 32;
    for (const point of [[longitude, south - half], [longitude, north + half], [west - half, latitude], [east + half, latitude]]) {
      const projected = projection(wgsToGcj(point[0], point[1]));
      if (projected) edge.push(projected);
    }
  }
  if (!edge.length) return null;
  const x = Math.max(0, Math.floor(Math.min(...edge.map(point => point[0]))));
  const y = Math.max(0, Math.floor(Math.min(...edge.map(point => point[1]))));
  const width = Math.min(viewportWidth, Math.ceil(Math.max(...edge.map(point => point[0])))) - x;
  const height = Math.min(viewportHeight, Math.ceil(Math.max(...edge.map(point => point[1])))) - y;
  if (width <= 0 || height <= 0) return null;
  const pixelWidth = Math.ceil(width * ratio), pixelHeight = Math.ceil(height * ratio);
  const indices = new Int32Array(pixelWidth * pixelHeight).fill(-1);
  for (let row = 0; row < pixelHeight; row++) {
    const screenY = y + (row + 0.5) * height / pixelHeight;
    for (let col = 0; col < pixelWidth; col++) {
      const gcj = projection.invert([x + (col + 0.5) * width / pixelWidth, screenY]);
      if (!gcj) continue;
      const [longitude, latitude] = gcjToWgs(gcj[0], gcj[1]);
      const c = Math.round((longitude - west) / field.step), r = Math.round((latitude - south) / field.step);
      if (c >= 0 && c < field.cols && r >= 0 && r < field.rows) indices[row * pixelWidth + col] = r * field.cols + c;
    }
  }
  const result = { x, y, width, height, pixelWidth, pixelHeight, indices };
  if (!cache) { cache = new Map(); mappingCache.set(projection, cache); }
  // A projection usually has one active grid; bound retained buffers on resize.
  if (cache.size >= 3) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

/**
 * Reprojects each output pixel to WGS84 and chooses its nearest categorical
 * display cell. No blur, interpolation of labels, or alpha/color normalization.
 * The caller clips the returned SVG image to the China land boundary.
 */
export function renderSpatialRaster(field: SpatialFieldResult, options: SpatialRasterOptions): ProjectedSpatialRaster | null {
  if (typeof document === 'undefined') return null;
  const mapping = rasterMapping(field, options);
  if (!mapping) return null;
  const canvas = document.createElement('canvas');
  canvas.width = mapping.pixelWidth; canvas.height = mapping.pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  const cellColors = new Uint8ClampedArray(field.seasons.length * 4);
  const colors = new Map<string, [number, number, number]>();
  for (let index = 0; index < field.seasons.length; index++) {
    const appearance = spatialCellAppearance(field, index, options);
    if (!appearance) continue;
    let rgb = colors.get(appearance.fill);
    if (!rgb) {
      const value = Number.parseInt(appearance.fill.slice(1), 16);
      rgb = [value >> 16 & 255, value >> 8 & 255, value & 255]; colors.set(appearance.fill, rgb);
    }
    const offset = index * 4;
    cellColors[offset] = rgb[0]; cellColors[offset + 1] = rgb[1]; cellColors[offset + 2] = rgb[2];
    cellColors[offset + 3] = Math.round(appearance.opacity * 255);
  }
  const image = context.createImageData(canvas.width, canvas.height), pixels = image.data;
  for (let index = 0; index < mapping.indices.length; index++) {
    const cell = mapping.indices[index];
    if (cell < 0) continue;
    const source = cell * 4, output = index * 4;
    pixels[output] = cellColors[source]; pixels[output + 1] = cellColors[source + 1];
    pixels[output + 2] = cellColors[source + 2]; pixels[output + 3] = cellColors[source + 3];
  }
  context.putImageData(image, 0, 0);
  return { url: canvas.toDataURL('image/png'), x: mapping.x, y: mapping.y, width: mapping.width, height: mapping.height };
}
