import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {feature} from 'topojson-client';
import type {Topology,GeometryCollection} from 'topojson-specification';
import {classifyCounty,EMPTY_COUNTY_WEATHER,mergeCountyWeather,summarizePrefectures,validCountyWeather} from './counties';
import type {CountyBoundaries,CountyCatalog,CountyReading,CountyWeather} from './counties';
import {addDays,beijingDate} from './season';

export function useCounties(date:string){
  const [catalog,setCatalog]=useState<CountyCatalog|null>(null),[boundaries,setBoundaries]=useState<CountyBoundaries|null>(null);
  const [data,setData]=useState<CountyWeather>(EMPTY_COUNTY_WEATHER),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [hasUpdater,setHasUpdater]=useState(false);
  const [revision,setRevision]=useState(0);
  const current=useRef<CountyCatalog|null>(null),request=useRef<AbortController|null>(null);
  const refresh=useCallback(async()=>{
    const catalog=current.current;if(!catalog)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    const timeout=setTimeout(()=>controller.abort('timeout'),15000);
    try{
      let incoming:CountyWeather|null=null;
      // Development serves a shared, incrementally refreshed snapshot. Static
      // hosting uses the bundled file and never launches thousands of API calls.
      for(const url of ['/api/county-weather','/data/county-weather.json']){
        try{
          const response=await fetch(url,{signal:controller.signal,cache:'no-cache'});
          if(!response.ok)continue;const value=await response.json();
          if(validCountyWeather(value,catalog)){incoming=value;if(!controller.signal.aborted)setHasUpdater(url.startsWith('/api/'));break;}
        }catch{if(controller.signal.aborted)throw new Error('县级模型快照连接超时');}
      }
      if(!incoming)throw new Error('县级模型快照暂不可用，缺少数据的县区保持灰色');
      if(!controller.signal.aborted)setData(previous=>mergeCountyWeather(previous,incoming!));
    }catch(e){if(controller.signal.reason!=='unmount')setError(e instanceof Error?e.message:'县级模型加载失败');}
    finally{clearTimeout(timeout);if(request.current===controller){setLoading(false);setRevision(v=>v+1);}}
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.all([
      fetch('/data/counties.json',{signal:controller.signal}).then(r=>{if(!r.ok)throw new Error('县级名录加载失败');return r.json() as Promise<CountyCatalog>;}),
      fetch('/data/counties.topo.json',{signal:controller.signal}).then(r=>{if(!r.ok)throw new Error('县界加载失败');return r.json() as Promise<Topology<{counties:GeometryCollection<{id:string}>}>>;})
    ]).then(([catalog,topology])=>{
      if(controller.signal.aborted)return;
      current.current=catalog;setCatalog(catalog);setBoundaries(feature(topology,topology.objects.counties) as CountyBoundaries);void refresh();
    }).catch(e=>{if(!controller.signal.aborted){setLoading(false);setError(e instanceof Error?e.message:'县界加载失败');}});
    return()=>{controller.abort();request.current?.abort('unmount');};
  },[refresh]);
  const readings=useMemo<CountyReading[]>(()=>catalog?.units.map(unit=>classifyCounty(unit,data.records[unit.id],date))??[],[catalog,data,date]);
  const ready=useMemo(()=>readings.filter(reading=>reading.state!==null),[readings]);
  const summaries=useMemo(()=>summarizePrefectures(readings),[readings]);
  const latest=addDays(beijingDate(),-1);
  const completeCount=useMemo(()=>catalog?.units.filter(unit=>data.records[unit.id]?.days.some(day=>day.date===latest&&day.mean!==null)).length??0,[catalog,data,latest]);
  const firstUsableDate=useMemo(()=>{
    const starts=Object.values(data.records).map(series=>series.days[0]?.date).filter((v):v is string=>!!v).sort();
    return starts.length?addDays(starts.at(-1)!,8):latest;
  },[data,latest]);
  useEffect(()=>{
    if(!catalog)return;
    const timer=setTimeout(()=>void refresh(),hasUpdater&&completeCount<catalog.units.length?15000:60*60*1000);
    return()=>clearTimeout(timer);
  },[catalog,completeCount,refresh,revision,hasUpdater]);
  return {catalog,boundaries,data,readings,ready,summaries,completeCount,firstUsableDate,loading,error,refresh,hasUpdater};
}
