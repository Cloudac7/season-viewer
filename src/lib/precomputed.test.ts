import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {repairPublicationFiles,verifyPublicationFiles} from '../../scripts/precompute-spatial';
import {compactDetails,decodeSpatialField,encodeSpatialField,expireSpatialForecast,fetchPrecomputedAsset,fieldMeta,packCountyReadings,precomputedForecastFresh,readSelectedCell,restoreDetails,unpackCountyReadings,validPrecomputedManifest} from './precomputed';
import type {PrecomputedManifest} from './precomputed';
import {computeSpatialField,sampleGridCell} from './spatial-field';
import type {SpatialFieldInput} from './spatial-field';
import {addDays} from './season';
import {classifyCounty,summarizePrefectures} from './counties';
import type {CountyUnit} from './counties';

const date='2026-10-25',now='2026-10-26T04:00:00Z',issuedAt='2026-10-26T00:00:00Z';
function fixture():SpatialFieldInput {
  const nodes=[0,1,2,3].map(index=>({id:`p${index}`,row:Math.floor(index/2),col:index%2,lon:100+index%2,lat:30+Math.floor(index/2)}));
  return {date,now,catalog:{version:1,id:'test',crs:'WGS84',step:1,origin:[100,30],rows:2,cols:2,nodes,source:{name:'test',url:'',retrievedAt:issuedAt,boundarySha256:'',note:''}},
    terrain:{version:1,bounds:{west:100,east:101,south:30,north:31},step:.5,rows:3,cols:3,heights:[0,200,400,600,800,1000,1200,1400,1600],source:{name:'DEM',url:'',documentation:'',attribution:'',retrievedAt:issuedAt,crs:'EPSG:4326',sourceZoom:6,resampling:'test',note:''}},
    weather:{version:1,source:'open-meteo',timeZone:'Asia/Shanghai',catalogId:'test',updatedAt:issuedAt,records:Object.fromEntries(nodes.map(node=>[node.id,{lon:node.lon,lat:node.lat,elevation:500,modelGrid:[node.lon,node.lat],updatedAt:issuedAt,days:Array.from({length:14},(_,i)=>({date:addDays(date,i-13),mean:18+i*.1})),forecast:{issuedAt,days:Array.from({length:7},(_,i)=>({date:addDays(date,i+1),mean:8}))}}]))}};
}
test('binary field round trip preserves signed categories, float planes, NaNs and geometry',()=>{
  const field=computeSpatialField(fixture());field.seasons[0]=-1;field.temperature[0]=NaN;
  const decoded=decodeSpatialField(encodeSpatialField(field),fieldMeta(field));
  for(const key of ['seasons','targets','temperature','average','status','expectedDays','transitionDays','estimated'] as const)assert.deepEqual(decoded[key],field[key]);
  assert.deepEqual(decoded.metadata,field.metadata);assert.equal(decoded.date,date);
});
test('binary decoder rejects corrupt dimensions and truncated assets',()=>{
  const field=computeSpatialField(fixture()),buffer=encodeSpatialField(field);
  assert.throws(()=>decodeSpatialField(buffer.slice(0,-1),fieldMeta(field)),/格式或尺寸/);
  assert.throws(()=>decodeSpatialField(buffer,{...fieldMeta(field),cols:4}),/格式或尺寸/);
  new DataView(buffer).setUint32(0,0,true);assert.throws(()=>decodeSpatialField(buffer,fieldMeta(field)),/格式或尺寸/);
});
test('expired forecast retains observed pending runs without mutating immutable cache',()=>{
  const field=computeSpatialField(fixture());field.status[0]=2;field.targets[0]=3;field.transitionDays[0]=2;field.expectedDays[0]=3;field.status[1]=2;field.targets[1]=3;field.transitionDays[1]=0;
  const expired=expireSpatialForecast(field);
  assert.equal(expired.status[0],1);assert.equal(expired.targets[0],3);assert.equal(expired.status[1],0);assert.equal(expired.targets[1],-1);assert.equal(expired.expectedDays[0],0);assert.equal(expired.metadata.forecastCells,0);
  assert.equal(field.status[0],2);assert.equal(field.targets[1],3);
});
test('compact click sources reproduce daily interpolation and seasonal state exactly',()=>{
  const input=fixture(),details=compactDetails(input),restored=restoreDetails(details,new Int16Array(input.terrain.heights).buffer);
  const original=sampleGridCell(input,100.5,30.5)!,selected=readSelectedCell(restored,date,100.51,30.49,new Date(now))!;
  assert.deepEqual(selected,original);assert.equal(readSelectedCell(restored,date,99,30,new Date(now)),null);
  assert.throws(()=>restoreDetails(details,new ArrayBuffer(2)),/高程尺寸/);
});
test('compact source restores mixed retrieval dates without treating yesterday as a current forecast',()=>{
  const input=fixture();input.weather.records.p0.forecast={issuedAt:'2026-10-25T00:00:00Z',days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-25',i),mean:5}))};
  const details=compactDetails(input),restored=restoreDetails(details,new Int16Array(input.terrain.heights).buffer);
  assert.equal(restored.weather.records.p1.forecast.days[0].date,'2026-10-26');assert.equal(restored.weather.records.p0.forecast.days[0].date,'2026-10-25');
  assert.equal(readSelectedCell(restored,date,100.5,30.5,new Date(now))!.forecastTransition,null);
});
test('precomputed forecast expires at Beijing midnight and the source deadline',()=>{
  const manifest={evaluatedDay:'2026-10-26'} as PrecomputedManifest,frame={forecastValidUntil:'2026-10-26T16:00:00Z'} as PrecomputedManifest['frames'][string];
  assert.equal(precomputedForecastFresh(manifest,frame,new Date('2026-10-26T15:59:59Z')),true);
  assert.equal(precomputedForecastFresh(manifest,frame,new Date('2026-10-26T16:00:00Z')),false);
  assert.equal(precomputedForecastFresh(manifest,{...frame,forecastValidUntil:'2026-10-26T05:00:00Z'},new Date('2026-10-26T05:00:00Z')),false);
});
test('county snapshots retain prepared states and expire forecasts without classifying again',()=>{
  const input=fixture(),unit:CountyUnit={id:'1',name:'县',provinceCode:1,province:'省',cityCode:11,city:'市',region:'西北',kind:'county',display:[100,30],lon:100,lat:30,pointMethod:'test'};
  const reading=classifyCounty(unit,input.weather.records.p0,date,new Date(now));
  reading.state={...reading.state!,transition:{target:'winter',days:2,start:'2026-10-24',threshold:10}};
  reading.forecastTransition={target:'winter',expectedDate:'2026-10-29',forecastDays:4,issuedAt};
  const saved=packCountyReadings(date,[reading],summarizePrefectures([reading]),issuedAt),current=unpackCountyReadings(saved,[unit],new Date(now))[0];
  assert.equal(current.unit,unit);assert.equal(current.state!.season,reading.state!.season);assert.equal(current.state!.average,reading.state!.average);assert.deepEqual(current.forecastTransition,reading.forecastTransition);
  const withoutObserved=structuredClone(saved);withoutObserved.readings[0].state!.transition=null;
  assert.equal(unpackCountyReadings(withoutObserved,[unit],new Date(now))[0].forecastTransition,null);
  assert.equal(unpackCountyReadings(saved,[unit],new Date('2026-10-26T16:00:00Z'))[0].forecastTransition,null);
});
test('manifest validation requires a complete frame publication',()=>{
  assert.equal(validPrecomputedManifest({version:1,revision:'abc',dates:[date],frames:{[date]:{field:'a'}}}),false);
});

test('failed asset requests leave the shared cache and can be retried',async t=>{
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return calls===1?new Response('temporary failure',{status:503}):new Response(JSON.stringify({ready:true}),{status:200});};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const url='/test-assets/retry-after-503.json';
  const failures=await Promise.allSettled([fetchPrecomputedAsset(url),fetchPrecomputedAsset(url)]);
  assert.equal(calls,1);assert.ok(failures.every(result=>result.status==='rejected'));
  const recovered=await fetchPrecomputedAsset<{ready:boolean}>(url);assert.deepEqual(recovered,{ready:true});assert.equal(calls,2);
  assert.equal(await fetchPrecomputedAsset(url),recovered);assert.equal(calls,2);
});
test('an existing immutable publication repairs missing, empty and nonfile assets only',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'season-publication-')),staged=join(directory,'staged'),published=join(directory,'published');
  t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(staged);await mkdir(published);
  for(const name of ['healthy.bin','missing.bin','empty.bin','directory.bin'])await writeFile(join(staged,name),`new:${name}`);
  await writeFile(join(published,'healthy.bin'),'healthy immutable content');const before=await stat(join(published,'healthy.bin'));
  await writeFile(join(published,'empty.bin'),'');await mkdir(join(published,'directory.bin'));
  await repairPublicationFiles(staged,published);
  assert.equal(await readFile(join(published,'healthy.bin'),'utf8'),'healthy immutable content');assert.equal((await stat(join(published,'healthy.bin'))).ino,before.ino);
  for(const name of ['missing.bin','empty.bin','directory.bin'])assert.equal(await readFile(join(published,name),'utf8'),`new:${name}`);
});

test('publication cache hits require every asset to be a nonempty regular file',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'season-cache-validation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const healthy=join(directory,'healthy.bin'),empty=join(directory,'empty.bin'),folder=join(directory,'folder.bin'),missing=join(directory,'missing.bin');
  await writeFile(healthy,'complete asset');await writeFile(empty,'');await mkdir(folder);
  await verifyPublicationFiles([healthy]);
  await assert.rejects(verifyPublicationFiles([healthy,empty]),/Incomplete precomputed asset/);
  await assert.rejects(verifyPublicationFiles([healthy,folder]),/Incomplete precomputed asset/);
  await assert.rejects(verifyPublicationFiles([healthy,missing]),{code:'ENOENT'});
});
