import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {EMPTY_GRID_WEATHER,fetchGridBatch,gridBatchApiCost,gridForecastIsFresh,gridHistoricalDays,validGridCatalog,validGridWeather} from '../src/lib/spatial-grid';
import type {WeatherGrid,WeatherGridCatalog} from '../src/lib/spatial-grid';
import {beijingDate,addDays} from '../src/lib/season';
import {acquireWeatherUpdateLock} from './weather-update-lock';

const directory=new URL('../public/data/',import.meta.url),cache=new URL('../data-sources/',import.meta.url);
const lock=new URL('weather-grid-update.lock',cache),usageFile=new URL('weather-grid-usage.json',cache),backoffFile=new URL('weather-grid-backoff.json',cache);
const releaseSharedLock=await acquireWeatherUpdateLock('independent-grid');
try{
await mkdir(cache,{recursive:true});
try{
  const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();
}catch{
  const pid=Number(await readFile(lock,'utf8').catch(()=>0));
  try{if(pid<=0)throw new Error('Empty lock');process.kill(pid,0);console.log('Weather grid refresh already running');process.exit(0);}catch{await unlink(lock).catch(()=>{});const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();}
}
interface Usage {key:string;at:number;cost:number}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let usage:Usage[]=[];
async function atomicJson(file:URL,value:unknown){
  const temporary=new URL(`${file.pathname.split('/').at(-1)}.${process.pid}.tmp`,file);
  await writeFile(temporary,JSON.stringify(value));await rename(temporary,file);
}
async function synchronizeUsage(data:WeatherGrid){
  const now=Date.now(),recent=new Map(usage.filter(entry=>Number.isFinite(entry.at)&&Number.isFinite(entry.cost)&&entry.cost>0&&entry.at>now-24*3600000).map(entry=>[entry.key,entry]));
  // Include county refreshes even though their independent updater predates this
  // ledger. Counting each recent county record prevents the grid bootstrap from
  // silently consuming a second complete daily free quota.
  try{
    const county=JSON.parse(await readFile(new URL('county-weather.json',directory),'utf8')) as {records:Record<string,{updatedAt:string;days:unknown[]}>};
    for(const [id,series] of Object.entries(county.records)){
      const at=Date.parse(series.updatedAt),key=`county:${id}:${series.updatedAt}`;
      if(at>now-24*3600000&&!recent.has(key))recent.set(key,{key,at,cost:series.days.length<=14?1.5:1});
    }
  }catch{/* no county snapshot yet */}
  // Recover completed batches after an interrupted run when its usage file was
  // removed. Existing request ledger entries already account for those batches.
  const requestTimes=[...recent.values()].filter(entry=>entry.key.startsWith('request:')).map(entry=>entry.at);
  for(const series of Object.values(data.records)){
    const at=Date.parse(series.updatedAt);
    if(at<=now-24*3600000||requestTimes.some(requestAt=>Math.abs(requestAt-at)<120000))continue;
    const key=`recovered-grid:${series.lon}:${series.lat}:${series.updatedAt}`;
    if(!recent.has(key))recent.set(key,{key,at,cost:series.days.length<=14?1.5:1});
  }
  usage=[...recent.values()];
  await atomicJson(usageFile,usage);
}
async function reserve(cost:number,data:WeatherGrid){
  for(;;){
    await synchronizeUsage(data);
    const now=Date.now(),daily=usage.reduce((sum,entry)=>sum+entry.cost,0),hourly=usage.filter(entry=>entry.at>now-3600000).reduce((sum,entry)=>sum+entry.cost,0),minutely=usage.filter(entry=>entry.at>now-60000).reduce((sum,entry)=>sum+entry.cost,0);
    if(daily+cost>9900)throw new Error(`Open-Meteo daily budget reserved: ${daily.toFixed(1)} recent calls; grid batch needs ${cost}. Checkpoint saved; retry after older calls expire.`);
    if(hourly+cost<=4900&&minutely+cost<=570){
      usage.push({key:`request:${process.pid}:${now}`,at:now,cost});await atomicJson(usageFile,usage);return;
    }
    const window=hourly+cost>4900?3600000:60000;
    const oldest=usage.filter(entry=>entry.at>now-window).sort((a,b)=>a.at-b.at)[0];
    const delay=Math.min(60000,Math.max(1000,(oldest?.at??now)+window-now+1000));
    console.log(`Weather grid respects shared free quota (${hourly.toFixed(0)}/hour, ${daily.toFixed(0)}/day); waiting ${Math.ceil(delay/1000)}s`);
    await sleep(delay);
  }
}
try{
  try{
    const backoff=JSON.parse(await readFile(backoffFile,'utf8')) as {until:number};
    if(backoff.until>Date.now())throw new Error(`Weather grid refresh paused until ${new Date(backoff.until).toISOString()} after provider rate limit`);
  }catch(error){if(error instanceof Error&&error.message.startsWith('Weather grid refresh paused'))throw error;}
  const value=JSON.parse(await readFile(new URL('weather-grid.json',directory),'utf8'));
  if(!validGridCatalog(value))throw new Error('Run data:grid:import first: invalid weather-grid.json');
  const catalog:WeatherGridCatalog=value;
  let data:WeatherGrid={...structuredClone(EMPTY_GRID_WEATHER),catalogId:catalog.id};
  try{const snapshot=JSON.parse(await readFile(new URL('weather-grid-weather.json',directory),'utf8'));if(validGridWeather(snapshot,catalog))data=snapshot;}catch{/* first independent grid download */}
  try{const saved=JSON.parse(await readFile(usageFile,'utf8'));if(Array.isArray(saved))usage=saved;}catch{/* first quota ledger */}
  const reserveOption=process.argv.slice(2).find(value=>value.startsWith('--reserve-calls='));
  if(reserveOption){
    const cost=Number(reserveOption.split('=')[1]);
    if(!Number.isFinite(cost)||cost<0||cost>10000)throw new Error('Invalid --reserve-calls: expected 0..10000');
    const key=`external-reserve:${beijingDate()}:${cost}`;
    if(cost&&!usage.some(entry=>entry.key===key))usage.push({key,at:Date.now()-3600001,cost});
    // Operator-audited older use counts toward the rolling day. Its one-hour
    // window is already over; do not manufacture a second hourly reservation.
    await atomicJson(usageFile,usage);
  }
  const latest=addDays(beijingDate(),-1);
  const pending=catalog.nodes.filter(node=>{
    const series=data.records[node.id];
    return !series||!gridHistoricalDays(series).some(day=>day.date===latest&&day.mean!==null)||!gridForecastIsFresh(series);
  });
  const batchSize=40;
  console.log(`Weather grid ${catalog.step}°: ${catalog.nodes.length-pending.length}/${catalog.nodes.length} current; ${pending.length} independent nodes pending`);
  console.log('Each request checkpoints atomically. Quota accounts for recent county updates; initial 21-day batches count as 1.5 calls per location.');
  for(let i=0;i<pending.length;i+=batchSize){
    const started=Date.now(),batch=pending.slice(i,i+batchSize);
    let error:unknown;
    for(let attempt=0;attempt<3;attempt++){
      await reserve(gridBatchApiCost(batch,data),data);
      try{data=await fetchGridBatch(batch,data,AbortSignal.timeout(45000));error=null;break;}
      catch(e){
        error=e;
        if(e instanceof Error&&/HTTP 429\b/.test(e.message)){
          const retryAfter=(e as Error&{retryAfter?:string|null}).retryAfter;
          const delay=retryAfter&&/^\d+(?:\.\d+)?$/.test(retryAfter)?Number(retryAfter)*1000:retryAfter?Date.parse(retryAfter)-Date.now():3600000;
          const until=Date.now()+Math.max(60000,Number.isFinite(delay)?delay:3600000);
          await atomicJson(backoffFile,{until,reason:'Open-Meteo HTTP 429'});
          throw new Error(`Open-Meteo HTTP 429: stopped at the last checkpoint; retry after ${new Date(until).toISOString()}.`);
        }
        if(attempt<2){console.log(`Weather grid retry after ${e instanceof Error?e.message:String(e)}`);await sleep(30000);}
      }
    }
    if(error)throw error;
    await atomicJson(new URL('weather-grid-weather.json',directory),data);
    console.log(`Weather grid ${catalog.nodes.length-pending.length+Math.min(i+batchSize,pending.length)}/${catalog.nodes.length} at ${data.updatedAt}`);
    // A bootstrap batch is 60 call equivalents. The minimum interval stays
    // below 600/minute; the shared ledger additionally enforces hour/day limits.
    if(i+batchSize<pending.length)await sleep(Math.max(0,6500-(Date.now()-started)));
  }
  console.log('Independent weather grid snapshot complete');
}finally{await unlink(lock).catch(()=>{});}
}finally{await releaseSharedLock();}
