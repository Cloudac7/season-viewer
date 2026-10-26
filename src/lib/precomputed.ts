import type {CountyReading,CountySeries,CountyUnit,PrefectureSummary} from './counties';
import type {SpatialCell,SpatialFieldInput,SpatialFieldResult} from './spatial-field';
import {sampleGridCell} from './spatial-field';
import type {SeasonState} from '../types';
import {beijingDate} from './season';
import type {WeatherGrid,WeatherGridCatalog} from './spatial-grid';
import type {TerrainGrid} from './terrain';

export interface PrecomputedFrame {
  field:string; meta:string; counties:string; layers:string; expiredLayers?:string;
  readyCount:number; forecastCount:number; countyReadyCount:number; countyCompleteCount:number; countyForecastCount:number;
  /** Earliest source expiry, also bounded by the next Beijing midnight. */
  forecastValidUntil:string|null;
}
export interface PrecomputedManifest {
  version:1; revision:string; generatedAt:string; evaluatedDay:string;
  dates:string[]; firstUsableDate:string; frames:Record<string,PrecomputedFrame>;
  locations:string; details:string; elevation:string;
  weather:{step:number;totalCount:number;updatedAt:string|null};
  counties:{totalCount:number;updatedAt:string|null};
  display:{bounds:TerrainGrid['bounds'];rows:number;cols:number;step:number};
}
export type SpatialFieldMeta=Pick<SpatialFieldResult,'bounds'|'step'|'rows'|'cols'|'date'|'metadata'>;
const arrays=['seasons','targets','temperature','average','status','expectedDays','transitionDays','estimated'] as const;
const MAGIC=0x53415631;
/** Little-endian Float32 planes followed by byte planes, all naturally aligned. */
export function encodeSpatialField(field:SpatialFieldResult):ArrayBuffer {
  const size=field.rows*field.cols,buffer=new ArrayBuffer(16+14*size),header=new DataView(buffer);
  header.setUint32(0,MAGIC,true);header.setUint32(4,size,true);header.setUint32(8,field.rows,true);header.setUint32(12,field.cols,true);
  let offset=16;
  for(const key of ['temperature','average'] as const){new Float32Array(buffer,offset,size).set(field[key]);offset+=4*size;}
  for(const key of ['seasons','targets','status','expectedDays','transitionDays','estimated'] as const){new Uint8Array(buffer,offset,size).set(new Uint8Array(field[key].buffer,field[key].byteOffset,size));offset+=size;}
  return buffer;
}
export function decodeSpatialField(buffer:ArrayBuffer,meta:SpatialFieldMeta):SpatialFieldResult {
  const header=new DataView(buffer),size=meta.rows*meta.cols;
  if(buffer.byteLength!==16+14*size||header.getUint32(0,true)!==MAGIC||header.getUint32(4,true)!==size||header.getUint32(8,true)!==meta.rows||header.getUint32(12,true)!==meta.cols)throw new Error('预计算格点文件格式或尺寸无效');
  let offset=16;
  const temperature=new Float32Array(buffer,offset,size);offset+=4*size;
  const average=new Float32Array(buffer,offset,size);offset+=4*size;
  const seasons=new Int8Array(buffer,offset,size);offset+=size;
  const targets=new Int8Array(buffer,offset,size);offset+=size;
  const status=new Uint8Array(buffer,offset,size);offset+=size;
  const expectedDays=new Int8Array(buffer,offset,size);offset+=size;
  const transitionDays=new Uint8Array(buffer,offset,size);offset+=size;
  const estimated=new Uint8Array(buffer,offset,size);
  return {...meta,temperature,average,seasons,targets,status,expectedDays,transitionDays,estimated};
}
export function fieldMeta(field:SpatialFieldResult):SpatialFieldMeta {
  const result={...field} as Partial<SpatialFieldResult>;for(const key of arrays)delete result[key];return result as SpatialFieldMeta;
}
export function expireSpatialForecast(field:SpatialFieldResult):SpatialFieldResult {
  const status=field.status.slice(),targets=field.targets.slice(),expectedDays=new Int8Array(field.expectedDays.length);
  let pendingCells=0;
  for(let index=0;index<status.length;index++){
    if(status[index]===2){status[index]=field.transitionDays[index]>0?1:0;if(status[index]===0)targets[index]=-1;}
    if(status[index]===1)pendingCells++;
  }
  return {...field,status,targets,expectedDays,metadata:{...field.metadata,forecastCells:0,pendingCells}};
}
export function precomputedForecastFresh(manifest:PrecomputedManifest,frame:PrecomputedFrame,now=new Date()):boolean {
  return manifest.evaluatedDay===beijingDate(now)&&!!frame.forecastValidUntil&&now.getTime()<Date.parse(frame.forecastValidUntil);
}
export function validPrecomputedManifest(value:unknown):value is PrecomputedManifest {
  if(!value||typeof value!=='object')return false;const v=value as PrecomputedManifest;
  return v.version===1&&typeof v.revision==='string'&&v.revision.length>0&&Array.isArray(v.dates)&&v.dates.length>0&&v.dates.every(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&v.frames?.[date]?.field&&v.frames[date]?.meta&&v.frames[date]?.counties&&v.frames[date]?.layers)&&typeof v.locations==='string'&&typeof v.details==='string'&&typeof v.elevation==='string'&&Number.isFinite(v.display?.rows)&&Number.isFinite(v.weather?.totalCount);
}

/** Compact source arrays are only used for a clicked location; national classification is baked. */
export interface PrecomputedDetails {
  version:1;catalog:WeatherGridCatalog;terrain:Omit<TerrainGrid,'heights'>;
  weather:{version:1;source:'open-meteo';timeZone:'Asia/Shanghai';catalogId:string;updatedAt:string|null};
  dates:string[];forecastDates:string[];
  records:Record<string,{elevation:number;updatedAt:string;values:(number|null)[];issuedAt?:string;forecast?:(number|null)[]}>;
}
export function compactDetails(input:SpatialFieldInput):PrecomputedDetails {
  const dates=[...new Set(Object.values(input.weather.records).flatMap(series=>series.days.map(day=>day.date)))].sort();
  const forecastDates=[...new Set(Object.values(input.weather.records).flatMap(series=>series.forecast?.days.map(day=>day.date)??[]))].sort();
  const records:PrecomputedDetails['records']={};
  for(const [id,series] of Object.entries(input.weather.records)){
    const history=new Map(series.days.map(day=>[day.date,day.mean])),forecast=new Map(series.forecast?.days.map(day=>[day.date,day.mean]));
    records[id]={elevation:series.elevation,updatedAt:series.updatedAt,values:dates.map(date=>history.get(date)??null),...(series.forecast?{issuedAt:series.forecast.issuedAt,forecast:forecastDates.map(date=>forecast.get(date)??null)}:{})};
  }
  const {heights:_,...terrain}=input.terrain;const {records:__,...weather}=input.weather;
  return {version:1,catalog:input.catalog,terrain,weather,dates,forecastDates,records};
}
export function restoreDetails(details:PrecomputedDetails,elevation:ArrayBuffer):Omit<SpatialFieldInput,'date'> {
  const size=details.terrain.rows*details.terrain.cols;if(elevation.byteLength!==size*2)throw new Error('预计算高程尺寸无效');
  const heights=Array.from(new Int16Array(elevation)),records:WeatherGrid['records']={};
  for(const node of details.catalog.nodes){
    const record=details.records[node.id];if(!record)continue;
    records[node.id]={lon:node.lon,lat:node.lat,elevation:record.elevation,modelGrid:[node.lon,node.lat],updatedAt:record.updatedAt,days:details.dates.map((date,index)=>({date,mean:record.values[index]??null})),forecast:record.issuedAt?{issuedAt:record.issuedAt,days:details.forecastDates.map((date,index)=>({date,mean:record.forecast?.[index]??null})).filter(day=>day.date>=beijingDate(new Date(record.issuedAt!)))}:undefined as never};
  }
  return {catalog:details.catalog,weather:{...details.weather,records},terrain:{...details.terrain,heights}};
}
export function readSelectedCell(input:Omit<SpatialFieldInput,'date'>,date:string,longitude:number,latitude:number,now=new Date()):SpatialCell|null {
  // Snap the readout to the same DEM lattice as the displayed categorical field.
  const {bounds,step,cols,rows}=input.terrain,col=Math.round((longitude-bounds.west)/step),row=Math.round((latitude-bounds.south)/step);
  if(col<0||row<0||col>=cols||row>=rows)return null;
  return sampleGridCell({...input,date,now},Number((bounds.west+col*step).toFixed(6)),Number((bounds.south+row*step).toFixed(6)));
}

type SavedState=Omit<SeasonState,'city'|'history'|'averages'>;
export interface PrecomputedCounties {
  version:1;date:string;updatedAt:string|null;
  readings:{id:string;status:CountyReading['status'];state:SavedState|null;forecastTransition:CountyReading['forecastTransition'];updatedAt:string|null;forecastValidUntil:string|null}[];
  summaries:Omit<PrefectureSummary,'readings'|'ready'>[];
}
export function packCountyReadings(date:string,readings:CountyReading[],summaries:PrefectureSummary[],updatedAt:string|null):PrecomputedCounties {
  return {version:1,date,updatedAt,readings:readings.map(reading=>{
    const {city:_,history:__,averages:___,...state}=reading.state??{} as SeasonState;
    const issued=reading.series?.forecast?.issuedAt;
    return {id:reading.unit.id,status:reading.status,state:reading.state?state as SavedState:null,forecastTransition:reading.forecastTransition,updatedAt:reading.series?.updatedAt??null,forecastValidUntil:issued?new Date(Math.min(Date.parse(issued)+86400000,Date.parse(`${beijingDate(new Date(issued))}T00:00:00+08:00`)+86400000)).toISOString():null};
  }),summaries:summaries.map(({readings:_,ready:__,...summary})=>summary)};
}
export function unpackCountyReadings(saved:PrecomputedCounties,units:CountyUnit[],now=new Date()):CountyReading[] {
  const byId=new Map(saved.readings.map(reading=>[reading.id,reading]));
  return units.map(unit=>{
    const row=byId.get(unit.id),state=row?.state?{...row.state,city:{id:unit.id,name:unit.name,province:unit.province,code:unit.provinceCode,region:unit.region,lat:unit.lat,lon:unit.lon,annual:0,amplitude:0},history:[],averages:[]}:null;
    const series:CountySeries|null=row?.updatedAt?{lon:unit.lon,lat:unit.lat,updatedAt:row.updatedAt,days:[]}:null;
    return {unit,state,series,status:row?.status??'missing',forecastTransition:row?.forecastValidUntil&&now.getTime()<Date.parse(row.forecastValidUntil)?row.forecastTransition:null};
  });
}

let manifestRequest:Promise<{manifest:PrecomputedManifest;hasUpdater:boolean}>|null=null,manifestChecked=0;
export function fetchPrecomputedManifest(force=false):Promise<{manifest:PrecomputedManifest;hasUpdater:boolean}> {
  if(manifestRequest&&!force&&Date.now()-manifestChecked<3000)return manifestRequest;
  manifestChecked=Date.now();
  manifestRequest=(async()=>{
    for(const url of ['/api/precomputed-spatial','/data/precomputed/manifest.json']){
      try{const response=await fetch(url,{cache:'no-cache',signal:AbortSignal.timeout(20000)});if(!response.ok)continue;const value=await response.json();if(validPrecomputedManifest(value))return {manifest:value,hasUpdater:url.startsWith('/api/')};}catch{/* static offline fallback */}
    }
    throw new Error('部署预计算数据暂不可用，请先运行数据预计算');
  })();return manifestRequest;
}
const assetCache=new Map<string,Promise<unknown>>();
export function fetchPrecomputedAsset<T>(url:string,binary=false):Promise<T> {
  const key=`${binary?'bin':'json'}:${url}`;
  if(!assetCache.has(key)){
    const promise=fetch(url).then(response=>{if(!response.ok)throw new Error(`预计算文件加载失败 (${response.status})`);return binary?response.arrayBuffer():response.json();});
    assetCache.set(key,promise);void promise.catch(()=>assetCache.delete(key));
    if(assetCache.size>30)assetCache.delete(assetCache.keys().next().value!);
  }
  return assetCache.get(key)! as Promise<T>;
}
