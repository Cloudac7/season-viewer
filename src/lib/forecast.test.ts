import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, classifyCity } from './season';
import { forecastIsFresh, projectTransition } from './forecast';
import type { TemperatureForecast } from './forecast';
import type { City } from '../types';

const city:City={id:'test',name:'测试县',province:'浙江省',code:330000,region:'华东',lat:30,lon:120,annual:0,amplitude:0};
const now=new Date('2026-10-11T04:00:00Z');
const history=(values:number[],end='2026-10-10')=>values.map((mean,i)=>({date:addDays(end,i-values.length+1),mean}));
const forecast=(values:(number|null)[]=Array(7).fill(18)):TemperatureForecast=>({issuedAt:'2026-10-11T00:00:00Z',days:values.map((mean,i)=>({date:addDays('2026-10-11',i),mean}))});
const pending=()=>classifyCity(city,history([24,24,24,24,24,18,18,18,18,18]),'2026-10-10');

test('projection confirms a current uninterrupted transition without changing the observed season',()=>{
  const state=pending(),before=JSON.stringify(state);
  assert.equal(state.transition?.days,4);
  assert.deepEqual(projectTransition(state,forecast(),'2026-10-10',now),{target:'autumn',expectedDate:'2026-10-11',forecastDays:1,issuedAt:'2026-10-11T00:00:00Z'});
  assert.equal(state.season,'summer');assert.equal(JSON.stringify(state),before);
});
test('projection can identify a transition beginning and completing wholly in the forecast',()=>{
  const state=classifyCity(city,history(Array(9).fill(25)),'2026-10-10');
  assert.equal(state.transition,null);
  assert.equal(projectTransition(state,forecast(),'2026-10-10',now)?.expectedDate,'2026-10-17');
  assert.equal(projectTransition(state,forecast(Array(7).fill(23)),'2026-10-10',now),null);
});
test('projection requires current forecasts and never overlays them on historical dates',()=>{
  assert.equal(forecastIsFresh(forecast(),now),true);
  assert.equal(forecastIsFresh({...forecast(),issuedAt:'2026-10-10T00:00:00Z'},now),false);
  assert.equal(forecastIsFresh({...forecast(),issuedAt:'2026-10-11T05:00:00Z'},now),false);
  assert.equal(projectTransition(pending(),forecast(),'2026-10-09',now),null);
  assert.equal(projectTransition(pending(),forecast(),'2026-10-10',new Date('2026-10-12T00:00:00Z')),null);
});
test('forecast freshness requires seven consecutive finite temperatures in the supported range',()=>{
  for(const invalid of [null,NaN,Infinity,-101,66]){
    const incomplete=forecast();incomplete.days[6].mean=invalid;
    assert.equal(forecastIsFresh(incomplete,now),false,`invalid daily mean ${invalid}`);
  }
  assert.equal(forecastIsFresh(forecast([18,18]),now),false);
  const gap=forecast();gap.days[3].date='2026-10-15';assert.equal(forecastIsFresh(gap,now),false);
  const edges=forecast([-100,65,18,18,18,18,18]);assert.equal(forecastIsFresh(edges,now),true);
});
test('partial, null, missing or out-of-range forecast days cannot imply completion',()=>{
  assert.equal(projectTransition(pending(),forecast([18,18]),'2026-10-10',now),null);
  assert.equal(projectTransition(pending(),forecast([18,18,18,18,18,18,null]),'2026-10-10',now),null);
  const missing=forecast();missing.days[3].date='2026-10-15';
  assert.equal(projectTransition(pending(),missing,'2026-10-10',now),null);
  assert.equal(projectTransition(pending(),forecast([70,18,18,18,18,18,18]),'2026-10-10',now),null);
});
test('a forecast reversal cannot restart the observed transition or qualify after completion',()=>{
  // A warm first day interrupts the current four-day cooling signal, even
  // though another autumn transition could eventually start later.
  assert.equal(projectTransition(pending(),forecast([40,18,18,18,18,18,18]),'2026-10-10',now),null);
  // Cooling confirms on day one, but the remaining forecast then begins a
  // warming transition; this is not highlighted as a stable forecast outcome.
  assert.equal(projectTransition(pending(),forecast([18,30,30,30,30,30,30]),'2026-10-10',now),null);
});
