import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {EMPTY_GRID_WEATHER,gridForecastIsFresh,gridHistoricalDays,validGridCatalog,validGridWeather} from './spatial-grid';
import type {WeatherGrid,WeatherGridCatalog} from './spatial-grid';
import {validateTerrainGrid} from './terrain';
import type {TerrainGrid} from './terrain';
import type {SpatialFieldResult,SpatialFieldWorkerRequest,SpatialFieldWorkerResponse} from './spatial-field';
import {addDays,beijingDate} from './season';

export interface SpatialWeatherState {
  catalog:WeatherGridCatalog|null; weather:WeatherGrid; terrain:TerrainGrid|null; field:SpatialFieldResult|null;
  loading:boolean; computing:boolean; error:string; hasUpdater:boolean;
  readyCount:number; totalCount:number; firstUsableDate:string; forecastCount:number;
  refresh:()=>Promise<void>;
}
function mergeGrid(previous:WeatherGrid,incoming:WeatherGrid):WeatherGrid {
  if(previous.catalogId!==incoming.catalogId)return incoming;
  const records={...previous.records};
  for(const [id,series] of Object.entries(incoming.records))if(!records[id]||Date.parse(series.updatedAt)>Date.parse(records[id].updatedAt))records[id]=series;
  return {...incoming,records,updatedAt:[previous.updatedAt,incoming.updatedAt].filter((value):value is string=>!!value).sort().at(-1)??null};
}
export function useSpatialWeather(date:string):SpatialWeatherState {
  const [calendarDay,setCalendarDay]=useState(()=>beijingDate());
  // Expire yesterday's projection even when a long-lived page is offline.
  useEffect(()=>{
    const check=()=>setCalendarDay(beijingDate());
    const midnight=Date.parse(`${addDays(calendarDay,1)}T00:00:00+08:00`);
    const timer=setTimeout(check,Math.max(20,midnight-Date.now()+20));
    document.addEventListener('visibilitychange',check);
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',check);};
  },[calendarDay]);
  const [catalog,setCatalog]=useState<WeatherGridCatalog|null>(null),[terrain,setTerrain]=useState<TerrainGrid|null>(null);
  const [weather,setWeather]=useState<WeatherGrid>(EMPTY_GRID_WEATHER),[field,setField]=useState<SpatialFieldResult|null>(null);
  const [loading,setLoading]=useState(true),[computing,setComputing]=useState(false),[loadError,setLoadError]=useState(''),[computeError,setComputeError]=useState('');
  const [hasUpdater,setHasUpdater]=useState(false),[revision,setRevision]=useState(0);
  const current=useRef<WeatherGridCatalog|null>(null),request=useRef<AbortController|null>(null),computeId=useRef(0);
  const refresh=useCallback(async()=>{
    const catalog=current.current;if(!catalog)return;
    request.current?.abort('superseded');const controller=new AbortController();request.current=controller;
    setLoading(true);setLoadError('');
    const timeout=setTimeout(()=>controller.abort('timeout'),20000);
    try{
      let incoming:WeatherGrid|null=null;
      // Static hosting uses the bundled snapshot. Only the Vite endpoint starts
      // a single shared server-side update; the browser never queries 1,265 APIs.
      for(const url of ['/api/weather-grid-weather','/data/weather-grid-weather.json']){
        try{
          const response=await fetch(url,{signal:controller.signal,cache:'no-cache'});
          if(!response.ok)continue;
          const value=await response.json();
          if(validGridWeather(value,catalog)){
            incoming=value;if(!controller.signal.aborted)setHasUpdater(url.startsWith('/api/'));break;
          }
        }catch{if(controller.signal.aborted)throw new Error('独立格点天气快照连接超时');}
      }
      if(!incoming)throw new Error('独立格点天气快照暂不可用，缺少四邻数据的区域保持灰色');
      if(!controller.signal.aborted)setWeather(previous=>mergeGrid(previous,incoming!));
    }catch(error){
      if(!['unmount','superseded'].includes(String(controller.signal.reason)))setLoadError(error instanceof Error?error.message:'格点天气加载失败');
    }finally{
      clearTimeout(timeout);
      if(request.current===controller){setLoading(false);setRevision(value=>value+1);}
    }
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.all([
      fetch('/data/weather-grid.json',{signal:controller.signal}).then(async response=>{
        if(!response.ok)throw new Error('独立格点目录加载失败');const value=await response.json();
        if(!validGridCatalog(value))throw new Error('独立格点目录校验失败');return value;
      }),
      fetch('/data/terrain.json',{signal:controller.signal}).then(async response=>{
        if(!response.ok)throw new Error('地形高程加载失败');const value=await response.json();
        if(!validateTerrainGrid(value))throw new Error('地形高程校验失败');return value;
      })
    ]).then(([catalog,terrain])=>{
      if(controller.signal.aborted)return;
      current.current=catalog;setCatalog(catalog);setTerrain(terrain);void refresh();
    }).catch(error=>{if(!controller.signal.aborted){setLoading(false);setLoadError(error instanceof Error?error.message:'格点资料加载失败');}});
    return()=>{controller.abort();request.current?.abort('unmount');};
  },[refresh]);
  useEffect(()=>{
    if(!catalog||!terrain||weather.catalogId!==catalog.id||!Object.keys(weather.records).length){setComputing(false);setField(null);return;}
    const id=++computeId.current;
    let active=true;
    setComputing(true);setComputeError('');setField(previous=>previous?.date===date&&beijingDate(new Date(previous.metadata.evaluatedAt))===calendarDay?previous:null);
    let worker:Worker;
    try{worker=new Worker(new URL('./spatial-field.worker.ts',import.meta.url),{type:'module'});}
    catch(error){setComputing(false);setComputeError(error instanceof Error?error.message:'浏览器无法启动格点计算');return;}
    worker.onmessage=({data}:MessageEvent<SpatialFieldWorkerResponse>)=>{
      if(!active||data.id!==id||computeId.current!==id)return;
      setComputing(false);
      if('error' in data){setField(null);setComputeError(data.error);}else setField(data.result);
    };
    worker.onerror=()=>{if(active&&computeId.current===id){setComputing(false);setField(null);setComputeError('格点计算失败，请刷新重试');}};
    const message:SpatialFieldWorkerRequest={id,input:{catalog,weather,terrain,date,now:new Date().toISOString()}};
    worker.postMessage(message);
    return()=>{active=false;worker.terminate();};
  },[catalog,terrain,weather,date,calendarDay]);
  const latest=addDays(calendarDay,-1);
  const readyCount=useMemo(()=>catalog?.nodes.filter(node=>{
    const series=weather.records[node.id];if(!series)return false;
    const days=new Map(gridHistoricalDays(series).map(day=>[day.date,day.mean]));
    return Array.from({length:9},(_,index)=>days.get(addDays(date,-index))).every(value=>typeof value==='number'&&Number.isFinite(value));
  }).length??0,[catalog,weather,date]);
  const currentCount=useMemo(()=>catalog?.nodes.filter(node=>{
    const series=weather.records[node.id];return series&&gridHistoricalDays(series).some(day=>day.date===latest&&day.mean!==null);
  }).length??0,[catalog,weather,latest]);
  const forecastCount=useMemo(()=>catalog?.nodes.filter(node=>gridForecastIsFresh(weather.records[node.id])).length??0,[catalog,weather,latest]);
  const firstUsableDate=useMemo(()=>{
    const starts=Object.values(weather.records).map(series=>gridHistoricalDays(series)[0]?.date).filter((value):value is string=>!!value).sort();
    const first=starts.length?addDays(starts.at(-1)!,8):latest;return first>latest?latest:first;
  },[weather,latest]);
  useEffect(()=>{
    if(!catalog)return;
    const timer=setTimeout(()=>void refresh(),hasUpdater&&(currentCount<catalog.nodes.length||forecastCount<catalog.nodes.length)?15000:3600000);
    return()=>clearTimeout(timer);
  },[catalog,currentCount,forecastCount,refresh,revision,hasUpdater]);
  return {catalog,weather,terrain,field,loading,computing,error:computeError||loadError,hasUpdater,readyCount,totalCount:catalog?.nodes.length??0,firstUsableDate,forecastCount,refresh};
}
