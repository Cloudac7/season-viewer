import {SEASONS} from '../data';
import type {Season} from '../types';
import {transitionColors} from '../lib/map-status';

export interface TransitionDirection {from:Season;target:Season}
export default function TransitionLegend({directions,enabled,onToggle}:{directions:TransitionDirection[];enabled:boolean;onToggle:()=>void}){
  const unique=new Map<string,TransitionDirection&{count:number}>();
  directions.forEach(direction=>{const key=`${direction.from}-${direction.target}`;unique.set(key,{...direction,count:(unique.get(key)?.count??0)+1});});
  const visible=[...unique.values()].sort((a,b)=>b.count-a.count);
  return <section className={`transition-direction-legend ${enabled?'':'disabled'}`} aria-label="按换季方向的颜色图例">
    <div className="transition-legend-heading"><span>换季色阶 <small>当前季节 → 目标季节</small></span><button className="transition-legend" onClick={onToggle} aria-pressed={enabled}><span className={`switch ${enabled?'on':''}`}><i/></span>标记换季</button></div>
    <div className="transition-palette-grid">{visible.map(({from,target})=>{
      const colors=transitionColors(from,target);
      return <div className="transition-palette-item" key={`${from}-${target}`}><b>{SEASONS[from].name.slice(0,1)} → {SEASONS[target].name.slice(0,1)}</b><span><i style={{background:colors.pending.fill}}/>正在换季</span><span><i style={{background:colors.forecast.fill}}/>预计完成换季</span></div>;
    })}</div>
    {!visible.length&&<p className="transition-legend-empty">当前范围暂无换季信号，出现时显示对应方向色阶。</p>}
  </section>;
}
