import test from 'node:test';
import assert from 'node:assert/strict';
import {temperatureColor,TEMPERATURE_BANDS,TEMPERATURE_LEGEND_TICKS} from './field';

test('temperature bands preserve the 10°C and 22°C decision boundaries without interpolation',()=>{
  assert.equal(temperatureColor(9.99),'#67c7bb');
  assert.equal(temperatureColor(10),'#82c978');
  assert.equal(temperatureColor(14.99),temperatureColor(10));
  assert.equal(temperatureColor(21.99),'#edda58');
  assert.equal(temperatureColor(22),'#f4c54c');
  assert.equal(temperatureColor(24.99),temperatureColor(22));
});

test('temperature legend covers extreme temperatures and shares every boundary with its adjacent band',()=>{
  assert.equal(temperatureColor(-100),'#7950a4');
  assert.equal(temperatureColor(-20),'#6869bc');
  assert.equal(temperatureColor(35),'#cf4744');
  assert.equal(temperatureColor(100),'#cf4744');
  assert.equal(TEMPERATURE_BANDS[0].min,null);
  assert.equal(TEMPERATURE_BANDS.at(-1)!.max,null);
  for(let index=1;index<TEMPERATURE_BANDS.length;index++){
    assert.equal(TEMPERATURE_BANDS[index-1].max,TEMPERATURE_BANDS[index].min);
  }
  assert.equal(temperatureColor(Number.NaN),'#e0e6e2');
  assert.equal(temperatureColor(Number.POSITIVE_INFINITY),'#e0e6e2');
});

test('temperature legend places labels at band boundaries and anchors the range ends',()=>{
  assert.equal(TEMPERATURE_LEGEND_TICKS.length,TEMPERATURE_BANDS.length+1);
  assert.deepEqual(TEMPERATURE_LEGEND_TICKS.map(tick=>tick.label),[
    '＜-20','-20','-10','0','5','10','15','20','22','25','30','35','≥35',
  ]);
  assert.deepEqual(TEMPERATURE_LEGEND_TICKS.map(tick=>tick.position),[
    0,1/12,2/12,3/12,4/12,5/12,6/12,7/12,8/12,9/12,10/12,11/12,1,
  ]);
  assert.equal(TEMPERATURE_LEGEND_TICKS[0].edge,'start');
  assert.equal(TEMPERATURE_LEGEND_TICKS.at(-1)!.edge,'end');
  assert.ok(TEMPERATURE_LEGEND_TICKS.slice(1,-1).every(tick=>tick.edge==='middle'));
});
