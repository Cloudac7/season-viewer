import type { DayTemperature } from '../types';
import type { CountyWeather, CountySeries } from './counties';
import type { WeatherGrid, WeatherGridSeries } from './spatial-grid';
import type { BiasProvider } from './bias';
import type { TemperatureForecast } from './forecast';

/**
 * Replace model-derived history with an observation-constrained reanalysis
 * (ERA5-Land 0.1°). Recent days missing from the reanalysis (≈5–6 day lag) keep
 * the live model value, so the final series is "real reanalysis history up to
 * the lag boundary + model past_days for the last few days".
 *
 * Applied to a working copy at precompute time, so raw snapshots stay untouched
 * and re-running is idempotent. Forecast days are never replaced by history.
 */

export interface HistoryField {
  version:1;
  source:string;
  model:string;
  fetchedAt:string;
  lagDays:number;
  /** Ascending ISO dates shared by every grid/county array. */
  dates:string[];
  grid:Record<string,(number | null)[]>;
  county:Record<string,(number | null)[]>;
}

function round2(value:number):number { return Math.round(value * 100) / 100; }
function validDate(date:unknown):date is string {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
function validSeries(values:unknown, length:number):values is (number | null)[] {
  return Array.isArray(values) && values.length === length
    && values.every(value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= -100 && value <= 65);
}

export function validHistoryField(value:unknown):value is HistoryField {
  if (!value || typeof value !== 'object') return false;
  const field = value as HistoryField;
  if (field.version !== 1 || typeof field.source !== 'string' || !field.source || typeof field.model !== 'string'
    || !Number.isFinite(field.lagDays) || field.lagDays < 0 || field.lagDays > 30
    || !Array.isArray(field.dates) || !field.dates.length || !field.dates.every(validDate)) return false;
  for (let i = 1; i < field.dates.length; i++) if (field.dates[i] <= field.dates[i - 1]) return false;
  if (!field.grid || typeof field.grid !== 'object' || !field.county || typeof field.county !== 'object') return false;
  const length = field.dates.length;
  return Object.values(field.grid).every(series => validSeries(series, length))
    && Object.values(field.county).every(series => validSeries(series, length));
}

function toDateMap(dates:string[], values:(number | null)[] | undefined):Map<string, number> {
  const map = new Map<string, number>();
  if (!values) return map;
  dates.forEach((date, index) => {
    const value = values[index];
    if (typeof value === 'number' && Number.isFinite(value)) map.set(date, value);
  });
  return map;
}

interface BiasableSeries { lon:number; lat:number; days:DayTemperature[]; forecast?:TemperatureForecast }

function mergeHistoryDays(series:BiasableSeries, history:Map<string, number>, provider:BiasProvider | null):DayTemperature[] {
  return series.days.map(day => {
    const real = history.get(day.date);
    if (real !== undefined) return { date:day.date, mean:round2(real) };
    if (provider && day.mean !== null && Number.isFinite(day.mean)) return { date:day.date, mean:round2(day.mean + provider.offset(series.lon, series.lat, day.date)) };
    return day;
  });
}

function transformSeries<T extends BiasableSeries>(series:T, history:Map<string, number>, provider:BiasProvider | null):T {
  const days = mergeHistoryDays(series, history, provider);
  if (!series.forecast) return { ...series, days };
  const forecast:TemperatureForecast = {
    ...series.forecast,
    days:series.forecast.days.map(day => {
      if (provider && day.mean !== null && Number.isFinite(day.mean)) return { date:day.date, mean:round2(day.mean + provider.offset(series.lon, series.lat, day.date)) };
      return day;
    }),
  };
  return { ...series, days, forecast };
}

export function applyHistoryAndBiasToGrid(weather:WeatherGrid, history:HistoryField | null, provider:BiasProvider | null):WeatherGrid {
  if (!history && !provider) return weather;
  const records:Record<string, WeatherGridSeries> = {};
  for (const [id, series] of Object.entries(weather.records)) {
    const map = history ? toDateMap(history.dates, history.grid[id]) : new Map<string, number>();
    records[id] = transformSeries(series, map, provider);
  }
  return { ...weather, records };
}

export function applyHistoryAndBiasToCounty(counties:CountyWeather, history:HistoryField | null, provider:BiasProvider | null):CountyWeather {
  if (!history && !provider) return counties;
  const records:Record<string, CountySeries> = {};
  for (const [id, series] of Object.entries(counties.records)) {
    const map = history ? toDateMap(history.dates, history.county[id]) : new Map<string, number>();
    records[id] = transformSeries(series, map, provider);
  }
  return { ...counties, records };
}

/** Count how many ISO dates in the retained history the field actually covers for a scope. */
export function historyCoverage(history:HistoryField | null, scope:'grid' | 'county'):{samples:number; latest:string | null} {
  if (!history) return { samples:0, latest:null };
  const table = history[scope];
  let samples = 0, latest:string | null = null;
  for (const values of Object.values(table)) {
    values.forEach((value, index) => {
      if (value !== null && Number.isFinite(value)) { samples++; const date = history.dates[index]; if (!latest || date > latest) latest = date; }
    });
  }
  return { samples, latest };
}
