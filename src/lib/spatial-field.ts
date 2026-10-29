import type { City, DayTemperature, Season, SeasonState } from '../types';
import type { WeatherGrid, WeatherGridCatalog, WeatherGridSeries } from './spatial-grid';
import { gridHistoricalDays } from './spatial-grid';
import type { TerrainGrid } from './terrain';
import { sampleTerrain } from './terrain';
import type { ForecastTransition, TemperatureForecast } from './forecast';
import { forecastIsFresh, projectTransition } from './forecast';
import { addDays, beijingDate, classifyCity } from './season';

/** Fixed environmental lapse rate, an approximation rather than a local sounding. */
export const LAPSE_RATE_C_PER_METER = 0.0065;
export const SPATIAL_SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];

export interface SpatialFieldInput {
  catalog: WeatherGridCatalog;
  weather: WeatherGrid;
  terrain: TerrainGrid;
  date: string;
  /** A fixed evaluation time makes replay and worker results reproducible. */
  now?: string | Date;
}

export interface SpatialTemperatureSeries {
  elevation: number;
  days: DayTemperature[];
  forecast?: TemperatureForecast;
  /** Earliest retrieval among all four contributing weather nodes. */
  updatedAt: string;
}

export interface SpatialCell extends SpatialTemperatureSeries {
  longitude: number;
  latitude: number;
  state: SeasonState | null;
  forecastTransition: ForecastTransition | null;
  status: 'ready' | 'missing' | 'insufficient' | 'stale';
  estimated: boolean;
}

export interface SpatialFieldResult {
  bounds: TerrainGrid['bounds'];
  step: number;
  rows: number;
  cols: number;
  date: string;
  /** Row zero is south; column zero is west. -1 denotes missing data. */
  seasons: Int8Array;
  targets: Int8Array;
  /** Daily mean and 5-day sliding mean respectively; NaN denotes missing. */
  temperature: Float32Array;
  average: Float32Array;
  /** 0 stable, 1 observed transition, 2 forecast completion. Missing uses seasons=-1. */
  status: Uint8Array;
  /** Completion day relative to selected date; zero means no forecast completion. */
  expectedDays: Int8Array;
  transitionDays: Uint8Array;
  estimated: Uint8Array;
  metadata: {
    method: 'daily-temperature-bilinear-with-elevation-correction';
    lapseRateCPerMeter: number;
    weatherGridStep: number;
    displayGridStep: number;
    weatherUpdatedAt: string | null;
    terrainSource: TerrainGrid['source'];
    evaluatedAt: string;
    validCells: number;
    missingCells: number;
    pendingCells: number;
    forecastCells: number;
    note: string;
  };
}

interface PreparedQuad {
  dates: string[];
  /** Four sea-level equivalents per date, ordered SW, SE, NW, NE. */
  history: Float64Array;
  forecast: Float64Array | null;
  forecastDates: string[];
  issuedAt: string | null;
  updatedAt: string;
}
interface Context {
  input: SpatialFieldInput;
  now: Date;
  nodes: Map<number, string>;
  quads: Map<number, PreparedQuad | null>;
}

function context(input: SpatialFieldInput): Context {
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('无效的格点计算时间');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date)) ||
    new Date(input.date).toISOString().slice(0, 10) !== input.date) throw new Error('无效的格点日期');
  if (input.catalog.id !== input.weather.catalogId) throw new Error('天气格点目录与快照不匹配');
  return { input, now, nodes: new Map(input.catalog.nodes.map(node => [node.row * input.catalog.cols + node.col, node.id])), quads: new Map() };
}

function seaLevel(values: (number | null | undefined)[], records: WeatherGridSeries[]): number[] {
  // Missing corners are mandatory even where their interpolation weight is zero:
  // this prevents a pixel on a grid edge from bridging a data hole.
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return [NaN, NaN, NaN, NaN];
  return values.map((value, i) => value! + LAPSE_RATE_C_PER_METER * records[i].elevation);
}

function prepareQuad(ctx: Context, row: number, col: number): PreparedQuad | null {
  const { catalog, weather, date } = ctx.input;
  const key = row * catalog.cols + col;
  if (ctx.quads.has(key)) return ctx.quads.get(key)!;
  const ids = [key, key + 1, key + catalog.cols, key + catalog.cols + 1].map(index => ctx.nodes.get(index));
  const records = ids.map(id => id ? weather.records[id] : undefined);
  if (records.some(record => !record || !Number.isFinite(record.elevation) || record.elevation < -12000 || record.elevation > 9000)) {
    ctx.quads.set(key, null); return null;
  }
  const corners = records as WeatherGridSeries[];
  const histories = corners.map(record => gridHistoricalDays(record).filter(day => day.date <= date));
  if (histories.some(history => !history.length)) { ctx.quads.set(key, null); return null; }
  const start = histories.map(history => history[0].date).sort().at(-1)!;
  const end = histories.map(history => history.at(-1)!.date).sort()[0];
  const maps = histories.map(history => new Map(history.map(day => [day.date, day.mean])));
  const dates: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) dates.push(day);
  const history = new Float64Array(dates.length * 4);
  dates.forEach((day, i) => history.set(seaLevel(maps.map(map => map.get(day)), corners), i * 4));
  const completeForecast = corners.every(record => forecastIsFresh(record.forecast, ctx.now));
  let forecast: Float64Array | null = null;
  const forecastDates: string[] = [];
  let issuedAt: string | null = null;
  if (completeForecast) {
    forecast = new Float64Array(7 * 4);
    for (let i = 0; i < 7; i++) {
      const day = corners[0].forecast!.days[i].date;
      forecastDates.push(day);
      forecast.set(seaLevel(corners.map(record => record.forecast!.days[i].date === day ? record.forecast!.days[i].mean : null), corners), i * 4);
    }
    issuedAt = corners.map(record => record.forecast!.issuedAt).sort()[0];
  }
  const quad = { dates, history, forecast, forecastDates, issuedAt, updatedAt: corners.map(record => record.updatedAt).sort()[0] };
  ctx.quads.set(key, quad);
  return quad;
}

function quadAt(ctx: Context, longitude: number, latitude: number) {
  const { catalog } = ctx.input;
  const x = (longitude - catalog.origin[0]) / catalog.step;
  const y = (latitude - catalog.origin[1]) / catalog.step;
  const epsilon = 1e-8;
  if (![x, y].every(Number.isFinite) || x < -epsilon || y < -epsilon || x > catalog.cols - 1 + epsilon || y > catalog.rows - 1 + epsilon) return null;
  const col = Math.min(catalog.cols - 2, Math.max(0, Math.floor(x)));
  const row = Math.min(catalog.rows - 2, Math.max(0, Math.floor(y)));
  const tx = Math.max(0, Math.min(1, x - col)), ty = Math.max(0, Math.min(1, y - row));
  const quad = prepareQuad(ctx, row, col);
  return quad ? { quad, weights: [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty] } : null;
}

function interpolate(values: Float64Array, offset: number, weights: number[], elevation: number): number | null {
  let value = 0;
  for (let corner = 0; corner < 4; corner++) {
    const reference = values[offset + corner];
    if (!Number.isFinite(reference)) return null;
    value += reference * weights[corner];
  }
  value -= LAPSE_RATE_C_PER_METER * elevation;
  return Number.isFinite(value) && value >= -100 && value <= 65 ? value : null;
}

function sampleSeries(ctx: Context, longitude: number, latitude: number, knownHeight?: number): SpatialTemperatureSeries | null {
  const elevation = knownHeight ?? sampleTerrain(ctx.input.terrain, longitude, latitude);
  if (elevation === null || !Number.isFinite(elevation)) return null;
  const location = quadAt(ctx, longitude, latitude);
  if (!location) return null;
  const { quad, weights } = location;
  const days = quad.dates.map((date, index) => ({ date, mean: interpolate(quad.history, index * 4, weights, elevation) }));
  const forecast: TemperatureForecast | undefined = quad.forecast && quad.issuedAt ? {
    issuedAt: quad.issuedAt,
    days: quad.forecastDates.map((date, index) => ({ date, mean: interpolate(quad.forecast!, index * 4, weights, elevation) })),
  } : undefined;
  return { elevation, days, forecast, updatedAt: quad.updatedAt };
}

/** Interpolates each daily temperature first. It never interpolates seasons or colors. */
export function sampleTemperatureSeries(input: SpatialFieldInput, longitude: number, latitude: number): SpatialTemperatureSeries | null {
  return sampleSeries(context(input), longitude, latitude);
}

function classify(ctx: Context, series: SpatialTemperatureSeries, longitude: number, latitude: number): SpatialCell {
  const { date } = ctx.input;
  const base = { ...series, longitude, latitude, state: null, forecastTransition: null, estimated: true };
  const last = series.days.at(-1);
  if (last?.date !== date || last.mean === null) return { ...base, status: series.days.some(day => day.date < date) ? 'stale' : 'missing' };
  const recent = series.days.slice(-9);
  if (recent.length !== 9 || recent.some((day, i) => day.date !== addDays(date, i - 8) || day.mean === null || !Number.isFinite(day.mean))) return { ...base, status: 'insufficient' };
  const city: City = { id: `grid:${longitude}:${latitude}`, name: '地形订正格点', province: '', code: 0, region: '西北', lat: latitude, lon: longitude, annual: 0, amplitude: 0 };
  const state = classifyCity(city, series.days, date);
  // Only an observed transition can gain a forecast completion state. This
  // keeps pending and forecast-completion masks within the same public
  // definition used by county and city readouts.
  const forecastTransition = date === addDays(beijingDate(ctx.now), -1) && state.transition
    ? projectTransition(state, series.forecast, date, ctx.now) : null;
  return { ...series, longitude, latitude, state, forecastTransition, status: 'ready', estimated: state.estimated };
}

/** Exact-coordinate readout using the same daily interpolation and seasonal rules as the raster. */
export function sampleGridCell(input: SpatialFieldInput, longitude: number, latitude: number): SpatialCell | null {
  const ctx = context(input), series = sampleSeries(ctx, longitude, latitude);
  return series ? classify(ctx, series, longitude, latitude) : null;
}

export function computeSpatialField(input: SpatialFieldInput): SpatialFieldResult {
  const ctx = context(input), { terrain } = input;
  const size = terrain.rows * terrain.cols;
  const seasons = new Int8Array(size).fill(-1), targets = new Int8Array(size).fill(-1);
  const temperature = new Float32Array(size).fill(NaN), average = new Float32Array(size).fill(NaN);
  const status = new Uint8Array(size), expectedDays = new Int8Array(size), transitionDays = new Uint8Array(size), estimated = new Uint8Array(size);
  let validCells = 0, pendingCells = 0, forecastCells = 0;
  for (let row = 0; row < terrain.rows; row++) {
    const latitude = terrain.bounds.south + row * terrain.step;
    for (let col = 0; col < terrain.cols; col++) {
      const index = row * terrain.cols + col, longitude = terrain.bounds.west + col * terrain.step;
      const series = sampleSeries(ctx, longitude, latitude, terrain.heights[index]);
      if (!series) continue;
      const reading = classify(ctx, series, longitude, latitude), state = reading.state;
      if (!state || state.average === null || state.temperature === null) continue;
      validCells++;
      seasons[index] = SPATIAL_SEASONS.indexOf(state.season);
      temperature[index] = state.temperature;
      average[index] = state.average;
      estimated[index] = Number(state.estimated);
      transitionDays[index] = state.transition?.days ?? 0;
      const forecast = reading.forecastTransition;
      if (forecast) {
        status[index] = 2; targets[index] = SPATIAL_SEASONS.indexOf(forecast.target); expectedDays[index] = forecast.forecastDays; forecastCells++;
      } else if (state.transition) {
        status[index] = 1; targets[index] = SPATIAL_SEASONS.indexOf(state.transition.target); pendingCells++;
      }
    }
  }
  return { bounds: { ...terrain.bounds }, step: terrain.step, rows: terrain.rows, cols: terrain.cols, date: input.date,
    seasons, targets, temperature, average, status, expectedDays, transitionDays, estimated,
    metadata: { method: 'daily-temperature-bilinear-with-elevation-correction', lapseRateCPerMeter: LAPSE_RATE_C_PER_METER,
      weatherGridStep: input.catalog.step, displayGridStep: terrain.step, weatherUpdatedAt: input.weather.updatedAt,
      terrainSource: terrain.source, evaluatedAt: ctx.now.toISOString(), validCells, missingCells: size - validCells, pendingCells, forecastCells,
      note: '独立天气格点逐日气温先按 6.5°C/km 归算至参考高度，四邻双线性插值后按真实 DEM 高程订正，再逐格计算滑动季节与预报换季。固定递减率为近似，未融合地面实况，细网格不是实际天气分辨率；缺邻点、缺完整日不填补。' },
  };
}

export interface SpatialFieldWorkerRequest { id: number | string; input: SpatialFieldInput }
export type SpatialFieldWorkerResponse = { id: number | string; result: SpatialFieldResult } | { id: number | string; error: string };
