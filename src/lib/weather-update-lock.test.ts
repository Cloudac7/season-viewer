import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {acquireWeatherUpdateLock} from '../../scripts/weather-update-lock';

test('county and grid download leases serialize and remove their shared lock',async()=>{
  const path=await mkdtemp(join(tmpdir(),'season-weather-lock-')),directory=pathToFileURL(path+'/'),file=new URL('weather-download.lock',directory);
  try{
    const releaseCounty=await acquireWeatherUpdateLock('county',{directory,waitMs:10});
    assert.equal(JSON.parse(await readFile(file,'utf8')).label,'county');
    let entered=false;
    const waiting=acquireWeatherUpdateLock('grid',{directory,waitMs:10}).then(release=>{entered=true;return release;});
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(entered,false);
    await releaseCounty();
    const releaseGrid=await waiting;
    assert.equal(JSON.parse(await readFile(file,'utf8')).label,'grid');
    await releaseGrid();
    await assert.rejects(readFile(file,'utf8'),{code:'ENOENT'});
  }finally{await rm(path,{recursive:true,force:true});}
});

test('abandoned process lock is recovered before a new download starts',async()=>{
  const path=await mkdtemp(join(tmpdir(),'season-weather-stale-')),directory=pathToFileURL(path+'/'),file=new URL('weather-download.lock',directory);
  try{
    await writeFile(file,JSON.stringify({pid:2147483647,label:'abandoned',startedAt:'2020-01-01T00:00:00.000Z'}));
    const release=await acquireWeatherUpdateLock('grid',{directory,waitMs:10});
    assert.equal(JSON.parse(await readFile(file,'utf8')).pid,process.pid);
    await release();
  }finally{await rm(path,{recursive:true,force:true});}
});
