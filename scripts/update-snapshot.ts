import { readFile, writeFile } from 'node:fs/promises';
import { fetchWeather } from '../src/lib/weather';
import type { WeatherDataset } from '../src/types';

const file=new URL('../public/data/weather-snapshot.json',import.meta.url);
let previous: WeatherDataset | null=null;
try { previous=JSON.parse(await readFile(file,'utf8')) as WeatherDataset; } catch { /* first snapshot */ }
const dataset=await fetchWeather(AbortSignal.timeout(90000),previous);
await writeFile(file,JSON.stringify(dataset));
console.log(`Saved ${Object.keys(dataset.cities).length} cities at ${dataset.updatedAt}`);
