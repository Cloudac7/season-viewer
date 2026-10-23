import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {fetchCountyBatch} from '../src/lib/county-weather';
import {EMPTY_COUNTY_WEATHER,validCountyWeather} from '../src/lib/counties';
import type {CountyCatalog,CountyWeather} from '../src/lib/counties';
import {beijingDate,addDays} from '../src/lib/season';
const directory=new URL('../public/data/',import.meta.url),lock=new URL('../data-sources/county-update.lock',import.meta.url);
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
  const pending=catalog.units.filter(unit=>!data.records[unit.id]?.days.some(day=>day.date===latest&&day.mean!==null));
  const batchSize=40;
  console.log(`County weather: ${catalog.units.length-pending.length}/${catalog.units.length} current; ${pending.length} pending`);
  for(let i=0;i<pending.length;i+=batchSize){
    const started=Date.now(),batch=pending.slice(i,i+batchSize);
    let error:unknown;
    for(let attempt=0;attempt<3;attempt++){
      try{data=await fetchCountyBatch(batch,data,AbortSignal.timeout(45000));error=null;break;}
      catch(e){error=e;if(attempt<2){console.log(`Retry batch after ${e instanceof Error?e.message:String(e)}`);await new Promise(resolve=>setTimeout(resolve,30000));}}
    }
    if(error)throw error;
    const target=new URL('county-weather.json',directory),temporary=new URL('county-weather.tmp.json',directory);
    await writeFile(temporary,JSON.stringify(data));await rename(temporary,target);
    console.log(`County weather ${catalog.units.length-pending.length+Math.min(i+batchSize,pending.length)}/${catalog.units.length} at ${data.updatedAt}`);
    // Stay below the public location quota; incremental batches only request
    // two past days after the initial fourteen-day bootstrap.
    if(i+batchSize<pending.length)await new Promise(resolve=>setTimeout(resolve,Math.max(0,6500-(Date.now()-started))));
  }
  console.log('County model snapshot complete');
}finally{await unlink(lock).catch(()=>{});}
