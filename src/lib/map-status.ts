import {SEASONS,TRANSITION_PALETTES} from '../data';
import type {Season,SeasonState} from '../types';
import type {CountyReading} from './counties';
import type {ForecastTransition} from './forecast';
import {sampleColor} from './field';

export function transitionColors(from:Season,target:Season){
  return TRANSITION_PALETTES[`${from}-${target}`]??{pending:SEASONS[target],forecast:SEASONS[from]};
}
export function transitionAppearance(state:SeasonState,forecast?:ForecastTransition|null){
  const target=forecast?.target??state.transition?.target;
  if(!target)return null;
  const status=forecast?'forecast':'pending';
  return {...transitionColors(state.season,target)[status],status,target,label:forecast?'预报预计完成':'换季进行中'};
}
export function countyTransitionAppearance(reading:CountyReading){
  return reading.state?transitionAppearance(reading.state,reading.forecastTransition):null;
}

export function countyTransitionStatus(reading:CountyReading):'forecast'|'pending'|'stable'|'missing'{
  if(!reading.state)return 'missing';
  if(reading.forecastTransition)return 'forecast';
  return reading.state.transition?'pending':'stable';
}
export function countyMapColor(reading:CountyReading,layer:'season'|'temperature',showTransitions:boolean):string{
  const appearance=countyTransitionAppearance(reading);
  if(showTransitions&&appearance)return appearance.fill;
  return reading.state?sampleColor(reading.state,layer):'#e0e6e2';
}
