import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryAndBiasToCounty, applyHistoryAndBiasToGrid, historyCoverage, validHistoryField } from './history';
import type { HistoryField } from './history';
import type { WeatherGrid } from './spatial-grid';
import type { CountyWeather } from './counties';

const history:HistoryField = {
  version:1, source:'era5-land', model:'era5_land', fetchedAt:'2026-07-15T00:00:00Z', lagDays:5,
  dates:['2026-07-13', '2026-07-14'],
  grid:{ r:[10, null] },
  county:{ u:[12, null] },
};
const provider = { offset:() => 1.5 };

function grid():WeatherGrid {
  return {
    version:1, source:'open-meteo', timeZone:'Asia/Shanghai', catalogId:'g', updatedAt:'2026-07-15T00:00:00Z',
    records:{ r:{ lon:116, lat:40, elevation:500, modelGrid:[116, 40], updatedAt:'2026-07-15T00:00:00Z',
      days:[{ date:'2026-07-13', mean:20 }, { date:'2026-07-14', mean:21 }],
      forecast:{ issuedAt:'2026-07-15T00:00:00Z', days:[{ date:'2026-07-15', mean:30 }] } } },
  };
}
function county():CountyWeather {
  return {
    version:1, source:'open-meteo', timeZone:'Asia/Shanghai', updatedAt:'2026-07-15T00:00:00Z',
    records:{ u:{ lon:116, lat:40, updatedAt:'2026-07-15T00:00:00Z',
      days:[{ date:'2026-07-13', mean:20 }, { date:'2026-07-14', mean:21 }],
      forecast:{ issuedAt:'2026-07-15T00:00:00Z', days:[{ date:'2026-07-15', mean:30 }] } } },
  };
}

test('history overrides model history, keeps model for lag/missing days, and still biases forecast', () => {
  const out = applyHistoryAndBiasToGrid(grid(), history, provider);
  assert.equal(out.records.r.days[0].mean, 10);   // reanalysis override, no bias
  assert.equal(out.records.r.days[1].mean, 22.5); // reanalysis null → model 21 + 1.5
  assert.equal(out.records.r.forecast!.days[0].mean, 31.5); // forecast model + bias
  assert.equal(grid().records.r.days[0].mean, 20); // input untouched
});

test('history override works without a bias provider (pure real history + model fill)', () => {
  const out = applyHistoryAndBiasToGrid(grid(), history, null);
  assert.equal(out.records.r.days[0].mean, 10);
  assert.equal(out.records.r.days[1].mean, 21); // no bias applied
  assert.equal(out.records.r.forecast!.days[0].mean, 30);
});

test('county history override and no-op when both absent', () => {
  const out = applyHistoryAndBiasToCounty(county(), history, provider);
  assert.equal(out.records.u.days[0].mean, 12);
  assert.equal(out.records.u.days[1].mean, 22.5);
  assert.equal(out.records.u.forecast!.days[0].mean, 31.5);
  const input = grid();
  assert.equal(applyHistoryAndBiasToGrid(input, null, null), input);
});

test('validHistoryField accepts well-formed fields and rejects malformed ones', () => {
  assert.equal(validHistoryField(history), true);
  assert.equal(validHistoryField(null), false);
  assert.equal(validHistoryField({ ...history, lagDays:40 }), false);
  assert.equal(validHistoryField({ ...history, dates:['2026-07-14', '2026-07-13'] }), false);
  assert.equal(validHistoryField({ ...history, grid:{ r:[10] } }), false);
  assert.equal(validHistoryField({ ...history, grid:{ r:[10, 999] } }), false);
});

test('historyCoverage reports finite samples and latest covered date', () => {
  const gridCoverage = historyCoverage(history, 'grid');
  assert.equal(gridCoverage.samples, 1);
  assert.equal(gridCoverage.latest, '2026-07-13');
  assert.deepEqual(historyCoverage(null, 'grid'), { samples:0, latest:null });
});
