import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {geoArea,geoMercator,geoPath} from 'd3-geo';
import type {FeatureCollection} from 'geojson';
import {LocateFixed,Minus,Plus} from 'lucide-react';
import type {Region,Season} from '../types';
import type {CountyBoundaries,CountyReading} from '../lib/counties';
import {SEASONS} from '../data';
import {countyMapColor,countyTransitionStatus,countyTransitionAppearance} from '../lib/map-status';

interface Props{readings:CountyReading[];boundaries:CountyBoundaries|null;selected:string;focus:{id:string;revision:number}|null;onSelect:(id:string,locate?:boolean)=>void;filter:Season|'all';region:Region|'all';layer:'season'|'temperature';showTransitions:boolean;showPoints:boolean;showBoundaries:boolean}
export default function CountyMap({readings,boundaries,selected,focus,onSelect,filter,region,layer,showTransitions,showPoints,showBoundaries=false}:Props){
  const [provinces,setProvinces]=useState<FeatureCollection|null>(null);
  const [view,setView]=useState({zoom:1,x:0,y:0}),[hover,setHover]=useState<{reading:CountyReading;x:number;y:number}|null>(null);
  const [width,setWidth]=useState(840);
  const svg=useRef<SVGSVGElement>(null),gesture=useRef<{x:number;y:number;ox:number;oy:number;id:string|null;moved:boolean}|null>(null);
  const id=useId().replaceAll(':','');
  const projection=useMemo(()=>geoMercator().center([104.5,36.5]).scale(610).translate([420,271]),[]);
  const path=useMemo(()=>geoPath(projection),[projection]);
  const seaPath=useMemo(()=>geoPath(geoMercator().center([113,10]).scale(230).translate([40,42])),[]);
  const indexed=useMemo(()=>new Map(readings.map(reading=>[reading.unit.id,reading])),[readings]);
  const shapes=useMemo(()=>boundaries?.features.map(feature=>({id:feature.properties.id,d:path(feature)??'',bounds:path.bounds(feature)}))??[],[boundaries,path]);
  const shapeById=useMemo(()=>new Map(shapes.map(shape=>[shape.id,shape])),[shapes]);
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/data/china.json',{signal:controller.signal}).then(r=>r.json() as Promise<FeatureCollection>).then(data=>{
      data.features.forEach(feature=>{if(geoArea(feature)<=2*Math.PI)return;if(feature.geometry.type==='Polygon')feature.geometry.coordinates.forEach(ring=>ring.reverse());if(feature.geometry.type==='MultiPolygon')feature.geometry.coordinates.forEach(polygon=>polygon.forEach(ring=>ring.reverse()));});setProvinces(data);
    }).catch(()=>{});return()=>controller.abort();
  },[]);
  useEffect(()=>{const target=svg.current;if(!target)return;const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width||840));observer.observe(target);return()=>observer.disconnect();},[boundaries]);
  useEffect(()=>{
    if(!focus)return;const shape=shapeById.get(focus.id);if(!shape)return;
    const [[left,top],[right,bottom]]=shape.bounds;
    const zoom=Math.min(48,Math.max(3,Math.min(550/Math.max(1,right-left),360/Math.max(1,bottom-top))));
    setView({zoom,x:(420-(left+right)/2)*zoom,y:(275-(top+bottom)/2)*zoom});setHover(null);
  },[focus,shapeById]);
  const changeZoom=(scale:number)=>{setView(v=>({...v,zoom:Math.max(.9,Math.min(64,v.zoom*scale))}));setHover(null);};
  const visible=useMemo(()=>shapes.filter(shape=>{
    const [[left,top],[right,bottom]]=shape.bounds;
    return (right-420)*view.zoom+420+view.x>=0&&(left-420)*view.zoom+420+view.x<=840&&(bottom-275)*view.zoom+275+view.y>=0&&(top-275)*view.zoom+275+view.y<=550;
  }),[shapes,view]);
  const current=indexed.get(selected),active=shapeById.get(selected);
  const label=current?projection(current.unit.display):null;
  if(!boundaries)return <div className="map-loading">正在载入真实县级边界…</div>;
  return <div className={`map-canvas field-canvas county-map-canvas county-borders-${showBoundaries?'visible':'hidden'}`} data-county-borders={showBoundaries?'visible':'hidden'} onMouseLeave={()=>setHover(null)}>
    <div className="map-watermark">COUNTY SEASONS<br/><span>OPEN-METEO · DAILY MODEL</span></div>
    <svg ref={svg} className="china-map field-map-svg county-map-svg" viewBox="0 0 840 550" role="img" tabIndex={0} aria-label={`全国真实县界季节地图，${readings.length}个行政单元，点击县区查看代表点数据，拖动平移`}
      onKeyDown={e=>{if(e.key==='+'||e.key==='='){e.preventDefault();changeZoom(1.4);}if(e.key==='-'){e.preventDefault();changeZoom(1/1.4);}if(e.key==='0')setView({zoom:1,x:0,y:0});if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setView(v=>({...v,x:v.x+(e.key==='ArrowLeft'?60:e.key==='ArrowRight'?-60:0),y:v.y+(e.key==='ArrowUp'?60:e.key==='ArrowDown'?-60:0)}));}}}
      onDoubleClick={e=>{e.preventDefault();changeZoom(1.6);}}
      onPointerDown={e=>{if(e.button!==0)return;gesture.current={x:e.clientX,y:e.clientY,ox:view.x,oy:view.y,id:(e.target as SVGElement).getAttribute('data-county'),moved:false};e.currentTarget.setPointerCapture(e.pointerId);setHover(null);}}
      onPointerMove={e=>{
        const drag=gesture.current;
        if(drag){const rect=e.currentTarget.getBoundingClientRect(),dx=(e.clientX-drag.x)*840/rect.width,dy=(e.clientY-drag.y)*550/rect.height;if(Math.abs(dx)+Math.abs(dy)>3){drag.moved=true;setView(v=>({...v,x:drag.ox+dx,y:drag.oy+dy}));}return;}
        const county=(e.target as SVGElement).getAttribute('data-county'),reading=county?indexed.get(county):null;
        setHover(reading?{reading,x:e.clientX,y:e.clientY}:null);
      }}
      onPointerUp={e=>{const drag=gesture.current;gesture.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);if(drag?.id&&!drag.moved)onSelect(drag.id);}}
      onPointerCancel={()=>{gesture.current=null;}}>
      <defs><clipPath id={`${id}-sea`}><rect x="2" y="2" width="75" height="80"/></clipPath></defs>
      <g className="county-map-transform" transform={`translate(${420+view.x} ${275+view.y}) scale(${view.zoom}) translate(-420 -275)`}>
        {provinces?.features.map((feature,i)=><path key={i} d={path(feature)??''} fill="#e0e6e2" stroke="#667786" strokeOpacity={.4} strokeWidth={.5/view.zoom} pointerEvents="none"/>)}
        {visible.map(shape=>{
          const reading=indexed.get(shape.id);if(!reading)return null;
          const muted=(region!=='all'&&reading.unit.region!==region)||(filter!=='all'&&reading.state?.season!==filter);
          const fill=countyMapColor(reading,layer,showTransitions);
          return <g key={shape.id} opacity={muted?.2:1} className="county-area" data-season={reading.state?.season??'missing'} data-transition={countyTransitionStatus(reading)}>
            <path data-county={shape.id} d={shape.d} fill={fill} stroke={showBoundaries?'rgba(248,250,245,.62)':fill} strokeWidth={(showBoundaries ? .4 : .35)/view.zoom} className="county-shape"/>
          </g>;
        })}
        {provinces?.features.map((feature,i)=><path key={i} d={path(feature)??''} fill="none" stroke="#667786" strokeOpacity={.4} strokeWidth={.5/view.zoom} pointerEvents="none"/>)}
        {active&&<path d={active.d} fill="none" stroke="#315e48" strokeWidth={1.5/view.zoom} pointerEvents="none"/>}
        {view.zoom<=2&&provinces?.features.filter(feature=>typeof feature.properties?.adcode==='number'&&Number(feature.properties.adcode)<810000).map(feature=>{
          const center=feature.properties?.centroid??feature.properties?.center;if(!center)return null;const xy=projection(center);if(!xy)return null;
          return <text key={feature.properties?.adcode} x={xy[0]} y={xy[1]} className="province-label field-province-label">{String(feature.properties?.name).replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|省|市/g,'')}</text>;
        })}
        {showPoints&&visible.map(shape=>{const reading=indexed.get(shape.id);const xy=reading?projection(reading.unit.display):null;return xy?<circle key={shape.id} cx={xy[0]} cy={xy[1]} r={1.8/view.zoom} fill="#365c48" stroke="#fff" strokeWidth={.6/view.zoom} pointerEvents="none"/>:null;})}
        {view.zoom>=3&&label&&current&&<text x={label[0]} y={label[1]-8/view.zoom} className="county-selected-label" fontSize={11*840/width/view.zoom} pointerEvents="none">{current.unit.name}</text>}
      </g>
      <g transform="translate(36,455)" className="compass"><path d="M0 34V0m-5 8L0 0l5 8"/><text x="0" y="-9">N</text></g>
      <g transform="translate(728,424)"><rect width="79" height="102" rx="3" fill="#f8faf8" stroke="#dce4de"/><g clipPath={`url(#${id}-sea)`}>{provinces?.features.filter(f=>f.properties?.adcode===460000||f.properties?.adcode==='100000_JD').map((f,i)=><path key={i} d={seaPath(f)??''} fill="#d5dfd3" stroke="#667786" strokeOpacity={.4} strokeWidth=".5"/>)}{boundaries.features.filter(f=>f.properties.id==='460300').map(f=>{const reading=indexed.get('460300'),fill=reading?countyMapColor(reading,layer,showTransitions):'#e0e6e2';return <path key="sansha-counties" d={seaPath(f)??''} fill={fill} stroke={showBoundaries?'rgba(248,250,245,.62)':fill} strokeWidth={showBoundaries ? .4 : .35} pointerEvents="none"/>;})}</g><text x="39.5" y="92" className="inset-label">南海诸岛</text></g>
    </svg>
    <div className="field-map-caption"><i/>{view.zoom.toFixed(1)}× · 真实县界 · 代表点参考季节</div>
    <div className="map-controls field-map-controls"><button onClick={()=>changeZoom(1.4)} aria-label="放大县级地图"><Plus size={17}/></button><button onClick={()=>changeZoom(1/1.4)} aria-label="缩小县级地图"><Minus size={17}/></button><span/><button onClick={()=>setView({zoom:1,x:0,y:0})} aria-label="重置县级地图"><LocateFixed size={17}/></button></div>
    {hover&&<div className="map-tooltip county-tooltip" style={{left:Math.min(hover.x+15,window.innerWidth-245),top:Math.min(hover.y+15,window.innerHeight-170)}}><div><strong>{hover.reading.unit.name}</strong><span>{hover.reading.state?SEASONS[hover.reading.state.season].name:'数据不足'}</span></div><small>{hover.reading.unit.province} · {hover.reading.unit.city} · {hover.reading.unit.id}</small><p>代表点 5 日均温 <b>{hover.reading.state?.average?.toFixed(1)??'—'}°C</b></p><small className={hover.reading.forecastTransition?'forecast-tooltip':''} style={{color:countyTransitionAppearance(hover.reading)?.color}}>{hover.reading.forecastTransition?`预计 ${hover.reading.forecastTransition.expectedDate.slice(5).replace('-','/')} 完成${SEASONS[hover.reading.forecastTransition.target].verb} · 尚待完整日确认`:hover.reading.state?.transition?`${SEASONS[hover.reading.state.transition.target].verb}进行中 · ${hover.reading.state.transition.days}/5 天`:'点击查看县区详情与日温曲线'}</small><footer>Open-Meteo 模型 · 非全县实测或全县均温</footer></div>}
  </div>;
}
