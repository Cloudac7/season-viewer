import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {FeatureCollection,Geometry,Position} from 'geojson';
import type {WeatherGridCatalog,WeatherGridNode} from '../src/lib/spatial-grid';
import {validGridCatalog} from '../src/lib/spatial-grid';
import {gcjToWgs} from '../src/lib/coordinates';

const output=new URL('../public/data/',import.meta.url);
const raw=await readFile(new URL('china.json',output),'utf8');
const boundaries=JSON.parse(raw) as FeatureCollection<Geometry,{adcode?:number;name?:string}>;
const arguments_=process.argv.slice(2),stepOption=arguments_.find(value=>value.startsWith('--step='))?.split('=')[1]??(arguments_.includes('--step')?arguments_[arguments_.indexOf('--step')+1]:undefined);
const step=stepOption===undefined?1:Number(stepOption);
if(step!==1&&step!==.5)throw new Error('Supported grid steps: --step=1 (default) or --step=0.5');
const origin:[number,number]=[73,18],rows=Math.round((54-origin[1])/step)+1,cols=Math.round((136-origin[0])/step)+1;
// Exclude the unnamed South China Sea dashed-line graphic. This is a sampling
// mask, not a new border dataset; the existing map retains its full island inset.
const polygons=boundaries.features.filter(feature=>feature.properties?.name&&feature.properties?.adcode).flatMap(feature=>feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[]).map(polygon=>polygon.map(ring=>ring.map(point=>gcjToWgs(point[0],point[1]))));
const boxes=polygons.map(polygon=>{
  const points=polygon[0];
  return {polygon,minX:Math.min(...points.map(point=>point[0])),maxX:Math.max(...points.map(point=>point[0])),minY:Math.min(...points.map(point=>point[1])),maxY:Math.max(...points.map(point=>point[1]))};
});
function ringContains(ring:Position[],x:number,y:number):boolean {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
const selected=new Set<string>();
function add(row:number,col:number){if(row>=0&&row<rows&&col>=0&&col<cols)selected.add(`${row},${col}`);}
function cell(lon:number,lat:number){
  const col=Math.floor((lon-origin[0])/step),row=Math.floor((lat-origin[1])/step);
  for(let dy=0;dy<=1;dy++)for(let dx=0;dx<=1;dx++)add(row+dy,col+dx);
}
for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
  const x=origin[0]+col*step,y=origin[1]+row*step;
  if(boxes.some(box=>x>=box.minX&&x<=box.maxX&&y>=box.minY&&y<=box.maxY&&ringContains(box.polygon[0],x,y)&&!box.polygon.slice(1).some(ring=>ringContains(ring,x,y)))){
    // A one-cell halo around land samples supports all four bilinear corners.
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)add(row+dy,col+dx);
  }
}
for(const polygon of polygons)for(const ring of polygon)for(let i=1;i<ring.length;i++){
  const a=ring[i-1],b=ring[i],cuts=[0,1];
  // Traverse each boundary segment at every crossed grid line so thin coastal
  // strips and islands also retain the four corners of every intersected cell.
  for(let axis=0;axis<2;axis++){
    const low=Math.min(a[axis],b[axis]),high=Math.max(a[axis],b[axis]);
    if(high===low)continue;
    for(let line=Math.ceil((low-origin[axis])/step);origin[axis]+line*step<high;line++){
      const t=(origin[axis]+line*step-a[axis])/(b[axis]-a[axis]);
      if(t>0&&t<1)cuts.push(t);
    }
  }
  cuts.sort((x,y)=>x-y);
  for(let j=0;j<cuts.length;j++){
    const t=cuts[j];cell(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t);
    if(j+1<cuts.length){const mid=(t+cuts[j+1])/2;cell(a[0]+(b[0]-a[0])*mid,a[1]+(b[1]-a[1])*mid);}
  }
}
const nodes:WeatherGridNode[]=[...selected].map(value=>{
  const [row,col]=value.split(',').map(Number);
  return {id:`r${row}c${col}`,row,col,lon:origin[0]+col*step,lat:origin[1]+row*step};
}).sort((a,b)=>a.row-b.row||a.col-b.col);
const boundarySha256=createHash('sha256').update(raw).digest('hex');
const id=`cn-wgs84-${step}-${createHash('sha256').update(JSON.stringify({origin,rows,cols,nodes,boundarySha256})).digest('hex').slice(0,16)}`;
const catalog:WeatherGridCatalog={version:1,id,crs:'WGS84',step,origin,rows,cols,nodes,source:{name:'Open-Meteo 独立规则采样格点',url:'https://open-meteo.com/en/docs',retrievedAt:new Date().toISOString(),boundarySha256,note:`WGS84 ${step}°独立规则采样，按省域陆地及一格缓冲选择，约${Math.round(step*65)}–${Math.round(step*111)} km；并非原始数值模式分辨率。90 m DEM 仅用于请求点高程降尺度，不代表90 m天气精度。`}};
if(!validGridCatalog(catalog))throw new Error('Invalid generated weather grid');
const countyCatalog=JSON.parse(await readFile(new URL('counties.json',output),'utf8')) as {units:unknown[]};
const bootstrapCalls=nodes.length*1.5+countyCatalog.units.length;
if(bootstrapCalls>9800)throw new Error(`Bootstrap budget too large: ${bootstrapCalls} calls including county daily update`);
await mkdir(output,{recursive:true});await writeFile(new URL('weather-grid.json',output),JSON.stringify(catalog));
console.log(`Saved ${nodes.length} independent ${step}° grid nodes; ${rows} rows × ${cols} columns (land + halo)`);
console.log(`Estimated initial grid + daily counties: ${bootstrapCalls} API call equivalents; daily incremental total ${nodes.length+countyCatalog.units.length}`);
