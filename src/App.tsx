import {useEffect,useMemo,useRef,useState} from 'react';
import type {CSSProperties} from 'react';
import {ArrowRight,BookOpen,CalendarDays,ChevronLeft,ChevronRight,CircleHelp,Compass,ExternalLink,Grid3X3,Info,Leaf,Map,MapPin,Radio,RefreshCw,Search,SlidersHorizontal,X} from 'lucide-react';
import {REGIONS,SEASONS,SEASON_ORDER} from './data';
import type {Region,Season,SeasonState} from './types';
import {addDays,beijingDate} from './lib/season';
import {countyTransitionAppearance} from './lib/map-status';
import {SPATIAL_SEASONS} from './lib/spatial-field';
import {lookupGridLocation} from './lib/grid-location';
import {useCounties} from './lib/useCounties';
import {useSpatialWeather} from './lib/useSpatialWeather';
import CountyMap from './components/CountyMap';
import CountyTable from './components/CountyTable';
import SpatialDetail from './components/SpatialDetail';
import SeasonIcon from './components/SeasonIcon';
import TransitionLegend from './components/TransitionLegend';
import TemperatureLegend from './components/TemperatureLegend';

type View='map'|'watch';
const statusVars=(appearance:ReturnType<typeof countyTransitionAppearance>):CSSProperties|undefined=>appearance?({'--status-fill':appearance.fill,'--status-color':appearance.color,'--status-pale':appearance.pale} as CSSProperties):undefined;
function TransitionProgress({state}:{state:SeasonState}){
  return <div className="progress-row"><div className="progress-steps">{[1,2,3,4,5].map(day=><span key={day} className={day<=(state.transition?.days??0)?'complete':''}/>)}</div><span><b>{state.transition?.days??0}</b> / 5 天</span></div>;
}

export default function App(){
  const today=beijingDate(),latestDate=addDays(today,-1);
  const [date,setDate]=useState(latestDate),[view,setView]=useState<View>('map');
  const [seasonFilter,setSeasonFilter]=useState<Season|'all'>('all'),[region,setRegion]=useState<Region|'all'>('all');
  const [search,setSearch]=useState(''),[selectedCounty,setSelectedCounty]=useState('110101');
  const [countyFocus,setCountyFocus]=useState<{id:string;revision:number}|null>(null);
  const [spatialPoint,setSpatialPoint]=useState({lon:91.1,lat:29.7});
  const [layer,setLayer]=useState<'season'|'temperature'>('season'),[showTransitions,setShowTransitions]=useState(true);
  const [showBoundaries,setShowBoundaries]=useState(false),[filterOpen,setFilterOpen]=useState(false),[methodOpen,setMethodOpen]=useState(false);
  const modalClose=useRef<HTMLButtonElement>(null),modalPanel=useRef<HTMLDivElement>(null);
  const countyData=useCounties(date),spatialData=useSpatialWeather(date);
  const availableDates=spatialData.availableDates;
  const minDate=availableDates[0]??latestDate,maxDate=availableDates.at(-1)??latestDate;
  const overlayTransitions=layer==='season'&&showTransitions;
  const spatialCell=useMemo(()=>spatialData.getCell(spatialPoint.lon,spatialPoint.lat),[spatialData.getCell,spatialPoint]);
  const location=useMemo(()=>spatialData.locations?lookupGridLocation(spatialData.locations,spatialPoint.lon,spatialPoint.lat):null,[spatialData.locations,spatialPoint]);
  useEffect(()=>{
    if(availableDates.length&&!availableDates.includes(date))setDate([...availableDates].reverse().find(day=>day<=date)??availableDates[0]);
  },[availableDates,date]);
  useEffect(()=>{
    if(!methodOpen)return;
    const previous=document.activeElement as HTMLElement|null;modalClose.current?.focus();
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape')setMethodOpen(false);
      if(event.key==='Tab'){
        const elements=modalPanel.current?.querySelectorAll<HTMLElement>('button,a[href]');if(!elements?.length)return;
        const first=elements[0],last=elements[elements.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',onKey);const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=overflow;previous?.focus();};
  },[methodOpen]);
  const validStates=countyData.ready.map(reading=>reading.state!);
  const counts=SEASON_ORDER.map(key=>({key,count:validStates.filter(state=>state.season===key).length}));
  const dominant=[...counts].sort((a,b)=>b.count-a.count)[0];
  const countyTransitions=countyData.readings.filter(reading=>(region==='all'||reading.unit.region===region)&&(seasonFilter==='all'||reading.state?.season===seasonFilter)&&(reading.state?.transition||reading.forecastTransition)).sort((a,b)=>Number(!!b.forecastTransition)-Number(!!a.forecastTransition)||(b.state?.transition?.days??0)-(a.state?.transition?.days??0));
  const searchResults=search.trim()?countyData.readings.filter(reading=>(reading.unit.id+reading.unit.name+reading.unit.province+reading.unit.city).includes(search.trim())).slice(0,7):[];
  const transitionDirections=useMemo(()=>{
    const field=spatialData.field;if(!field||field.date!==date)return [];
    const directions=new globalThis.Map<string,{from:Season;target:Season}>();
    for(let i=0;i<field.seasons.length;i++){
      const from=SPATIAL_SEASONS[field.seasons[i]],target=SPATIAL_SEASONS[field.targets[i]];
      if(from&&target&&field.status[i]&&(seasonFilter==='all'||from===seasonFilter))directions.set(from+'-'+target,{from,target});
    }
    return [...directions.values()];
  },[spatialData.field,date,seasonFilter]);
  const toggleSeason=(season:Season)=>setSeasonFilter(previous=>previous===season?'all':season);
  const changeView=(next:View)=>{setView(next);setSeasonFilter('all');setRegion('all');setSearch('');};
  const selectCounty=(id:string,locate=false)=>{
    setSelectedCounty(id);setView('map');setSearch('');
    const unit=countyData.catalog?.units.find(unit=>unit.id===id),field=spatialData.field;
    if(unit){const step=field?.step??.1,west=field?.bounds.west??0,south=field?.bounds.south??0;setSpatialPoint({lon:Number((Math.round((unit.lon-west)/step)*step+west).toFixed(4)),lat:Number((Math.round((unit.lat-south)/step)*step+south).toFixed(4))});}
    if(locate){setCountyFocus(previous=>({id,revision:(previous?.revision??0)+1}));requestAnimationFrame(()=>document.getElementById('season-map-panel')?.scrollIntoView({behavior:'auto',block:'start'}));}
  };
  const refresh=()=>{void spatialData.refresh();void countyData.refresh();};
  const stepDate=(direction:number)=>{const index=availableDates.indexOf(date),next=availableDates[index+direction];if(next)setDate(next);};
  const updatedAt=spatialData.field?.metadata.weatherUpdatedAt;

  return <div className="app-shell">
    <header className="header"><div className="header-inner">
      <a className="brand" href="#" onClick={event=>{event.preventDefault();changeView('map');}} aria-label="四时首页"><span className="brand-symbol"><i/><i/><i/><i/></span><span className="brand-name">四时<span>SEASON ATLAS</span></span><span className="brand-divider"/><span className="brand-tagline">知冷暖 · 见四季</span></a>
      <nav className="top-nav" aria-label="主导航"><button className={view==='map'?'active':''} onClick={()=>changeView('map')}><Map size={16}/>全国地图</button><button className={view==='watch'?'active':''} onClick={()=>changeView('watch')}><Radio size={16}/>换季观察<span className="nav-count">{countyTransitions.length}</span></button></nav>
      <button className="method-button" aria-label="查看季节划分标准" onClick={()=>setMethodOpen(true)}><BookOpen size={16}/><span>划分标准</span><ExternalLink size={12}/></button>
    </div></header>
    <main>
      <section className="hero"><div><div className="eyebrow"><span/>循温而行，感知季节</div><h1>{view==='watch'?'换季，正在发生。':'一幅地图，阅尽中国四季。'}</h1><p>{view==='watch'?'捕捉气温越过阈值的过程，追踪季节的脚步。':'以气温为刻度，观察山河之间春生、夏长、秋收、冬藏。'}</p></div><div className="hero-date"><div><CalendarDays size={15}/><span>{today.replaceAll('-',' . ')}</span><span className="time-zone">北京时间</span></div><span className="date-caption"><span className="status-dot"/>{spatialData.loading?'正在读取季节快照':'季节快照 · 完整日与 7 日预报'}<button onClick={refresh} disabled={spatialData.loading} aria-label="刷新气温数据"><RefreshCw size={13} className={spatialData.loading?'spin':''}/></button></span></div></section>
      <section className="season-cards" aria-label="季节分布统计">{counts.map(({key,count})=>{
        const meta=SEASONS[key],percent=validStates.length?Math.round(count/validStates.length*100):0;
        return <button className={'season-card '+key+(seasonFilter===key?' is-active':'')} style={{'--season-color':meta.color,'--season-pale':meta.pale} as CSSProperties} key={key} onClick={()=>toggleSeason(key)} aria-pressed={seasonFilter===key}>
          <div className="season-card-top"><span className="season-icon"><SeasonIcon season={key} size={22}/></span><span>{meta.name}<small>{meta.en}</small></span>{dominant.key===key&&count>0&&<span className="dominant-tag">当前主季</span>}<ChevronRight className="season-chevron" size={15}/></div>
          <div className="season-card-bottom"><span><b>{count.toString().padStart(2,'0')}</b><small>个县级参考点</small></span><span className="season-percent">{percent}<small>%</small></span></div><div className="season-card-bar"><span style={{width:percent+'%'}}/></div><div className="season-decoration"><SeasonIcon season={key} size={105}/></div>
        </button>;
      })}</section>
      <p className="spatial-stat-caption">统计按县级代表点计数；地图按地形格点独立判定，数量占比不代表面积占比。</p>
      <div className="workspace-toolbar"><div className="section-heading"><h2>{view==='map'?'全国季节分布':'换季观察'}</h2><span className="muted-line"/><span>{countyData.readings.length.toLocaleString()} 个县级单元 · {countyData.summaries.length} 个地级与直辖汇总</span>{seasonFilter!=='all'&&<button className="filter-chip" onClick={()=>setSeasonFilter('all')}>{SEASONS[seasonFilter].name}<X size={11}/></button>}</div><div className="toolbar-controls"><button className="date-step" disabled={date<=minDate} onClick={()=>stepDate(-1)} aria-label="前一天"><ChevronLeft size={16}/></button><label className="date-input"><CalendarDays size={14}/><input aria-label="查看日期" type="date" value={date} min={minDate} max={maxDate} onChange={event=>{if(availableDates.includes(event.target.value))setDate(event.target.value);}}/></label><button className="date-step" disabled={date>=maxDate} onClick={()=>stepDate(1)} aria-label="后一天"><ChevronRight size={16}/></button><span className="toolbar-divider"/><button className={'filter-button '+(filterOpen?'active':'')} onClick={()=>setFilterOpen(value=>!value)}><SlidersHorizontal size={14}/>筛选</button></div></div>
      {filterOpen&&<div className="filter-panel"><label>地理区域<select value={region} onChange={event=>setRegion(event.target.value as Region|'all')}><option value="all">全国所有区域</option>{REGIONS.map(value=><option key={value}>{value}</option>)}</select></label><label>季节<select value={seasonFilter} onChange={event=>setSeasonFilter(event.target.value as Season|'all')}><option value="all">全部季节</option>{SEASON_ORDER.map(value=><option value={value} key={value}>{SEASONS[value].name}</option>)}</select></label><button onClick={()=>{setRegion('all');setSeasonFilter('all');}}>重置筛选</button><span>地图、县区和地级汇总同步应用筛选。</span></div>}
      {view==='map'&&<div className="dashboard-grid">
        <section className="map-card panel" id="season-map-panel">
          <div className="map-toolbar dual-map-toolbar"><span className="map-view-label"><Grid3X3 size={14}/>地形季节图</span><div className="segmented"><button className={layer==='season'?'active':''} aria-pressed={layer==='season'} onClick={()=>setLayer('season')}>季节分布</button><button className={layer==='temperature'?'active':''} aria-pressed={layer==='temperature'} onClick={()=>setLayer('temperature')}>滑动均温</button></div><div className="map-search"><Search size={15}/><input placeholder="县区 / 城市 / 区划码" aria-label="搜索县区或城市" value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&searchResults[0])selectCounty(searchResults[0].unit.id,true);if(event.key==='Escape')setSearch('');}}/>{search&&<button aria-label="清除搜索" onClick={()=>setSearch('')}><X size={13}/></button>}{search&&<div className="search-results">{searchResults.length?searchResults.map(reading=><button key={reading.unit.id} onClick={()=>selectCounty(reading.unit.id,true)}><MapPin size={13}/><b>{reading.unit.name}</b><span>{reading.unit.city} · {reading.unit.id}</span></button>):<p>未找到县区，试试所属市或六位区划码</p>}</div>}</div></div>
          <div className="model-coverage"><span><i/>独立气温采样：{spatialData.readyCount.toLocaleString()} / {spatialData.totalCount.toLocaleString()} 点</span><span>地形温度场 · 分级等值面</span></div>
          <div className="field-controls"><span className="field-style-label">{spatialData.field?.metadata.weatherGridStep??1}°气温采样 · {spatialData.field?.step??.1}°地形辅助</span><label className="field-points-toggle"><input type="checkbox" checked={showBoundaries} onChange={event=>setShowBoundaries(event.target.checked)}/>显示县界</label></div>
          <div className="field-source-note"><span>Open-Meteo + Terrarium DEM · {updatedAt?new Date(updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'正在读取发布快照'}</span><button aria-label="刷新格点模型" disabled={spatialData.loading} onClick={()=>void spatialData.refresh()}><RefreshCw size={11} className={spatialData.loading?'spin':''}/></button></div>
          <div className="spatial-method-note"><Info size={13}/><span>细网格与平滑边界用于表达地形差异，实际精度取决于气温采样；点选读取原始格点判定。</span></div>
          {spatialData.error&&<div className="model-data-error" role="status">{spatialData.error}</div>}
          <CountyMap readings={countyData.readings} boundaries={countyData.boundaries} selected={selectedCounty} focus={countyFocus} onSelect={selectCounty} filter={seasonFilter} region={region} layer={layer} showTransitions={overlayTransitions} showPoints={false} showBoundaries={showBoundaries} spatialMode spatialField={spatialData.field?.date===date?spatialData.field:null} spatialLayers={spatialData.field?.date===date?spatialData.layers:null} getSpatialLocation={spatialData.getLocation} onSpatialSelect={setSpatialPoint} spatialSelected={spatialPoint} spatialLoading={spatialData.loading}/>
          <div className="map-legend status-map-legend">{layer==='season'?SEASON_ORDER.map(season=><button key={season} onClick={()=>toggleSeason(season)} className={seasonFilter!==season&&seasonFilter!=='all'?'dim':''}><i style={{background:SEASONS[season].fill}}/>{SEASONS[season].name}</button>):<TemperatureLegend overlaid={false}/>}<span className="legend-divider"/><span className="missing-legend"><i/>资料不足</span></div>
          {layer==='season'&&<TransitionLegend directions={transitionDirections} enabled={showTransitions} onToggle={()=>setShowTransitions(value=>!value)}/>}
          <div className="map-footnote"><Info size={12}/><span>省域裁切 · 县界仅作定位 · 南海附图仅示位置</span><span className="map-source">模型参考</span></div>
        </section>
        <aside className="side-column"><SpatialDetail cell={spatialCell} location={location} date={date} loading={spatialData.loading}/><section className="watch-card panel"><div className="watch-heading"><h3><Radio size={16}/>县级换季参考<span>{countyTransitions.length}</span></h3><button onClick={()=>changeView('watch')} aria-label="查看全部换季县区"><ArrowRight size={16}/></button></div><p className="watch-description">按县内代表点统计，与地形格点独立计算。</p><div className="watch-list">{countyTransitions.length?countyTransitions.slice(0,3).map(reading=><button className="watch-item" style={statusVars(countyTransitionAppearance(reading))} key={reading.unit.id} onClick={()=>selectCounty(reading.unit.id,true)}><div><span className="watch-city">{reading.unit.name}<small>{reading.unit.city}</small></span><span className="watch-target"><b className={reading.forecastTransition?'forecast-text':''}>{reading.forecastTransition?'预计 '+reading.forecastTransition.expectedDate.slice(5).replace('-','/')+' '+SEASONS[reading.forecastTransition.target].verb:SEASONS[reading.state!.transition!.target].verb}</b></span></div>{reading.state?.transition?<TransitionProgress state={reading.state}/>:<span className="watch-forecast-note">预报中新发过程 · 尚待完整日确认</span>}</button>):<div className="watch-empty"><Leaf size={25}/><span>{countyData.loading?'正在读取县级统计':'当前筛选暂无换季过程'}</span></div>}</div><div className="watch-note"><Info size={12}/>代表点换季参考 · 预报预计不等于实际确认</div></section></aside>
      </div>}
      {view==='map'&&<section className="insight-strip"><span className="insight-symbol"><Compass size={23}/></span><div><b>季节的边界，由气温慢慢写下。</b><span>{date}，{SEASONS[dominant.key].name}占 {dominant.count} 个县级参考点；数量统计与地图面积分布分别展示。</span></div><button onClick={()=>setMethodOpen(true)}>了解滑标法<ArrowRight size={14}/></button></section>}
      {countyData.error&&<div className="model-data-error" role="status">{countyData.error}</div>}
      <CountyTable readings={countyData.readings} summaries={countyData.summaries} date={date} region={region} season={seasonFilter} onlyTransitions={view==='watch'} onSelect={selectCounty}/>
      <footer className="footer"><div><span className="footer-brand">四时</span><span>让季节可见，让冷暖可知。</span></div><span><span className="status-dot"/>Open-Meteo 模型数据<i/>滑标参考判定<button aria-label="查看季节判定说明" onClick={()=>setMethodOpen(true)}><CircleHelp size={13}/></button></span><span className="footer-credit">MADE FOR THE CHANGING SEASONS</span></footer>
    </main>
    {methodOpen&&<div className="modal-overlay" onClick={event=>{if(event.target===event.currentTarget)setMethodOpen(false);}}><div className="method-modal" role="dialog" aria-modal="true" aria-labelledby="method-title" ref={modalPanel}><button className="modal-close" ref={modalClose} aria-label="关闭划分标准" onClick={()=>setMethodOpen(false)}><X size={20}/></button><span className="modal-eyebrow"><BookOpen size={15}/> HOW SEASONS ARE DEFINED</span><h2 id="method-title">跟随气温，读懂四季。</h2><p className="modal-lead">参考 GB/T 42074—2022 的滑动平均阈值与连续性规则，提供季节估算和换季观察。</p><div className="method-thresholds">{SEASON_ORDER.map(season=><div key={season} style={{background:SEASONS[season].pale,color:SEASONS[season].color}}><SeasonIcon season={season}/><b>{SEASONS[season].name}</b><span>{season==='winter'?'< 10°C':season==='summer'?'≥ 22°C':'10°C ≤ T < 22°C'}</span></div>)}</div><ol className="method-steps"><li><b>发布前生成温度场与季节图</b><p>独立规则气温先归算参考高度，四邻双线性插值后按真实 DEM 高程订正，再逐格计算滑标。全国分类、县级统计和等值面均在构建时生成，页面直接加载对应日期的结果。</p></li><li><b>连续达标，观察季节的转变</b><p>当天及此前 4 天形成 5 日滑动均温；入春 ≥10°C、入夏 ≥22°C、入秋 &lt;22°C、入冬 &lt;10°C。连续达标 1–4 天为观察，第 5 天完成参考初判。缺测和日期断档会中断过程。</p></li><li><b>预报和完整日分别展示</b><p>历史日期只用已结束的完整日。当前 7 日预报另行推算预计完成日期，过期后自动撤下；切换滑动均温时只显示温度色标。</p></li><li><b>平滑边界，保留离散颜色</b><p>温度使用连续场分级等值面，季节与换季使用各自分类掩膜的平滑轮廓，不对季节编号做插值，也不做颜色归一化。显示边界是网格间的近似，点选读数保留原格点值。</p></li></ol><div className="method-caveat"><Info size={17}/><div><b>参考估算的边界</b><p>1°气温采样和 0.1°地形显示网格不等于 10 km 气温精度。固定 6.5°C/km 高差订正无法还原局地逆温、坡向等过程，未融合地面实况。尚未接入 1991–2020 常年日温、偏早二次判断和特殊气候区校正，短序列季节可能为初始估计，不能替代官方入季结论。县级统计按代表点计数，地级均温为有效代表点等权平均。历史县界可能不包含最新区划调整；台湾缺县界时只标省级归属。</p></div></div><div className="data-settings"><div><b>当前数据源</b><span>Open-Meteo + Terrarium DEM · {updatedAt??'等待发布快照'}</span></div><button onClick={()=>{refresh();setMethodOpen(false);}}>刷新发布快照<ArrowRight size={14}/></button></div><div className="method-links"><a href="https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=2CC96F656DE7E1641FEA09766A87FDD3" target="_blank" rel="noreferrer">国家标准全文<ExternalLink size={12}/></a><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo 数据说明<ExternalLink size={12}/></a><span>CC BY 4.0</span></div></div></div>}
  </div>;
}
