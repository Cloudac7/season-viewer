import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {feature} from 'topojson-client';
import type {Topology,GeometryCollection} from 'topojson-specification';
import {EMPTY_COUNTY_WEATHER} from './counties';
import type {CountyBoundaries,CountyCatalog,PrefectureSummary} from './counties';
import {addDays,beijingDate} from './season';
import {fetchPrecomputedAsset,fetchPrecomputedManifest,unpackCountyReadings} from './precomputed';
import type {PrecomputedCounties,PrecomputedManifest} from './precomputed';

/** Weather classification and prefecture aggregates are prepared during deployment. */
export function useCounties(date:string){
  const [catalog,setCatalog]=useState<CountyCatalog|null>(null),[boundaries,setBoundaries]=useState<CountyBoundaries|null>(null);
  const [manifest,setManifest]=useState<PrecomputedManifest|null>(null),[saved,setSaved]=useState<PrecomputedCounties|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[hasUpdater,setHasUpdater]=useState(false),[clock,setClock]=useState(()=>Date.now());
  const mounted=useRef(true),errorRef=useRef('');
  const [retryRevision,setRetryRevision]=useState(0);
  useEffect(()=>{errorRef.current=error;},[error]);
  const refresh=useCallback(async(forceAssets=true)=>{
    if(forceAssets||errorRef.current)setRetryRevision(value=>value+1);
    try{const result=await fetchPrecomputedManifest(true);if(mounted.current){setManifest(previous=>previous?.revision===result.manifest.revision?previous:result.manifest);setHasUpdater(result.hasUpdater);setClock(Date.now());setError('');}}
    catch(error){if(mounted.current){setLoading(false);setError(error instanceof Error?error.message:'预计算县级统计加载失败');}}
  },[]);
  useEffect(()=>{
    mounted.current=true;
    void fetchPrecomputedManifest().then(result=>{if(mounted.current){setManifest(result.manifest);setHasUpdater(result.hasUpdater);setClock(Date.now());}}).catch(error=>{if(mounted.current){setLoading(false);setError(error instanceof Error?error.message:'县级发布索引加载失败');}});
    return()=>{mounted.current=false;};
  },[]);
  // A temporarily unavailable manifest must not discard successfully loaded geography.
  useEffect(()=>{
    let active=true;
    void Promise.all([
      fetchPrecomputedAsset<CountyCatalog>('/data/counties.json'),
      fetchPrecomputedAsset<Topology<{counties:GeometryCollection<{id:string}>}>>('/data/counties.topo.json')
    ]).then(([catalog,topology])=>{if(active){setCatalog(catalog);setBoundaries(feature(topology,topology.objects.counties) as CountyBoundaries);}}).catch(error=>{if(active){setLoading(false);setError(error instanceof Error?error.message:'县级地理资料加载失败');}});
    return()=>{active=false;};
  },[retryRevision]);
  useEffect(()=>{const timer=setInterval(()=>void refresh(false),!manifest?10000:hasUpdater?30000:3600000);return()=>clearInterval(timer);},[hasUpdater,manifest,refresh]);
  const frame=manifest?.frames[date];
  useEffect(()=>{
    if(!frame){setSaved(null);if(manifest)setLoading(false);return;}let active=true;setLoading(true);
    void fetchPrecomputedAsset<PrecomputedCounties>(frame.counties).then(value=>{if(active){setSaved(value);setLoading(false);setError('');}}).catch(error=>{if(active){setLoading(false);setError(error instanceof Error?error.message:'县级日期统计加载失败');}});
    return()=>{active=false;};
  },[frame,manifest,retryRevision]);
  useEffect(()=>{
    const check=()=>setClock(Date.now()),today=beijingDate(new Date(clock));
    const expiry=saved?.readings.map(reading=>Date.parse(reading.forecastValidUntil??'')).filter(value=>value>clock)??[];
    const deadline=Math.min(Date.parse(`${addDays(today,1)}T00:00:00+08:00`),...expiry);
    const timer=setTimeout(check,Math.max(20,deadline-Date.now()+20));document.addEventListener('visibilitychange',check);
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',check);};
  },[clock,saved]);
  const readings=useMemo(()=>catalog&&saved?.date===date?unpackCountyReadings(saved,catalog.units,new Date(clock)):[],[catalog,saved,date,clock]);
  const ready=useMemo(()=>readings.filter(reading=>reading.state!==null),[readings]);
  const data=useMemo(()=>({...EMPTY_COUNTY_WEATHER,updatedAt:manifest?.counties.updatedAt??null,records:Object.fromEntries(readings.filter(reading=>reading.series).map(reading=>[reading.unit.id,reading.series!]))}),[readings,manifest]);
  const summaries=useMemo<PrefectureSummary[]>(()=>{
    if(!saved||saved.date!==date)return [];const groups=new Map<string,typeof readings>();
    for(const reading of readings){const id=String(reading.unit.cityCode);if(!groups.has(id))groups.set(id,[]);groups.get(id)!.push(reading);}
    return saved.summaries.map(summary=>{const group=groups.get(summary.id)??[];return {...summary,readings:group,ready:group.filter(reading=>reading.state!==null),transitionCount:group.filter(reading=>reading.state?.transition).length,forecastCount:group.filter(reading=>reading.state?.transition&&reading.forecastTransition?.target===reading.state.transition.target).length};});
  },[saved,readings,date]);
  const forecastCount=manifest?.evaluatedDay===beijingDate(new Date(clock))?(frame?.countyForecastCount??0):0;
  return {catalog,boundaries,data,readings,ready,summaries,completeCount:frame?.countyCompleteCount??0,forecastCount,firstUsableDate:manifest?.firstUsableDate??'',availableDates:manifest?.dates??[],loading,error,refresh,hasUpdater};
}
