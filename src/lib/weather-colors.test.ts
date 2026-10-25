import test from 'node:test';
import assert from 'node:assert/strict';
import {temperatureColor,TEMPERATURE_BANDS} from './field';

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
