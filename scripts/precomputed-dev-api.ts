import {readFile,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import type {Plugin} from 'vite';
import {beijingDate} from '../src/lib/season';

/** Development alone schedules refreshes. Production serves immutable assets. */
export function precomputedDevApi():Plugin{
  const root=new URL('../',import.meta.url),manifest=new URL('public/data/precomputed/manifest.json',root);
  let worker:ReturnType<typeof spawn>|null=null,checkedAt=0,retryAt=0,seen='';
  return {name:'precomputed-season-snapshot',configureServer(server){
    server.middlewares.use('/api/precomputed-spatial',async(req,res)=>{
      if(req.method!=='GET'){res.statusCode=405;res.end();return;}
      let published:string|null=null;
      try{published=await readFile(manifest,'utf8');}catch{/* bootstrap */}
      try{
        const sources=await Promise.all(['county-weather.json','weather-grid-weather.json','weather-grid.json','terrain.json'].map(async file=>{const source=await stat(new URL('public/data/'+file,root));return source.mtimeMs+':'+source.size;}));
        const signature=beijingDate()+':'+sources.join('|');
        if(!worker&&Date.now()>=retryAt&&(signature!==seen||Date.now()-checkedAt>=3600000)){
          checkedAt=Date.now();seen=signature;
          worker=spawn(process.execPath,['--import','tsx','scripts/refresh-precomputed.ts'],{cwd:root,stdio:'inherit'});
          worker.once('exit',code=>{worker=null;if(code!==0)retryAt=Date.now()+3600000;});
          worker.once('error',()=>{worker=null;retryAt=Date.now()+3600000;});
        }
      }catch{/* A previous immutable snapshot remains available offline. */}
      res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Precomputed-Updater',worker?'running':Date.now()<retryAt?'backoff':'idle');
      if(published)res.end(published);
      else{res.statusCode=503;res.end(JSON.stringify({error:'正在准备发布快照，请稍后重试'}));}
    });
  }};
}
