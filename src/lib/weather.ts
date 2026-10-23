import { CITIES } from '../data';
import type { DayTemperature, WeatherDataset } from '../types';
import { addDays, beijingDate } from './season';

const CACHE_KEY = 'sishi-weather-v2';
export const REFRESH_MS = 60 * 60 * 1000;
export function readCache(): WeatherDataset | null {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as WeatherDataset | null;
    if (!data || data.source !== 'live' || !CITIES.every(c => Array.isArray(data.cities?.[c.id]) && data.cities[c.id].length >= 9)) return null;
    return data;
  } catch { return null; }
}
export function createDemo(): WeatherDataset {
  const today = beijingDate();
  return { source: 'demo', updatedAt: new Date().toISOString(), cities: Object.fromEntries(CITIES.map((city, index) => {
    const days = Array.from({ length: 408 }, (_, i) => {
      const date = addDays(today, i - 400);
      const d = new Date(`${date}T00:00:00Z`);
      const doy = (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000;
      const wave = Math.cos((doy - 203) * Math.PI * 2 / 365.25);
      const front = 2.2 * Math.sin(doy / 7.2 + index * .7) + 1.4 * Math.sin(doy / 3.6 + index * .4);
      return { date, mean: Math.round((city.annual + city.amplitude * wave + front) * 10) / 10 };
    });
    return [city.id, days];
  })) };
}
interface ApiLocation { daily?: { time: string[]; temperature_2m_mean: (number | null)[] }; error?: boolean; reason?: string }
async function get(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? '数据源请求频率受限，请稍后重试' : `气温服务暂不可用（${response.status}）`);
  const json = await response.json();
  if (json.error) throw new Error(json.reason ?? '气温服务返回错误');
  return (Array.isArray(json) ? json : [json]) as ApiLocation[];
}
export async function fetchWeather(signal: AbortSignal, previous: WeatherDataset | null = readCache()): Promise<WeatherDataset> {
  const today = beijingDate();
  const common = { latitude: CITIES.map(c => c.lat).join(','), longitude: CITIES.map(c => c.lon).join(','), daily: 'temperature_2m_mean', timezone: 'Asia/Shanghai' };
  const forecast = new URLSearchParams({ ...common, past_days: '14', forecast_days: '8' });
  const archive = new URLSearchParams({ ...common, start_date: addDays(today, -400), end_date: addDays(today, -10) });
  // Refresh only the recent overlap on normal hourly updates. Downloading the
  // entire 400-day archive hourly would waste bandwidth and API quota.
  const recentRequest = get(`https://api.open-meteo.com/v1/forecast?${forecast}`, signal);
  // Attach a rejection handler while checking the baseline to avoid an unhandled
  // rejection if the recent request fails before the local snapshot loads.
  void recentRequest.catch(() => {});
  if (!previous) {
    try {
      const response = await fetch('/data/weather-snapshot.json', { signal });
      if (response.ok) previous = await response.json() as WeatherDataset;
    } catch { /* Node updater or absent snapshot: load the archive below. */ }
  }
  const reusable = previous?.source === 'live' && CITIES.every(city => {
    const history = previous?.cities?.[city.id];
    return Array.isArray(history) && history.length >= 365 && history[0]?.date <= addDays(today,-365) && history.some(d => d.date === addDays(today,-14) && d.mean !== null);
  });
  const historicalRequest: Promise<ApiLocation[]> = reusable
    ? Promise.resolve(CITIES.map(city => ({daily:{time:previous!.cities[city.id].map(d=>d.date),temperature_2m_mean:previous!.cities[city.id].map(d=>d.mean)}})))
    : get(`https://archive-api.open-meteo.com/v1/archive?${archive}`, signal);
  const [recent, historic] = await Promise.all([recentRequest, historicalRequest]);
  if (recent.length !== CITIES.length || historic.length !== CITIES.length) throw new Error('返回的城市覆盖不完整，请重新加载');
  const cities = Object.fromEntries(CITIES.map((city, i) => {
    const merged = new Map<string, DayTemperature>();
    for (const location of [historic[i], recent[i]]) {
      if (!location.daily || location.error) throw new Error(`${city.name}气温数据不完整`);
      location.daily.time.forEach((date, j) => {
        const value = location.daily!.temperature_2m_mean[j];
        merged.set(date, { date, mean: typeof value === 'number' && Number.isFinite(value) ? value : null });
      });
    }
    const days = Array.from(merged.values()).filter(d => d.date >= addDays(today,-400)).sort((a, b) => a.date.localeCompare(b.date));
    if (!days.some(d => d.date === addDays(today, -1) && d.mean !== null)) throw new Error(`${city.name}缺少最新完整日数据`);
    return [city.id, days];
  }));
  const data: WeatherDataset = { source: 'live', updatedAt: new Date().toISOString(), cities };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* storage may be unavailable */ }
  return data;
}
