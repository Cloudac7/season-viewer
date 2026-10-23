import { useEffect, useMemo, useState } from 'react';
import { geoArea, geoGraticule10, geoMercator, geoPath } from 'd3-geo';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import { LocateFixed, Minus, Plus, RotateCcw } from 'lucide-react';
import type { Season, SeasonState } from '../types';
import { SEASONS } from '../data';

interface Props { states: SeasonState[]; selected: string; onSelect: (id: string) => void; filter: Season | 'all'; showTransitions: boolean; layer: 'season' | 'temperature' }
type Province = Feature<Geometry, { name: string; adcode: number | string; centroid?: [number, number]; center?: [number, number] }>;
const labels: Record<string, [number, number, string]> = {
  '110000':[116.4,40.5,'北京'], '120000':[118.3,39,'天津'], '130000':[115,38.1,'河北'],
  '140000':[112.1,37.4,'山西'], '150000':[113.5,44,'内蒙古'], '210000':[123,41.6,'辽宁'],
  '220000':[126.2,43.6,'吉林'], '230000':[128,47.6,'黑龙江'], '310000':[122,31.1,'上海'],
  '320000':[119.1,33.4,'江苏'], '330000':[120.3,29,'浙江'], '340000':[117,31.5,'安徽'],
  '350000':[118,26,'福建'], '360000':[115.5,27.3,'江西'], '370000':[118.4,36.5,'山东'],
  '410000':[113.3,33.7,'河南'], '420000':[112.2,30.9,'湖北'], '430000':[111.6,27.5,'湖南'],
  '440000':[113.4,23.7,'广东'], '450000':[108.3,23.8,'广西'], '460000':[109.5,19.1,'海南'],
  '500000':[107.8,29.9,'重庆'], '510000':[102.9,30.4,'四川'], '520000':[106.5,26.8,'贵州'],
  '530000':[101.1,24.5,'云南'], '540000':[88.4,31.5,'西藏'], '610000':[108.8,35.6,'陕西'],
  '620000':[102.8,37.7,'甘肃'], '630000':[96.3,35.6,'青海'], '640000':[106.1,37.3,'宁夏'],
  '650000':[85,41.8,'新疆'], '710000':[121.3,23.5,'台湾'], '810000':[115.3,21.9,'香港'], '820000':[112.6,21.3,'澳门'],
};
function temperatureColor(temp: number) {
  if (temp < 5) return '#9bb8cf'; if (temp < 10) return '#b4cad9';
  if (temp < 15) return '#c7d6c4'; if (temp < 20) return '#dbcfa6';
  if (temp < 25) return '#e3b981'; return '#d99a78';
}
export default function ChinaMap({ states, selected, onSelect, filter, showTransitions, layer }: Props) {
  const [geo, setGeo] = useState<FeatureCollection | null>(null);
  const [mapError, setMapError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<{ state: SeasonState; x: number; y: number } | null>(null);
  useEffect(() => { fetch('/data/china.json').then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<FeatureCollection>; }).then(data => {
    // DataV follows RFC 7946 ring winding; d3-geo expects the opposite winding
    // for polygons smaller than a hemisphere. Preserve holes by reversing all rings.
    data.features.forEach(feature => {
      if (geoArea(feature) <= 2 * Math.PI) return;
      if (feature.geometry.type === 'Polygon') feature.geometry.coordinates.forEach(ring => ring.reverse());
      if (feature.geometry.type === 'MultiPolygon') feature.geometry.coordinates.forEach(polygon => polygon.forEach(ring => ring.reverse()));
    });
    setGeo(data);
  }).catch(() => setMapError(true)); }, []);
  const projection = useMemo(() => geoMercator().center([104.5, 36.5]).scale(610).translate([420, 271]), []);
  const path = useMemo(() => geoPath(projection), [projection]);
  const seaPath = useMemo(() => geoPath(geoMercator().center([113,10]).scale(230).translate([40,42])), []);
  const provincial = useMemo(() => {
    const map = new Map<number, SeasonState[]>();
    states.forEach(s => map.set(s.city.code, [...(map.get(s.city.code) ?? []), s]));
    return map;
  }, [states]);
  if (mapError) return <div className="map-loading">地图载入失败，请刷新页面重试。</div>;
  if (!geo) return <div className="map-loading"><span className="loading-dot"/>正在展开中国地图…</div>;
  return <div className="map-canvas" onMouseLeave={() => setHover(null)}>
    <div className="map-watermark">CHINA<br/><span>SEASON ATLAS</span></div>
    <div className="map-scale"><span>全国视图</span><i/>代表城市滑标估算</div>
    <svg className="china-map" viewBox="0 0 840 550" role="img" aria-label="全国季节分布交互地图，省域颜色由代表城市多数季节确定">
      <defs><pattern id="transition-stripes" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="2" height="7" fill="#ffffff" opacity=".55"/></pattern><filter id="map-shadow"><feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#516456" floodOpacity=".07"/></filter><clipPath id="sea-clip"><rect x="2" y="2" width="75" height="80"/></clipPath></defs>
      <g transform={`translate(420 260) scale(${zoom}) translate(-420 -260)`}>
        <path d={path(geoGraticule10()) ?? ''} className="graticule"/>
        <g filter="url(#map-shadow)">
          {(geo.features as Province[]).filter(f => typeof f.properties.adcode === 'number').map(feature => {
            const group = provincial.get(Number(feature.properties.adcode)) ?? [];
            const counts = group.reduce((all, s) => ({ ...all, [s.season]: (all[s.season] ?? 0) + 1 }), {} as Record<Season, number>);
            const main = group.length ? [...group].sort((a,b) => (counts[b.season] ?? 0) - (counts[a.season] ?? 0))[0] : null;
            const valid = group.filter(s => s.average !== null);
            const average = valid.length ? valid.reduce((sum,s) => sum + s.average!, 0) / valid.length : null;
            const muted = filter !== 'all' && !group.some(s => s.season === filter);
            const fill = main && average !== null ? layer === 'temperature' ? temperatureColor(average) : SEASONS[main.season].fill : '#e1e6e3';
            const state = group.find(s => s.city.id === selected) ?? main;
            const active = group.some(s => s.city.id === selected);
            return <g key={feature.properties.adcode} opacity={muted ? .22 : 1}>
              <path d={path(feature) ?? ''} fill={fill} className={`province ${active ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`${feature.properties.name}，${main ? SEASONS[main.season].name : '暂无数据'}，点击查看代表城市`}
                onClick={() => state && onSelect(state.city.id)} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && state) { e.preventDefault(); onSelect(state.city.id); } }}
                onMouseMove={e => state && setHover({ state, x: e.clientX, y: e.clientY })}/>
              {showTransitions && group.some(s => s.transition) && <path d={path(feature) ?? ''} fill="url(#transition-stripes)" pointerEvents="none"/>}
            </g>;
          })}
          {(geo.features as Province[]).filter(f => f.properties.adcode === '100000_JD').map(f => <path key="islands-boundary" d={path(f) ?? ''} className="island-line"/>)}
        </g>
        {Object.entries(labels).map(([code, [lon, lat, name]]) => {
          const xy = projection([lon,lat]); if (!xy) return null;
          const state = provincial.get(Number(code))?.[0];
          return <text key={code} x={xy[0]} y={xy[1]} className={`province-label ${Number(code) >= 810000 ? 'small' : ''}`} onClick={() => state && onSelect(state.city.id)}>{name}</text>;
        })}
        {states.filter(s => showTransitions && s.transition || s.city.id === selected).map(s => {
          const xy = projection([s.city.lon,s.city.lat]); if (!xy) return null;
          const active = selected === s.city.id;
          return <g key={s.city.id} className="city-marker" onClick={() => onSelect(s.city.id)} onMouseMove={e => setHover({ state: s, x: e.clientX, y: e.clientY })}>
            <circle cx={xy[0]} cy={xy[1]} r={active ? 12 : 8} fill={active ? '#245c4c' : '#a77743'} opacity=".15"/>
            <circle cx={xy[0]} cy={xy[1]} r={active ? 5 : 3.4} fill={active ? '#245c4c' : '#a77743'} stroke="white" strokeWidth="1.7"/>
          </g>;
        })}
      </g>
      <g transform="translate(36,455)" className="compass"><path d="M0 34V0m-5 8L0 0l5 8"/><text x="0" y="-9">N</text></g>
      <g transform="translate(728,424)"><rect width="79" height="102" rx="3" fill="#f8faf8" stroke="#dce4de"/><g clipPath="url(#sea-clip)">{(geo.features as Province[]).filter(f=>f.properties.adcode===460000||f.properties.adcode==='100000_JD').map(f=><path key={f.properties.adcode} d={seaPath(f)??''} fill="#c4d1c4" stroke="#a5b7a5" strokeWidth=".5"/>)}</g><text x="39.5" y="92" className="inset-label">南海诸岛</text></g>
    </svg>
    <div className="map-controls"><button onClick={() => setZoom(z => Math.min(1.7,z + .15))} aria-label="放大地图"><Plus size={17}/></button><button onClick={() => setZoom(z => Math.max(.85,z - .15))} aria-label="缩小地图"><Minus size={17}/></button><span/><button onClick={() => setZoom(1)} aria-label="重置地图"><LocateFixed size={17}/></button></div>
    {zoom !== 1 && <button className="reset-map" onClick={() => setZoom(1)}><RotateCcw size={12}/>重置视图</button>}
    {hover && <div className="map-tooltip" style={{ left: Math.min(hover.x + 15, window.innerWidth - 225), top: Math.min(hover.y + 15, window.innerHeight - 115) }}><div><strong>{hover.state.city.name}</strong><span style={{ color: SEASONS[hover.state.season].color }}>{SEASONS[hover.state.season].name}</span></div><p>5 日滑动均温 <b>{hover.state.average?.toFixed(1) ?? '—'}°C</b></p><small>{hover.state.transition ? `${SEASONS[hover.state.transition.target].verb}观察中 · ${hover.state.transition.days}/5 天` : '点击查看气温与季节详情'}</small></div>}
  </div>;
}
