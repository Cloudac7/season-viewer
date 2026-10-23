import type { CountyUnit, CountyWeather, CountySeries } from './counties';
import { addDays, beijingDate } from './season';

interface ApiLocation {latitude:number;longitude:number;daily?:{time:string[];temperature_2m_mean:(number|null)[]}}
export async function fetchCountyBatch(units:CountyUnit[],previous:CountyWeather,signal:AbortSignal):Promise<CountyWeather>{
  if(!units.length)return previous;
  const initial=units.some(unit=>!previous.records[unit.id]?.days.length);
  const params=new URLSearchParams({latitude:units.map(unit=>unit.lat).join(','),longitude:units.map(unit=>unit.lon).join(','),daily:'temperature_2m_mean',timezone:'Asia/Shanghai',past_days:initial?'14':'2',forecast_days:'1'});
  const response=await fetch(`https://api.open-meteo.com/v1/forecast?${params}`,{signal});
  if(!response.ok)throw new Error(`Open-Meteo HTTP ${response.status}`);
  const body=await response.json();if(body.error)throw new Error(body.reason??'县级模型响应无效');
  const locations:ApiLocation[]=Array.isArray(body)?body:[body];
  if(locations.length!==units.length)throw new Error('县级批次覆盖不完整，保留旧快照');
  const now=new Date().toISOString(),today=beijingDate(),records={...previous.records};
  units.forEach((unit,index)=>{
    const result=locations[index];
    if(!result.daily||result.daily.time.length!==result.daily.temperature_2m_mean.length)throw new Error(`县 ${unit.id} 缺少日温`);
    const merged=new Map((previous.records[unit.id]?.days??[]).map(day=>[day.date,day]));
    result.daily.time.forEach((date,i)=>{
      const value=result.daily!.temperature_2m_mean[i];
      if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('模型日期格式无效');
      merged.set(date,{date,mean:typeof value==='number'&&Number.isFinite(value)&&value>=-100&&value<=65?value:null});
    });
    const days=[...merged.values()].filter(day=>day.date>=addDays(today,-400)).sort((a,b)=>a.date.localeCompare(b.date));
    if(!Array.from({length:9},(_,i)=>merged.get(addDays(today,-1-i))?.mean).every(mean=>typeof mean==='number'&&Number.isFinite(mean)))throw new Error(`县 ${unit.id} 缺少最近9个完整日，保留旧快照`);
    const series:CountySeries={lon:unit.lon,lat:unit.lat,updatedAt:now,days,modelGrid:[result.longitude,result.latitude]};
    records[unit.id]=series;
  });
  return {version:1,source:'open-meteo',timeZone:'Asia/Shanghai',updatedAt:now,records};
}
