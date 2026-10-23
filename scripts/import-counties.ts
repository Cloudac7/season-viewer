import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {geoArea,geoCentroid,geoContains} from 'd3-geo';
import {topology} from 'topojson-server';
import {presimplify,simplify,quantile} from 'topojson-simplify';
import {quantize,feature as decode} from 'topojson-client';
import {gcjToWgs} from '../src/lib/coordinates';
import type {Feature,Geometry,FeatureCollection} from 'geojson';

const base='https://geo.datav.aliyun.com/areas_v3/bound/';
const cache=new URL('../data-sources/datav/',import.meta.url),output=new URL('../public/data/',import.meta.url);
await mkdir(cache,{recursive:true});
const sources:{file:string;sha256:string}[]=[];
async function load(file:string){
  let raw:string;
  try{raw=await readFile(new URL(file,cache),'utf8');}
  catch{
    const response=await fetch(base+file,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`${file}: HTTP ${response.status}`);
    raw=await response.text();JSON.parse(raw);await writeFile(new URL(file,cache),raw);
  }
  sources.push({file,sha256:createHash('sha256').update(raw).digest('hex')});return JSON.parse(raw);
}
// Reuse the first downloaded examples, if present.
for(const file of ['all.json','330000_full.json','330100_full.json']){
  try{await rename(new URL(file,new URL('../public/data/sources/datav/',import.meta.url)),new URL(file,cache));}catch{/* already cached */}
}
const all=await load('all.json') as {adcode:number;name:string;level:string;parent:number|null;lng:number;lat:number}[];
const lookup=new Map(all.map(node=>[node.adcode,node]));
const districts=all.filter(node=>node.level==='district');
const leafCities=all.filter(node=>node.level==='city'&&!all.some(child=>child.parent===node.adcode));
const parents=[...new Set(districts.map(node=>node.parent!))];
const shapes=new Map<number,Feature<Geometry,Record<string,any>>>();
let completed=0;
const jobs=[...parents.map(code=>({code,file:`${code}_full.json`})),...leafCities.map(node=>({code:node.adcode,file:`${node.adcode}.json`}))];
let next=0;
await Promise.all(Array.from({length:5},async()=>{
  while(next<jobs.length){
    const job=jobs[next++];
    const collection=await load(job.file) as FeatureCollection<Geometry,Record<string,any>>;
    for(const shape of collection.features)if(typeof shape.properties.adcode==='number')shapes.set(shape.properties.adcode,shape);
    completed++;if(completed%40===0||completed===jobs.length)console.log(`Boundary files ${completed}/${jobs.length}`);
  }
}));
function normalized(shape:Feature<Geometry,Record<string,any>>){
  if(geoArea(shape)>2*Math.PI){
    if(shape.geometry.type==='Polygon')shape.geometry.coordinates.forEach(ring=>ring.reverse());
    if(shape.geometry.type==='MultiPolygon')shape.geometry.coordinates.forEach(polygon=>polygon.forEach(ring=>ring.reverse()));
  }
  return shape;
}
function insidePoint(shape:Feature<Geometry,Record<string,any>>):{point:[number,number];method:string}{
  const center=shape.properties.center as [number,number]|undefined;
  if(center&&geoContains(shape,center))return {point:center,method:'县内行政中心'};
  const centroid=geoCentroid(shape) as [number,number];
  if(geoContains(shape,centroid))return {point:centroid,method:'县内几何代表点'};
  const polygons=shape.geometry.type==='Polygon'?[shape.geometry.coordinates]:shape.geometry.type==='MultiPolygon'?shape.geometry.coordinates:[];
  const candidates=polygons.sort((a,b)=>geoArea({type:'Polygon',coordinates:b})-geoArea({type:'Polygon',coordinates:a}));
  for(const polygon of candidates){
    const ys=polygon[0].map(p=>p[1]),low=Math.min(...ys),high=Math.max(...ys);
    for(let step=0;step<25;step++){
      const y=low+(high-low)*((step+1)/26),cuts:number[]=[];
      for(const ring of polygon)for(let i=0;i<ring.length-1;i++){
        const a=ring[i],b=ring[i+1];
        if((a[1]>y)!==(b[1]>y))cuts.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));
      }
      cuts.sort((a,b)=>a-b);
      const intervals=[];for(let i=0;i<cuts.length-1;i+=2)intervals.push([cuts[i],cuts[i+1]]);
      intervals.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]));
      for(const [left,right] of intervals){const point:[number,number]=[(left+right)/2,y];if(geoContains(shape,point))return {point,method:'县内边界代表点'};}
    }
  }
  throw new Error(`Cannot find an interior sample for ${shape.properties.adcode}`);
}
const regionFor=(code:number)=>[11,12,13,14,15].includes(code)?'华北':[21,22,23].includes(code)?'东北':[31,32,33,34,35,36,37].includes(code)?'华东':[41,42,43].includes(code)?'华中':[44,45,46].includes(code)?'华南':[50,51,52,53,54].includes(code)?'西南':[61,62,63,64,65].includes(code)?'西北':'港澳台';
const units=[],features:Feature<Geometry,Record<string,any>>[]=[],missing=[];
for(const node of [...districts,...leafCities].sort((a,b)=>a.adcode-b.adcode)){
  const raw=shapes.get(node.adcode);if(!raw){missing.push({id:node.adcode,name:node.name});continue;}
  const shape=normalized(structuredClone(raw));
  let province=node;
  while(province.level!=='province'&&province.parent)province=lookup.get(province.parent)!;
  const parent=lookup.get(node.parent!)!;
  const city=node.level==='city'?node:parent.level==='city'?parent:province;
  const chosen=insidePoint(shape),[lon,lat]=gcjToWgs(...chosen.point);
  const kind=[441900,442000,460400,620200].includes(node.adcode)?'undivided-city':'county';
  units.push({id:String(node.adcode),name:node.name,provinceCode:province.adcode,province:province.name,cityCode:city.adcode,city:city.name,region:regionFor(Math.floor(province.adcode/10000)),kind,display:chosen.point.map(v=>Number(v.toFixed(6))),lon,lat,pointMethod:chosen.method});
  features.push({type:'Feature',id:String(node.adcode),properties:{id:String(node.adcode)},geometry:shape.geometry});
}
if(missing.length)throw new Error(`Missing county boundaries: ${JSON.stringify(missing)}`);
const full=presimplify(topology({counties:{type:'FeatureCollection',features}},1e6));
const compact=quantize(simplify(full,quantile(full,.45)),1e5);
// Verify all display representatives are still inside their simplified county.
const decoded=decode(compact,compact.objects.counties) as FeatureCollection<Geometry,{id:string}>;
let adjusted=0;
for(const unit of units){
  const shape=decoded.features.find(feature=>feature.properties.id===unit.id)!;
  if(!geoContains(shape,unit.display)){
    const chosen=insidePoint({...shape,properties:{adcode:unit.id}});
    unit.display=chosen.point.map(v=>Number(v.toFixed(6)));[unit.lon,unit.lat]=gcjToWgs(...chosen.point);unit.pointMethod='简化县界内代表点';adjusted++;
  }
}
const metadata={version:1,source:{name:'DataV.GeoAtlas / 高德公开行政区边界',url:base,documentation:'https://help.aliyun.com/zh/datav/datav-7-0/user-guide/datav-geoatlas-widgets/',retrievedAt:new Date().toISOString(),boundaryVersion:'areas_v3（源接口未提供统一修订日期）',displayCrs:'GCJ-02',weatherCrs:'WGS84',note:'历史公开区划边界；不保证与最新行政调整一致。台湾县级边界未由此源提供，保留省域轮廓。4个无县级分区城市以城市单元展示。'},units,sources,missing,representativesAdjusted:adjusted};
await writeFile(new URL('counties.json',output),JSON.stringify(metadata));
await writeFile(new URL('counties.topo.json',output),JSON.stringify(compact));
console.log(`Saved ${units.length} administrative units; ${features.length} real boundaries; ${adjusted} interior point adjustments`);
