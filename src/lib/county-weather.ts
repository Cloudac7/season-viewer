import type { CountyUnit, CountyWeather, CountySeries } from './counties';
import { countyHistoricalDays } from './counties';
import type {DayTemperature} from '../types';
import { addDays, beijingDate } from './season';
import {fetchOpenMeteo} from './open-meteo';

interface ApiLocation {latitude:number;longitude:number;daily?:{time:string[];temperature_2m_mean:(number|null)[]}}
/** A stale or absent point needs fourteen days to recover the history window. */
export function countyBatchPastDays(units:CountyUnit[],previous:CountyWeather,today=beijingDate()):number{
  return units.some(unit=>{
    const series=previous.records[unit.id],historical=series?countyHistoricalDays(series):[];
    return !historical.length||historical.at(-1)!.date<addDays(today,-3);
  })?14:2;
}
/** One variable across 21 bootstrap days costs 1.5 calls per location. */
export function countyBatchApiCost(units:CountyUnit[],previous:CountyWeather,today=beijingDate()):number{
  return units.length*Math.max(1,(countyBatchPastDays(units,previous,today)+7)/14);
}
export async function fetchCountyBatch(units:CountyUnit[],previous:CountyWeather,signal:AbortSignal):Promise<CountyWeather>{
  if(!units.length)return previous;
  const params=new URLSearchParams({latitude:units.map(unit=>unit.lat).join(','),longitude:units.map(unit=>unit.lon).join(','),daily:'temperature_2m_mean',timezone:'Asia/Shanghai',past_days:String(countyBatchPastDays(units,previous)),forecast_days:'7'});
  const response=await fetchOpenMeteo(params,signal);
  const body=await response.json();if(body.error)throw new Error(body.reason??'县级模型响应无效');
  const locations:ApiLocation[]=Array.isArray(body)?body:[body];
  if(locations.length!==units.length)throw new Error('县级批次覆盖不完整，保留旧快照');
  const now=new Date().toISOString(),today=beijingDate(new Date(now)),records={...previous.records};
  units.forEach((unit,index)=>{
    const result=locations[index];
    if(!result.daily||result.daily.time.length!==result.daily.temperature_2m_mean.length)throw new Error(`县 ${unit.id} 缺少日温`);
    const prior=previous.records[unit.id];
    const merged=new Map((prior?countyHistoricalDays(prior):[]).map(day=>[day.date,day]));
    const forecast:DayTemperature[]=[];
    result.daily.time.forEach((date,i)=>{
      const value=result.daily!.temperature_2m_mean[i];
      if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('模型日期格式无效');
      const day={date,mean:typeof value==='number'&&Number.isFinite(value)&&value>=-100&&value<=65?value:null};
      if(date<today)merged.set(date,day);else forecast.push(day);
    });
    const days=[...merged.values()].filter(day=>day.date>=addDays(today,-400)&&day.date<today).sort((a,b)=>a.date.localeCompare(b.date));
    if(!Array.from({length:9},(_,i)=>merged.get(addDays(today,-1-i))?.mean).every(mean=>typeof mean==='number'&&Number.isFinite(mean)))throw new Error(`县 ${unit.id} 缺少最近9个完整日，保留旧快照`);
    const series:CountySeries={lon:unit.lon,lat:unit.lat,updatedAt:now,days,modelGrid:[result.longitude,result.latitude],forecast:{issuedAt:now,days:forecast.sort((a,b)=>a.date.localeCompare(b.date))}};
    records[unit.id]=series;
  });
  return {version:1,source:'open-meteo',timeZone:'Asia/Shanghai',updatedAt:now,records};
}
