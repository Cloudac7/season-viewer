import {spawn} from 'node:child_process';
const root=new URL('../',import.meta.url);
const run=(script:string)=>new Promise<number>((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','tsx',script],{cwd:root,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>resolve(code??1));
});
let failed=false;
for(const script of ['scripts/update-counties.ts','scripts/update-weather-grid.ts']){
  try{if(await run(script)!==0){failed=true;break;}}
  catch(error){console.error(error);failed=true;break;}
}
// Real observation-constrained history (ERA5-Land) is best-effort: a failure
// must not block the weather refresh or deployment. Without a fresh field,
// precompute reuses the cached history-era5.json or falls back to model past_days.
if(!failed){
  try{
    if(await run('scripts/fetch-era5-history.ts')!==0)console.warn('ERA5-Land history refresh failed; reusing existing history-era5.json or model past_days');
  }catch(error){console.warn('ERA5-Land history refresh error; continuing with existing/model history');console.warn(error);}
}
// Local development can still bake the previous snapshot after an upstream
// failure. CI never deploys a failed refresh, so do not spend time baking it.
if(!failed||!process.env.CI){
  try{if(await run('scripts/precompute-spatial.ts')!==0)failed=true;}
  catch(error){console.error(error);failed=true;}
}else console.error('Refresh incomplete; skipping CI precomputation and deployment.');
if(failed)process.exitCode=1;
