import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EMPTY_GRID_WEATHER,fetchGridBatch,gridBatchApiCost,gridBatchPastDays,gridHistoricalDays,validGridCatalog,validGridWeather} from './spatial-grid';
import type {WeatherGrid,WeatherGridCatalog,WeatherGridNode} from './spatial-grid';
import {addDays,beijingDate} from './season';

const node:WeatherGridNode={id:'r0c0',row:0,col:0,lon:85,lat:32};
const catalog:WeatherGridCatalog={version:1,id:'test-grid',crs:'WGS84',step:.5,origin:[85,32],rows:2,cols:2,nodes:[node],source:{name:'test',url:'https://open-meteo.com/en/docs',retrievedAt:new Date().toISOString(),boundarySha256:'test',note:'test'}};
const empty=():WeatherGrid=>({...structuredClone(EMPTY_GRID_WEATHER),catalogId:catalog.id});
function apiResult(past=14){
  const today=beijingDate(),time=Array.from({length:past+7},(_,i)=>addDays(today,i-past));
  return {latitude:32,longitude:85,elevation:4823,utc_offset_seconds:28800,daily:{time,temperature_2m_mean:time.map((_,i)=>-7+i*.3)}};
}

test('independent WGS84 grid is regular and includes western interior sampling',async()=>{
  const actual=JSON.parse(await readFile(new URL('../../public/data/weather-grid.json',import.meta.url),'utf8'));
  assert.ok(validGridCatalog(actual));
  assert.equal(actual.step,1);
  assert.ok(actual.nodes.length>1000&&actual.nodes.length<1600);
  assert.ok(actual.nodes.some((point:WeatherGridNode)=>point.lon===85&&point.lat===32));
  assert.ok(actual.nodes.length*1.5+2874<10000);
  const corrupt=structuredClone(catalog);corrupt.nodes[0].lon+=.01;
  assert.equal(validGridCatalog(corrupt),false);
  const duplicate=structuredClone(catalog);duplicate.nodes.push({...node});
  assert.equal(validGridCatalog(duplicate),false);
});

test('grid bootstrap stores real elevation and separates incomplete and forecast days',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async input=>{
      const url=new URL(String(input));
      assert.equal(url.searchParams.get('past_days'),'14');
      assert.equal(url.searchParams.get('forecast_days'),'7');
      assert.equal(url.searchParams.get('cell_selection'),'land');
      assert.equal(url.searchParams.has('elevation'),false);
      return new Response(JSON.stringify(apiResult()),{status:200});
    };
    const data=await fetchGridBatch([node],empty(),new AbortController().signal);
    assert.ok(validGridWeather(data,catalog));
    const series=data.records[node.id],today=beijingDate();
    assert.equal(series.elevation,4823);
    assert.equal(series.days.length,14);
    assert.equal(series.days.at(-1)!.date,addDays(today,-1));
    assert.equal(series.forecast.days.length,7);
    assert.equal(series.forecast.days[0].date,today);
    assert.equal(gridBatchPastDays([node],data),2);
    assert.equal(gridBatchApiCost([node],data),1);
    assert.equal(gridBatchApiCost([node],empty()),1.5);
    const wrong=structuredClone(data);wrong.catalogId='county-records';
    assert.equal(validGridWeather(wrong,catalog),false);
    const forecastAsHistory=structuredClone(data);forecastAsHistory.records[node.id].days.push(series.forecast.days[0]);
    assert.equal(validGridWeather(forecastAsHistory,catalog),false);
    assert.equal(gridHistoricalDays(forecastAsHistory.records[node.id]).length,14);
  }finally{globalThis.fetch=original;}
});

test('incremental grid update retains historical coverage and requests two past days',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify(apiResult()),{status:200});
    const initial=await fetchGridBatch([node],empty(),new AbortController().signal);
    globalThis.fetch=async input=>{
      assert.equal(new URL(String(input)).searchParams.get('past_days'),'2');
      return new Response(JSON.stringify(apiResult(2)),{status:200});
    };
    const updated=await fetchGridBatch([node],initial,new AbortController().signal);
    assert.equal(updated.records[node.id].days.length,14);
    assert.equal(updated.records[node.id].days[0].date,initial.records[node.id].days[0].date);
    const stale=structuredClone(initial);
    stale.records[node.id].days=stale.records[node.id].days.slice(0,-4);
    assert.equal(gridBatchPastDays([node],stale),14);
  }finally{globalThis.fetch=original;}
});

test('grid data rejects missing recent history, invalid elevation and incomplete forecast atomically',async()=>{
  const original=globalThis.fetch,previous=empty();
  try{
    const missing=apiResult();missing.daily.temperature_2m_mean[13]=null as unknown as number;
    globalThis.fetch=async()=>new Response(JSON.stringify(missing),{status:200});
    await assert.rejects(fetchGridBatch([node],previous,new AbortController().signal),/9个完整日/);
    const elevation=apiResult();elevation.elevation=Infinity;
    globalThis.fetch=async()=>new Response(JSON.stringify(elevation),{status:200});
    await assert.rejects(fetchGridBatch([node],previous,new AbortController().signal),/坐标、高程或日温/);
    const forecast=apiResult();forecast.daily.time.pop();forecast.daily.temperature_2m_mean.pop();
    globalThis.fetch=async()=>new Response(JSON.stringify(forecast),{status:200});
    await assert.rejects(fetchGridBatch([node],previous,new AbortController().signal),/7天有效预报/);
    assert.deepEqual(previous.records,{});
  }finally{globalThis.fetch=original;}
});
