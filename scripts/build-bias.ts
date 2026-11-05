import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildBiasField, computeMonthlyResiduals, parseStationJson } from '../src/lib/bias';
import type { StationRecord } from '../src/lib/bias';
import { addDays, beijingDate } from '../src/lib/season';
import { fetchModelDaily } from './station-model';

/**
 * Build the station-derived bias field consumed by precompute.
 *
 * Usage: node --import tsx scripts/build-bias.ts [--window=60] [--radius=150] [--limit=N] [--out=<path>]
 * Reads data-sources/stations.json, compares the production model against each
 * station's observations over the recent window, and writes per-station monthly
 * residuals to public/data/bias-field.json.
 */

const args = process.argv.slice(2);
const numOption = (name:string, fallback:number):number => {
  const raw = args.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const project = resolve(new URL('../', import.meta.url).pathname);
const stationsPath = resolve(project, 'data-sources/stations.json');
const outputPath = resolve(args.find(value => value.startsWith('--out='))?.split('=')[1] ?? resolve(project, 'public/data/bias-field.json'));

async function main():Promise<void> {
  const snapshot = JSON.parse(await readFile(stationsPath, 'utf8'));
  let stations: StationRecord[] = parseStationJson(snapshot);
  const limit = numOption('limit', 0);
  if (limit > 0) stations = stations.slice(0, limit);
  if (!stations.length) throw new Error(`No stations in ${stationsPath}; run import-stations first`);

  const window = Math.max(7, Math.min(92, Math.round(numOption('window', 60))));
  const radius = Math.max(20, Math.min(1000, numOption('radius', 150)));
  const endOption = args.find(value => value.startsWith('--end='))?.split('=')[1];
  const end = endOption && /^\d{4}-\d{2}-\d{2}$/.test(endOption) ? endOption : addDays(beijingDate(), -1);
  const start = addDays(end, -(window - 1));
  console.log(`Calibrating ${stations.length} stations over ${start}..${end} (${window} days)`);

  const model = await fetchModelDaily(stations, { pastDays:window });
  const residuals: { lon:number; lat:number; elevation:number | null; monthly:(number | null)[] }[] = [];
  let samples = 0;
  for (const station of stations) {
    const modelled = model.get(station.id) ?? [];
    const result = computeMonthlyResiduals(station.daily, modelled, { start, end });
    if (result.samples === 0) continue;
    samples += result.samples;
    residuals.push({ lon:station.lon, lat:station.lat, elevation:station.elevation, monthly:result.monthly });
  }
  if (!residuals.length) throw new Error('No station residuals could be computed');

  const field = buildBiasField(residuals, { source:'noaa-ghcn-daily+meteostat', radiusKm:radius, start, end, samples });
  await mkdir(resolve(project, 'public/data'), { recursive:true });
  await writeFile(outputPath, JSON.stringify(field));
  console.log(`Wrote bias field: ${field.points.length} points, ${samples} samples, radius ${radius} km -> ${outputPath}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
