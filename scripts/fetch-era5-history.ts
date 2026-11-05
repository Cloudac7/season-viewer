import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addDays, beijingDate } from '../src/lib/season';

/**
 * Build ERA5-Land 0.1° daily-mean history for precompute.
 *
 * The Open-Meteo archive endpoint meters calls (≈500 location-calls/minute), so
 * this script fetches the 1° grid nodes (which themselves cover China + halo),
 * honours `x-ratelimit-remaining`, and then derives county representative-point
 * history by bilinear interpolation from that grid. Recent days beyond the
 * ERA5-Land lag stay null and fall back to the live model at merge time.
 *
 * Usage: node --import tsx scripts/fetch-era5-history.ts [--days=30] [--scope=both|grid|county] [--limit=N] [--out=<path>]
 */

const args = process.argv.slice(2);
const option = (name:string):string | undefined => args.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
const num = (name:string, fallback:number):number => { const raw = option(name); const n = raw === undefined ? NaN : Number(raw); return Number.isFinite(n) ? n : fallback; };
const sleep = (ms:number) => new Promise(r => setTimeout(r, ms));

const project = resolve(new URL('../', import.meta.url).pathname);
const directory = resolve(project, 'public/data');
const outputPath = resolve(option('out') ?? resolve(directory, 'history-era5.json'));
const scope = (option('scope') ?? 'both') as 'both' | 'grid' | 'county';
const limit = num('limit', 0);
const days = Math.max(7, Math.min(120, Math.round(num('days', 30))));
const BATCH = 100;
const WINDOW_WAIT_MS = 61_000;

interface Point { id:string; lon:number; lat:number }
let rateRemaining:number | null = null;

async function fetchBatch(points:Point[], start:string, end:string):Promise<Map<string,(number | null)[]>> {
  const params = new URLSearchParams({
    latitude:points.map(p => p.lat).join(','),
    longitude:points.map(p => p.lon).join(','),
    daily:'temperature_2m_mean', timezone:'Asia/Shanghai',
    start_date:start, end_date:end, models:'era5_land',
  });
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (rateRemaining !== null && rateRemaining < points.length) {
      console.log(`    rate budget low (${rateRemaining} < ${points.length}); waiting ${WINDOW_WAIT_MS / 1000}s`);
      await sleep(WINDOW_WAIT_MS); rateRemaining = null;
    }
    let response:Response;
    try {
      response = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`, { signal:AbortSignal.timeout(90_000) });
    } catch (error) {
      if (attempt === 8) throw error;
      await sleep(5000 * attempt); continue;
    }
    const headerRemaining = response.headers.get('x-ratelimit-remaining');
    if (headerRemaining !== null) { const parsed = Number(headerRemaining); if (Number.isFinite(parsed)) rateRemaining = parsed; }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : WINDOW_WAIT_MS;
      console.log(`    429; waiting ${Math.ceil(wait / 1000)}s (attempt ${attempt})`);
      await sleep(wait); continue;
    }
    if (!response.ok) {
      if (response.status >= 500 && attempt < 8) { await sleep(5000 * attempt); continue; }
      throw new Error(`archive HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body.error) throw new Error(body.reason ?? 'archive error');
    const list = Array.isArray(body) ? body : [body];
    if (list.length !== points.length) throw new Error(`archive batch incomplete: ${list.length}/${points.length}`);
    const result = new Map<string,(number | null)[]>();
    points.forEach((point, index) => {
      const daily = list[index]?.daily;
      if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.temperature_2m_mean)) { result.set(point.id, []); return; }
      result.set(point.id, daily.time.map((_date:string, j:number) => {
        const value = daily.temperature_2m_mean[j];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      }));
    });
    return result;
  }
  throw new Error('archive failed after retries');
}

async function collect(points:Point[], dates:string[]):Promise<Record<string,(number | null)[]>> {
  const table:Record<string,(number | null)[]> = {};
  const selected = limit > 0 ? points.slice(0, limit) : points;
  for (let i = 0; i < selected.length; i += BATCH) {
    const batch = selected.slice(i, i + BATCH);
    console.log(`  ${i + batch.length}/${selected.length}`);
    const values = await fetchBatch(batch, dates[0], dates.at(-1)!);
    for (const point of batch) {
      const series = values.get(point.id) ?? [];
      table[point.id] = dates.map((_date, index) => series[index] ?? null);
    }
  }
  return table;
}

/** Bilinear interpolation of the 1° grid history to county representative points. */
function deriveCountyFromGrid(
  grid:Record<string,(number | null)[]>,
  catalog:{ origin:[number,number]; step:number; nodes:{ id:string; row:number; col:number }[] },
  countyPoints:Point[], dates:string[],
):Record<string,(number | null)[]> {
  const origin = catalog.origin, step = catalog.step;
  const byRowCol = new Map<string,string>();
  for (const node of catalog.nodes) byRowCol.set(`${node.row},${node.col}`, node.id);
  const table:Record<string,(number | null)[]> = {};
  for (const point of countyPoints) {
    const fx = (point.lon - origin[0]) / step, fy = (point.lat - origin[1]) / step;
    const c0 = Math.floor(fx), r0 = Math.floor(fy), tx = fx - c0, ty = fy - r0;
    const corners:{ id:string | undefined; weight:number }[] = [
      { id:byRowCol.get(`${r0},${c0}`), weight:(1 - tx) * (1 - ty) },
      { id:byRowCol.get(`${r0},${c0 + 1}`), weight:tx * (1 - ty) },
      { id:byRowCol.get(`${r0 + 1},${c0}`), weight:(1 - tx) * ty },
      { id:byRowCol.get(`${r0 + 1},${c0 + 1}`), weight:tx * ty },
    ];
    table[point.id] = dates.map((_date, d) => {
      let sum = 0, weight = 0;
      for (const corner of corners) {
        if (!corner.id || corner.weight <= 0) continue;
        const value = grid[corner.id]?.[d];
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        sum += value * corner.weight; weight += corner.weight;
      }
      return weight > 0 ? Math.round((sum / weight) * 100) / 100 : null;
    });
  }
  return table;
}

async function main():Promise<void> {
  const end = option('end') ?? addDays(beijingDate(), -1);
  const start = addDays(end, -(days - 1));
  const dates:string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  console.log(`ERA5-Land history ${start}..${end} (${dates.length} days), scope=${scope}`);

  const gridCatalog = scope === 'county' ? null : JSON.parse(await readFile(resolve(directory, 'weather-grid.json'), 'utf8'));
  const countyCatalog = scope === 'grid' ? null : JSON.parse(await readFile(resolve(directory, 'counties.json'), 'utf8'));
  const gridPoints:Point[] = (gridCatalog?.nodes ?? []).map((n:{ id:string; lon:number; lat:number }) => ({ id:n.id, lon:n.lon, lat:n.lat }));
  const countyPoints:Point[] = (countyCatalog?.units ?? []).map((u:{ id:string; lon:number; lat:number }) => ({ id:u.id, lon:u.lon, lat:u.lat }));

  let grid:Record<string,(number | null)[]> = {}, county:Record<string,(number | null)[]> = {};
  if (scope === 'county') {
    console.log(`Fetching county directly (${countyPoints.length})...`); county = await collect(countyPoints, dates);
  } else {
    console.log(`Fetching grid (${gridPoints.length})...`); grid = await collect(gridPoints, dates);
    if (scope === 'both') { console.log(`Deriving ${countyPoints.length} county points from grid (bilinear)...`); county = deriveCountyFromGrid(grid, gridCatalog, countyPoints, dates); }
  }

  let latest:string | null = null;
  for (const values of [...Object.values(grid), ...Object.values(county)]) values.forEach((v, i) => { if (v !== null && (!latest || dates[i] > latest)) latest = dates[i]; });
  const lagDays = latest ? Math.max(0, Math.round((Date.parse(end) - Date.parse(latest)) / 86_400_000)) : days;
  const field = { version:1, source:'era5-land', model:'era5_land', fetchedAt:new Date().toISOString(), lagDays, dates, grid, county };
  await mkdir(directory, { recursive:true });
  await writeFile(outputPath, JSON.stringify(field));
  console.log(`Wrote ${outputPath}: latest real history ${latest ?? 'none'}, lag ${lagDays}d, grid=${Object.keys(grid).length}, county=${Object.keys(county).length}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
