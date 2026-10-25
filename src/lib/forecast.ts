import type { DayTemperature, Season, SeasonState } from '../types';
import { addDays, beijingDate, classifyCity } from './season';

export interface TemperatureForecast { issuedAt:string; days:DayTemperature[] }
export interface ForecastTransition { target:Season; expectedDate:string; forecastDays:number; issuedAt:string }

// issuedAt is the time this application retrieved the current model forecast,
// rather than an observation time or a claimed numerical-model run time.
export function forecastIsFresh(forecast:TemperatureForecast|undefined,now=new Date()):boolean {
  if(!forecast)return false;
  const issued=Date.parse(forecast.issuedAt),age=now.getTime()-issued;
  const today=beijingDate(now);
  return Number.isFinite(issued)&&age>=0&&age<24*60*60*1000&&beijingDate(new Date(issued))===today&&forecast.days.length>=7&&forecast.days.slice(0,7).every((day,index)=>day.date===addDays(today,index)&&typeof day.mean==='number'&&Number.isFinite(day.mean)&&day.mean>=-100&&day.mean<=65);
}

export function projectTransition(state:SeasonState,forecast:TemperatureForecast|undefined,date:string,now=new Date()):ForecastTransition|null {
  const transition=state.transition;
  if(!forecastIsFresh(forecast,now)||date!==addDays(beijingDate(now),-1)||state.average===null)return null;
  const history=state.history.filter(day=>day.date<=date);
  if(history.at(-1)?.date!==date)return null;
  const future=forecast!.days.slice(0,7);
  if(future.length!==7||future.some((day,index)=>day.date!==addDays(date,index+1)||typeof day.mean!=='number'||!Number.isFinite(day.mean)||day.mean < -100||day.mean > 65))return null;
  const projected=[...history];
  let completion:ForecastTransition|null=null;
  for(let index=0;index<future.length;index++){
    const day=future[index];
    projected.push(day);
    const next=classifyCity(state.city,projected,day.date);
    if(completion){
      if(next.season!==completion.target||next.transition)return null;
      continue;
    }
    if(next.season!==state.season&&!next.estimated){
      if(transition&&next.season!==transition.target)return null;
      completion={target:next.season,expectedDate:day.date,forecastDays:index+1,issuedAt:forecast!.issuedAt};
      continue;
    }
    // A broken run cannot be restarted later in the forecast and described as
    // completion of the transition currently observed on the map.
    if(transition&&(next.season!==state.season||next.transition?.target!==transition.target||next.transition.start!==transition.start||next.transition.days!==transition.days+index+1))return null;
  }
  return completion;
}
