import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {geoContains} from 'd3-geo';
import {feature} from 'topojson-client';
import type {Topology,GeometryCollection} from 'topojson-specification';
import {classifyCounty,countyForecastIsFresh,countyHistoricalDays,EMPTY_COUNTY_WEATHER,mergeCountyWeather,summarizePrefectures,validCountyWeather} from './counties';
import type {CountyCatalog,CountyBoundaries,CountySeries,CountyWeather} from './counties';
import {countyBatchApiCost,countyBatchPastDays,fetchCountyBatch} from './county-weather';
import {OpenMeteoHttpError} from './open-meteo';
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
test('legacy unfinished days stay forecasts even after the snapshot becomes old',()=>{
  const legacy=days(Array(12).fill(15),'2026-10-14');
  assert.equal(countyHistoricalDays(legacy).at(-1)?.date,'2026-10-22');
  assert.equal(classifyCounty(unit,legacy,'2026-10-23',new Date('2026-10-25T00:00:00Z')).status,'stale');
  assert.equal(classifyCounty(unit,legacy,'2026-10-24',new Date('2026-10-25T00:00:00Z')).state,null);
});
test('county projection and validation keep forecasts separate from observed seasons',()=>{
  const series=days([24,24,24,24,24,18,18,18,18,18]);series.updatedAt='2026-10-11T00:00:00Z';
  series.forecast={issuedAt:series.updatedAt,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-11',i),mean:18}))};
  const now=new Date('2026-10-11T04:00:00Z'),reading=classifyCounty(unit,series,'2026-10-10',now);
  assert.equal(reading.state?.season,'summer');assert.equal(reading.forecastTransition?.target,'autumn');
  assert.equal(reading.forecastTransition?.expectedDate,'2026-10-11');assert.equal(countyForecastIsFresh(series,now),true);
  assert.equal(validCountyWeather(dataset(series),catalog),true);
  const incomplete=structuredClone(series);incomplete.forecast!.days[6].mean=null;
  assert.equal(countyForecastIsFresh(incomplete,now),false);assert.equal(classifyCounty(unit,incomplete,'2026-10-10',now).forecastTransition,null);
  const invalid=structuredClone(series);invalid.forecast!.days[1].date='2026-10-10';
  assert.equal(validCountyWeather(dataset(invalid),catalog),false);
  invalid.forecast={issuedAt:'2026-10-12T00:00:00Z',days:[]};assert.equal(validCountyWeather(dataset(invalid),catalog),false);
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
test('prefecture signals count observed and forecast transitions once per county',()=>{
  const observed=classifyCounty(unit,days([24,24,24,24,24,18,18,18,18,18]),'2026-10-10');
  const forecast={target:'autumn' as const,expectedDate:'2026-10-11',forecastDays:1,issuedAt:'2026-10-11T00:00:00Z'};
  const both={...observed,forecastTransition:forecast};
  const predicted={...classifyCounty({...unit,id:'future'},days(Array(9).fill(25)),'2026-10-09'),forecastTransition:forecast};
  const summary=summarizePrefectures([both,predicted])[0];
  assert.equal(summary.transitionCount,2);assert.equal(summary.forecastCount,2);
});
test('county seasons use the exact four legend colors rather than interpolated mixtures',()=>{
  const state=classifyCounty(unit,days(Array(9).fill(15)),'2026-10-09').state!;
  for(const season of SEASON_ORDER)assert.equal(sampleColor({...state,season},'season'),SEASONS[season].fill);
  assert.equal(sampleColor({...state,average:null},'season'),'#e0e6e2');
});
test('initial model fetch batches representative coordinates with an explicit Beijing daily boundary',async t=>{
  let requested='';const today=beijingDate();
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{assert.equal(url,'https://api.open-meteo.com/v1/forecast');assert.equal(init.method,'POST');requested=String(init.body);return new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:Array.from({length:21},(_,i)=>addDays(today,i-14)),temperature_2m_mean:Array(21).fill(15)}}));});
  const result=await fetchCountyBatch([unit],EMPTY_COUNTY_WEATHER,new AbortController().signal);
  const params=new URLSearchParams(requested);
  assert.equal(params.get('latitude'),String(unit.lat));assert.equal(params.get('longitude'),String(unit.lon));assert.equal(params.get('timezone'),'Asia/Shanghai');assert.equal(params.get('past_days'),'14');assert.equal(params.get('forecast_days'),'7');
  assert.equal(countyBatchPastDays([unit],EMPTY_COUNTY_WEATHER,today),14);assert.equal(countyBatchApiCost([unit],EMPTY_COUNTY_WEATHER,today),1.5);
  assert.equal(classifyCounty(unit,result.records[unit.id],addDays(today,-1)).status,'ready');
  assert.equal(result.records[unit.id].days.at(-1)?.date,addDays(today,-1));
  assert.equal(result.records[unit.id].forecast?.days[0].date,today);assert.equal(result.records[unit.id].forecast?.days.length,7);
});
test('incremental fetch retains older history and rejects partial responses without mutating the snapshot',async t=>{
  const today=beijingDate(),previous=dataset(days(Array(30).fill(15),addDays(today,-30)));let requested='';
  previous.records[unit.id].updatedAt=new Date(`${addDays(today,-1)}T00:00:00Z`).toISOString();
  const saved=JSON.stringify(previous);
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{requested=String(init.body);return new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:Array.from({length:9},(_,i)=>addDays(today,i-2)),temperature_2m_mean:Array(9).fill(16)}}));});
  const updated=await fetchCountyBatch([unit],previous,new AbortController().signal);
  assert.equal(new URLSearchParams(requested).get('past_days'),'2');assert.equal(countyBatchPastDays([unit],previous,today),2);assert.equal(countyBatchApiCost([unit],previous,today),1);assert.equal(updated.records[unit.id].days[0].date,addDays(today,-30));assert.equal(updated.records[unit.id].days.at(-1)?.mean,16);assert.equal(JSON.stringify(previous),saved);assert.equal(updated.records[unit.id].forecast?.days.length,7);
  t.mock.method(globalThis,'fetch',async()=>new Response('[]'));
  await assert.rejects(fetchCountyBatch([unit],previous,new AbortController().signal),/覆盖不完整/);assert.equal(JSON.stringify(previous),saved);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:['2026-02-30'],temperature_2m_mean:[15]}})));
  await assert.rejects(fetchCountyBatch([unit],previous,new AbortController().signal),/日期格式无效/);
});
test('refresh fills stale history from the API instead of promoting old forecast temperatures',async t=>{
  const today=beijingDate(),previous=dataset(days(Array(16).fill(15),addDays(today,-17)));let requested='';
  previous.records[unit.id].updatedAt=`${addDays(today,-4)}T00:00:00Z`;
  previous.records[unit.id].days.push({date:addDays(today,-1),mean:-30});
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{requested=String(init.body);return new Response(JSON.stringify({latitude:unit.lat,longitude:unit.lon,daily:{time:Array.from({length:21},(_,i)=>addDays(today,i-14)),temperature_2m_mean:Array(21).fill(16)}}));});
  const result=await fetchCountyBatch([unit],previous,new AbortController().signal);
  assert.equal(new URLSearchParams(requested).get('past_days'),'14');
  assert.equal(result.records[unit.id].days.at(-1)?.mean,16);assert.ok(result.records[unit.id].days.every(day=>day.date<today));
  assert.equal(result.records[unit.id].forecast?.days.length,7);
});
test('county HTTP errors preserve status and Retry-After without changing the snapshot',async t=>{
  const previous=structuredClone(EMPTY_COUNTY_WEATHER);
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:429,headers:{'Retry-After':'120'}}));
  await assert.rejects(fetchCountyBatch([unit],previous,new AbortController().signal),(error:unknown)=>error instanceof OpenMeteoHttpError&&error.status===429&&error.retryAfter==='120');
  assert.deepEqual(previous,EMPTY_COUNTY_WEATHER);
});
test('county multi-point batches preserve response order and charge each requested location',async t=>{
  const units=catalog.units.slice(0,2),today=beijingDate();
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
    const params=new URLSearchParams(String(init.body));
    assert.equal(params.get('latitude'),units.map(point=>point.lat).join(','));
    assert.equal(params.get('longitude'),units.map(point=>point.lon).join(','));
    const time=Array.from({length:21},(_,i)=>addDays(today,i-14));
    return new Response(JSON.stringify(units.map((point,i)=>({latitude:point.lat,longitude:point.lon,daily:{time,temperature_2m_mean:Array(21).fill(10+i)}}))));
  });
  const result=await fetchCountyBatch(units,EMPTY_COUNTY_WEATHER,new AbortController().signal);
  assert.equal(result.records[units[0].id].days.at(-1)?.mean,10);
  assert.equal(result.records[units[1].id].days.at(-1)?.mean,11);
  assert.equal(countyBatchApiCost(units,EMPTY_COUNTY_WEATHER,today),3);
  assert.equal(countyBatchApiCost(units,result,today),2);
  delete result.records[units[1].id];
  assert.equal(countyBatchPastDays(units,result,today),14);
  assert.equal(countyBatchApiCost(units,result,today),3);
});
