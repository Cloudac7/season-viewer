import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {EMPTY_GRID_WEATHER,fetchGridBatch,gridBatchApiCost,gridForecastIsFresh,gridHistoricalDays,validGridCatalog,validGridWeather} from '../src/lib/spatial-grid';
import type {WeatherGrid,WeatherGridCatalog} from '../src/lib/spatial-grid';
import {beijingDate,addDays} from '../src/lib/season';
import {OPEN_METEO_BATCH_SIZE,OpenMeteoQuota,runOpenMeteoBatch} from './open-meteo-request';
import {acquireWeatherUpdateLock} from './weather-update-lock';

const directory=new URL('../public/data/',import.meta.url),cache=new URL('../data-sources/',import.meta.url);
const lock=new URL('weather-grid-update.lock',cache),quota=new OpenMeteoQuota();
const releaseSharedLock=await acquireWeatherUpdateLock('independent-grid');
try{
await mkdir(cache,{recursive:true});
try{
  const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();
}catch{
  const pid=Number(await readFile(lock,'utf8').catch(()=>0));
  try{if(pid<=0)throw new Error('Empty lock');process.kill(pid,0);console.log('Weather grid refresh already running');process.exit(0);}catch{await unlink(lock).catch(()=>{});const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();}
}
async function atomicJson(file:URL,value:unknown){
  const temporary=new URL(`${file.pathname.split('/').at(-1)}.${process.pid}.tmp`,file);
  await writeFile(temporary,JSON.stringify(value));await rename(temporary,file);
}
try{
  const value=JSON.parse(await readFile(new URL('weather-grid.json',directory),'utf8'));
  if(!validGridCatalog(value))throw new Error('Run data:grid:import first: invalid weather-grid.json');
  const catalog:WeatherGridCatalog=value;
  let data:WeatherGrid={...structuredClone(EMPTY_GRID_WEATHER),catalogId:catalog.id};
  try{const snapshot=JSON.parse(await readFile(new URL('weather-grid-weather.json',directory),'utf8'));if(validGridWeather(snapshot,catalog))data=snapshot;}catch{/* first independent grid download */}
  const reserveOption=process.argv.slice(2).find(value=>value.startsWith('--reserve-calls='));
  if(reserveOption){
    const cost=Number(reserveOption.split('=')[1]);
    if(!Number.isFinite(cost)||cost<0||cost>10000)throw new Error('Invalid --reserve-calls: expected 0..10000');
    const key=`external-reserve:${beijingDate()}:${cost}`;
    if(cost)await quota.reserveExternal(cost,key);
  }
  const latest=addDays(beijingDate(),-1);
  const pending=catalog.nodes.filter(node=>{
    const series=data.records[node.id];
    return !series||!gridHistoricalDays(series).some(day=>day.date===latest&&day.mean!==null)||!gridForecastIsFresh(series);
  });
  const batchSize=OPEN_METEO_BATCH_SIZE,batchCount=Math.ceil(pending.length/batchSize);
  console.log(`Weather grid ${catalog.step}°: ${catalog.nodes.length-pending.length}/${catalog.nodes.length} current; ${pending.length} independent nodes pending`);
  console.log('Each request checkpoints atomically. County and grid requests share one conservative quota ledger; initial 21-day batches count as 1.5 calls per location.');
  for(let i=0;i<pending.length;i+=batchSize){
    const started=Date.now(),batch=pending.slice(i,i+batchSize),batchNumber=Math.floor(i/batchSize)+1;
    const cost=gridBatchApiCost(batch,data);
    try{
      data=await runOpenMeteoBatch({
        quota,kind:'grid',cost,locations:batch.length,
        task:()=>fetchGridBatch(batch,data,AbortSignal.timeout(45000)),
      });
    }catch(error){
      console.error(`Weather grid batch ${batchNumber}/${batchCount} failed; the previous checkpoint was retained`);
      throw error;
    }
    await atomicJson(new URL('weather-grid-weather.json',directory),data);
    const completed=catalog.nodes.length-pending.length+Math.min(i+batchSize,pending.length);
    console.log(`Weather grid checkpoint ${batchNumber}/${batchCount}: ${completed}/${catalog.nodes.length}, ${batch.length} locations, ${cost.toFixed(1)} calls, ${((Date.now()-started)/1000).toFixed(1)}s, ${data.updatedAt}`);
  }
  console.log('Independent weather grid snapshot complete');
}finally{await unlink(lock).catch(()=>{});}
}finally{await releaseSharedLock();}
