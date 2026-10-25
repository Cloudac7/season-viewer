import test from 'node:test';
import assert from 'node:assert/strict';
import {SEASONS,TRANSITION_PALETTES} from '../data';
import {classifyCounty} from './counties';
import type {CountySeries,CountyUnit} from './counties';
import {addDays} from './season';
import {sampleColor} from './field';
import {countyMapColor,countyTransitionStatus} from './map-status';

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

test('autumn to winter has deep red observation and purple forecast steps distinct from the summer to autumn path',()=>{
  const unit:CountyUnit={id:'test',name:'测试县',provinceCode:110000,province:'北京',cityCode:110100,city:'北京',region:'华北',kind:'county',display:[116,40],lon:116,lat:40,pointMethod:'测试'};
  const issuedAt='2026-10-11T00:00:00Z',now=new Date(issuedAt);
  const series:CountySeries={lon:116,lat:40,updatedAt:issuedAt,days:[15,15,15,15,15,5,5,5,5,5].map((mean,i)=>({date:addDays('2026-10-01',i),mean}))};
  const pending=classifyCounty(unit,series,'2026-10-10',now);
  const forecast=classifyCounty(unit,{...series,forecast:{issuedAt,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-11',i),mean:5}))}},'2026-10-10',now);
  assert.equal(pending.state?.season,'autumn');
  assert.equal(pending.state?.transition?.target,'winter');
  assert.equal(forecast.forecastTransition?.target,'winter');
  assert.equal(countyMapColor(pending,'season',true),'#a84250');
  assert.equal(countyMapColor(forecast,'season',true),'#8871b5');
  assert.equal(countyMapColor(forecast,'season',false),SEASONS.autumn.fill);
  assert.notEqual(countyMapColor(forecast,'season',true),TRANSITION_PALETTES['summer-autumn']!.forecast.fill);
});
