import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {geoContains} from 'd3-geo';
import {feature} from 'topojson-client';
import type {Topology,GeometryCollection} from 'topojson-specification';
import {classifyCounty,EMPTY_COUNTY_WEATHER,mergeCountyWeather,summarizePrefectures,validCountyWeather} from './counties';
import type {CountyCatalog,CountyBoundaries,CountySeries,CountyWeather} from './counties';
import {fetchCountyBatch} from './county-weather';
import {gcjToWgs,wgsToGcj} from './coordinates';
import {sampleColor} from './field';
import {addDays,beijingDate} from './season';
import {SEASONS,SEASON_ORDER} from '../data';

const catalog=JSON.parse(readFileSync(new URL('../../public/data/counties.json',import.meta.url),'utf8')) as CountyCatalog;
const unit=catalog.units[0];
const days=(values:(number|null)[],start='2026-10-01'):CountySeries=>({lon:unit.lon,lat:unit.lat,updatedAt:'2026-10-23T00:00:00Z',days:values.map((mean,i)=>({date:addDays(start,i),mean}))});
const dataset=(series:CountySeries):CountyWeather=>({...EMPTY_COUNTY_WEATHER,updatedAt:series.updatedAt,records:{[unit.id]:series}});

test('county identities and real boundaries match without invented Taiwan subdivisions',()=>{
  assert.equal(catalog.units.length,2874);assert.equal(new Set(catalog.units.map(u=>u.id)).size,2874);
  assert.equal(catalog.units.filter(u=>u.kind==='undivided-city').length,4);
  assert.equal(new Set(catalog.units.map(u=>u.provinceCode)).size,33);
  assert.ok(!catalog.units.some(u=>u.provinceCode===710000));
  const topology=JSON.parse(readFileSync(new URL('../../public/data/counties.topo.json',import.meta.url),'utf8')) as Topology<{counties:GeometryCollection<{id:string}>}>;
  const boundaries=feature(topology,topology.objects.counties) as CountyBoundaries;
  const shapes=new Map(boundaries.features.map(f=>[f.properties.id,f]));
  assert.equal(shapes.size,catalog.units.length);
  for(const u of catalog.units)assert.ok(geoContains(shapes.get(u.id)!,u.display),`${u.name} representative must be inside its county`);
});
test('model queries convert GCJ-02 display points to WGS84 rather than mixing coordinate systems',()=>{
  const gcj=wgsToGcj(116.404,39.915);
  assert.ok(Math.abs(gcj[0]-116.41024449916938)<1e-8);assert.ok(Math.abs(gcj[1]-39.91640428150164)<1e-8);
  const wgs=gcjToWgs(...gcj);assert.ok(Math.abs(wgs[0]-116.404)<1e-6);assert.ok(Math.abs(wgs[1]-39.915)<1e-6);
  assert.deepEqual(gcjToWgs(-.1276,51.5072),[-.1276,51.5072]);
  for(const u of catalog.units){const [lon,lat]=wgsToGcj(u.lon,u.lat);assert.ok(Math.abs(lon-u.display[0])<2e-6&&Math.abs(lat-u.display[1])<2e-6);}
});
test('county data validation rejects mismatched identities, shifted coordinates and bad daily values',()=>{
  const good=dataset(days(Array(9).fill(15)));assert.equal(validCountyWeather(good,catalog),true);
  const wrongId=structuredClone(good);wrongId.records.unknown=wrongId.records[unit.id];assert.equal(validCountyWeather(wrongId,catalog),false);
  const wrongPoint=structuredClone(good);wrongPoint.records[unit.id].lon+=.1;assert.equal(validCountyWeather(wrongPoint,catalog),false);
  const duplicate=structuredClone(good);duplicate.records[unit.id].days[4]=duplicate.records[unit.id].days[3];assert.equal(validCountyWeather(duplicate,catalog),false);
  const invalid=structuredClone(good);invalid.records[unit.id].days[4].mean=999999;assert.equal(validCountyWeather(invalid,catalog),false);
  invalid.records[unit.id].days[4]={date:'2026-02-30',mean:null};assert.equal(validCountyWeather(invalid,catalog),false);
});
test('missing or insufficient county data remains gray without borrowing a neighboring point',()=>{
  assert.equal(classifyCounty(unit,undefined,'2026-10-09').state,null);
  assert.equal(classifyCounty(unit,days(Array(8).fill(15)),'2026-10-08').status,'insufficient');
  const broken=days([15,15,15,null,15,15,15,15,15]);assert.equal(classifyCounty(unit,broken,'2026-10-09').state,null);
  assert.equal(classifyCounty(unit,days(Array(9).fill(15)),'2026-10-10').status,'stale');
});
test('county transitions use consecutive complete days and ignore future temperatures',()=>{
  const input=days([24,24,24,24,24,18,18,18,18,18,18]);
  const pending=classifyCounty(unit,input,'2026-10-10');assert.equal(pending.state?.season,'summer');assert.equal(pending.state?.transition?.days,4);
  const confirmed=classifyCounty(unit,input,'2026-10-11');assert.equal(confirmed.state?.season,'autumn');
  const unchanged=classifyCounty(unit,{...input,days:[...input.days,...days(Array(9).fill(-10),'2026-10-12').days]},'2026-10-10');assert.equal(unchanged.state?.season,pending.state?.season);assert.equal(unchanged.state?.average,pending.state?.average);
});
test('snapshot merging keeps the freshest record for each county during partial updates',()=>{
  const old=dataset(days(Array(9).fill(15))),fresh=structuredClone(old);fresh.records[unit.id].updatedAt='2026-10-24T00:00:00Z';fresh.records[unit.id].days[0].mean=16;fresh.updatedAt='2026-10-24T00:00:00Z';
  assert.equal(mergeCountyWeather(fresh,old).records[unit.id].days[0].mean,16);
  const other=catalog.units[1];old.records[other.id]={...days(Array(9).fill(15)),lon:other.lon,lat:other.lat};
  assert.equal(Object.keys(mergeCountyWeather(old,fresh).records).length,2);
});
test('prefecture summaries exclude missing counties and report tied seasons',()=>{
  const first=classifyCounty(unit,days(Array(9).fill(25)),'2026-10-09');
  const other={...unit,id:'other'};const second=classifyCounty(other,days(Array(9).fill(5)),'2026-10-09');
  const missing=classifyCounty({...unit,id:'missing'},undefined,'2026-10-09');
  const summary=summarizePrefectures([first,second,missing])[0];
  assert.equal(summary.ready.length,2);assert.equal(summary.readings.length,3);assert.equal(summary.average,15);assert.deepEqual(summary.mainSeasons,['summer','winter']);
});
test('county seasons use the exact four legend colors rather than interpolated mixtures',()=>{
  const state=classifyCounty(unit,days(Array(9).fill(15)),'2026-10-09').state!;
  for(const season of SEASON_ORDER)assert.equal(sampleColor({...state,season},'season'),SEASONS[season].fill);
  assert.equal(sampleColor({...state,average:null},'season'),'#e0e6e2');
});
test('initial model fetch batches representative coordinates with an explicit Beijing daily boundary',async t=>{
  let requested='';const today=beijingDate();
  t.mock.method(globalThis,'fetch',async(url:string)=>{requested=url;return new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:Array.from({length:15},(_,i)=>addDays(today,i-14)),temperature_2m_mean:Array(15).fill(15)}}));});
  const result=await fetchCountyBatch([unit],EMPTY_COUNTY_WEATHER,new AbortController().signal);
  const params=new URL(requested).searchParams;
  assert.equal(params.get('latitude'),String(unit.lat));assert.equal(params.get('longitude'),String(unit.lon));assert.equal(params.get('timezone'),'Asia/Shanghai');assert.equal(params.get('past_days'),'14');
  assert.equal(classifyCounty(unit,result.records[unit.id],addDays(today,-1)).status,'ready');
});
test('incremental fetch retains older history and rejects partial responses without mutating the snapshot',async t=>{
  const today=beijingDate(),previous=dataset(days(Array(30).fill(15),addDays(today,-30))),original=JSON.stringify(previous);let requested='';
  t.mock.method(globalThis,'fetch',async(url:string)=>{requested=url;return new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:[addDays(today,-2),addDays(today,-1),today],temperature_2m_mean:[16,16,16]}}));});
  const updated=await fetchCountyBatch([unit],previous,new AbortController().signal);
  assert.equal(new URL(requested).searchParams.get('past_days'),'2');assert.equal(updated.records[unit.id].days[0].date,addDays(today,-30));assert.equal(updated.records[unit.id].days.at(-1)?.mean,16);assert.equal(JSON.stringify(previous),original);
  t.mock.method(globalThis,'fetch',async()=>new Response('[]'));
  await assert.rejects(fetchCountyBatch([unit],previous,new AbortController().signal),/覆盖不完整/);assert.equal(JSON.stringify(previous),original);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:['2026-02-30'],temperature_2m_mean:[15]}})));
  await assert.rejects(fetchCountyBatch([unit],previous,new AbortController().signal),/日期格式无效/);
});
