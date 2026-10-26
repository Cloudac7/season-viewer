import { Check, Grid3X3, Info, LoaderCircle, Mountain } from 'lucide-react';
import type { CSSProperties } from 'react';
import { SEASONS } from '../data';
import { forecastIsFresh } from '../lib/forecast';
import { transitionAppearance } from '../lib/map-status';
import type { GridLocation } from '../lib/grid-location';
import type { SpatialCell } from '../lib/spatial-field';
import SeasonIcon from './SeasonIcon';
import TemperatureChart from './TemperatureChart';

export interface SpatialDetailProps { cell: SpatialCell | null; date: string; loading: boolean; location?: GridLocation | null }

export default function SpatialDetail({ cell, date, loading, location }: SpatialDetailProps) {
  const state = cell?.state ?? null, season = state ? SEASONS[state.season] : null;
  const forecast = cell?.forecastTransition ?? null;
  const pendingAppearance = state ? transitionAppearance(state) : null;
  const forecastAppearance = state && forecast ? transitionAppearance(state, forecast) : null;
  const statusStyle = (appearance: NonNullable<typeof pendingAppearance>): CSSProperties => ({
    '--status-fill': appearance.fill, '--status-color': appearance.color, '--status-pale': appearance.pale,
    backgroundColor: appearance.pale, color: appearance.color, borderColor: appearance.fill,
  } as CSSProperties);
  const chartInput = cell ? [...cell.days, ...(forecastIsFresh(cell.forecast) ? cell.forecast!.days : [])] : [];
  return <section className="panel city-card county-detail spatial-detail" aria-busy={loading}>
    <div className="city-top"><div><span className="tiny-label">气温格点场 · OPEN-METEO + DEM</span><h3><Grid3X3 size={18}/>{location?.title ?? (cell ? '行政区划资料未覆盖' : '选择地图位置')}</h3><p className="county-breadcrumb">{cell ? `${cell.longitude.toFixed(2)}°E · ${cell.latitude.toFixed(2)}°N · WGS84 · 格点估算${location?.kind === 'province' ? ' · 省级定位' : ''}` : '点击地图查看当地的季节与日温'}</p></div></div>
    {loading && <p className="spatial-detail-loading" role="status"><LoaderCircle size={14}/>正在载入气温图…</p>}
    {cell && state && season ? <>
      <div className="city-season" style={{ background: season.pale, color: season.color }}><span className="city-season-symbol"><SeasonIcon season={state.season} size={42}/></span><div><small>格点参考季节</small><strong>{season.name}</strong></div><span className="city-season-note">{state.since ? <><b>{state.since.slice(5).replace('-', '月')}日</b>参考{season.verb}日</> : <>短序列初始估计<br/>待历史积累校正</>}</span></div>
      <div className="city-temperatures"><div><span>5 日滑动平均气温</span><strong>{state.average?.toFixed(1)}<small>°C</small></strong></div><div><span>当日日平均气温</span><strong>{state.temperature?.toFixed(1)}<small>°C</small></strong></div></div>
      {forecast && forecastAppearance && <div className="forecast-completion" style={statusStyle(forecastAppearance)}><div><span className="transition-swatch forecast" style={{ backgroundColor: forecastAppearance.fill }}/><b>预报预计完成{SEASONS[forecast.target].verb}</b><strong>{forecast.expectedDate.slice(5).replace('-', '/')}</strong></div><p>当前仍为{season.name}，按本次 7 日格点预报推算；等待完整日温确认。</p><small>预报获取：{new Date(forecast.issuedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} · 预计第 5 个滑标达标日</small></div>}
      {state.transition && pendingAppearance ? <div className="city-transition" style={statusStyle(pendingAppearance)}><div><span className="status-dot pending" style={{ backgroundColor: pendingAppearance.fill }}/><b>{SEASONS[state.transition.target].verb}进行中</b><span>{state.transition.days} / 5 天</span></div><div className="progress-row"><div className="progress-steps">{[1, 2, 3, 4, 5].map(day => <span key={day} className={day <= state.transition!.days ? 'complete' : ''} style={day <= state.transition!.days ? { backgroundColor: pendingAppearance.fill } : undefined}/>)}</div><span>完整日已达标</span></div></div> : <div className="city-stable"><Check size={14}/>{forecast ? '预报中的换季过程尚待发生' : '暂无新的连续换季过程'}<span>{state.estimated ? '初始估计' : '5 天参考确认'}</span></div>}
      <TemperatureChart state={state} date={date} input={chartInput}/>
    </> : <div className="county-empty"><Info size={22}/><b>{!cell ? loading ? '正在准备全国格点数据' : '选择地图上的一个位置' : cell.status === 'stale' ? '缺少所选日期完整日温' : cell.status === 'insufficient' ? '连续完整日温不足 9 天' : '该位置天气格点数据缺失'}</b><span>{cell ? '四邻格点或完整日温不足时保留空白，等待数据补全。' : '地图按逐日气温与真实地形计算，季节边界无需沿县界延伸。'}</span></div>}
    <div className="county-point-info"><span><Mountain size={13}/> 地形订正模型估算 · {date}</span>{cell && <b>DEM 平均高程 {Math.round(cell.elevation).toLocaleString('zh-CN')} m</b>}<small>日温先归算参考高度，再空间插值并按当地 DEM 高程订正；结果为格点估算，非地面实测或县域均温。</small><small>0.1° 为显示采样间距，实际气温精度取决于原始天气模型及地形订正。</small>{cell && <small>天气更新：{new Date(cell.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</small>}</div>
  </section>;
}
