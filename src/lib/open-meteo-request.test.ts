import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {OpenMeteoHttpError, OpenMeteoNetworkError} from './open-meteo';
import {OpenMeteoQuota, rateLimitUntil, runOpenMeteoBatch, weatherBatchCost} from '../../scripts/open-meteo-request';

async function fixture(t:test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'weather-quota-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=pathToFileURL(`${join(root,'ledger')}/`),dataDirectory=pathToFileURL(`${join(root,'data')}/`);
  await mkdir(directory); await mkdir(dataDirectory);
  let now=Date.parse('2026-10-28T01:00:00Z');
  const sleep=async(ms:number)=>{now+=ms;};
  const make=(session?:string)=>new OpenMeteoQuota({directory,dataDirectory,now:()=>now,sleep,log:()=>{},session});
  return {directory,dataDirectory,sleep,now:()=>now,make};
}

test('cost includes each coordinate and long request duration; Retry-After supports seconds and dates',()=>{
  assert.equal(weatherBatchCost(40,2),40);
  assert.equal(weatherBatchCost(40,14),60);
  const now=Date.parse('2026-10-28T01:00:00Z');
  assert.equal(rateLimitUntil('120',now),now+120000);
  assert.equal(rateLimitUntil('Wed, 28 Oct 2026 02:00:00 GMT',now),now+3600000);
  assert.equal(rateLimitUntil(null,now),now+3600000);
});

test('transient retries reserve every attempt; validation and client errors stop immediately',async t=>{
  const f=await fixture(t),quota=f.make();let attempts=0;
  const result=await runOpenMeteoBatch({quota,kind:'county',cost:40,sleep:f.sleep,log:()=>{},task:async()=>{
    attempts++;if(attempts<3)throw new OpenMeteoNetworkError(Object.assign(new Error('connect'),{code:'ECONNRESET'}));return 'ok';
  }});
  assert.equal(result,'ok');assert.equal(attempts,3);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  assert.equal(usage.length,3);assert.equal(usage.reduce((a:number,x:{cost:number})=>a+x.cost,0),120);
  attempts=0;
  await assert.rejects(runOpenMeteoBatch({quota,kind:'grid',cost:20,sleep:f.sleep,log:()=>{},task:async()=>{attempts++;throw new OpenMeteoHttpError(new Response('',{status:400}));}}),/HTTP 400/);
  assert.equal(attempts,1);
  attempts=0;
  await assert.rejects(runOpenMeteoBatch({quota,kind:'grid',cost:20,sleep:f.sleep,log:()=>{},task:async()=>{attempts++;throw new Error('bad model data');}}),/bad model data/);
  assert.equal(attempts,1);
});

test('a short 429 cooldown retries once, then releases the shared county and grid quota',async t=>{
  const f=await fixture(t);let attempts=0;
  const result=await runOpenMeteoBatch({quota:f.make(),kind:'county',cost:40,sleep:f.sleep,log:()=>{},task:async()=>{
    attempts++;
    if(attempts===1)throw new OpenMeteoHttpError(new Response('',{status:429,headers:{'retry-after':'1'}}));
    return 'ok';
  }});
  assert.equal(result,'ok');
  assert.equal(attempts,2);
  await f.make().reserve('grid',40);
});

test('a long 429 persists its cooldown and stops further county and grid requests',async t=>{
  const f=await fixture(t);let attempts=0;
  await assert.rejects(runOpenMeteoBatch({quota:f.make(),kind:'county',cost:40,sleep:f.sleep,task:async()=>{
    attempts++;throw new OpenMeteoHttpError(new Response('',{status:429,headers:{'retry-after':'3600'}}));
  }}),/HTTP 429/);
  assert.equal(attempts,1);
  await assert.rejects(f.make().reserve('grid',40),/cooldown active/);
  await f.sleep(3600000);
  await f.make().reserve('grid',40);
});

test('restored snapshots recover recent usage and keep legacy entries without double counting them',async t=>{
  const f=await fixture(t),at=new Date(f.now()-10000).toISOString();
  await writeFile(new URL('county-weather.json',f.dataDirectory),JSON.stringify({records:{a:{updatedAt:at},b:{updatedAt:at}}}));
  await writeFile(new URL('weather-grid-weather.json',f.dataDirectory),JSON.stringify({records:{g:{updatedAt:at,lon:100,lat:30}}}));
  await writeFile(new URL('weather-grid-usage.json',f.directory),JSON.stringify([
    {key:`county:a:${at}`,at:f.now()-10000,cost:1},
    {key:`recovered-grid:100:30:${at}`,at:f.now()-10000,cost:1},
  ]));
  await f.make().reserve('county',10);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  assert.equal(usage.length,4);
  assert.equal(usage.find((x:{key:string})=>x.key===`county:b:${at}`).cost,1.5);
});

test('an old production snapshot does not consume a fresh runner daily budget',async t=>{
  const f=await fixture(t),at=new Date(f.now()-7*3600000).toISOString();
  await writeFile(new URL('county-weather.json',f.dataDirectory),JSON.stringify({records:{a:{updatedAt:at},b:{updatedAt:at}}}));
  await f.make().reserve('county',10);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  assert.equal(usage.length,1);
  assert.equal(usage[0].cost,10);
});

test('daily budget and stored cooldown cannot be bypassed by starting another updater',async t=>{
  const f=await fixture(t);
  await writeFile(new URL('weather-grid-usage.json',f.directory),JSON.stringify([{key:'request:legacy',at:f.now()-7200000,cost:9890}]));
  await assert.rejects(f.make().reserve('county',20),/daily budget/);
  await assert.rejects(f.make().reserve('grid',20),/daily budget/);
});

test('operator reservations are idempotent and count toward the shared daily ledger',async t=>{
  const f=await fixture(t),key='external-reserve:2026-10-28:45';
  await f.make().reserveExternal(45,key);
  await f.make().reserveExternal(45,key);
  await f.make().reserve('county',10);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  assert.equal(usage.reduce((sum:number,entry:{cost:number})=>sum+entry.cost,0),55);
});

test('a new workflow session ignores a previous runner usage ledger',async t=>{
  const f=await fixture(t);
  await writeFile(new URL('weather-grid-usage.json',f.directory),JSON.stringify([
    {key:'request:county:old:n100:old',at:f.now()-7200000,cost:9700,session:'run-old'},
  ]));
  await f.make('run-new').reserve('grid',100,100);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  const current=usage.filter((entry:{session?:string})=>entry.session==='run-new');
  assert.equal(current.length,1);
  assert.equal(current[0].cost,100);
});

test('county and grid share one scoped ledger within a workflow run',async t=>{
  const f=await fixture(t),session='4242-1';
  await f.make(session).reserve('county',100,100);
  await f.make(session).reserve('grid',100,100);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  assert.equal(usage.length,2);
  assert.deepEqual(usage.map((entry:{session:string})=>entry.session),[session,session]);
  assert.equal(usage.reduce((sum:number,entry:{cost:number})=>sum+entry.cost,0),200);
});

test('a scoped CI session does not reconstruct quota from prior-run snapshots',async t=>{
  const f=await fixture(t),at=new Date(f.now()-10000).toISOString();
  await writeFile(new URL('county-weather.json',f.dataDirectory),JSON.stringify({records:{a:{updatedAt:at},b:{updatedAt:at}}}));
  await writeFile(new URL('weather-grid-weather.json',f.dataDirectory),JSON.stringify({records:{g:{updatedAt:at,lon:100,lat:30}}}));
  await f.make('run-current').reserve('county',10,10);
  const usage=JSON.parse(await readFile(new URL('weather-grid-usage.json',f.directory),'utf8'));
  assert.equal(usage.length,1);
  assert.equal(usage[0].cost,10);
  assert.equal(usage[0].session,'run-current');
});

test('the daily guard still applies inside an over-budget scoped session',async t=>{
  const f=await fixture(t),session='run-current';
  await writeFile(new URL('weather-grid-usage.json',f.directory),JSON.stringify([
    {key:'request:county:current:n100:old',at:f.now()-7200000,cost:9890,session},
    {key:'request:county:other:n100:old',at:f.now()-7200000,cost:9000,session:'run-other'},
  ]));
  await assert.rejects(f.make(session).reserve('grid',20,20),/daily budget/);
});

test('a cooldown is shared within one workflow session and isolated between runs',async t=>{
  const f=await fixture(t);
  await assert.rejects(runOpenMeteoBatch({quota:f.make('run-old'),kind:'county',cost:40,sleep:f.sleep,task:async()=>{
    throw new OpenMeteoHttpError(new Response('',{status:429,headers:{'retry-after':'3600'}}));
  }}),/HTTP 429/);
  await assert.rejects(f.make('run-old').reserve('grid',40),/cooldown active/);
  await f.make('run-new').reserve('grid',40);
});
