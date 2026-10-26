import type { DayTemperature } from '../types';
import type { TemperatureForecast } from './forecast';
import { forecastIsFresh } from './forecast';
import { addDays, beijingDate } from './season';

/** Coordinates and sample spacing are WGS84, independent of county representatives. */
export interface WeatherGridNode { id:string; row:number; col:number; lon:number; lat:number }
export interface WeatherGridCatalog {
  version:1; id:string; crs:'WGS84'; step:number; origin:[number,number]; rows:number; cols:number;
  nodes:WeatherGridNode[];
  source:{ name:string; url:string; retrievedAt:string; boundarySha256:string; note:string };
}
export interface WeatherGridSeries {
  lon:number; lat:number; elevation:number; modelGrid:[number,number]; updatedAt:string;
  days:DayTemperature[]; forecast:TemperatureForecast;
}
export interface WeatherGrid {
  version:1; source:'open-meteo'; timeZone:'Asia/Shanghai'; catalogId:string;
  updatedAt:string|null; records:Record<string,WeatherGridSeries>;
}
export const EMPTY_GRID_WEATHER:WeatherGrid={version:1,source:'open-meteo',timeZone:'Asia/Shanghai',catalogId:'',updatedAt:null,records:{}};

function validDate(date:unknown):date is string {
  return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
}
function validDays(days:unknown):days is DayTemperature[] {
  return Array.isArray(days)&&days.every((day,i)=>day&&validDate(day.date)&&(i===0||day.date>days[i-1].date)&&(day.mean===null||typeof day.mean==='number'&&Number.isFinite(day.mean)&&day.mean>=-100&&day.mean<=65));
}
export function validGridCatalog(value:unknown):value is WeatherGridCatalog {
  if(!value||typeof value!=='object')return false;
  const catalog=value as WeatherGridCatalog;
  if(catalog.version!==1||typeof catalog.id!=='string'||!catalog.id||catalog.crs!=='WGS84'||!Number.isFinite(catalog.step)||catalog.step<=0||catalog.step>2||!Array.isArray(catalog.origin)||catalog.origin.length!==2||!catalog.origin.every(Number.isFinite)||!Number.isInteger(catalog.rows)||!Number.isInteger(catalog.cols)||catalog.rows<2||catalog.cols<2||!Array.isArray(catalog.nodes)||!catalog.nodes.length)return false;
  const ids=new Set<string>();
  return catalog.nodes.every(node=>{
    if(!node||typeof node.id!=='string'||ids.has(node.id)||node.id!==`r${node.row}c${node.col}`||!Number.isInteger(node.row)||!Number.isInteger(node.col)||node.row<0||node.row>=catalog.rows||node.col<0||node.col>=catalog.cols||!Number.isFinite(node.lon)||!Number.isFinite(node.lat)||Math.abs(node.lon-catalog.origin[0]-node.col*catalog.step)>1e-6||Math.abs(node.lat-catalog.origin[1]-node.row*catalog.step)>1e-6)return false;
    ids.add(node.id);return true;
  });
}
export function gridHistoricalDays(series:WeatherGridSeries):DayTemperature[] {
  const cutoff=beijingDate(new Date(series.updatedAt));
  return series.days.filter(day=>day.date<cutoff);
}
export function gridForecastIsFresh(series:WeatherGridSeries|undefined,now=new Date()):boolean {
  return forecastIsFresh(series?.forecast,now);
}
export function validGridWeather(value:unknown,catalog:WeatherGridCatalog):value is WeatherGrid {
  if(!value||typeof value!=='object')return false;
  const weather=value as WeatherGrid;
  if(weather.version!==1||weather.source!=='open-meteo'||weather.timeZone!=='Asia/Shanghai'||weather.catalogId!==catalog.id||!weather.records||typeof weather.records!=='object'||Array.isArray(weather.records)||(weather.updatedAt!==null&&!Number.isFinite(Date.parse(weather.updatedAt))))return false;
  const nodes=new Map(catalog.nodes.map(node=>[node.id,node]));
  return Object.entries(weather.records).every(([id,series])=>{
    const node=nodes.get(id);
    if(!node||!series||!Number.isFinite(Date.parse(series.updatedAt))||!Number.isFinite(series.lon)||!Number.isFinite(series.lat)||Math.abs(series.lon-node.lon)>1e-6||Math.abs(series.lat-node.lat)>1e-6||!Number.isFinite(series.elevation)||series.elevation < -500||series.elevation>9000||!Array.isArray(series.modelGrid)||series.modelGrid.length!==2||!series.modelGrid.every(Number.isFinite)||Math.abs(series.modelGrid[0]-node.lon)>1.5||Math.abs(series.modelGrid[1]-node.lat)>1.5||!validDays(series.days)||!series.forecast||!Number.isFinite(Date.parse(series.forecast.issuedAt))||Date.parse(series.forecast.issuedAt)>Date.parse(series.updatedAt)||!validDays(series.forecast.days))return false;
    const cutoff=beijingDate(new Date(series.updatedAt)),issuedDay=beijingDate(new Date(series.forecast.issuedAt));
    return series.days.every(day=>day.date<cutoff)&&series.forecast.days.every(day=>day.date>=issuedDay);
  });
}

interface ApiLocation {
  latitude:number; longitude:number; elevation:number; utc_offset_seconds?:number;
  daily?:{ time:string[]; temperature_2m_mean:(number|null)[] };
}
export function gridBatchPastDays(nodes:WeatherGridNode[],previous:WeatherGrid,today=beijingDate()):number {
  return nodes.some(node=>{
    const series=previous.records[node.id],days=series?gridHistoricalDays(series):[];
    return !days.length||days.at(-1)!.date<addDays(today,-3);
  })?14:2;
}
/** One variable for 21 bootstrap days is conservatively budgeted as 1.5 calls/location. */
export function gridBatchApiCost(nodes:WeatherGridNode[],previous:WeatherGrid,today=beijingDate()):number {
  return nodes.length*Math.max(1,(gridBatchPastDays(nodes,previous,today)+7)/14);
}
export async function fetchGridBatch(nodes:WeatherGridNode[],previous:WeatherGrid,signal:AbortSignal):Promise<WeatherGrid> {
  if(!nodes.length)return previous;
  const requestToday=beijingDate();
  const params=new URLSearchParams({latitude:nodes.map(node=>node.lat).join(','),longitude:nodes.map(node=>node.lon).join(','),daily:'temperature_2m_mean',timezone:'Asia/Shanghai',past_days:String(gridBatchPastDays(nodes,previous,requestToday)),forecast_days:'7',cell_selection:'land'});
  // Omit elevation: Open-Meteo uses the requested point's 90 m DEM elevation
  // for its existing statistical downscaling; do not apply a second lapse rate.
  const response=await fetch(`https://api.open-meteo.com/v1/forecast?${params}`,{signal});
  if(!response.ok)throw Object.assign(new Error(`Open-Meteo grid HTTP ${response.status}`),{status:response.status,retryAfter:response.headers.get('retry-after')});
  const body=await response.json();
  if(body.error)throw new Error(body.reason??'格点模型响应无效');
  const locations:ApiLocation[]=Array.isArray(body)?body:[body];
  if(locations.length!==nodes.length)throw new Error('格点批次覆盖不完整，保留旧快照');
  const now=new Date().toISOString(),today=beijingDate(new Date(now)),records={...previous.records};
  nodes.forEach((node,index)=>{
    const result=locations[index];
    if(!Number.isFinite(result.elevation)||result.elevation < -500||result.elevation>9000||!Number.isFinite(result.longitude)||!Number.isFinite(result.latitude)||Math.abs(result.longitude-node.lon)>1.5||Math.abs(result.latitude-node.lat)>1.5||(result.utc_offset_seconds!==undefined&&result.utc_offset_seconds!==28800)||!result.daily||!Array.isArray(result.daily.time)||!Array.isArray(result.daily.temperature_2m_mean)||result.daily.time.length!==result.daily.temperature_2m_mean.length)throw new Error(`格点 ${node.id} 响应坐标、高程或日温无效`);
    const prior=previous.records[node.id];
    const merged=new Map((prior?gridHistoricalDays(prior):[]).map(day=>[day.date,day]));
    const forecast:DayTemperature[]=[],seen=new Set<string>();
    result.daily.time.forEach((date,i)=>{
      if(!validDate(date)||seen.has(date))throw new Error(`格点 ${node.id} 模型日期无效或重复`);
      seen.add(date);
      const value=result.daily!.temperature_2m_mean[i];
      const day={date,mean:typeof value==='number'&&Number.isFinite(value)&&value>=-100&&value<=65?value:null};
      if(date<today)merged.set(date,day);else forecast.push(day);
    });
    const days=[...merged.values()].filter(day=>day.date>=addDays(today,-400)&&day.date<today).sort((a,b)=>a.date.localeCompare(b.date));
    if(!Array.from({length:9},(_,i)=>merged.get(addDays(today,-1-i))?.mean).every(mean=>typeof mean==='number'&&Number.isFinite(mean)))throw new Error(`格点 ${node.id} 缺少最近9个完整日，保留旧快照`);
    const series:WeatherGridSeries={lon:node.lon,lat:node.lat,elevation:result.elevation,modelGrid:[result.longitude,result.latitude],updatedAt:now,days,forecast:{issuedAt:now,days:forecast.sort((a,b)=>a.date.localeCompare(b.date))}};
    if(!gridForecastIsFresh(series,new Date(now)))throw new Error(`格点 ${node.id} 缺少连续7天有效预报，保留旧快照`);
    records[node.id]=series;
  });
  return {...previous,updatedAt:now,records};
}
