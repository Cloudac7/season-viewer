import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat,rm,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {feature} from 'topojson-client';
import type {Topology,GeometryCollection} from 'topojson-specification';
import type {CountyBoundaries,CountyCatalog,CountyWeather} from '../src/lib/counties';
import {classifyCounty,countyForecastIsFresh,countyHistoricalDays,summarizePrefectures,validCountyWeather} from '../src/lib/counties';
import {addDays,beijingDate} from '../src/lib/season';
import {computeSpatialField} from '../src/lib/spatial-field';
import {gridForecastIsFresh,gridHistoricalDays,validGridCatalog,validGridWeather} from '../src/lib/spatial-grid';
import {validateTerrainGrid} from '../src/lib/terrain';
import {compactDetails,encodeSpatialField,expireSpatialForecast,fieldMeta,packCountyReadings,validPrecomputedManifest} from '../src/lib/precomputed';
import type {PrecomputedManifest} from '../src/lib/precomputed';
import {buildGridLocations} from '../src/lib/grid-location';
import type {ProvinceBoundaries} from '../src/lib/grid-location';
import {acquireWeatherUpdateLock} from './weather-update-lock';
import {generateSpatialContours} from '../src/lib/spatial-contours';

const project=fileURLToPath(new URL('../',import.meta.url));
const sourceFiles=['public/data/weather-grid.json','public/data/weather-grid-weather.json','public/data/terrain.json','public/data/counties.json','public/data/counties.topo.json','public/data/county-weather.json','public/data/china.json'];
const codeFiles=['scripts/precompute-spatial.ts','src/lib/precomputed.ts','src/lib/spatial-field.ts','src/lib/spatial-contours.ts','src/lib/grid-location.ts','src/lib/season.ts','src/lib/forecast.ts','src/lib/counties.ts','src/lib/coordinates.ts','src/lib/spatial-grid.ts','src/lib/terrain.ts','src/lib/field.ts','src/lib/map-status.ts','src/data.ts'];
async function json(path:string,value:unknown){await writeFile(path,JSON.stringify(value));}
/** A cache hit requires every published asset to be a nonempty regular file. */
export async function verifyPublicationFiles(paths:string[]):Promise<void> {
  await Promise.all(paths.map(async path=>{
    const info=await stat(path);
    if(!info.isFile()||info.size===0)throw new Error(`Incomplete precomputed asset: ${path}`);
  }));
}

/** Repair incomplete flat publications without replacing healthy immutable assets. */
export async function repairPublicationFiles(output:string,finalOutput:string):Promise<void> {
  for(const entry of await readdir(output,{withFileTypes:true})){
    if(!entry.isFile())throw new Error(`Unexpected nested precomputed asset: ${entry.name}`);
    const destination=resolve(finalOutput,entry.name);
    let missing=false;
    try{const info=await stat(destination);missing=!info.isFile()||info.size===0;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing=true;}
    if(missing){
      // A directory at a flat asset path is corrupt. Remove that path only;
      // the staged complete file is then installed with a single rename.
      await rm(destination,{recursive:true,force:true});
      await rename(resolve(output,entry.name),destination);
    }
  }
}

/** Build is intentionally offline: it consumes bundled, validated model snapshots. */
export async function precomputeSpatial(options:{force?:boolean;quiet?:boolean}={}):Promise<PrecomputedManifest> {
  const release=await acquireWeatherUpdateLock('spatial deployment precompute',{directory:new URL('../data-sources/precompute-lock/',import.meta.url),waitMs:1000});
  try{return await precomputeSpatialLocked(options);}finally{await release();}
}
async function precomputeSpatialLocked(options:{force?:boolean;quiet?:boolean}):Promise<PrecomputedManifest> {
  const now=new Date(),today=beijingDate(now),started=Date.now();
  const sources=await Promise.all(sourceFiles.map(path=>readFile(resolve(project,path),'utf8')));
  const code=await Promise.all(codeFiles.map(path=>readFile(resolve(project,path),'utf8')));
  const hash=createHash('sha256').update('spatial-precompute-v2').update(today);for(const source of [...sources,...code])hash.update(source);
  const revision=hash.digest('hex').slice(0,20),base=resolve(project,'public/data/precomputed');
  const manifestPath=resolve(base,'manifest.json');
  if(!options.force){try{const existing=JSON.parse(await readFile(manifestPath,'utf8'));if(validPrecomputedManifest(existing)&&existing.revision===revision){await verifyPublicationFiles([existing.locations,existing.details,existing.elevation,...Object.values(existing.frames).flatMap(frame=>[frame.field,frame.meta,frame.counties,frame.layers,...(frame.expiredLayers?[frame.expiredLayers]:[])])].map(url=>resolve(project,'public',url.slice(1))));if(!options.quiet)console.log(`Spatial data unchanged: ${revision} (${existing.dates.length} dates)`);return existing;}}catch{/* rebuild missing or invalid publication */}}
  const [catalog,weather,terrain,counties,topology,countyWeather,provinces]=sources.map(source=>JSON.parse(source));
  if(!validGridCatalog(catalog)||!validGridWeather(weather,catalog)||!validateTerrainGrid(terrain))throw new Error('天气格点目录、快照或 DEM 校验失败');
  const countyCatalog=counties as CountyCatalog,countySnapshot=countyWeather as CountyWeather;
  if(!validCountyWeather(countySnapshot,countyCatalog))throw new Error('县级模型快照校验失败');
  const histories=Object.values(weather.records).map(series=>gridHistoricalDays(series));
  const starts=histories.map(days=>days[0]?.date).filter((date):date is string=>!!date).sort();
  const ends=histories.map(days=>days.at(-1)?.date).filter((date):date is string=>!!date).sort();
  const latest=[addDays(today,-1),ends.at(-1)!].sort()[0];
  const first=[addDays(latest,-29),addDays(starts.at(-1)!,8)].sort().at(-1)!;
  const dates:string[]=[];for(let date=first;date<=latest;date=addDays(date,1))dates.push(date);
  if(!dates.length)throw new Error('格点快照尚无连续 9 个完整日，不能发布虚构季节');
  const finalOutput=resolve(base,revision),output=resolve(project,'data-sources',`.precomputed-${revision}-${process.pid}`),prefix=`/data/precomputed/${revision}`;await mkdir(base,{recursive:true});await mkdir(output,{recursive:true});
  const input={catalog,weather,terrain,date:latest,now:now.toISOString()};
  await json(resolve(output,'details.json'),compactDetails(input));
  await writeFile(resolve(output,'elevation.bin'),Buffer.from(new Int16Array(terrain.heights).buffer));
  const countyTopology=topology as Topology<{counties:GeometryCollection<{id:string}>}>;
  const countyBoundaries=feature(countyTopology,countyTopology.objects.counties) as CountyBoundaries;
  const locations=buildGridLocations({grid:terrain,catalog:countyCatalog,boundaries:countyBoundaries,provinces:provinces as ProvinceBoundaries});
  await json(resolve(output,'locations.json'),locations);
  const forecastCount=catalog.nodes.filter(node=>gridForecastIsFresh(weather.records[node.id],now)).length;
  const countyCompleteCount=countyCatalog.units.filter(unit=>{const series=countySnapshot.records[unit.id];return series&&countyHistoricalDays(series).some(day=>day.date===addDays(today,-1)&&day.mean!==null);}).length;
  const countyForecastCount=countyCatalog.units.filter(unit=>countyForecastIsFresh(countySnapshot.records[unit.id],now)).length;
  const expiries=Object.values(weather.records).filter(series=>gridForecastIsFresh(series,now)).map(series=>Date.parse(series.forecast.issuedAt)+86400000);
  const forecastValidUntil=expiries.length?new Date(Math.min(Date.parse(`${addDays(today,1)}T00:00:00+08:00`),...expiries)).toISOString():null;
  const frames:PrecomputedManifest['frames']={};
  for(const date of dates){
    const field=computeSpatialField({...input,date});
    const readings=countyCatalog.units.map(unit=>classifyCounty(unit,countySnapshot.records[unit.id],date,now));
    const summaries=summarizePrefectures(readings),stem=resolve(output,date),url=`${prefix}/${date}`;
    await writeFile(`${stem}.bin`,Buffer.from(encodeSpatialField(field)));
    await json(`${stem}.meta.json`,fieldMeta(field));
    await json(`${stem}.counties.json`,packCountyReadings(date,readings,summaries,countySnapshot.updatedAt));
    await json(`${stem}.layers.json`,generateSpatialContours(field));
    let expiredLayers:string|undefined;
    if(field.metadata.forecastCells){await json(`${stem}.expired.layers.json`,generateSpatialContours(expireSpatialForecast(field)));expiredLayers=`${url}.expired.layers.json`;}
    const readyCount=catalog.nodes.filter(node=>{const series=weather.records[node.id];if(!series)return false;const days=new Map(gridHistoricalDays(series).map(day=>[day.date,day.mean]));return Array.from({length:9},(_,index)=>days.get(addDays(date,-index))).every(value=>typeof value==='number'&&Number.isFinite(value));}).length;
    frames[date]={field:`${url}.bin`,meta:`${url}.meta.json`,counties:`${url}.counties.json`,layers:`${url}.layers.json`,...(expiredLayers?{expiredLayers}:{}),readyCount,forecastCount:date===addDays(today,-1)?forecastCount:0,countyReadyCount:readings.filter(reading=>reading.state).length,countyCompleteCount,countyForecastCount,forecastValidUntil:date===addDays(today,-1)?forecastValidUntil:null};
    if(!options.quiet)console.log(`Precomputed ${date}: ${field.metadata.validCells.toLocaleString()} grid cells, ${readings.filter(reading=>reading.state).length} counties`);
  }
  const manifest:PrecomputedManifest={version:1,revision,generatedAt:now.toISOString(),evaluatedDay:today,dates,firstUsableDate:dates[0],frames,locations:`${prefix}/locations.json`,details:`${prefix}/details.json`,elevation:`${prefix}/elevation.bin`,weather:{step:catalog.step,totalCount:catalog.nodes.length,updatedAt:weather.updatedAt},counties:{totalCount:countyCatalog.units.length,updatedAt:countySnapshot.updatedAt},display:{bounds:terrain.bounds,rows:terrain.rows,cols:terrain.cols,step:terrain.step}};
  // Publish a complete immutable directory first, then atomically switch the index.
  try{await rename(output,finalOutput);}catch(error){
    if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
    // Reuse healthy immutable files, but recover missing or incomplete entries.
    await repairPublicationFiles(output,finalOutput);await rm(output,{recursive:true,force:true});
  }
  const temporary=resolve(base,`manifest.${process.pid}.tmp`);await json(temporary,manifest);await rename(temporary,manifestPath);
  if(!options.quiet)console.log(`Published ${revision}: ${dates.length} dates in ${((Date.now()-started)/1000).toFixed(1)}s`);
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  precomputeSpatial({force:process.argv.includes('--force')}).catch(error=>{console.error(error);process.exitCode=1;});
}
