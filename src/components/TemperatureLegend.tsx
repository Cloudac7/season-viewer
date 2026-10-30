import {TEMPERATURE_BANDS,TEMPERATURE_LEGEND_TICKS} from '../lib/field';

export default function TemperatureLegend({overlaid}:{overlaid:boolean}){
  return <div className="weather-temperature-legend" aria-label="五日滑动均温分级色标">
    <div className="weather-scale-heading"><b>5 日滑动均温</b><span>分级色标 · °C</span></div>
    <div className="weather-temperature-bands">{TEMPERATURE_BANDS.map(band=><div key={band.label} title={band.label} aria-label={band.label}><i style={{background:band.fill}}/></div>)}</div>
    <div className="weather-temperature-axis" aria-hidden="true">{TEMPERATURE_LEGEND_TICKS.map(tick=><small key={`${tick.edge}-${tick.label}`} className={`edge-${tick.edge}`} style={{left:`${tick.position*100}%`}}>{tick.label}</small>)}</div>
    {overlaid&&<p>换季色阶优先显示，关闭“标记换季”可查看完整温度分布。</p>}
  </div>;
}
