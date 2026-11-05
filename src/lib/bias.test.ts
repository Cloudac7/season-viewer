import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBiasToCounty, applyBiasToGrid, biasOffsetAt, buildBiasField, computeMonthlyResiduals,
  createBiasProvider, evaluateAccuracy, haversineKm, monthlyOffset, parseGhcnDailyCsv,
  parseMeteostatCsv, parseStationJson, validBiasField,
} from './bias';
import type { BiasField, BiasProvider } from './bias';
import type { CountyWeather } from './counties';
import type { WeatherGrid } from './spatial-grid';

const jul = '2026-07-15';

function fieldWith(points:{ lon:number; lat:number; monthly:(number | null)[] }[], radiusKm = 500):BiasField {
  return buildBiasField(points.map(point => ({ ...point, elevation:null })), { source:'test', radiusKm, start:'2026-06-01', end:'2026-07-31', samples:1 });
}
function emptyMonthly(value:number | null = null):(number | null)[] { return new Array<number | null>(12).fill(value); }

test('haversine returns plausible intercity distances', () => {
  const beijingShanghai = haversineKm(116.4, 39.9, 121.47, 31.23);
  assert.ok(beijingShanghai > 1000 && beijingShanghai < 1150, `got ${beijingShanghai}`);
  assert.equal(haversineKm(116.4, 39.9, 116.4, 39.9), 0);
});

test('monthly residuals average observation minus model and skip gaps', () => {
  const observed = [
    { date:'2026-07-01', mean:26 }, { date:'2026-07-02', mean:24 },
    { date:'2026-07-03', mean:null }, { date:'2026-08-01', mean:20 },
  ];
  const modelled = [
    { date:'2026-07-01', mean:24 }, { date:'2026-07-02', mean:22 },
    { date:'2026-07-03', mean:22 }, { date:'2026-08-01', mean:25 },
  ];
  const { monthly, samples } = computeMonthlyResiduals(observed, modelled);
  assert.equal(samples, 3);
  assert.equal(monthly[6], 2); // July: (2 + 2) / 2
  assert.equal(monthly[7], -5); // August: 20 - 25
  assert.equal(monthly[0], null);
});

test('buildBiasField keeps valid points and rejects out-of-range residuals', () => {
  const field = fieldWith([
    { lon:116.4, lat:39.9, monthly:emptyMonthly(2) },
    { lon:999, lat:39.9, monthly:emptyMonthly(2) }, // invalid lon dropped
    { lon:121.4, lat:31.2, monthly:emptyMonthly(999) }, // implausible residual dropped
  ]);
  assert.equal(field.points.length, 1);
  assert.equal(field.points[0].monthly[6], 2);
  assert.equal(validBiasField(field), true);
});

test('monthlyOffset falls back to the available-month mean', () => {
  const monthly = emptyMonthly(null); monthly[6] = 3; monthly[7] = 1;
  assert.equal(monthlyOffset({ lon:0, lat:0, elevation:null, monthly }, 6), 3);
  assert.equal(monthlyOffset({ lon:0, lat:0, elevation:null, monthly }, 0), 2);
  assert.equal(monthlyOffset({ lon:0, lat:0, elevation:null, monthly:emptyMonthly(null) }, 0), 0);
});

test('biasOffsetAt interpolates by inverse distance and respects radius/exact hits', () => {
  const field = fieldWith([
    { lon:116, lat:40, monthly:emptyMonthly(2) },
    { lon:116, lat:42, monthly:emptyMonthly(-2) },
  ], 500);
  assert.equal(biasOffsetAt(field, 116, 41, jul), 0); // equidistant
  assert.ok(biasOffsetAt(field, 116, 40.1, jul) > 0); // closer to +2
  assert.ok(biasOffsetAt(field, 116, 41.9, jul) < 0); // closer to -2
  assert.equal(biasOffsetAt(field, 116, 40, jul), 2); // exact station hit
  assert.equal(biasOffsetAt(field, 130, 20, jul), 0); // outside radius
});

test('createBiasProvider is null without usable points', () => {
  assert.equal(createBiasProvider(null), null);
  assert.equal(createBiasProvider(fieldWith([])), null);
  const provider = createBiasProvider(fieldWith([{ lon:116, lat:40, monthly:emptyMonthly(1.5) }]));
  assert.ok(provider);
  assert.equal(provider!.offset(116, 40, jul), 1.5);
});

test('applyBiasToGrid shifts history and forecast but leaves nulls untouched', () => {
  const provider: BiasProvider = { offset:() => 1.5 };
  const weather:WeatherGrid = {
    version:1, source:'open-meteo', timeZone:'Asia/Shanghai', catalogId:'g', updatedAt:'2026-07-15T00:00:00Z',
    records:{ r:{ lon:116, lat:40, elevation:500, modelGrid:[116, 40], updatedAt:'2026-07-15T00:00:00Z',
      days:[{ date:'2026-07-13', mean:20 }, { date:'2026-07-14', mean:null }],
      forecast:{ issuedAt:'2026-07-15T00:00:00Z', days:[{ date:'2026-07-15', mean:30 }] } } },
  };
  const biased = applyBiasToGrid(weather, provider);
  assert.equal(biased.records.r.days[0].mean, 21.5);
  assert.equal(biased.records.r.days[1].mean, null);
  assert.equal(biased.records.r.forecast!.days[0].mean, 31.5);
  assert.equal(weather.records.r.days[0].mean, 20); // input untouched
  assert.equal(applyBiasToGrid(weather, null), weather);
});

test('applyBiasToCounty shifts representative series', () => {
  const county:CountyWeather = {
    version:1, source:'open-meteo', timeZone:'Asia/Shanghai', updatedAt:'2026-07-15T00:00:00Z',
    records:{ u:{ lon:116, lat:40, updatedAt:'2026-07-15T00:00:00Z', days:[{ date:'2026-07-13', mean:20 }] } },
  };
  const biased = applyBiasToCounty(county, { offset:() => -2 });
  assert.equal(biased.records.u.days[0].mean, 18);
  assert.equal(applyBiasToCounty(county, null), county);
});

test('evaluateAccuracy reports bias, RMSE and MAE', () => {
  assert.deepEqual(evaluateAccuracy([{ obs:10, model:8 }, { obs:12, model:10 }]), { count:2, bias:2, rmse:2, mae:2 });
  const mixed = evaluateAccuracy([{ obs:10, model:10 }, { obs:14, model:10 }]);
  assert.equal(mixed.bias, 2); assert.equal(mixed.rmse, 2.83); assert.equal(mixed.mae, 2);
  assert.deepEqual(evaluateAccuracy([]), { count:0, bias:null, rmse:null, mae:null });
});

test('validBiasField rejects malformed fields', () => {
  const good = fieldWith([{ lon:116, lat:40, monthly:emptyMonthly(1) }]);
  assert.equal(validBiasField(good), true);
  assert.equal(validBiasField({ ...good, radiusKm:0 }), false);
  assert.equal(validBiasField({ ...good, points:[] }), false);
  assert.equal(validBiasField({ ...good, points:[{ lon:116, lat:40, elevation:null, monthly:[1, 2] }] }), false);
  assert.equal(validBiasField(null), false);
});

test('parseGhcnDailyCsv handles quoted fields, tenths of °C and missing sentinels', () => {
  const csv = [
    '"STATION","DATE","LATITUDE","LONGITUDE","ELEVATION","NAME","PRCP","PRCP_ATTRIBUTES","SNWD","SNWD_ATTRIBUTES","TMAX","TMAX_ATTRIBUTES","TMIN","TMIN_ATTRIBUTES","TAVG","TAVG_ATTRIBUTES"',
    '"CHM00054511","2026-07-01","39.93","116.28","55.0","BEIJING, CH","    0",",,S","","","  310",",,S","  200","H,,S","  255","H,,S"',
    '"CHM00054511","2026-07-02","39.93","116.28","55.0","BEIJING, CH","","","","","  320",",,S","  220","H,,S","",""',
    '"CHM00054511","2026-07-03","39.93","116.28","55.0","BEIJING, CH","","","","","-9999",",,S","-9999",",,S","-9999","S"',
  ].join('\n');
  const station = parseGhcnDailyCsv(csv);
  assert.equal(station.id, 'CHM00054511');
  assert.equal(station.name, 'BEIJING, CH');
  assert.equal(station.lat, 39.93);
  assert.equal(station.daily.length, 2);
  assert.equal(station.daily[0].mean, 25.5); // TAVG 255 tenths
  assert.equal(station.daily[1].mean, 27);   // (TMAX 320 + TMIN 220) / 2 tenths
});

test('parseMeteostatCsv and parseStationJson normalise daily means', () => {
  const meteostat = parseMeteostatCsv('date,tavg,tmin,tmax\n2026-07-01,26.0,20.1,31.4\n2026-07-02,,21.0,30.0', { id:'m1', lon:116, lat:40 });
  assert.equal(meteostat.daily.length, 2);
  assert.equal(meteostat.daily[0].mean, 26);
  assert.equal(meteostat.daily[1].mean, 25.5);

  const parsed = parseStationJson({ stations:[{ id:'a', lon:116, lat:40, elevation:50, daily:[{ date:'2026-07-01', mean:25 }, { date:'bad', mean:1 }, { date:'2026-07-02', mean:null }] }] });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].daily.length, 1);
  assert.equal(parsed[0].elevation, 50);
});
