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
// Keep a usable published snapshot even if an upstream refresh is unavailable.
// Baking with today's evaluation time also removes expired forecast overlays.
try{if(await run('scripts/precompute-spatial.ts')!==0)failed=true;}
catch(error){console.error(error);failed=true;}
if(failed)process.exitCode=1;
