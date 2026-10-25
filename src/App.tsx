import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, CircleHelp, Compass, ExternalLink, Info, Leaf, Map, MapPin, Radio, RefreshCw, Search, SlidersHorizontal, Star, X } from 'lucide-react';
import { CITIES, REGIONS, SEASONS, SEASON_ORDER } from './data';
import type { Region, Season, SeasonState, WeatherDataset } from './types';
import { addDays, beijingDate, classifyCity } from './lib/season';
import { createDemo, fetchWeather, readCache, REFRESH_MS } from './lib/weather';
import ChinaMap from './components/ChinaMap';
import SeasonIcon from './components/SeasonIcon';
import TemperatureChart from './components/TemperatureChart';
import CountyMap from './components/CountyMap';
import CountyDetail from './components/CountyDetail';
import CountyTable from './components/CountyTable';
import { useCounties } from './lib/useCounties';
import { projectTransition } from './lib/forecast';
import { countyTransitionAppearance, transitionAppearance } from './lib/map-status';
import TransitionLegend from './components/TransitionLegend';
import TemperatureLegend from './components/TemperatureLegend';

type View = 'map' | 'watch' | 'favorites';
const statusVars=(appearance:ReturnType<typeof transitionAppearance>):React.CSSProperties|undefined=>appearance?({'--status-fill':appearance.fill,'--status-color':appearance.color,'--status-pale':appearance.pale} as React.CSSProperties):undefined;
const fmt = (value: number | null) => value === null ? '—' : value.toFixed(1);
function useFavorites() {
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { const stored = JSON.parse(localStorage.getItem('sishi-favorites') ?? 'null'); if (Array.isArray(stored)) return stored.filter(v => typeof v === 'string' && CITIES.some(c => c.id === v)); } catch { /* browser storage */ }
    return ['c0','c18','c34','c42'];
  });
  const toggle = (id: string) => setFavorites(previous => {
    const next = previous.includes(id) ? previous.filter(v => v !== id) : [...previous,id];
    try { localStorage.setItem('sishi-favorites',JSON.stringify(next)); } catch { /* browser storage */ }
    return next;
  });
  return { favorites, toggle };
}

function TransitionProgress({ state }: { state: SeasonState }) {
  return <div className="progress-row"><div className="progress-steps">{[1,2,3,4,5].map(day => <span key={day} className={day <= (state.transition?.days ?? 0) ? 'complete' : ''}/>)}</div><span><b>{state.transition?.days ?? 0}</b> / 5 天</span></div>;
}

export default function App() {
  const today = beijingDate();
  const latestDate = addDays(today,-1);
  const [date,setDate] = useState(latestDate);
  const [dataset,setDataset] = useState<WeatherDataset>(() => readCache() ?? createDemo());
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [liveEnabled,setLiveEnabled] = useState(true);
  const [view,setView] = useState<View>('map');
  const [seasonFilter,setSeasonFilter] = useState<Season | 'all'>('all');
  const [region,setRegion] = useState<Region | 'all'>('all');
  const [search,setSearch] = useState('');
  const [selected,setSelected] = useState('c0');
  const [layer,setLayer] = useState<'season' | 'temperature'>('season');
  const [mapMode,setMapMode] = useState<'counties' | 'cities'>('counties');
  const [showPoints,setShowPoints] = useState(false);
  const [showBoundaries,setShowBoundaries] = useState(false);
  const [selectedCounty,setSelectedCounty] = useState('110101');
  const [countyFocus,setCountyFocus] = useState<{id:string;revision:number}|null>(null);
  const [showTransitions,setShowTransitions] = useState(true);
  const [methodOpen,setMethodOpen] = useState(false);
  const [filterOpen,setFilterOpen] = useState(false);
  const [tableSearch,setTableSearch] = useState('');
  const [tablePage,setTablePage] = useState(0);
  const [tableScope,setTableScope] = useState<'all' | 'transition'>('all');
  const [notification,setNotification] = useState('');
  const request = useRef<{ controller: AbortController; id: number } | null>(null);
  const modalClose = useRef<HTMLButtonElement>(null);
  const modalPanel = useRef<HTMLDivElement>(null);
  const { favorites,toggle: toggleFavorite } = useFavorites();
  const countyData = useCounties(date);
  const minDate = mapMode==='counties'&&view!=='favorites'?[addDays(latestDate,-30),countyData.firstUsableDate].sort().at(-1)!:addDays(latestDate,-30);
  useEffect(()=>{if(mapMode==='counties'&&view!=='favorites'&&Object.keys(countyData.data.records).length&&date<minDate)setDate(minDate);},[mapMode,view,countyData.data,date,minDate]);

  const refresh = useCallback(async (force = false) => {
    const cache = readCache();
    if (!force && cache && Date.now()-new Date(cache.updatedAt).getTime()<REFRESH_MS) { setDataset(cache); return; }
    request.current?.controller.abort();
    const controller = new AbortController();
    const id = Date.now() + Math.random();
    request.current = { controller,id }; setLoading(true); setError('');
    const timeout = window.setTimeout(() => controller.abort('timeout'),35000);
    try { const data = await fetchWeather(controller.signal); if (request.current?.id===id) setDataset(data); }
    catch (e) { if (request.current?.id===id && controller.signal.reason !== 'unmount') setError(controller.signal.aborted ? '气温服务连接超时，可稍后重试。' : e instanceof Error ? e.message : '气温数据加载失败'); }
    finally { clearTimeout(timeout); if (request.current?.id===id) setLoading(false); }
  },[]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/weather-snapshot.json', { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('No snapshot'); return response.json() as Promise<WeatherDataset>; })
      .then(snapshot => {
        if (snapshot.source !== 'live' || !CITIES.every(city => Array.isArray(snapshot.cities?.[city.id]))) return;
        setDataset(previous => previous.source === 'demo' || Date.parse(snapshot.updatedAt) > Date.parse(previous.updatedAt) ? snapshot : previous);
      }).catch(() => { /* live API and clearly labelled demo remain available */ });
    return () => controller.abort();
  },[]);
  useEffect(() => {
    if (!liveEnabled) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(true),REFRESH_MS);
    return () => { clearInterval(interval); request.current?.controller.abort('unmount'); };
  },[refresh,liveEnabled]);
  useEffect(() => {
    if (!methodOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    modalClose.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMethodOpen(false);
      if (e.key === 'Tab') {
        const elements = modalPanel.current?.querySelectorAll<HTMLElement>('button, a[href]');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown',onKey);
    const overflow = document.body.style.overflow; document.body.style.overflow='hidden';
    return () => { document.removeEventListener('keydown',onKey); document.body.style.overflow=overflow; previous?.focus(); };
  },[methodOpen]);
  useEffect(() => { if (!notification) return; const t = setTimeout(() => setNotification(''),3500); return () => clearTimeout(t); },[notification]);

  const states = useMemo(() => CITIES.map(city => classifyCity(city,(dataset.cities[city.id] ?? []).filter(day=>dataset.source==='demo'||day.date<beijingDate(new Date(dataset.updatedAt))),date)),[dataset,date]);
  const forecastByCity = useMemo(()=>Object.fromEntries(dataset.source==='live'?states.flatMap(state=>{const projected=projectTransition(state,{issuedAt:dataset.updatedAt,days:(dataset.cities[state.city.id]??[]).filter(day=>day.date>=beijingDate(new Date(dataset.updatedAt)))},date);return projected?[[state.city.id,projected]]:[];}):[]),[states,dataset,date]);
  const countyStates = countyData.ready.map(reading=>reading.state!);
  const displayStates = mapMode==='counties'&&view!=='favorites'?countyStates:states;
  const validStates = displayStates.filter(state=>state.average!==null);
  const statUnit = mapMode==='counties'&&view!=='favorites'?'县级单元':'代表城市';
  const effectiveDemo = (mapMode==='cities'||view==='favorites')&&dataset.source==='demo';
  const displayTransitionCount=mapMode==='counties'&&view!=='favorites'?countyData.readings.filter(reading=>reading.state?.transition||reading.forecastTransition).length:displayStates.filter(state=>state.transition||forecastByCity[state.city.id]).length;
  const countyFiltered = countyData.readings.filter(reading=>(region==='all'||reading.unit.region===region)&&(seasonFilter==='all'||reading.state?.season===seasonFilter));
  const countyTransitions = countyFiltered.filter(reading=>reading.state?.transition||reading.forecastTransition).sort((a,b)=>Number(!!b.forecastTransition)-Number(!!a.forecastTransition)||(b.state?.transition?.days??0)-(a.state?.transition?.days??0));
  const countyForecasts=countyTransitions.filter(reading=>reading.forecastTransition);
  const countyPending=countyTransitions.length-countyForecasts.length;
  const countyRegions = [...new Set(countyTransitions.map(reading=>reading.unit.province))];
  const currentCounty = countyData.readings.find(reading=>reading.unit.id===selectedCounty)??countyData.readings[0]??null;
  const filtered = states.filter(s => (region==='all'||s.city.region===region) && (seasonFilter==='all'||s.season===seasonFilter));
  const current = states.find(s => s.city.id===selected)!;
  const currentForecast=forecastByCity[selected];
  const currentAppearance=transitionAppearance(current,currentForecast);
  const currentPendingAppearance=transitionAppearance(current);
  const season = SEASONS[current.season];
  const transitions = filtered.filter(s => (s.transition||forecastByCity[s.city.id]) && s.average !== null).sort((a,b) => (b.transition?.days??0)-(a.transition?.days??0));
  const transitionDirections=mapMode==='counties'?countyTransitions.flatMap(reading=>{const appearance=countyTransitionAppearance(reading);return appearance&&reading.state?[{from:reading.state.season,target:appearance.target}]:[];}):transitions.flatMap(state=>{const appearance=transitionAppearance(state,forecastByCity[state.city.id]);return appearance?[{from:state.season,target:appearance.target}]:[];});
  const searchResults = search.trim() ? states.filter(s => `${s.city.name}${s.city.province}${s.city.region}`.includes(search.trim())).slice(0,7) : [];
  const countySearchResults = search.trim()?countyData.readings.filter(reading=>`${reading.unit.id}${reading.unit.name}${reading.unit.province}${reading.unit.city}`.includes(search.trim())).slice(0,7):[];
  const counts = SEASON_ORDER.map(key => ({ key, count: validStates.filter(s => s.season===key).length }));
  const dominant = [...counts].sort((a,b) => b.count-a.count)[0];
  const tableStates = filtered.filter(s => (view!=='favorites'||favorites.includes(s.city.id)) && (view!=='watch' && tableScope!=='transition'||!!s.transition||!!forecastByCity[s.city.id]) && `${s.city.name}${s.city.province}`.includes(tableSearch.trim()));
  const maxPage = Math.max(0,Math.ceil(tableStates.length/8)-1);
  const page = Math.min(tablePage,maxPage);
  const selectCity = (id: string) => { setSelected(id);setMapMode('cities');setSearch('');if(view!=='map'){setView('map');window.scrollTo({top:0,behavior:'smooth'});} };
  const selectCounty = (id:string,locate=false) => {
    setSelectedCounty(id);setMapMode('counties');setView('map');setSearch('');
    if(locate){setCountyFocus(previous=>({id,revision:(previous?.revision??0)+1}));requestAnimationFrame(()=>document.getElementById('season-map-panel')?.scrollIntoView({behavior:'auto',block:'start'}));}
  };
  const toggleSeason = (key: Season) => { setSeasonFilter(p => p===key?'all':key); setTablePage(0); };
  const changeView = (next: View) => { setView(next); setTableScope('all'); setTablePage(0); setSeasonFilter('all'); setRegion('all'); setTableSearch(''); };
  const exportCsv = () => {
    const rows = [['日期','城市','省级地区','区域','参考季节','日均温°C','5日滑动均温°C','换季方向','连续达标天数','预报预计目标','预计确认日期','预报获取时间','数据类型'],...tableStates.map(s => [date,s.city.name,s.city.province,s.city.region,SEASONS[s.season].name,fmt(s.temperature),fmt(s.average),s.transition?SEASONS[s.transition.target].verb:'',s.transition?.days??'',forecastByCity[s.city.id]?SEASONS[forecastByCity[s.city.id].target].verb:'',forecastByCity[s.city.id]?.expectedDate??'',forecastByCity[s.city.id]?.issuedAt??'',dataset.source==='demo'?'模拟演示':'Open-Meteo模型估算'])];
    const csv='\uFEFF'+rows.map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
    const a=document.createElement('a'); a.href=url; a.download=`四时-季节分布-${date}.csv`; a.click(); URL.revokeObjectURL(url);
    setNotification(`已导出 ${tableStates.length} 个城市的${dataset.source==='demo'?'演示':''}数据`);
  };

  return <div className="app-shell">
    <header className="header"><div className="header-inner">
      <a className="brand" href="#" onClick={e=>{e.preventDefault();changeView('map');}} aria-label="四时首页"><span className="brand-symbol"><i/><i/><i/><i/></span><span className="brand-name">四时<span>SEASON ATLAS</span></span><span className="brand-divider"/><span className="brand-tagline">知冷暖 · 见四季</span></a>
      <nav className="top-nav" aria-label="主导航"><button className={view==='map'?'active':''} onClick={()=>changeView('map')}><Map size={16}/>全国地图</button><button className={view==='watch'?'active':''} onClick={()=>changeView('watch')}><Radio size={16}/>换季观察<span className="nav-count">{mapMode==='counties'?countyTransitions.length:transitions.length}</span></button><button className={view==='favorites'?'active':''} onClick={()=>changeView('favorites')}><Star size={16}/>我的关注</button></nav>
      <button className="method-button" aria-label="查看季节划分标准" onClick={()=>setMethodOpen(true)}><BookOpen size={16}/><span>划分标准</span><ExternalLink size={12}/></button>
    </div></header>
    <main>
      <section className="hero"><div><div className="eyebrow"><span/>循温而行，感知季节</div><h1>{view==='watch'?'换季，正在发生。':view==='favorites'?'心之所向，四季有信。':'一幅地图，阅尽中国四季。'}</h1><p>{view==='watch'?'捕捉每一次气温越过阈值的时刻，追踪季节的脚步。':view==='favorites'?'收藏在意的城市，让每一次冷暖变化都有迹可循。':'以气温为刻度，观察山河之间春生、夏长、秋收、冬藏。'}</p></div><div className="hero-date"><div><CalendarDays size={15}/><span>{today.replaceAll('-',' . ')}</span><span className="time-zone">北京时间</span></div><span className="date-caption"><span className={`status-dot ${effectiveDemo?'amber':''}`}/>{mapMode==='counties'&&view!=='favorites'?(countyData.loading?'正在同步县级快照':'县级模型 · 完整日与 7 日预报'):loading?'正在同步城市气温':dataset.source==='demo'?'演示数据 · 非实时气象':'城市模型 · 每小时更新'}<button onClick={()=>{if(mapMode==='counties'&&view!=='favorites')void countyData.refresh();else if(liveEnabled)void refresh(true);else{setDataset(createDemo());setNotification('演示数据已重新生成');}}} disabled={mapMode==='counties'&&view!=='favorites'?countyData.loading:loading} aria-label="刷新气温数据"><RefreshCw size={13} className={(mapMode==='counties'&&view!=='favorites'?countyData.loading:loading)?'spin':''}/></button></span></div></section>

      {(mapMode==='cities'||view==='favorites')&&(dataset.source==='demo'||error) && <div className={`data-banner ${error?'warning':''}`} role="status"><Info size={15}/><span>{loading?'正在连接 Open-Meteo，当前暂以模拟气温展示交互。':error?`${error} 当前显示${dataset.source==='demo'?'模拟演示':'上次缓存的模型'}数据。`:'当前为模拟气温演示，季节分布与换季进度仅用于体验功能。'}</span><button onClick={()=>{setLiveEnabled(true);void refresh(true);}} disabled={loading}>{loading?'连接中':'连接实时数据'}<ArrowRight size={13}/></button></div>}

      <section className="season-cards" aria-label="季节分布统计">{counts.map(({key,count})=>{
        const meta=SEASONS[key]; const percent=validStates.length?Math.round(count/validStates.length*100):0;
        return <button className={`season-card ${key} ${seasonFilter===key?'is-active':''}`} style={{'--season-color':meta.color,'--season-pale':meta.pale} as React.CSSProperties} key={key} onClick={()=>toggleSeason(key)} aria-pressed={seasonFilter===key}>
          <div className="season-card-top"><span className="season-icon"><SeasonIcon season={key} size={22}/></span><span>{meta.name}<small>{meta.en}</small></span>{dominant.key===key&&count>0&&<span className="dominant-tag">当前主季</span>}<ChevronRight className="season-chevron" size={15}/></div>
          <div className="season-card-bottom"><span><b>{count.toString().padStart(2,'0')}</b><small>个{statUnit}</small></span><span className="season-percent">{percent}<small>%</small></span></div><div className="season-card-bar"><span style={{width:`${percent}%`}}/></div>
          <div className="season-decoration"><SeasonIcon season={key} size={105}/></div>
        </button>;
      })}</section>

      <div className="workspace-toolbar"><div className="section-heading"><h2>{view==='map'?(mapMode==='counties'?'全国县级季节分布':'重点城市季节参考'):view==='watch'?'换季观察':'关注城市'}</h2><span className="muted-line"/><span>{mapMode==='counties'&&view!=='favorites'?`${countyData.readings.length.toLocaleString()} 个县级单元 · ${countyData.summaries.length} 个地级与直辖汇总`:`${view==='favorites'?favorites.length:CITIES.length} 个重点城市 · 模型参考`}</span>{seasonFilter!=='all'&&<button className="filter-chip" onClick={()=>setSeasonFilter('all')}>{SEASONS[seasonFilter].name}<X size={11}/></button>}</div><div className="toolbar-controls"><button className="date-step" disabled={date<=minDate} onClick={()=>setDate(d=>addDays(d,-1))} aria-label="前一天"><ChevronLeft size={16}/></button><label className="date-input"><CalendarDays size={14}/><input aria-label="查看日期" type="date" value={date} min={minDate} max={latestDate} onChange={e=>{if(e.target.value&&e.target.value>=minDate&&e.target.value<=latestDate)setDate(e.target.value);}}/></label><button className="date-step" disabled={date>=latestDate} onClick={()=>setDate(d=>addDays(d,1))} aria-label="后一天"><ChevronRight size={16}/></button><span className="toolbar-divider"/><button className={`filter-button ${filterOpen?'active':''}`} onClick={()=>setFilterOpen(v=>!v)}><SlidersHorizontal size={14}/>筛选</button></div></div>
      {filterOpen&&<div className="filter-panel"><label>地理区域<select value={region} onChange={e=>{setRegion(e.target.value as Region|'all');setTablePage(0);}}><option value="all">全国所有区域</option>{REGIONS.map(r=><option key={r}>{r}</option>)}</select></label><label>季节<select value={seasonFilter} onChange={e=>setSeasonFilter(e.target.value as Season|'all')}><option value="all">全部季节</option>{SEASON_ORDER.map(s=><option value={s} key={s}>{SEASONS[s].name}</option>)}</select></label><button onClick={()=>{setRegion('all');setSeasonFilter('all');}}>重置筛选</button><span>县区、汇总列表及换季观察同步应用筛选，地图淡化其他区域。</span></div>}

      {view==='map'&&<div className="dashboard-grid">
        <section className="map-card panel" id="season-map-panel"><div className="map-toolbar dual-map-toolbar"><div className="segmented map-view-switch" role="group" aria-label="地图数据层级"><button className={mapMode==='counties'?'active':''} aria-pressed={mapMode==='counties'} onClick={()=>{setMapMode('counties');setSearch('');}}>县级分布</button><button className={mapMode==='cities'?'active':''} aria-pressed={mapMode==='cities'} onClick={()=>{setMapMode('cities');setSearch('');}}>重点城市</button></div><div className="segmented"><button className={layer==='season'?'active':''} onClick={()=>setLayer('season')}>季节分布</button><button className={layer==='temperature'?'active':''} onClick={()=>setLayer('temperature')}>滑动均温</button></div><div className="map-search"><Search size={15}/><input placeholder={mapMode==='counties'?'县区 / 城市 / 区划码':'搜索重点城市'} aria-label="搜索县区或城市" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){if(mapMode==='counties'&&countySearchResults[0])selectCounty(countySearchResults[0].unit.id,true);else if(mapMode==='cities'&&searchResults[0])selectCity(searchResults[0].city.id);}if(e.key==='Escape')setSearch('');}}/>{search&&<button aria-label="清除搜索" onClick={()=>setSearch('')}><X size={13}/></button>}{search&&<div className="search-results">{mapMode==='counties'?(countySearchResults.length?countySearchResults.map(reading=><button key={reading.unit.id} onClick={()=>selectCounty(reading.unit.id,true)}><MapPin size={13}/><b>{reading.unit.name}</b><span>{reading.unit.city} · {reading.unit.id}</span></button>):<p>未找到县区，试试所属市或六位区划码</p>):searchResults.length?searchResults.map(s=><button key={s.city.id} onClick={()=>selectCity(s.city.id)}><MapPin size={13}/><b>{s.city.name}</b><span>{s.city.province} · {SEASONS[s.season].name}</span></button>):<p>暂未覆盖该重点城市</p>}</div>}</div></div>
          <div className="model-coverage"><span><i/>{mapMode==='counties'?`县级模型：${countyData.ready.length.toLocaleString()} / ${countyData.readings.length.toLocaleString()} 个可判定`:`重点城市：${CITIES.length} 个独立参考点`}</span><span>{mapMode==='counties'?'区域分级填色 · 县界默认隐藏 · 缺测标灰':'代表城市模型与县级汇总分开计算'}</span></div>
          {mapMode==='counties'&&<><div className="field-controls"><span className="field-style-label">县内代表点气温 · 非全县均温</span><label className="field-points-toggle"><input type="checkbox" checked={showBoundaries} onChange={e=>setShowBoundaries(e.target.checked)}/>显示县界</label><label className="field-points-toggle"><input type="checkbox" checked={showPoints} onChange={e=>setShowPoints(e.target.checked)}/>显示代表点</label></div><div className="field-source-note"><span>{countyData.loading?'正在读取共享县级模型快照…':`Open-Meteo · 最近14天起步，历史逐日积累 · ${countyData.data.updatedAt?new Date(countyData.data.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'等待同步'}`}</span><button aria-label="刷新县级模型" disabled={countyData.loading} onClick={()=>void countyData.refresh()}><RefreshCw size={11} className={countyData.loading?'spin':''}/></button></div>{countyData.completeCount<countyData.readings.length&&<div className="county-sync-note" role="status">最新完整日已覆盖 {countyData.completeCount.toLocaleString()} / {countyData.readings.length.toLocaleString()} 个单元，{countyData.hasUpdater?'剩余代表点正在分批同步。':'共享快照尚未覆盖的县区保持灰色。'}</div>}{countyData.forecastCount<countyData.readings.length&&<div className="county-forecast-note" role="status">今日 7 日预报已更新 {countyData.forecastCount.toLocaleString()} / {countyData.readings.length.toLocaleString()} 个单元，{countyData.hasUpdater?'正在分批补齐。':'其余单元暂不显示预报完成标记。'}</div>}{showTransitions&&countyTransitions.length>0&&<div className="field-transition-note"><Radio size={12}/><span><b>{countyTransitions.length} 个县级单元有换季信号</b> · {countyRegions.slice(0,4).join('、')}{countyRegions.length>4?'等':''}部分地区<small>{countyPending} 个进行中 · {countyForecasts.length} 个按当前预报预计完成 · 按换季方向着色</small></span></div>}{countyData.error&&<div className="model-data-error" role="status">{countyData.error}</div>}</>}
          {mapMode==='counties'?<CountyMap readings={countyData.readings} boundaries={countyData.boundaries} selected={selectedCounty} focus={countyFocus} onSelect={selectCounty} filter={seasonFilter} region={region} layer={layer} showTransitions={showTransitions} showPoints={showPoints} showBoundaries={showBoundaries}/>:<ChinaMap states={states} forecastByCity={forecastByCity} selected={selected} onSelect={selectCity} filter={seasonFilter} showTransitions={showTransitions} layer={layer}/>}
          <div className="map-legend status-map-legend">{layer==='season'?SEASON_ORDER.map(s=><button key={s} onClick={()=>toggleSeason(s)} className={seasonFilter!==s&&seasonFilter!=='all'?'dim':''}><i style={{background:SEASONS[s].fill}}/>{SEASONS[s].name}</button>):<TemperatureLegend overlaid={showTransitions}/>}<span className="legend-divider"/>{mapMode==='counties'&&<span className="missing-legend"><i/>资料不足</span>}</div>
          <TransitionLegend directions={transitionDirections} enabled={showTransitions} onToggle={()=>setShowTransitions(value=>!value)}/>
          <div className="map-footnote"><Info size={12}/><span>{mapMode==='counties'?'县界：DataV 公开历史区划 · 台湾县级未覆盖 · 4 个无下辖县区城市单独列示':'季节色按城市多数季节，换季色表示已覆盖城市信号，不代表全省一致'}</span><span className="map-source">模型参考</span></div>
        </section>

        <aside className="side-column">{mapMode==='counties'?<CountyDetail reading={currentCounty} date={date} onLocate={id=>selectCounty(id,true)}/>:<section className="city-card panel"><div className="city-top"><div><span className="tiny-label">代表城市 · 模型估算</span><h3><MapPin size={18}/>{current.city.name}<span>{current.city.province===current.city.name?current.city.region:current.city.province}</span></h3></div><button className={`favorite-button ${favorites.includes(selected)?'saved':''}`} onClick={()=>toggleFavorite(selected)} aria-label={favorites.includes(selected)?'取消关注城市':'关注城市'} aria-pressed={favorites.includes(selected)}><Star size={19} fill={favorites.includes(selected)?'currentColor':'none'}/></button></div>
          <div className="city-season" style={{background:season.pale,color:season.color}}><span className="city-season-symbol"><SeasonIcon season={current.season} size={42}/></span><div><small>此刻，正值</small><strong>{season.name}</strong></div><span className="city-season-note">{current.since?<><b>{current.since.slice(5).replace('-','月')}日</b>参考{season.verb}日</>:<>季节初始估计<br/>待完整气候校正</>}</span></div>
          <div className="city-temperatures"><div><span>5 日滑动平均气温<CircleHelp size={12} onClick={()=>setMethodOpen(true)}/></span><strong>{fmt(current.average)}<small>°C</small></strong></div><div><span>当日日平均气温</span><strong>{fmt(current.temperature)}<small>°C</small></strong></div></div>
          {currentForecast&&<div className="forecast-completion" style={statusVars(currentAppearance)}><div><span className="transition-swatch forecast"/><b>预报预计完成{SEASONS[currentForecast.target].verb}</b><strong>{currentForecast.expectedDate.slice(5).replace('-','/')}</strong></div><p>当前仍为{season.name}，等待完整日温确认。</p><small>按当前 7 日预报推算 · 非实际换季结论</small></div>}{current.transition?<div className="city-transition" style={statusVars(currentPendingAppearance)}><div><span className="status-dot pending"/><b>{SEASONS[current.transition.target].verb}进行中</b><span>待持续确认</span></div><TransitionProgress state={current}/></div>:<div className="city-stable"><Check size={14}/>{current.average===null?'当前日期气温数据缺失':'暂未出现新的连续达标过程'}<span>{current.estimated?'参考估计':'已完成 5 天确认'}</span></div>}
          <TemperatureChart state={current} date={date} input={dataset.cities[selected]??[]}/>
        </section>}
        {mapMode==='counties'&&<section className="watch-card panel"><div className="watch-heading"><h3><Radio size={16}/>县区换季观察<span>{countyTransitions.length}</span></h3><button onClick={()=>changeView('watch')} aria-label="查看全部换季县区"><ArrowRight size={16}/></button></div><p className="watch-description">追踪完整日过程与预报预计完成日期。</p><div className="watch-list">{countyTransitions.length?countyTransitions.slice(0,3).map(reading=><button className="watch-item" style={statusVars(countyTransitionAppearance(reading))} key={reading.unit.id} onClick={()=>selectCounty(reading.unit.id,true)}><div><span className="watch-city">{reading.unit.name}<small>{reading.unit.city}</small></span><span className="watch-target"><b className={reading.forecastTransition?'forecast-text':''}>{reading.forecastTransition?`预计 ${reading.forecastTransition.expectedDate.slice(5).replace('-','/')} ${SEASONS[reading.forecastTransition.target].verb}`:SEASONS[reading.state!.transition!.target].verb}</b></span></div>{reading.state?.transition?<TransitionProgress state={reading.state}/>:<span className="watch-forecast-note">预报中新发过程 · 尚待完整日确认</span>}</button>):<div className="watch-empty"><Leaf size={25}/><span>{countyData.ready.length?'当前筛选暂无换季过程':'县级代表点同步中'}</span></div>}</div><div className="watch-note"><Info size={12}/>颜色与名单使用同一判定 · 预报预计不等于实际确认</div></section>}
        {mapMode==='cities'&&<section className="watch-card panel"><div className="watch-heading"><h3><span className="radar-icon"><Radio size={17}/></span>城市换季参考<span>{transitions.length}</span></h3><button onClick={()=>changeView('watch')} aria-label="查看全部换季城市"><ArrowRight size={16}/></button></div><p className="watch-description">完整日过程与 7 日预报分开判定。</p><div className="watch-list">{transitions.length?transitions.slice(0,3).map(s=><button className="watch-item" style={statusVars(transitionAppearance(s,forecastByCity[s.city.id]))} key={s.city.id} onClick={()=>selectCity(s.city.id)}><div><span className="watch-city">{s.city.name}<small>{s.city.province}</small></span><span className="watch-target">{SEASONS[s.season].name.slice(0,1)}<ArrowRight size={12}/><b>{forecastByCity[s.city.id]?`预计 ${forecastByCity[s.city.id].expectedDate.slice(5).replace('-','/')} ${SEASONS[forecastByCity[s.city.id].target].verb}`:SEASONS[s.transition!.target].verb}</b></span></div>{s.transition?<TransitionProgress state={s}/>:<span className="watch-forecast-note">预报中新发过程 · 尚待完整日确认</span>}</button>):<div className="watch-empty"><Leaf size={25}/><span>季节正安稳流转</span><small>当前筛选范围内暂无换季过程</small></div>}</div><div className="watch-note"><Info size={12}/>连续 5 个滑动均温达标后，初步确认换季</div></section>}</aside>
      </div>}

      {view==='map'&&<section className="insight-strip"><span className="insight-symbol"><Compass size={23}/></span><div><b>季节的边界，由气温慢慢写下。</b><span>{date===latestDate?'最近完整日':date.replaceAll('-','/')}，{SEASONS[dominant.key].name}覆盖 {dominant.count} 个{statUnit}，另有 {displayTransitionCount} 个{statUnit}正在等待新季节的到来。</span></div><button onClick={()=>setMethodOpen(true)}>了解滑标法<ArrowRight size={14}/></button></section>}

      {mapMode==='counties'&&view!=='favorites'&&<CountyTable readings={countyData.readings} summaries={countyData.summaries} date={date} region={region} season={seasonFilter} onlyTransitions={view==='watch'} onSelect={selectCounty}/>}
      {(mapMode==='cities'||view==='favorites')&&<section className="table-panel panel"><div className="table-heading"><div><h2>{view==='favorites'?'我的关注城市':view==='watch'?'城市模型换季观察':'城市季节一览'}</h2><span>{view==='favorites'?'点击星标，留住你关心的城市':view==='watch'?'包含正在进行及当前预报预计完成的换季过程':'每一座城市，都有自己的季节节奏'}</span></div><div className="table-tools"><label className="table-search"><Search size={14}/><input aria-label="筛选城市列表" value={tableSearch} onChange={e=>{setTableSearch(e.target.value);setTablePage(0);}} placeholder="查找城市"/></label>{view==='map'&&<button className={`table-filter ${tableScope==='transition'?'active':''}`} onClick={()=>{setTableScope(s=>s==='all'?'transition':'all');setTablePage(0);}}><Radio size={14}/>仅看换季</button>}<button className="export-button" onClick={exportCsv}><ArrowDownToLine size={14}/><span>导出数据</span></button></div></div><div className="table-scroll"><table><thead><tr><th>城市 / 地区</th><th>当前季节</th><th>5 日滑动均温</th><th>日均气温</th><th>换季状态</th><th>关注</th></tr></thead><tbody>{tableStates.slice(page*8,(page+1)*8).map(s=><tr key={s.city.id}><td><button className="table-city" onClick={()=>selectCity(s.city.id)}>{s.city.name}<small>{s.city.province} · {s.city.region}</small></button></td><td><span className="season-badge" style={{color:SEASONS[s.season].color,background:SEASONS[s.season].pale}}><SeasonIcon season={s.season} size={13}/>{SEASONS[s.season].name}</span></td><td className="numeric">{fmt(s.average)}<small> °C</small></td><td className="numeric light">{fmt(s.temperature)}<small> °C</small></td><td style={statusVars(transitionAppearance(s,forecastByCity[s.city.id]))}>{forecastByCity[s.city.id]?<span className="table-transition forecast"><i/>预计{SEASONS[forecastByCity[s.city.id].target].verb}<small>{forecastByCity[s.city.id].expectedDate.slice(5).replace('-','/')} 确认</small></span>:s.transition?<span className="table-transition"><i/>{SEASONS[s.transition.target].verb}观察中<small>{s.transition.days} / 5 天</small></span>:<span className="table-stable">{s.average===null?'数据缺失':s.estimated?'季节参考估计':'季节稳定'}</span>}</td><td><button className={`favorite-button ${favorites.includes(s.city.id)?'saved':''}`} onClick={()=>toggleFavorite(s.city.id)} aria-label={`${favorites.includes(s.city.id)?'取消关注':'关注'}${s.city.name}`}><Star size={16} fill={favorites.includes(s.city.id)?'currentColor':'none'}/></button></td></tr>)}</tbody></table></div>{tableStates.length===0&&<div className="table-empty"><Search size={25}/><b>{view==='favorites'?'还没有符合条件的关注城市':'没有找到符合条件的城市'}</b><span>调整筛选条件，或在全国地图中探索更多城市。</span><button onClick={()=>{setTableSearch('');setSeasonFilter('all');setRegion('all');setTableScope('all');if(view==='favorites')changeView('map');}}>查看所有城市<ArrowRight size={13}/></button></div>}<div className="table-footer"><span>共 {tableStates.length} 个城市<span className="desktop-only"> · 数据截至 {date}（北京时间完整日）</span></span><div><button disabled={page===0} onClick={()=>setTablePage(p=>Math.max(0,p-1))} aria-label="上一页"><ChevronLeft size={15}/></button><span>{page+1} / {maxPage+1}</span><button disabled={page>=maxPage} onClick={()=>setTablePage(p=>p+1)} aria-label="下一页"><ChevronRight size={15}/></button></div></div></section>}

      <footer className="footer"><div><span className="footer-brand">四时</span><span>让季节可见，让冷暖可知。</span></div><span><span className={`status-dot ${effectiveDemo?'amber':''}`}/>{effectiveDemo?'模拟演示数据':'Open-Meteo 模型数据'}<i/>滑标参考判定<button aria-label="查看季节判定说明" onClick={()=>setMethodOpen(true)}><CircleHelp size={13}/></button></span><span className="footer-credit">MADE FOR THE CHANGING SEASONS</span></footer>
    </main>
    {notification&&<div className="toast" role="status"><Check size={16}/>{notification}</div>}
    {methodOpen&&<div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget)setMethodOpen(false);}}><div className="method-modal" role="dialog" aria-modal="true" aria-labelledby="method-title" ref={modalPanel}><button className="modal-close" ref={modalClose} aria-label="关闭划分标准" onClick={()=>setMethodOpen(false)}><X size={20}/></button><span className="modal-eyebrow"><BookOpen size={15}/> HOW SEASONS ARE DEFINED</span><h2 id="method-title">跟随气温，读懂四季。</h2><p className="modal-lead">本项目参考 GB/T 42074—2022《气候季节划分》的滑动平均阈值与连续性规则，提供季节估算和换季观察。</p><div className="method-thresholds">{SEASON_ORDER.map(s=><div key={s} style={{background:SEASONS[s].pale,color:SEASONS[s].color}}><SeasonIcon season={s}/><b>{SEASONS[s].name}</b><span>{s==='winter'?'< 10°C':s==='summer'?'≥ 22°C':'10°C ≤ T < 22°C'}</span></div>)}</div><ol className="method-steps"><li><b>先平均，消除单日温度波动</b><p>将当天及之前 4 天的日平均气温相加除以 5，形成每日的 5 日滑动平均气温。缺失值或日期断档会中断连续过程。</p></li><li><b>连续 5 天达标，初步确认换季</b><p>依阈值追踪：入春 ≥10°C、入夏 ≥22°C、入秋 &lt;22°C、入冬 &lt;10°C。连续达标 1–4 天标记为“换季观察中”；第 5 天完成初判，并从对应 9 天日均温中回溯首个达标日期。</p></li><li><b>完整日判定，预报单独展示</b><p>截至所选日期，仅使用北京时间已经结束的完整日。曲线虚线为所选日期之后的模型参考，不参与当日的换季确认。</p></li></ol><div className="method-caveat"><Info size={17}/><div><b>参考估算的边界</b><p>气温来自 Open-Meteo 再分析及预报模型，并非地面逐日实测。尚未接入 1991–2020 常年日温序列，未执行偏早 15 天以上的二次判断，也未正式校正无冬、无夏等特殊气候地区。序列尚未检出夏/冬时，以 8 月 1 日、1 月 1 日作为展示用季节衔接。连续 5 天反向越界会重新判定，春秋方向使用上/下半年辅助估计；这些规则不等同于标准的二次判断。县级数据按县内代表点计算滑标参考季节，再沿真实县界展示；代表点不表示全县实测或全县均温。首次获取近14天日温，历史随每日更新积累，未检出完整季节过程时标记初始估计。地级汇总主季按有效县区多数判定，均温是有效代表点等权平均。边界采用 DataV areas_v3 公开历史区划，不保证覆盖最新调整；台湾县级未覆盖，4个无下辖县区城市以独立单元列示。不能替代官方入季结论。</p></div></div><div className="data-settings"><div><b>当前数据源</b><span>{mapMode==='counties'&&view!=='favorites'?`Open-Meteo 县级快照 · ${countyData.data.updatedAt??'同步中'}`:dataset.source==='demo'?'确定性模拟气温 · 仅演示':`Open-Meteo · 更新于 ${new Date(dataset.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`}</span></div><button onClick={()=>{if(mapMode==='counties'&&view!=='favorites'){void countyData.refresh();setMethodOpen(false);return;}if(dataset.source==='demo'){setLiveEnabled(true);void refresh(true);}else{setLiveEnabled(false);setDataset(createDemo());setError('');setLoading(false);}setMethodOpen(false);}}>{mapMode==='counties'&&view!=='favorites'?'刷新县级快照':dataset.source==='demo'?'连接实时模型':'切换演示模式'}<ArrowRight size={14}/></button></div><div className="method-links"><a href="https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=2CC96F656DE7E1641FEA09766A87FDD3" target="_blank" rel="noreferrer">国家标准全文<ExternalLink size={12}/></a><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo 数据说明<ExternalLink size={12}/></a><span>CC BY 4.0 · 非商业免费接口</span></div></div></div>}
  </div>;
}
