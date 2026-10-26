import {mkdir,writeFile,link,readFile,unlink} from 'node:fs/promises';
import {readFileSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

interface Owner {pid:number;startedAt:string;label:string}
function processAlive(pid:number):boolean {
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
/** County and spatial downloads share a whole-run lock, never nested per-type locks. */
export async function acquireWeatherUpdateLock(label:string,options:{directory?:URL;waitMs?:number}={}):Promise<()=>Promise<void>> {
  const directory=options.directory??new URL('../data-sources/',import.meta.url),lock=new URL('weather-download.lock',directory);
  const waitMs=Math.min(30000,Math.max(10,options.waitMs??30000));
  await mkdir(directory,{recursive:true});
  const owner:Owner={pid:process.pid,startedAt:new Date().toISOString(),label},contents=JSON.stringify({...owner,token:randomUUID()});
  const candidate=new URL(`.weather-download-${process.pid}-${randomUUID()}.lock`,directory);
  // Publish a fully written inode with an exclusive hard link. An empty file
  // from open('wx') must never be mistaken for an abandoned process's lease.
  await writeFile(candidate,contents,{flag:'wx'});
  try{for(;;){
    try{
      await link(candidate,lock);break;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      let prior:string;
      try{prior=await readFile(lock,'utf8');}catch{continue;}
      let active:Owner|null=null;
      try{active=JSON.parse(prior) as Owner;}catch{/* stale partial lock */}
      if(!active||!processAlive(active.pid)){
        // Check again before unlinking so a completed owner cannot cause a
        // stale-lock cleanup to remove the next process's new lease.
        if(await readFile(lock,'utf8').catch(()=>null)===prior)await unlink(lock).catch(()=>{});
        continue;
      }
      console.log(`Weather download waits for ${active.label} (PID ${active.pid}); rechecking in ${Math.ceil(waitMs/1000)}s`);
      await new Promise(resolve=>setTimeout(resolve,waitMs));
    }
  }}finally{await unlink(candidate).catch(()=>{});}
  const onExit=()=>{
    try{if(readFileSync(lock,'utf8')===contents)unlinkSync(lock);}catch{/* released or replaced */}
  };
  process.once('exit',onExit);
  return async()=>{
    process.removeListener('exit',onExit);
    if(await readFile(lock,'utf8').catch(()=>null)===contents)await unlink(lock).catch(()=>{});
  };
}
