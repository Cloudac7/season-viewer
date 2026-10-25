import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import type {Plugin} from 'vite';
import {countyForecastIsFresh,countyHistoricalDays,EMPTY_COUNTY_WEATHER} from '../src/lib/counties';
import type {CountyCatalog,CountyWeather} from '../src/lib/counties';
import {addDays,beijingDate} from '../src/lib/season';

export function countyDevApi():Plugin{
  let worker:ReturnType<typeof spawn>|null=null,checkedAt=0;
  const root=new URL('../',import.meta.url);
  return {name:'county-model-snapshot',configureServer(server){
    server.middlewares.use('/api/county-weather',async(req,res)=>{
      if(req.method!=='GET'){res.statusCode=405;res.end();return;}
      let data:CountyWeather=EMPTY_COUNTY_WEATHER;
      try{data=JSON.parse(await readFile(new URL('public/data/county-weather.json',root),'utf8'));}catch{/* bootstrapping */}
      if(!worker&&Date.now()-checkedAt>60000){
        checkedAt=Date.now();
        try{
          const catalog=JSON.parse(await readFile(new URL('public/data/counties.json',root),'utf8')) as CountyCatalog;
          const latest=addDays(beijingDate(),-1);
          if(catalog.units.some(unit=>{
            const series=data.records[unit.id];
            return !series||!countyHistoricalDays(series).some(day=>day.date===latest&&day.mean!==null)||!countyForecastIsFresh(series);
          })){
            worker=spawn(process.execPath,['--import','tsx','scripts/update-counties.ts'],{cwd:root,stdio:'inherit'});
            worker.once('exit',()=>{worker=null;});worker.once('error',()=>{worker=null;});
          }
        }catch{/* frontend can still show the bundled snapshot */}
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));
    });
  }};
}
