import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { biasOffsetAt, buildBiasField, computeMonthlyResiduals, evaluateAccuracy, parseStationJson } from '../src/lib/bias';
import type { StationRecord } from '../src/lib/bias';
import { addDays, beijingDate } from '../src/lib/season';
import { fetchModelDaily } from './station-model';

/**
 * Held-out evaluation of the station bias correction.
 *
 * Usage: node --import tsx scripts/evaluate-accuracy.ts [--window=60] [--radius=150] [--limit=N]
 * Splits stations deterministically into calibration (~70%) and held-out (~30%),
 * builds the bias field from calibration only, and reports RMSE / bias / MAE on
 * the held-out stations before and after applying the correction.
 */

const args = process.argv.slice(2);
const numOption = (name:string, fallback:number):number => {
  const raw = args.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const isHeldOut = (id:string):boolean => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 10 >= 7;
};

const project = resolve(new URL('../', import.meta.url).pathname);

async function main():Promise<void> {
  const snapshot = JSON.parse(await readFile(resolve(project, 'data-sources/stations.json'), 'utf8'));
  let stations: StationRecord[] = parseStationJson(snapshot);
  const limit = numOption('limit', 0);
  if (limit > 0) stations = stations.slice(0, limit);
  if (!stations.length) throw new Error('No stations; run import-stations first');

  const window = Math.max(7, Math.min(92, Math.round(numOption('window', 60))));
  const radius = Math.max(20, Math.min(1000, numOption('radius', 150)));
  const endOption = args.find(value => value.startsWith('--end='))?.split('=')[1];
  const end = endOption && /^\d{4}-\d{2}-\d{2}$/.test(endOption) ? endOption : addDays(beijingDate(), -1);
  const start = addDays(end, -(window - 1));

  const model = await fetchModelDaily(stations, { pastDays:window });
  const calibration = stations.filter(station => !isHeldOut(station.id));
  const heldOut = stations.filter(station => isHeldOut(station.id));
  if (!calibration.length || !heldOut.length) throw new Error('Need both calibration and held-out stations');

  const residuals: { lon:number; lat:number; elevation:number | null; monthly:(number | null)[] }[] = [];
  let samples = 0, calibrationResidualSum = 0, calibrationResidualCount = 0;
  for (const station of calibration) {
    const result = computeMonthlyResiduals(station.daily, model.get(station.id) ?? [], { start, end });
    if (result.samples === 0) continue;
    samples += result.samples;
    residuals.push({ lon:station.lon, lat:station.lat, elevation:station.elevation, monthly:result.monthly });
    const series = new Map((model.get(station.id) ?? []).filter(day => day.mean !== null).map(day => [day.date, day.mean as number]));
    for (const day of station.daily) {
      if (day.date < start || day.date > end) continue;
      const modelled = series.get(day.date);
      if (modelled === undefined || !Number.isFinite(modelled)) continue;
      calibrationResidualSum += day.mean - modelled; calibrationResidualCount += 1;
    }
  }
  const globalBias = calibrationResidualCount ? calibrationResidualSum / calibrationResidualCount : 0;
  const field = buildBiasField(residuals, { source:'noaa-ghcn-daily+meteostat', radiusKm:radius, start, end, samples });

  const before: { obs:number; model:number }[] = [];
  const after: { obs:number; model:number }[] = [];
  const afterGlobal: { obs:number; model:number }[] = [];
  for (const station of heldOut) {
    const series = new Map((model.get(station.id) ?? []).filter(day => day.mean !== null).map(day => [day.date, day.mean as number]));
    for (const day of station.daily) {
      if (day.date < start || day.date > end) continue;
      const modelled = series.get(day.date);
      if (modelled === undefined || !Number.isFinite(modelled)) continue;
      before.push({ obs:day.mean, model:modelled });
      after.push({ obs:day.mean, model:modelled + biasOffsetAt(field, station.lon, station.lat, day.date) });
      afterGlobal.push({ obs:day.mean, model:modelled + globalBias });
    }
  }

  const report = {
    generatedAt:new Date().toISOString(), window, radius,
    calibrationStations:calibration.length, heldOutStations:heldOut.length, samples,
    globalBias:Math.round(globalBias * 100) / 100,
    before:evaluateAccuracy(before), after:evaluateAccuracy(after), afterGlobal:evaluateAccuracy(afterGlobal),
  };
  console.log(JSON.stringify(report, null, 2));
  await mkdir(resolve(project, 'artifacts'), { recursive:true });
  await writeFile(resolve(project, 'artifacts/bias-evaluation.json'), JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
