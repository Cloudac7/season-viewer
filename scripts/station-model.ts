import { fetchOpenMeteo, OPEN_METEO_FORECAST_MODELS } from '../src/lib/open-meteo';
import type { StationRecord } from '../src/lib/bias';
import type { DayTemperature } from '../src/types';

export const STATION_BATCH_SIZE = 100;

/**
 * Fetch the model's own daily mean series at each station location over the
 * recent window, so it can be compared against observations to form residuals.
 * Uses the same endpoint and model as production requests.
 */
export async function fetchModelDaily(
  stations: StationRecord[],
  options: { pastDays: number; model?: string },
): Promise<Map<string, DayTemperature[]>> {
  const model = options.model ?? OPEN_METEO_FORECAST_MODELS;
  const result = new Map<string, DayTemperature[]>();
  for (let i = 0; i < stations.length; i += STATION_BATCH_SIZE) {
    const batch = stations.slice(i, i + STATION_BATCH_SIZE);
    const params = new URLSearchParams({
      latitude: batch.map(s => s.lat).join(','),
      longitude: batch.map(s => s.lon).join(','),
      daily: 'temperature_2m_mean',
      timezone: 'Asia/Shanghai',
      past_days: String(options.pastDays),
      forecast_days: '1',
      models: model,
    });
    const response = await fetchOpenMeteo(params, AbortSignal.timeout(60_000));
    const body = await response.json();
    if (body.error) throw new Error(body.reason ?? 'station model response invalid');
    const list = (Array.isArray(body) ? body : [body]) as { daily?: { time: string[]; temperature_2m_mean: (number | null)[] } }[];
    if (list.length !== batch.length) throw new Error(`station model batch incomplete: ${list.length}/${batch.length}`);
    batch.forEach((station, index) => {
      const daily = list[index]?.daily;
      if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.temperature_2m_mean)) { result.set(station.id, []); return; }
      result.set(station.id, daily.time.map((date, j) => {
        const value = daily.temperature_2m_mean[j];
        return { date, mean: typeof value === 'number' && Number.isFinite(value) ? value : null };
      }));
    });
  }
  return result;
}
