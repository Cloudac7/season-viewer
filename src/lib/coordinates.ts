// DataV/Amap display coordinates are GCJ-02; Open-Meteo expects WGS84.
const PI=Math.PI,A=6378245,EE=.00669342162296594323;
const outside=(lon:number,lat:number)=>lon<72.004||lon>137.8347||lat<.8293||lat>55.8271;
export function wgsToGcj(lon:number,lat:number):[number,number]{
  if(outside(lon,lat))return [lon,lat];
  const x=lon-105,y=lat-35;
  let dLat=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));
  dLat+=(20*Math.sin(6*x*PI)+20*Math.sin(2*x*PI))*2/3;
  dLat+=(20*Math.sin(y*PI)+40*Math.sin(y/3*PI))*2/3;
  dLat+=(160*Math.sin(y/12*PI)+320*Math.sin(y*PI/30))*2/3;
  let dLon=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
  dLon+=(20*Math.sin(6*x*PI)+20*Math.sin(2*x*PI))*2/3;
  dLon+=(20*Math.sin(x*PI)+40*Math.sin(x/3*PI))*2/3;
  dLon+=(150*Math.sin(x/12*PI)+300*Math.sin(x/30*PI))*2/3;
  const radLat=lat/180*PI,magic=1-EE*Math.sin(radLat)**2,sqrt=Math.sqrt(magic);
  dLat=dLat*180/((A*(1-EE))/(magic*sqrt)*PI);
  dLon=dLon*180/(A/sqrt*Math.cos(radLat)*PI);
  return [lon+dLon,lat+dLat];
}
export function gcjToWgs(lon:number,lat:number):[number,number]{
  if(outside(lon,lat))return [lon,lat];
  let x=lon,y=lat;
  for(let i=0;i<6;i++){const [gx,gy]=wgsToGcj(x,y);x-=gx-lon;y-=gy-lat;}
  return [Number(x.toFixed(6)),Number(y.toFixed(6))];
}
