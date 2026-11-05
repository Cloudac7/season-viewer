import {readFile,writeFile} from 'node:fs/promises';
import {geoArea} from 'd3-geo';
import {merge,quantize,feature as decode} from 'topojson-client';
import {topology as buildTopology} from 'topojson-server';
import {presimplify,simplify,quantile} from 'topojson-simplify';
import type {Topology,GeometryCollection} from 'topojson-specification';
import type {Feature,Geometry,FeatureCollection} from 'geojson';
import type {CountyCatalog} from '../src/lib/counties';

/**
 * Dissolve the committed county boundaries into prefecture-level (地级) areas.
 *
 * `counties.topo.json` only carries county ids; the prefecture each county
 * belongs to lives in the `counties.json` catalog as `cityCode`. We union the
 * county geometries that share a cityCode so the client can draw 369
 * prefecture outlines without shipping a second source of truth.
 */
const input=new URL('../public/data/',import.meta.url),output=new URL('../public/data/prefecture.topo.json',import.meta.url);
const catalog=JSON.parse(await readFile(new URL('counties.json',input),'utf8')) as CountyCatalog;
const countyTopology=JSON.parse(await readFile(new URL('counties.topo.json',input),'utf8')) as Topology<{counties:GeometryCollection<{id:string}>}>;

const cityByCounty=new Map(catalog.units.map(unit=>[unit.id,unit.cityCode]));
const cityName=new Map<number,string>();
for(const unit of catalog.units)if(!cityName.has(unit.cityCode))cityName.set(unit.cityCode,unit.city);

const groups=new Map<number,{id:string}[]>();
const unmapped:string[]=[];
for(const geometry of countyTopology.objects.counties.geometries){
  const city=cityByCounty.get(geometry.id);
  if(city===undefined){unmapped.push(geometry.id);continue;}
  if(!groups.has(city))groups.set(city,[]);
  groups.get(city)!.push(geometry);
}
if(unmapped.length)throw new Error(`Counties without a prefecture mapping: ${JSON.stringify(unmapped.slice(0,10))}`);

const features:Feature<Geometry,{id:string;name:string}>[]=[];
for(const [city,geometries] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
  const geometry=merge(countyTopology,geometries);
  if(!geometry)throw new Error(`Failed to dissolve prefecture ${city}`);
  features.push({type:'Feature',properties:{id:String(city),name:cityName.get(city)??String(city)},geometry});
}

/** A simplified ring can occasionally flip winding; reverse the offending polygon. */
function normalizeWinding(feature:Feature<Geometry,{id:string;name:string}>):void {
  const geometry=feature.geometry;
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.type==='MultiPolygon'?geometry.coordinates:[];
  for(const polygon of polygons){
    if(geoArea({type:'Polygon',coordinates:polygon})>2*Math.PI)polygon.forEach(ring=>ring.reverse());
  }
}

const presimplified=presimplify(buildTopology({prefectures:{type:'FeatureCollection',features}},1e6));
let compact=quantize(simplify(presimplified,quantile(presimplified,.1)),1e5);
let decoded=decode(compact,compact.objects.prefectures) as FeatureCollection<Geometry,{id:string;name:string}>;
// Quantising/simplifying shared arcs may invert a ring; re-encode until every
// prefecture decodes with normal (non-complement) winding.
for(let pass=0;pass<3&&decoded.features.some(shape=>geoArea(shape)>2*Math.PI);pass++){
  decoded.features.forEach(normalizeWinding);
  const rebuilt=presimplify(buildTopology({prefectures:{type:'FeatureCollection',features:decoded.features}},1e6));
  compact=quantize(rebuilt,1e5);
  decoded=decode(compact,compact.objects.prefectures) as FeatureCollection<Geometry,{id:string;name:string}>;
}
if(decoded.features.length!==groups.size)throw new Error('Prefecture decode count mismatch');
for(const shape of decoded.features){
  if(!shape.geometry)throw new Error(`Empty prefecture geometry ${shape.properties.id}`);
  if(geoArea(shape)>2*Math.PI)throw new Error(`Prefecture ${shape.properties.id} still wound as the complement`);
}

await writeFile(output,JSON.stringify(compact));
console.log(`Saved ${features.length} prefecture boundaries -> public/data/prefecture.topo.json`);
