import {Crosshair,Info,MapPin,Check} from 'lucide-react';
import type {CSSProperties} from 'react';
import type {CountyReading} from '../lib/counties';
import {countyHistoricalDays} from '../lib/counties';
import {forecastIsFresh} from '../lib/forecast';
import {transitionAppearance} from '../lib/map-status';
import {SEASONS} from '../data';
import SeasonIcon from './SeasonIcon';
import TemperatureChart from './TemperatureChart';

export default function CountyDetail({reading,date,onLocate}:{reading:CountyReading|null;date:string;onLocate:(id:string)=>void}){
  if(!reading)return <section className="panel county-detail"><p>正在载入县区信息…</p></section>;
  const {unit,state,series,forecastTransition}=reading,season=state?SEASONS[state.season]:null;
  const pendingAppearance=state?transitionAppearance(state):null,forecastAppearance=state&&forecastTransition?transitionAppearance(state,forecastTransition):null;
  const statusStyle=(appearance:NonNullable<typeof pendingAppearance>):CSSProperties=>({'--status-fill':appearance.fill,'--status-color':appearance.color,'--status-pale':appearance.pale,backgroundColor:appearance.pale,color:appearance.color,borderColor:appearance.fill} as CSSProperties);
  const chartInput=series?[...countyHistoricalDays(series),...(forecastIsFresh(series.forecast)?series.forecast!.days:[])]:[];
  return <section className="panel city-card county-detail">
    <div className="city-top"><div><span className="tiny-label">县级代表点 · OPEN-METEO</span><h3><MapPin size={18}/>{unit.name}</h3><p className="county-breadcrumb">{unit.province}{unit.city!==unit.province?` · ${unit.city}`:''} · {unit.id}</p></div><button className="county-locate" onClick={()=>onLocate(unit.id)} aria-label={`定位${unit.name}`}><Crosshair size={17}/></button></div>
    {state&&season?<>
      <div className="city-season" style={{background:season.pale,color:season.color}}><span className="city-season-symbol"><SeasonIcon season={state.season} size={42}/></span><div><small>代表点参考季节</small><strong>{season.name}</strong></div><span className="city-season-note">{state.since?<><b>{state.since.slice(5).replace('-','月')}日</b>参考{season.verb}日</>:<>短序列初始估计<br/>待历史积累校正</>}</span></div>
      <div className="city-temperatures"><div><span>5 日滑动平均气温</span><strong>{state.average?.toFixed(1)}<small>°C</small></strong></div><div><span>当日日平均气温</span><strong>{state.temperature?.toFixed(1)}<small>°C</small></strong></div></div>
      {forecastTransition&&forecastAppearance&&<div className="forecast-completion" style={statusStyle(forecastAppearance)}><div><span className="transition-swatch forecast" style={{backgroundColor:forecastAppearance.fill}}/><b>预报预计完成{SEASONS[forecastTransition.target].verb}</b><strong>{forecastTransition.expectedDate.slice(5).replace('-','/')}</strong></div><p>当前仍为{season.name}，按本次 7 日预报推算；等待完整日温确认。</p><small>预报获取：{new Date(forecastTransition.issuedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})} · 预计第 5 个滑标达标日</small></div>}
      {state.transition&&pendingAppearance?<div className="city-transition" style={statusStyle(pendingAppearance)}><div><span className="status-dot pending" style={{backgroundColor:pendingAppearance.fill}}/><b>{SEASONS[state.transition.target].verb}进行中</b><span>{state.transition.days} / 5 天</span></div><div className="progress-row"><div className="progress-steps">{[1,2,3,4,5].map(day=><span key={day} className={day<=state.transition!.days?'complete':''} style={day<=state.transition!.days?{backgroundColor:pendingAppearance.fill}:undefined}/>)}</div><span>完整日已达标</span></div></div>:<div className="city-stable"><Check size={14}/>{forecastTransition?'预报中的换季过程尚待发生':'暂无新的连续换季过程'}<span>{state.estimated?'初始估计':'5 天参考确认'}</span></div>}
      <TemperatureChart state={state} date={date} input={chartInput}/>
    </>:<div className="county-empty"><Info size={22}/><b>{reading.status==='missing'?'该日县级数据尚未覆盖':reading.status==='stale'?'缺少所选日期日温':'连续日温不足 9 天'}</b><span>县界保留灰色，等待该代表点模型数据完整后判定。</span></div>}
    <div className="county-point-info"><span>{unit.pointMethod} · WGS84</span><b>{unit.lon.toFixed(4)}°E，{unit.lat.toFixed(4)}°N</b><small>{unit.kind==='undivided-city'?'该城市无下辖县级分区，按独立城市单元展示。':'该点的季节沿县界展示，不表示全县气候一致。'}</small><small>模型更新：{series?new Date(series.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待同步'}</small></div>
  </section>;
}
