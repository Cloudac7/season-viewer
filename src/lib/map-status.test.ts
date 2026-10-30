import test from 'node:test';
import assert from 'node:assert/strict';
import {SEASONS,TRANSITION_PALETTES} from '../data';
import {classifyCounty} from './counties';
import type {CountySeries,CountyUnit} from './counties';
import {addDays} from './season';
import {sampleColor} from './field';
import {countyMapColor,countyTransitionAppearance,countyTransitionStatus,transitionAppearance} from './map-status';

test('forecast completion takes color priority without changing the current season, and the switch restores both base layers',()=>{
  const unit:CountyUnit={id:'test',name:'测试县',provinceCode:110000,province:'北京',cityCode:110100,city:'北京',region:'华北',kind:'county',display:[116,40],lon:116,lat:40,pointMethod:'测试'};
  const issuedAt='2026-10-11T00:00:00Z',now=new Date(issuedAt);
  const series:CountySeries={lon:116,lat:40,updatedAt:issuedAt,days:[24,24,24,24,24,18,18,18,18,18].map((mean,i)=>({date:addDays('2026-10-01',i),mean}))};
  const pending=classifyCounty(unit,series,'2026-10-10',now);
  const forecast=classifyCounty(unit,{...series,forecast:{issuedAt,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-11',i),mean:18}))}},'2026-10-10',now);
  assert.equal(pending.state?.transition?.days,4);
  assert.equal(countyTransitionStatus(pending),'pending');
  assert.equal(forecast.forecastTransition?.expectedDate,'2026-10-11');
  assert.equal(forecast.state?.season,'summer');
  assert.equal(countyMapColor(pending,'season',true),TRANSITION_PALETTES['summer-autumn']!.pending.fill);
  assert.equal(countyMapColor(forecast,'season',true),TRANSITION_PALETTES['summer-autumn']!.forecast.fill);
  assert.equal(countyMapColor(forecast,'season',false),SEASONS.summer.fill);
  assert.equal(countyMapColor(forecast,'temperature',false),sampleColor(forecast.state!,'temperature'));
  assert.equal(countyMapColor(classifyCounty(unit,undefined,'2026-10-10',now),'season',true),'#e0e6e2');
  assert.ok(!Object.values(SEASONS).some(season=>season.fill===TRANSITION_PALETTES['summer-autumn']!.pending.fill||season.fill===TRANSITION_PALETTES['summer-autumn']!.forecast.fill));
});

test('autumn to winter uses deep red while pending and purple after the forecast establishes completion',()=>{
  const unit:CountyUnit={id:'test',name:'测试县',provinceCode:110000,province:'北京',cityCode:110100,city:'北京',region:'华北',kind:'county',display:[116,40],lon:116,lat:40,pointMethod:'测试'};
  const issuedAt='2026-10-11T00:00:00Z',now=new Date(issuedAt);
  const series:CountySeries={lon:116,lat:40,updatedAt:issuedAt,days:[15,15,15,15,15,5,5,5,5,5].map((mean,i)=>({date:addDays('2026-10-01',i),mean}))};
  const pending=classifyCounty(unit,series,'2026-10-10',now);
  const forecast=classifyCounty(unit,{...series,forecast:{issuedAt,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-11',i),mean:5}))}},'2026-10-10',now);
  assert.equal(pending.state?.season,'autumn');
  assert.equal(pending.state?.transition?.target,'winter');
  assert.equal(forecast.forecastTransition?.target,'winter');
  assert.equal(countyMapColor(pending,'season',true),'#b7354f');
  assert.equal(countyMapColor(forecast,'season',true),'#8754b0');
  assert.equal(countyMapColor(forecast,'season',false),SEASONS.autumn.fill);
  assert.notEqual(countyMapColor(forecast,'season',true),TRANSITION_PALETTES['summer-autumn']!.forecast.fill);
});

test('winter to autumn uses a teal and ochre palette distinct from both autumn to winter states',()=>{
  const winterAutumn=TRANSITION_PALETTES['winter-autumn']!,autumnWinter=TRANSITION_PALETTES['autumn-winter']!;
  assert.equal(winterAutumn.pending.fill,'#3f9ba8');
  assert.equal(winterAutumn.forecast.fill,'#c79624');
  for(const winterColor of [winterAutumn.pending.fill,winterAutumn.forecast.fill]){
    for(const entryColor of [autumnWinter.pending.fill,autumnWinter.forecast.fill])assert.notEqual(winterColor,entryColor);
  }
});

test('forecast completion cannot be rendered without an observed transition',()=>{
  const unit:CountyUnit={id:'test',name:'测试县',provinceCode:110000,province:'北京',cityCode:110100,city:'北京',region:'华北',kind:'county',display:[116,40],lon:116,lat:40,pointMethod:'测试'};
  const issuedAt='2026-10-11T00:00:00Z',now=new Date(issuedAt);
  const series:CountySeries={lon:116,lat:40,updatedAt:issuedAt,days:Array(9).fill(25).map((mean,i)=>({date:addDays('2026-10-02',i),mean}))};
  const reading=classifyCounty(unit,{...series,forecast:{issuedAt,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-11',i),mean:18}))}},'2026-10-10',now);
  const synthetic={...reading,forecastTransition:{target:'autumn' as const,expectedDate:'2026-10-17',forecastDays:7,issuedAt}};
  assert.equal(reading.state?.transition,null);
  assert.equal(transitionAppearance(reading.state!,synthetic.forecastTransition),null);
  assert.equal(countyTransitionAppearance(synthetic),null);
  assert.equal(countyTransitionStatus(synthetic),'stable');
  assert.equal(countyMapColor(synthetic,'season',true),SEASONS.summer.fill);
});
