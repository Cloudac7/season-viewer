import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import type {Plugin} from 'vite';
import {EMPTY_GRID_WEATHER,gridForecastIsFresh,gridHistoricalDays,validGridCatalog,validGridWeather} from '../src/lib/spatial-grid';
import type {WeatherGrid} from '../src/lib/spatial-grid';
import {addDays,beijingDate} from '../src/lib/season';

/** Shared local snapshots; it never starts the county updater or browser API fan-out. */
export function gridDevApi():Plugin {
  let worker:ReturnType<typeof spawn>|null=null,checkedAt=0,retryAt=0;
  const root=new URL('../',import.meta.url),cache=new URL('data-sources/',root);
  async function externalWorkerRunning(){
    try{const pid=Number(await readFile(new URL('weather-grid-update.lock',cache),'utf8'));if(pid<=0)return false;process.kill(pid,0);return true;}catch{return false;}
  }
  return {name:'independent-weather-grid-snapshot',configureServer(server){
    server.middlewares.use('/api/weather-grid-weather',async(req,res)=>{
      if(req.method!=='GET'){res.statusCode=405;res.end();return;}
      try{
        const catalog=JSON.parse(await readFile(new URL('public/data/weather-grid.json',root),'utf8'));
        if(!validGridCatalog(catalog))throw new Error('Weather grid catalog unavailable');
        let data:WeatherGrid={...EMPTY_GRID_WEATHER,catalogId:catalog.id,records:{}};
        try{const snapshot=JSON.parse(await readFile(new URL('public/data/weather-grid-weather.json',root),'utf8'));if(validGridWeather(snapshot,catalog))data=snapshot;}catch{/* first independent bootstrap */}
        try{const backoff=JSON.parse(await readFile(new URL('weather-grid-backoff.json',cache),'utf8')) as {until:number};retryAt=Math.max(retryAt,Number.isFinite(backoff.until)?backoff.until:0);}catch{/* no provider backoff */}
        const running=!!worker||await externalWorkerRunning();
        if(!running&&Date.now()>=retryAt&&Date.now()-checkedAt>60000){
          checkedAt=Date.now();
          const latest=addDays(beijingDate(),-1);
          if(catalog.nodes.some(node=>{
            const series=data.records[node.id];
            return !series||!gridHistoricalDays(series).some(day=>day.date===latest&&day.mean!==null)||!gridForecastIsFresh(series);
          })){
            worker=spawn(process.execPath,['--import','tsx','scripts/update-weather-grid.ts'],{cwd:root,stdio:'inherit'});
            worker.once('exit',code=>{worker=null;if(code!==0)retryAt=Date.now()+3600000;});
            worker.once('error',()=>{worker=null;retryAt=Date.now()+3600000;});
          }
        }
        res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.setHeader('X-Weather-Grid-Updater',running||worker?'running':Date.now()<retryAt?'backoff':'idle');
        res.end(JSON.stringify(data));
      }catch(error){
        res.statusCode=503;res.setHeader('Content-Type','application/json; charset=utf-8');
        res.end(JSON.stringify({error:error instanceof Error?error.message:'Weather grid unavailable'}));
      }
    });
  }};
}
