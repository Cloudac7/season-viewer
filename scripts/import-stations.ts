import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseGhcnDailyCsv, parseMeteostatCsv, parseStationJson } from '../src/lib/bias';
import type { StationRecord } from '../src/lib/bias';

/**
 * Build a normalised station-observation file for bias calibration.
 *
 * Usage:
 *   node --import tsx scripts/import-stations.ts --input=<dir|file> [--format=ghcn-csv|meteostat-csv|json] [--out=<path>]
 *   node --import tsx scripts/import-stations.ts --download=<id,id,...> [--out=<path>]
 *
 * Formats:
 *   ghcn-csv      NOAA GHCN-Daily `access/{station}.csv` files (one per station, dir or single file)
 *   meteostat-csv Meteostat bulk per-station CSV; requires --meta=<stations.json> with {id,lon,lat,elevation,name}
 *   json          already-normalised {stations:[...]} or array
 */

const args = process.argv.slice(2);
const option = (name:string):string | undefined => {
  const direct = args.find(value => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const directory = new URL('../data-sources/', import.meta.url);
const output = resolve(option('out') ?? new URL('stations.json', directory).pathname);
const format = option('format') ?? 'ghcn-csv';
const input = option('input');
const download = option('download');
const metaPath = option('meta');

async function readMeta():Promise<Map<string, { lon:number; lat:number; elevation:number | null; name?:string }>> {
  if (!metaPath) return new Map();
  const parsed = JSON.parse(await readFile(resolve(metaPath), 'utf8')) as { stations?: Record<string, { lon:number; lat:number; elevation?:number; name?:string }> } | Record<string, { lon:number; lat:number; elevation?:number; name?:string }>;
  const table = (parsed as { stations?: unknown }).stations ?? parsed;
  const map = new Map<string, { lon:number; lat:number; elevation:number | null; name?:string }>();
  for (const [id, value] of Object.entries(table as Record<string, { lon:number; lat:number; elevation?:number; name?:string }>)) {
    if (value && Number.isFinite(value.lon) && Number.isFinite(value.lat)) map.set(id, { lon:value.lon, lat:value.lat, elevation:value.elevation ?? null, name:value.name });
  }
  return map;
}

async function fromGhcn(path:string):Promise<StationRecord[]> {
  const { statSync } = await import('node:fs');
  const files = statSync(path).isDirectory()
    ? (await readdir(path)).filter(name => name.toLowerCase().endsWith('.csv')).map(name => resolve(path, name))
    : [resolve(path)];
  const stations: StationRecord[] = [];
  for (const file of files) {
    try {
      const record = parseGhcnDailyCsv(await readFile(file, 'utf8'));
      if (record.daily.length) stations.push(record);
    } catch (error) {
      console.warn(`Skipping ${basename(file)}: ${(error as Error).message}`);
    }
  }
  return stations;
}

async function fromMeteostat(path:string, meta:Map<string, { lon:number; lat:number; elevation:number | null; name?:string }>):Promise<StationRecord[]> {
  const files = (await readdir(path)).filter(name => name.toLowerCase().endsWith('.csv')).map(name => resolve(path, name));
  const stations: StationRecord[] = [];
  for (const file of files) {
    const id = basename(file).replace(/\.csv$/i, '');
    const location = meta.get(id);
    if (!location) { console.warn(`Skipping ${id}: no coordinates in --meta`); continue; }
    try {
      const record = parseMeteostatCsv(await readFile(file, 'utf8'), { id, ...location });
      if (record.daily.length) stations.push(record);
    } catch (error) {
      console.warn(`Skipping ${id}: ${(error as Error).message}`);
    }
  }
  return stations;
}

async function downloadGhcn(ids:string[]):Promise<StationRecord[]> {
  const stations: StationRecord[] = [];
  for (const id of ids) {
    const url = `https://www.ncei.noaa.gov/data/global-historical-climatology-network-daily/access/${id}.csv`;
    const response = await fetch(url, { signal:AbortSignal.timeout(60_000) });
    if (!response.ok) { console.warn(`Skipping ${id}: HTTP ${response.status}`); continue; }
    try {
      const record = parseGhcnDailyCsv(await response.text(), { id });
      if (record.daily.length) stations.push(record);
    } catch (error) {
      console.warn(`Skipping ${id}: ${(error as Error).message}`);
    }
  }
  return stations;
}

async function main():Promise<void> {
  let stations: StationRecord[];
  if (download) stations = await downloadGhcn(download.split(',').map(value => value.trim()).filter(Boolean));
  else if (!input) throw new Error('Provide --input=<path> or --download=<id,id,...>');
  else if (format === 'json') stations = parseStationJson(JSON.parse(await readFile(resolve(input), 'utf8')));
  else if (format === 'ghcn-csv') stations = await fromGhcn(input);
  else if (format === 'meteostat-csv') stations = await fromMeteostat(input, await readMeta());
  else throw new Error(`Unknown --format: ${format}`);

  if (!stations.length) throw new Error('No usable stations parsed');
  const payload = { version:1, source:`stations:${download ? 'ghcn-daily' : format}`, importedAt:new Date().toISOString(), stations };
  await mkdir(new URL('../data-sources/', import.meta.url), { recursive:true });
  await writeFile(output, JSON.stringify(payload));
  const observations = stations.reduce((sum, station) => sum + station.daily.length, 0);
  console.log(`Saved ${stations.length} stations (${observations} daily records) to ${output}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
