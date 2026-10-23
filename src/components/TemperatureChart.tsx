import { useState } from 'react';
import type { SeasonState } from '../types';
import { addDays, beijingDate, rollingMeans } from '../lib/season';

export default function TemperatureChart({ state, date, input }: { state: SeasonState; date: string; input: SeasonState['history'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const start = addDays(date, -9);
  const today = beijingDate();
  const averages = rollingMeans(input);
  const points = input.map((d,i) => ({ ...d, average: averages[i] })).filter(d => d.date >= start && d.date <= addDays(date, 3));
  const values = points.flatMap(d => [d.mean, d.average]).filter((v): v is number => v !== null);
  const low = Math.floor((Math.min(8,...values) - 2) / 5) * 5;
  const high = Math.ceil((Math.max(24,...values) + 2) / 5) * 5;
  const x = (i: number) => 30 + i / Math.max(1,points.length - 1) * 460;
  const y = (v: number) => 142 - (v-low) / (high-low) * 125;
  const line = (type: 'mean' | 'average', forecast: boolean) => {
    let open = false;
    return points.map((p,i) => {
      if (p[type] === null || (forecast ? p.date < date : p.date > date)) { open = false; return ''; }
      const command = `${open ? 'L' : 'M'}${x(i)},${y(p[type]!)}`; open = true; return command;
    }).join(' ');
  };
  const currentIndex = points.findIndex(d => d.date === date);
  const focus = hover === null ? null : points[hover];
  return <div className="chart-wrap">
    <div className="chart-title"><h4>近期气温走势</h4><span>单位 °C</span></div>
    <svg viewBox="0 0 510 178" className="temperature-chart" role="img" aria-label={`${state.city.name}日均温和5日滑动均温曲线，虚线为参考日期之后的模型数据，不参与当日判定`} onMouseLeave={() => setHover(null)}>
      {[10,22].map(t => <g key={t}><line x1="30" x2="490" y1={y(t)} y2={y(t)} stroke="#dce4dd" strokeDasharray="4 4"/><text x="3" y={y(t)+3} className="axis-label">{t}°</text></g>)}
      {currentIndex >= 0 && currentIndex < points.length - 1 && <><rect x={x(currentIndex)} y="8" width={490-x(currentIndex)} height="138" fill="#f4f6f3"/><text x={x(currentIndex)+9} y="17" className="axis-label">{date<addDays(today,-1)?'后续数据':'预报'}</text></>}
      <path d={line('mean',false)} fill="none" stroke="#bac8c1" strokeWidth="2"/>
      <path d={line('average',false)} fill="none" stroke="#397864" strokeWidth="2.7"/>
      <path d={line('mean',true)} fill="none" stroke="#bac8c1" strokeWidth="2" strokeDasharray="4 4"/>
      <path d={line('average',true)} fill="none" stroke="#397864" strokeWidth="2.7" strokeDasharray="4 4"/>
      {points.map((p,i) => <g key={p.date}>
        {i % 3 === 0 && <text x={x(i)} y="167" className="axis-label" textAnchor="middle">{p.date.slice(5).replace('-','/')}</text>}
        <rect x={x(i)-15} y="10" width="30" height="138" fill="transparent" onMouseEnter={() => setHover(i)}/>
        {p.date === date && p.average !== null && <circle cx={x(i)} cy={y(p.average)} r="4.5" fill="#397864" stroke="white" strokeWidth="2"/>}
      </g>)}
      {focus && hover !== null && <><line x1={x(hover)} x2={x(hover)} y1="10" y2="145" stroke="#8a9b90" strokeDasharray="3 3"/>{focus.average !== null && <circle cx={x(hover)} cy={y(focus.average)} r="4" fill="#397864"/>}</>}
    </svg>
    {focus && <div className="chart-hover">{focus.date.slice(5)} · 日均 {focus.mean?.toFixed(1) ?? '—'}° · 滑动均温 {focus.average?.toFixed(1) ?? '—'}°{focus.date>=today?'（预报）':focus.date>date?'（后续）':''}</div>}
    <div className="chart-legend"><span><i className="daily"/>日平均气温</span><span><i/>5 日滑动平均气温</span></div>
  </div>;
}
