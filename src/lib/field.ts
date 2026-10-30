import { SEASONS } from '../data';
import type { SeasonState } from '../types';

interface TemperatureBand { min:number|null;max:number|null;fill:string;label:string }
export interface TemperatureLegendTick { label:string; position:number; edge:'start'|'middle'|'end' }

// Fixed intervals keep the legend comparable across dates and retain the 10°C / 22°C season thresholds.
export const TEMPERATURE_BANDS:readonly TemperatureBand[] = [
  {min:null,max:-20,fill:'#7950a4',label:'＜−20°C'},
  {min:-20,max:-10,fill:'#6869bc',label:'−20～−10°C'},
  {min:-10,max:0,fill:'#4c91cd',label:'−10～0°C'},
  {min:0,max:5,fill:'#58b5d7',label:'0～5°C'},
  {min:5,max:10,fill:'#67c7bb',label:'5～10°C'},
  {min:10,max:15,fill:'#82c978',label:'10～15°C'},
  {min:15,max:20,fill:'#bdd363',label:'15～20°C'},
  {min:20,max:22,fill:'#edda58',label:'20～22°C'},
  {min:22,max:25,fill:'#f4c54c',label:'22～25°C'},
  {min:25,max:30,fill:'#ef9d43',label:'25～30°C'},
  {min:30,max:35,fill:'#e7753f',label:'30～35°C'},
  {min:35,max:null,fill:'#cf4744',label:'≥35°C'},
];

// Labels describe the boundaries between adjacent bands. The outer labels are
// anchored to the bar ends so "below -20" and "35 and above" frame the range.
export const TEMPERATURE_LEGEND_TICKS:readonly TemperatureLegendTick[] = [
  {label:`＜${TEMPERATURE_BANDS[0].max}`,position:0,edge:'start'},
  ...TEMPERATURE_BANDS.slice(1).map((band,index)=>({
    label:`${band.min}`,position:(index+1)/TEMPERATURE_BANDS.length,edge:'middle' as const,
  })),
  {label:`≥${TEMPERATURE_BANDS.at(-1)!.min}`,position:1,edge:'end'},
];

export function temperatureColor(temperature:number):string {
  if(!Number.isFinite(temperature))return '#e0e6e2';
  return TEMPERATURE_BANDS.find(band=>(band.min===null||temperature>=band.min)&&(band.max===null||temperature<band.max))!.fill;
}

export function sampleColor(state:SeasonState,layer:'season'|'temperature'):string {
  if(state.average===null||!Number.isFinite(state.average))return '#e0e6e2';
  if(layer==='season')return SEASONS[state.season].fill;
  return temperatureColor(state.average);
}
