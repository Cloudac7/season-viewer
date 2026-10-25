import type { FeatureCollection, Geometry } from 'geojson';
import type { DayTemperature, Region, SeasonState } from '../types';
import { addDays, beijingDate, classifyCity } from './season';
import { SEASON_ORDER } from '../data';
import { forecastIsFresh, projectTransition } from './forecast';
import type { ForecastTransition, TemperatureForecast } from './forecast';

export interface CountyUnit {id:string;name:string;provinceCode:number;province:string;cityCode:number;city:string;region:Region;kind:'county'|'undivided-city';display:[number,number];lon:number;lat:number;pointMethod:string}
export interface CountyCatalog {version:1;source:{name:string;url:string;retrievedAt:string;boundaryVersion:string;displayCrs:string;weatherCrs:string;note:string};units:CountyUnit[]}
export type CountyBoundaries=FeatureCollection<Geometry,{id:string}>;
export interface CountySeries {lon:number;lat:number;updatedAt:string;days:DayTemperature[];modelGrid?:[number,number];forecast?:TemperatureForecast}
export interface CountyWeather {version:1;source:'open-meteo';timeZone:'Asia/Shanghai';updatedAt:string|null;records:Record<string,CountySeries>}
export interface CountyReading {unit:CountyUnit;state:SeasonState|null;series:CountySeries|null;status:'ready'|'missing'|'insufficient'|'stale';forecastTransition:ForecastTransition|null}
export const EMPTY_COUNTY_WEATHER:CountyWeather={version:1,source:'open-meteo',timeZone:'Asia/Shanghai',updatedAt:null,records:{}};
export function validCountyWeather(value:unknown,catalog:CountyCatalog):value is CountyWeather{
  if(!value||typeof value!=='object')return false;
  const data=value as CountyWeather;
  if(data.version!==1||data.source!=='open-meteo'||data.timeZone!=='Asia/Shanghai'||!data.records||typeof data.records!=='object'||Array.isArray(data.records))return false;
  if(data.updatedAt!==null&&!Number.isFinite(Date.parse(data.updatedAt)))return false;
  const known=new Map(catalog.units.map(unit=>[unit.id,unit]));
  const validDays=(days:DayTemperature[])=>Array.isArray(days)&&days.every((day,i)=>day&&typeof day.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day.date)&&Number.isFinite(Date.parse(day.date))&&new Date(day.date).toISOString().slice(0,10)===day.date&&(i===0||day.date>days[i-1].date)&&(day.mean===null||typeof day.mean==='number'&&Number.isFinite(day.mean)&&day.mean>=-100&&day.mean<=65));
  return Object.entries(data.records).every(([id,series])=>{
    const unit=known.get(id);
    return unit&&series&&Math.abs(series.lon-unit.lon)<1e-5&&Math.abs(series.lat-unit.lat)<1e-5&&Number.isFinite(Date.parse(series.updatedAt))&&validDays(series.days)&&
      (series.forecast===undefined||(series.forecast&&Number.isFinite(Date.parse(series.forecast.issuedAt))&&Date.parse(series.forecast.issuedAt)<=Date.parse(series.updatedAt)&&validDays(series.forecast.days)&&series.forecast.days.every(day=>day.date>=beijingDate(new Date(series.forecast!.issuedAt)))));
  });
}
export function countyForecastIsFresh(series:CountySeries|undefined,now=new Date()):boolean{
  return forecastIsFresh(series?.forecast,now);
}
export function countyHistoricalDays(series:CountySeries):DayTemperature[]{
  // Older snapshots included the unfinished retrieval day in `days`. Its
  // becoming a past calendar date does not turn that forecast into history.
  const cutoff=beijingDate(new Date(series.updatedAt));
  return series.days.filter(day=>day.date<cutoff);
}
export function classifyCounty(unit:CountyUnit,series:CountySeries|undefined,date:string,now=new Date()):CountyReading{
  const reading={unit,series:series??null,state:null,forecastTransition:null};
  if(!series)return {...reading,status:'missing'};
  const historical=countyHistoricalDays(series),days=new Map(historical.map(day=>[day.date,day.mean]));
  if(days.get(date)===undefined||days.get(date)===null)return {...reading,status:historical.some(day=>day.date<date)?'stale':'missing'};
  if(!Array.from({length:9},(_,i)=>days.get(addDays(date,-i))).every(value=>typeof value==='number'&&Number.isFinite(value)))return {...reading,status:'insufficient'};
  const city={id:unit.id,name:unit.name,province:unit.province,code:unit.provinceCode,region:unit.region,lat:unit.lat,lon:unit.lon,annual:0,amplitude:0};
  const state=classifyCity(city,historical,date);
  return {unit,series,state,status:'ready',forecastTransition:projectTransition(state,series.forecast,date,now)};
}
export function mergeCountyWeather(previous:CountyWeather,incoming:CountyWeather):CountyWeather{
  const records={...previous.records};
  for(const [id,series] of Object.entries(incoming.records))if(!records[id]||Date.parse(series.updatedAt)>Date.parse(records[id].updatedAt))records[id]=series;
  const updatedAt=[previous.updatedAt,incoming.updatedAt].filter((v):v is string=>!!v).sort().at(-1)??null;
  return {...previous,updatedAt,records};
}
export interface PrefectureSummary {id:string;name:string;province:string;region:Region;readings:CountyReading[];ready:CountyReading[];season:SeasonState['season']|null;mainSeasons:SeasonState['season'][];average:number|null;transitionCount:number;forecastCount:number}
export function summarizePrefectures(readings:CountyReading[]):PrefectureSummary[]{
  const groups=new Map<number,CountyReading[]>();
  for(const reading of readings)groups.set(reading.unit.cityCode,[...(groups.get(reading.unit.cityCode)??[]),reading]);
  return [...groups.entries()].map(([code,group])=>{
    const ready=group.filter(reading=>reading.state!==null);
    const counts=new Map<SeasonState['season'],number>();for(const reading of ready)counts.set(reading.state!.season,(counts.get(reading.state!.season)??0)+1);
    const most=Math.max(0,...counts.values()),mainSeasons=SEASON_ORDER.filter(season=>most>0&&counts.get(season)===most),season=mainSeasons[0]??null;
    return {id:String(code),name:group[0].unit.city,province:group[0].unit.province,region:group[0].unit.region,readings:group,ready,season,mainSeasons,average:ready.length?ready.reduce((sum,r)=>sum+r.state!.average!,0)/ready.length:null,transitionCount:ready.filter(r=>r.state!.transition||r.forecastTransition).length,forecastCount:ready.filter(r=>r.forecastTransition).length};
  });
}
