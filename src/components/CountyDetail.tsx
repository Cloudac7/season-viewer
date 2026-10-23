import {Crosshair,Info,MapPin,Check} from 'lucide-react';
import type {CountyReading} from '../lib/counties';
import {SEASONS} from '../data';
import SeasonIcon from './SeasonIcon';
import TemperatureChart from './TemperatureChart';

export default function CountyDetail({reading,date,onLocate}:{reading:CountyReading|null;date:string;onLocate:(id:string)=>void}){
  if(!reading)return <section className="panel county-detail"><p>正在载入县区信息…</p></section>;
  const {unit,state,series}=reading,season=state?SEASONS[state.season]:null;
  return <section className="panel city-card county-detail">
    <div className="city-top"><div><span className="tiny-label">县级代表点 · OPEN-METEO</span><h3><MapPin size={18}/>{unit.name}</h3><p className="county-breadcrumb">{unit.province}{unit.city!==unit.province?` · ${unit.city}`:''} · {unit.id}</p></div><button className="county-locate" onClick={()=>onLocate(unit.id)} aria-label={`定位${unit.name}`}><Crosshair size={17}/></button></div>
    {state&&season?<>
      <div className="city-season" style={{background:season.pale,color:season.color}}><span className="city-season-symbol"><SeasonIcon season={state.season} size={42}/></span><div><small>代表点参考季节</small><strong>{season.name}</strong></div><span className="city-season-note">{state.since?<><b>{state.since.slice(5).replace('-','月')}日</b>参考{season.verb}日</>:<>短序列初始估计<br/>待历史积累校正</>}</span></div>
      <div className="city-temperatures"><div><span>5 日滑动平均气温</span><strong>{state.average?.toFixed(1)}<small>°C</small></strong></div><div><span>当日日平均气温</span><strong>{state.temperature?.toFixed(1)}<small>°C</small></strong></div></div>
      {state.transition?<div className="city-transition"><div><span className="status-dot amber"/><b>{SEASONS[state.transition.target].verb}观察中</b><span>{state.transition.days} / 5 天</span></div><div className="progress-row"><div className="progress-steps">{[1,2,3,4,5].map(day=><span key={day} className={day<=state.transition!.days?'complete':''}/>)}</div><span>待持续确认</span></div></div>:<div className="city-stable"><Check size={14}/>暂无新的连续换季过程<span>{state.estimated?'初始估计':'5 天参考确认'}</span></div>}
      <TemperatureChart state={state} date={date} input={series?.days??[]}/>
    </>:<div className="county-empty"><Info size={22}/><b>{reading.status==='missing'?'该日县级数据尚未覆盖':reading.status==='stale'?'缺少所选日期日温':'连续日温不足 9 天'}</b><span>县界保留灰色，等待该代表点模型数据完整后判定。</span></div>}
    <div className="county-point-info"><span>{unit.pointMethod} · WGS84</span><b>{unit.lon.toFixed(4)}°E，{unit.lat.toFixed(4)}°N</b><small>{unit.kind==='undivided-city'?'该城市无下辖县级分区，按独立城市单元展示。':'该点的季节沿县界展示，不表示全县气候一致。'}</small><small>模型更新：{series?new Date(series.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待同步'}</small></div>
  </section>;
}
