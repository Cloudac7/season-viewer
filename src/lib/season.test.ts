import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES } from '../data';
import type { DayTemperature } from '../types';
import { addDays, beijingDate, classifyCity, rollingMeans } from './season';

function days(values: (number|null)[], start='2026-09-01'): DayTemperature[] {
  return values.map((mean,i)=>({date:addDays(start,i),mean}));
}
test('uses exactly five daily means and treats missing values as missing',()=>{
  assert.deepEqual(rollingMeans(days([10,12,14,16,18,20])),[null,null,null,null,14,16]);
  assert.equal(rollingMeans(days([10,12,null,16,18])).at(-1),null);
  const gap=days([10,12,14,16,18]); gap[4].date=addDays(gap[4].date,1);
  assert.equal(rollingMeans(gap).at(-1),null);
});
test('autumn remains summer until five consecutive sliding averages below 22',()=>{
  const input=days([24,24,24,24,24,18,18,18,18,18,18]);
  const pending=classifyCity(CITIES[0],input,'2026-09-10');
  assert.equal(pending.season,'summer');
  assert.equal(pending.transition?.target,'autumn');
  assert.equal(pending.transition?.days,4);
  const confirmed=classifyCity(CITIES[0],input,'2026-09-11');
  assert.equal(confirmed.season,'autumn');
  assert.equal(confirmed.transition,null);
  assert.equal(confirmed.since,'2026-09-06');
});
test('22 degrees is summer and 10 degrees is not winter',()=>{
  assert.equal(classifyCity(CITIES[0],days(Array(20).fill(22)),'2026-09-20').season,'summer');
  assert.equal(classifyCity(CITIES[0],days(Array(20).fill(10)),'2026-09-20').season,'autumn');
  const winter=classifyCity(CITIES[0],days([15,15,15,15,15,...Array(12).fill(9)]),'2026-09-17');
  assert.equal(winter.season,'winter');
});
test('one-day hot spell never reverts an autumn confirmation to summer',()=>{
  const input=days([25,25,25,25,25,...Array(12).fill(18),30,...Array(6).fill(18)]);
  assert.equal(classifyCity(CITIES[0],input,input.at(-1)!.date).season,'autumn');
});
test('a confirmed warm reversal prevents an early cold spell from locking the season',()=>{
  const input=days([25,25,25,25,25,...Array(12).fill(18),...Array(14).fill(26)]);
  const result=classifyCity(CITIES[0],input,input.at(-1)!.date);
  assert.equal(result.season,'summer'); assert.equal(result.transition,null);
});
test('after an autumn cold spell a warm reversal is autumn rather than a false spring',()=>{
  const input=days([15,15,15,15,15,...Array(12).fill(5),...Array(14).fill(15)]);
  assert.equal(classifyCity(CITIES[0],input,input.at(-1)!.date).season,'autumn');
});
test('future temperatures do not participate in historical classification',()=>{
  const history=days([24,24,24,24,24,18,18,18,18]);
  const extended=days([24,24,24,24,24,18,18,18,18,...Array(10).fill(3)]);
  const a=classifyCity(CITIES[0],history,'2026-09-09');
  const b=classifyCity(CITIES[0],extended,'2026-09-09');
  assert.equal(a.season,b.season); assert.deepEqual(a.transition,b.transition);
});
test('a missing daily value breaks a pending consecutive sequence',()=>{
  const input=days([24,24,24,24,24,18,18,18,null,18,18,18,18,18]);
  const state=classifyCity(CITIES[0],input,input.at(-1)!.date);
  assert.equal(state.season,'summer');assert.equal(state.transition?.days,1);
});
test('missing selected day does not reuse old temperatures or an old pending count',()=>{
  const state=classifyCity(CITIES[0],days([24,24,24,24,24,18,18]),'2026-09-10');
  assert.equal(state.average,null);assert.equal(state.temperature,null);assert.equal(state.transition,null);
});
test('dates consistently use Beijing time at the UTC day boundary',()=>{
  assert.equal(beijingDate(new Date('2026-10-22T18:00:00Z')),'2026-10-23');
  assert.equal(addDays('2026-01-01',-1),'2025-12-31');
});
