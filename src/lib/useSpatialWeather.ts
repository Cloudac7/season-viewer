import {useCallback,useEffect,useRef,useState} from 'react';
import {EMPTY_GRID_WEATHER} from './spatial-grid';
import type {WeatherGrid,WeatherGridCatalog} from './spatial-grid';
import type {TerrainGrid} from './terrain';
import type {SpatialFieldInput,SpatialFieldResult} from './spatial-field';
import type {SpatialContours} from './spatial-contours';
import type {GridLocations} from './grid-location';
import {lookupGridLocation} from './grid-location';
import {decodeSpatialField,expireSpatialForecast,fetchPrecomputedAsset,fetchPrecomputedManifest,precomputedForecastFresh,readSelectedCell,restoreDetails} from './precomputed';
import type {PrecomputedDetails,PrecomputedManifest,SpatialFieldMeta} from './precomputed';
import {addDays,beijingDate} from './season';

export interface SpatialWeatherState {
  /** Source data is compact and used only for one clicked point, never a national worker. */
  catalog:WeatherGridCatalog|null;weather:WeatherGrid;terrain:TerrainGrid|null;field:SpatialFieldResult|null;
  manifest:PrecomputedManifest|null;availableDates:string[];layers:SpatialContours|null;locations:GridLocations|null;
  loading:boolean;computing:boolean;error:string;hasUpdater:boolean;
  readyCount:number;totalCount:number;firstUsableDate:string;forecastCount:number;
  refresh:(forceAssets?:boolean)=>Promise<void>;
  getCell:(lon:number,lat:number)=>ReturnType<typeof readSelectedCell>;
  getLocation:(lon:number,lat:number)=>ReturnType<typeof lookupGridLocation>;
}
export function useSpatialWeather(date:string):SpatialWeatherState {
  const [manifest,setManifest]=useState<PrecomputedManifest|null>(null),[hasUpdater,setHasUpdater]=useState(false);
  const [field,setField]=useState<SpatialFieldResult|null>(null),[layers,setLayers]=useState<SpatialContours|null>(null);
  const [locations,setLocations]=useState<GridLocations|null>(null),[details,setDetails]=useState<Omit<SpatialFieldInput,'date'>|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[clock,setClock]=useState(()=>Date.now());
  const mounted=useRef(true),errorRef=useRef('');
  const [retryRevision,setRetryRevision]=useState(0);
  useEffect(()=>{errorRef.current=error;},[error]);
  const refresh=useCallback(async(forceAssets=true)=>{
    if(forceAssets||errorRef.current)setRetryRevision(value=>value+1);
    try{
      const result=await fetchPrecomputedManifest(true);if(!mounted.current)return;
      setManifest(previous=>previous?.revision===result.manifest.revision?previous:result.manifest);setHasUpdater(result.hasUpdater);setClock(Date.now());setError('');
    }catch(error){if(mounted.current)setError(error instanceof Error?error.message:'预计算格点数据加载失败');}
    finally{if(mounted.current)setLoading(false);}
  },[]);
  useEffect(()=>{
    mounted.current=true;
    void fetchPrecomputedManifest().then(result=>{if(mounted.current){setManifest(result.manifest);setHasUpdater(result.hasUpdater);setClock(Date.now());}}).catch(error=>{if(mounted.current){setError(error instanceof Error?error.message:'预计算数据加载失败');setLoading(false);}});
    return()=>{mounted.current=false;};
  },[]);
  useEffect(()=>{const timer=setInterval(()=>void refresh(false),!manifest?10000:hasUpdater?30000:3600000);return()=>clearInterval(timer);},[hasUpdater,manifest,refresh]);
  const frame=manifest?.frames[date],fresh=!!manifest&&!!frame&&precomputedForecastFresh(manifest,frame,new Date(clock));
  useEffect(()=>{
    const check=()=>setClock(Date.now()),today=beijingDate(new Date(clock));
    const deadline=Math.min(Date.parse(`${addDays(today,1)}T00:00:00+08:00`),frame?.forecastValidUntil&&Date.parse(frame.forecastValidUntil)>clock?Date.parse(frame.forecastValidUntil):Infinity);
    const timer=setTimeout(check,Math.max(20,deadline-Date.now()+20));document.addEventListener('visibilitychange',check);
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',check);};
  },[clock,frame?.forecastValidUntil]);
  useEffect(()=>{
    let active=true;
    if(!manifest||!frame){setField(null);setLayers(null);if(manifest)setLoading(false);return;}
    setLoading(true);setError('');
    setField(previous=>previous?.date===date?(fresh?previous:expireSpatialForecast(previous)):null);
    setLayers(previous=>field?.date===date&&!( !fresh&&previous?.layers.some(surface=>surface.kind==='transition'&&surface.status===2))?previous:null);
    void Promise.all([
      fetchPrecomputedAsset<SpatialFieldMeta>(frame.meta),fetchPrecomputedAsset<ArrayBuffer>(frame.field,true),
      fetchPrecomputedAsset<SpatialContours>(!fresh&&frame.expiredLayers?frame.expiredLayers:frame.layers)
    ]).then(([meta,buffer,contours])=>{
      if(!active)return;const decoded=decodeSpatialField(buffer,meta);setField(fresh?decoded:expireSpatialForecast(decoded));setLayers(contours);setLoading(false);
    }).catch(error=>{if(active){setLoading(false);setError(error instanceof Error?error.message:'预计算日期加载失败');}});
    return()=>{active=false;};
  },[manifest,frame,date,fresh,retryRevision]);
  useEffect(()=>{
    if(!manifest)return;let active=true;
    void fetchPrecomputedAsset<GridLocations>(manifest.locations).then(value=>{if(active)setLocations(value);}).catch(error=>{if(active)setError(error instanceof Error?error.message:'区划索引加载失败');});
    void Promise.all([fetchPrecomputedAsset<PrecomputedDetails>(manifest.details),fetchPrecomputedAsset<ArrayBuffer>(manifest.elevation,true)]).then(([details,elevation])=>{if(active)setDetails(restoreDetails(details,elevation));}).catch(error=>{if(active)setError(error instanceof Error?error.message:'点选详情加载失败');});
    return()=>{active=false;};
  },[manifest,retryRevision]);
  const getCell=useCallback((lon:number,lat:number)=>details&&field?.date===date?readSelectedCell(details,date,lon,lat,new Date(clock)):null,[details,field,date,clock]);
  const getLocation=useCallback((lon:number,lat:number)=>locations?lookupGridLocation(locations,lon,lat):null,[locations]);
  return {catalog:details?.catalog??null,weather:details?.weather??{...EMPTY_GRID_WEATHER,updatedAt:manifest?.weather.updatedAt??null},terrain:details?.terrain??null,field,manifest,availableDates:manifest?.dates??[],layers,locations,loading,computing:false,error,hasUpdater,readyCount:frame?.readyCount??0,totalCount:manifest?.weather.totalCount??0,firstUsableDate:manifest?.firstUsableDate??'',forecastCount:fresh?frame?.forecastCount??0:0,refresh,getCell,getLocation};
}
