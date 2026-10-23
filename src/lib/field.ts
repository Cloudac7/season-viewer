import { SEASONS } from '../data';
import type { SeasonState } from '../types';

const temperatureStops=[[-10,[139,172,199]],[5,[175,197,215]],[10,[190,211,205]],[15,[200,215,182]],[22,[231,201,139]],[30,[214,149,111]]] as const;
export function sampleColor(state:SeasonState,layer:'season'|'temperature'):string {
  if(state.average===null||!Number.isFinite(state.average))return '#e0e6e2';
  if(layer==='season')return SEASONS[state.season].fill;
  const value=Math.max(-10,Math.min(30,state.average));
  const upper=temperatureStops.findIndex(stop=>stop[0]>=value);
  if(upper<=0)return `rgb(${temperatureStops[0][1].join(',')})`;
  const a=temperatureStops[upper-1],b=temperatureStops[upper],t=(value-a[0])/(b[0]-a[0]);
  return `rgb(${a[1].map((v,index)=>Math.round(v+(b[1][index]-v)*t)).join(',')})`;
}
