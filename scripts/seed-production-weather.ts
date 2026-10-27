import {readFile, rename, writeFile} from 'node:fs/promises';
import {validCountyWeather} from '../src/lib/counties';
import {validGridCatalog, validGridWeather} from '../src/lib/spatial-grid';
import type {CountyCatalog} from '../src/lib/counties';

const directory = new URL('../public/data/', import.meta.url);
const countyCatalog = JSON.parse(await readFile(new URL('counties.json', directory), 'utf8')) as CountyCatalog;
const gridCatalog = JSON.parse(await readFile(new URL('weather-grid.json', directory), 'utf8'));
if (!validGridCatalog(gridCatalog)) throw new Error('Invalid local grid catalog');

const names = ['county-weather.json', 'weather-grid-weather.json'] as const;
const snapshots = await Promise.all(names.map(async name => {
  const response = await fetch(`https://season.tomori.xyz/data/${name}`, {signal: AbortSignal.timeout(45_000)});
  if (!response.ok) throw new Error(`Cannot seed ${name}: HTTP ${response.status}`);
  return await response.json();
}));
if (!validCountyWeather(snapshots[0], countyCatalog) || !Object.keys(snapshots[0].records).length ||
    !validGridWeather(snapshots[1], gridCatalog) || !Object.keys(snapshots[1].records).length) {
  throw new Error('Production weather snapshots do not match the local catalogs');
}

// Validate both files before replacing either checked-in snapshot.
for (let i = 0; i < names.length; i++) {
  const temporary = new URL(`${names[i]}.tmp.json`, directory);
  await writeFile(temporary, JSON.stringify(snapshots[i]));
  await rename(temporary, new URL(names[i], directory));
}
console.log('Seeded weather checkpoints from the current production deployment');
