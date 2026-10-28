import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {countyBatchApiCost,fetchCountyBatch} from '../src/lib/county-weather';
import {EMPTY_COUNTY_WEATHER,validCountyWeather,countyForecastIsFresh,countyHistoricalDays} from '../src/lib/counties';
import type {CountyCatalog,CountyWeather} from '../src/lib/counties';
import {beijingDate,addDays} from '../src/lib/season';
import {OPEN_METEO_BATCH_SIZE,OpenMeteoQuota,runOpenMeteoBatch} from './open-meteo-request';
import {acquireWeatherUpdateLock} from './weather-update-lock';
const directory=new URL('../public/data/',import.meta.url),lock=new URL('../data-sources/county-update.lock',import.meta.url);
const quota=new OpenMeteoQuota();
const releaseSharedLock=await acquireWeatherUpdateLock('county');
try{
await mkdir(new URL('../data-sources/',import.meta.url),{recursive:true});
try{
  const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();
}catch{
  const pid=Number(await readFile(lock,'utf8').catch(()=>0));
  try{if(pid<=0)throw new Error('Empty lock');process.kill(pid,0);console.log('County refresh already running');process.exit(0);}catch{await unlink(lock).catch(()=>{});const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();}
}
try{
  const catalog=JSON.parse(await readFile(new URL('counties.json',directory),'utf8')) as CountyCatalog;
  let data:CountyWeather=structuredClone(EMPTY_COUNTY_WEATHER);
  try{const value=JSON.parse(await readFile(new URL('county-weather.json',directory),'utf8'));if(validCountyWeather(value,catalog))data=value;}catch{/* initial snapshot */}
  const latest=addDays(beijingDate(),-1);
  const pending=catalog.units.filter(unit=>{
    const series=data.records[unit.id];
    return !series||!countyHistoricalDays(series).some(day=>day.date===latest&&day.mean!==null)||!countyForecastIsFresh(series);
  });
  const batchSize=OPEN_METEO_BATCH_SIZE,batchCount=Math.ceil(pending.length/batchSize);
  console.log(`County weather: ${catalog.units.length-pending.length}/${catalog.units.length} current; ${pending.length} pending`);
  for(let i=0;i<pending.length;i+=batchSize){
    const started=Date.now(),batch=pending.slice(i,i+batchSize),batchNumber=Math.floor(i/batchSize)+1;
    const cost=countyBatchApiCost(batch,data);
    try{
      data=await runOpenMeteoBatch({
        quota,kind:'county',cost,locations:batch.length,
        task:()=>fetchCountyBatch(batch,data,AbortSignal.timeout(45000)),
      });
    }catch(error){
      console.error(`County batch ${batchNumber}/${batchCount} failed; the previous checkpoint was retained`);
      throw error;
    }
    const target=new URL('county-weather.json',directory),temporary=new URL('county-weather.tmp.json',directory);
    await writeFile(temporary,JSON.stringify(data));await rename(temporary,target);
    const completed=catalog.units.length-pending.length+Math.min(i+batchSize,pending.length);
    console.log(`County checkpoint ${batchNumber}/${batchCount}: ${completed}/${catalog.units.length}, ${batch.length} locations, ${cost.toFixed(1)} calls, ${((Date.now()-started)/1000).toFixed(1)}s, ${data.updatedAt}`);
  }
  console.log('County model snapshot complete');
}finally{await unlink(lock).catch(()=>{});}
}finally{await releaseSharedLock();}
