import type { DayTemperature } from '../types';
import type { CountyWeather, CountySeries } from './counties';
import type { WeatherGrid, WeatherGridSeries } from './spatial-grid';
import type { TemperatureForecast } from './forecast';

/**
 * Station-based additive bias correction for daily mean temperature.
 *
 * Model output (`temperature_2m_mean`) carries systematic local bias against
 * ground observations. This module turns free station observations into a
 * monthly residual field (observation − model) and applies it to gridded /
 * representative-point series. It is deliberately pure so the calibration can
 * be validated offline against a held-out station split.
 */

export interface StationDaily { date:string; mean:number }
export interface StationRecord {
  id:string; name?:string; lon:number; lat:number; elevation:number | null;
  daily:StationDaily[];
}
export interface StationBiasPoint {
  lon:number; lat:number; elevation:number | null;
  /** Additive residual (°C, obs − model) for Jan..Dec; null when unobserved. */
  monthly:(number | null)[];
}
export interface BiasField {
  version:1; method:'idw'; source:string; radiusKm:number;
  calibration:{ start:string; end:string; stations:number; samples:number };
  points:StationBiasPoint[];
}
export interface BiasProvider { offset(lon:number, lat:number, date:string):number }

export interface AccuracyMetrics {
  count:number; bias:number | null; rmse:number | null; mae:number | null;
}

const MONTHS = 12;
function round1(value:number):number { return Math.round(value * 10) / 10; }
function round2(value:number):number { return Math.round(value * 100) / 100; }
function finiteInRange(value:number, min:number, max:number):boolean { return Number.isFinite(value) && value >= min && value <= max; }
function monthIndex(date:string):number { const month = Number(date.slice(5, 7)); return Number.isInteger(month) && month >= 1 && month <= 12 ? month - 1 : -1; }

/** Great-circle distance in kilometres (haversine, mean Earth radius). */
export function haversineKm(aLon:number, aLat:number, bLon:number, bLat:number):number {
  const toRad = Math.PI / 180, dLat = (bLat - aLat) * toRad, dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Mean observation-minus-model residual per calendar month over a shared date
 * range. Only days present in both series with finite values contribute.
 */
export function computeMonthlyResiduals(
  observed:DayTemperature[], modelled:DayTemperature[],
  options:{ start?:string; end?:string } = {},
):{ monthly:(number | null)[]; samples:number } {
  const model = new Map<string, number>();
  for (const day of modelled) if (day.mean !== null && Number.isFinite(day.mean)) model.set(day.date, day.mean);
  const sums = new Array<number>(MONTHS).fill(0), counts = new Array<number>(MONTHS).fill(0);
  let samples = 0;
  for (const day of observed) {
    if (day.mean === null || !finiteInRange(day.mean, -100, 65)) continue;
    if (options.start && day.date < options.start) continue;
    if (options.end && day.date > options.end) continue;
    const value = model.get(day.date);
    if (value === undefined || !Number.isFinite(value)) continue;
    const month = monthIndex(day.date);
    if (month < 0) continue;
    sums[month] += day.mean - value; counts[month] += 1; samples += 1;
  }
  const monthly = sums.map((sum, index) => counts[index] ? round2(sum / counts[index]) : null);
  return { monthly, samples };
}

/** Assemble a validated IDW bias field from per-station monthly residuals. */
export function buildBiasField(
  stations:{ lon:number; lat:number; elevation:number | null; monthly:(number | null)[] }[],
  options:{ source:string; radiusKm:number; start:string; end:string; samples:number },
):BiasField {
  const points:StationBiasPoint[] = stations
    .filter(station => finiteInRange(station.lon, -180, 180) && finiteInRange(station.lat, -90, 90)
      && station.monthly.length === MONTHS && station.monthly.some(value => value !== null && finiteInRange(value, -60, 60)))
    .map(station => ({
      lon:round2(station.lon), lat:round2(station.lat),
      elevation:typeof station.elevation === 'number' && Number.isFinite(station.elevation) ? station.elevation : null,
      monthly:station.monthly.map(value => value !== null && finiteInRange(value, -60, 60) ? round2(value) : null),
    }));
  return {
    version:1, method:'idw', source:options.source, radiusKm:options.radiusKm,
    calibration:{ start:options.start, end:options.end, stations:points.length, samples:options.samples },
    points,
  };
}

/** Monthly residual for a point, falling back to its available-month mean, else 0. */
export function monthlyOffset(point:StationBiasPoint, month:number):number {
  const direct = month >= 0 && month < MONTHS ? point.monthly[month] : null;
  if (direct !== null && Number.isFinite(direct)) return direct;
  const available = point.monthly.filter((value):value is number => value !== null && Number.isFinite(value));
  if (!available.length) return 0;
  return available.reduce((sum, value) => sum + value, 0) / available.length;
}

/** Inverse-distance weighted additive offset (°C) at a location, 0 if no station is near. */
export function biasOffsetAt(field:BiasField, lon:number, lat:number, date:string, maxKm = field.radiusKm):number {
  const month = monthIndex(date);
  let weighted = 0, weight = 0, exact:number | null = null;
  for (const point of field.points) {
    const distance = haversineKm(lon, lat, point.lon, point.lat);
    if (distance > maxKm) continue;
    const offset = monthlyOffset(point, month);
    if (distance < 0.5) { exact = offset; continue; }
    const w = 1 / (distance * distance);
    weighted += w * offset; weight += w;
  }
  if (exact !== null) return round2(exact);
  if (weight === 0) return 0;
  return round2(weighted / weight);
}

/** Wrap a validated field in the small interface consumed by the precompute step. */
export function createBiasProvider(field:BiasField | null | undefined):BiasProvider | null {
  if (!field || field.version !== 1 || field.method !== 'idw' || !Array.isArray(field.points) || !field.points.length) return null;
  return { offset:(lon, lat, date) => biasOffsetAt(field, lon, lat, date) };
}

function shiftDays(days:DayTemperature[], lon:number, lat:number, provider:BiasProvider):DayTemperature[] {
  return days.map(day => {
    if (day.mean === null || !Number.isFinite(day.mean)) return day;
    return { date:day.date, mean:round2(day.mean + provider.offset(lon, lat, day.date)) };
  });
}
interface BiasableSeries { lon:number; lat:number; days:DayTemperature[]; forecast?:TemperatureForecast }
function biasSeries<T extends BiasableSeries>(series:T, provider:BiasProvider):T {
  const days = shiftDays(series.days, series.lon, series.lat, provider);
  if (!series.forecast) return { ...series, days };
  const forecast:TemperatureForecast = { ...series.forecast, days:shiftDays(series.forecast.days, series.lon, series.lat, provider) };
  return { ...series, days, forecast };
}

/**
 * Apply a bias provider to a grid snapshot. Returns the input untouched when no
 * provider is available, so raw snapshots remain backward compatible.
 */
export function applyBiasToGrid(weather:WeatherGrid, provider:BiasProvider | null):WeatherGrid {
  if (!provider) return weather;
  const records:Record<string, WeatherGridSeries> = {};
  for (const [id, series] of Object.entries(weather.records)) records[id] = biasSeries(series, provider);
  return { ...weather, records };
}

/** Apply a bias provider to a county snapshot (raw snapshot stays unchanged). */
export function applyBiasToCounty(counties:CountyWeather, provider:BiasProvider | null):CountyWeather {
  if (!provider) return counties;
  const records:Record<string, CountySeries> = {};
  for (const [id, series] of Object.entries(counties.records)) records[id] = biasSeries(series, provider);
  return { ...counties, records };
}

/** Bias / RMSE / MAE of model values against observations. */
export function evaluateAccuracy(pairs:{ obs:number; model:number }[]):AccuracyMetrics {
  const valid = pairs.filter(pair => Number.isFinite(pair.obs) && Number.isFinite(pair.model));
  if (!valid.length) return { count:0, bias:null, rmse:null, mae:null };
  let sum = 0, sq = 0, abs = 0;
  for (const pair of valid) { const diff = pair.obs - pair.model; sum += diff; sq += diff * diff; abs += Math.abs(diff); }
  const count = valid.length;
  return { count, bias:round2(sum / count), rmse:round2(Math.sqrt(sq / count)), mae:round2(abs / count) };
}

export function validBiasField(value:unknown):value is BiasField {
  if (!value || typeof value !== 'object') return false;
  const field = value as BiasField;
  if (field.version !== 1 || field.method !== 'idw' || typeof field.source !== 'string' || !field.source
    || !finiteInRange(field.radiusKm, 1, 2000) || !Array.isArray(field.points) || !field.points.length) return false;
  const calibration = field.calibration;
  if (!calibration || typeof calibration.start !== 'string' || typeof calibration.end !== 'string'
    || !Number.isInteger(calibration.stations) || !Number.isInteger(calibration.samples)) return false;
  return field.points.every(point => point && finiteInRange(point.lon, -180, 180) && finiteInRange(point.lat, -90, 90)
    && (point.elevation === null || Number.isFinite(point.elevation))
    && Array.isArray(point.monthly) && point.monthly.length === MONTHS
    && point.monthly.every(value => value === null || finiteInRange(value, -60, 60)));
}

function numberOrNull(raw:string | undefined):number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(value) || Math.abs(value) > 1000) return null;
  return value;
}

/** Minimal RFC-4180 CSV line splitter: honours quoted fields that contain commas. */
function parseCsvLine(line:string):string[] {
  const cells:string[] = []; let current = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') { if (line[i + 1] === '"') { current += '"'; i++; } else quoted = false; }
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

/**
 * NOAA GHCN-Daily station CSV (NCEI `access/{station}.csv`). Fields are quoted
 * and temperatures are stored in tenths of °C; the daily mean uses TAVG when
 * present, else (TMAX+TMIN)/2. Missing sentinels (empty / ±9999) become null.
 */
export function parseGhcnDailyCsv(csv:string, meta:Partial<Pick<StationRecord, 'id' | 'name' | 'lat' | 'lon' | 'elevation'>> = {}):StationRecord {
  const lines = csv.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) throw new Error('GHCN CSV is empty');
  const header = parseCsvLine(lines[0]).map(cell => cell.trim().toUpperCase());
  const column = (...names:string[]) => { for (const name of names) { const index = header.indexOf(name); if (index >= 0) return index; } return -1; };
  const dateIndex = column('DATE');
  if (dateIndex < 0) throw new Error('GHCN CSV has no DATE column');
  const tavgIndex = column('TAVG', 'TEMP'), tmaxIndex = column('TMAX'), tminIndex = column('TMIN');
  const daily:StationDaily[] = [];
  let id = meta.id, name = meta.name, lon = meta.lon, lat = meta.lat, elevation = meta.elevation ?? null;
  for (let row = 1; row < lines.length; row++) {
    const cells = parseCsvLine(lines[row]);
    const date = cells[dateIndex]?.trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (id === undefined) id = cells[column('STATION')]?.trim();
    if (name === undefined) name = cells[column('NAME')]?.trim();
    if (lat === undefined) lat = numberOrNull(cells[column('LATITUDE')]) ?? undefined;
    if (lon === undefined) lon = numberOrNull(cells[column('LONGITUDE')]) ?? undefined;
    if (elevation === null) elevation = numberOrNull(cells[column('ELEVATION')]);
    const tavg = numberOrNull(cells[tavgIndex]);
    const tmax = numberOrNull(cells[tmaxIndex]);
    const tmin = numberOrNull(cells[tminIndex]);
    // GHCN access CSV reports tenths of °C.
    const tenths = tavg !== null ? tavg : tmax !== null && tmin !== null ? (tmax + tmin) / 2 : null;
    if (tenths === null) continue;
    const mean = tenths / 10;
    if (finiteInRange(mean, -100, 65)) daily.push({ date, mean:round1(mean) });
  }
  if (!id || lat === undefined || lon === undefined) throw new Error('GHCN CSV is missing station identity or coordinates');
  return { id, name, lon, lat, elevation, daily };
}

/** Meteostat bulk CSV (per-station): uses `tavg`, else mean of `tmin`/`tmax`. */
export function parseMeteostatCsv(csv:string, meta:Pick<StationRecord, 'id' | 'lon' | 'lat'> & Partial<Pick<StationRecord, 'name' | 'elevation'>>):StationRecord {
  const lines = csv.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) throw new Error('Meteostat CSV is empty');
  const header = parseCsvLine(lines[0]).map(cell => cell.trim().toLowerCase());
  const dateIndex = header.indexOf('date');
  if (dateIndex < 0) throw new Error('Meteostat CSV has no date column');
  const tavgIndex = header.indexOf('tavg'), tmaxIndex = header.indexOf('tmax'), tminIndex = header.indexOf('tmin');
  const daily:StationDaily[] = [];
  for (let row = 1; row < lines.length; row++) {
    const cells = parseCsvLine(lines[row]);
    const date = cells[dateIndex]?.trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const tavg = numberOrNull(cells[tavgIndex]), tmax = numberOrNull(cells[tmaxIndex]), tmin = numberOrNull(cells[tminIndex]);
    const mean = tavg !== null ? tavg : tmax !== null && tmin !== null ? (tmax + tmin) / 2 : null;
    if (mean !== null && finiteInRange(mean, -100, 65)) daily.push({ date, mean:round1(mean) });
  }
  return { id:meta.id, name:meta.name, lon:meta.lon, lat:meta.lat, elevation:meta.elevation ?? null, daily };
}

/** Normalise a `{stations:[...]}` payload or bare array of station records. */
export function parseStationJson(value:unknown):StationRecord[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { stations?:unknown }).stations) ? (value as { stations:unknown[] }).stations : null;
  if (!list) throw new Error('Station JSON must be an array or {stations:[...]}');
  const records:StationRecord[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as StationRecord;
    if (typeof item.id !== 'string' || !item.id || !finiteInRange(item.lon, -180, 180) || !finiteInRange(item.lat, -90, 90) || !Array.isArray(item.daily)) continue;
    const daily = item.daily.filter(day => day && typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
      && typeof day.mean === 'number' && finiteInRange(day.mean, -100, 65)).map(day => ({ date:day.date, mean:round1(day.mean) }));
    records.push({ id:item.id, name:item.name, lon:item.lon, lat:item.lat, elevation:typeof item.elevation === 'number' && Number.isFinite(item.elevation) ? item.elevation : null, daily });
  }
  return records;
}
