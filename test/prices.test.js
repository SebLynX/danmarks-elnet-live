/* Tests for prices.js: API records -> the columnar prices.json series, and
   the guard that the Worker's copy of compactPrices() has not drifted.

   Run:  node --test            (Node 18+, no packages)                      */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { compactPrices, AREAS, STEP } = require('../prices.js');

const rec = (TimeUTC, PriceArea, DayAheadPriceEUR) => ({ TimeUTC, PriceArea, DayAheadPriceEUR });

test('compactPrices lays both areas on one UTC quarter grid, nulls where a quarter is missing', () => {
  const records = [
    rec('2026-10-23T22:00:00', 'DK2', 37.23),
    rec('2026-10-23T22:00:00', 'DK1', 36.9),
    rec('2026-10-23T22:15:00', 'DK1', 35.04),
    // DK2 22:15 missing on purpose
    rec('2026-10-23T22:30:00', 'DK1', 4.89),
    rec('2026-10-23T22:30:00', 'DK2', -0.01),
    rec('2026-10-23T22:30:00', 'DE', 80),           // another area: ignored
    rec('2026-10-23T22:37:00', 'DK1', 1),           // off the quarter grid: ignored
    rec('2026-10-23T22:45:00', 'DK1', null),        // no price: ignored, stays a gap
    rec('2026-10-23T22:45:00', 'DK2', 12.345)
  ];
  const d = compactPrices(records);
  assert.equal(d.t0, '2026-10-23T22:00:00Z');
  assert.equal(d.step, 15);
  assert.equal(d.n, 4);
  assert.deepEqual(d.p.DK1, [369, 350, 49, null]);
  assert.deepEqual(d.p.DK2, [372, null, 0, 123]);
  assert.ok(Object.is(d.p.DK2[2], 0), 'a rounded -0.01 must be 0, not -0');
  assert.deepEqual(Object.keys(d.p), ['DK1', 'DK2']);
});

test('compactPrices accepts stamps with or without a trailing Z', () => {
  const d = compactPrices([rec('2026-10-23T22:00:00Z', 'DK1', 1), rec('2026-10-23T22:15:00', 'DK2', 2)]);
  assert.equal(d.n, 2);
  assert.deepEqual(d.p.DK1, [10, null]);
  assert.deepEqual(d.p.DK2, [null, 20]);
});

test('compactPrices spans a 25-hour DST day as 100 quarters', () => {
  // 25-10-2026 00:00 to 23:45 Danish time is 22:00Z the day before to 22:45Z
  const records = [];
  for (let t = Date.UTC(2026, 9, 24, 22); t <= Date.UTC(2026, 9, 25, 22, 45); t += 15 * 60000) {
    records.push(rec(new Date(t).toISOString().slice(0, 19), 'DK1', 10));
    records.push(rec(new Date(t).toISOString().slice(0, 19), 'DK2', 20));
  }
  const d = compactPrices(records);
  assert.equal(d.n, 100);
  assert.equal(d.p.DK1.filter(v => v !== null).length, 100);
});

test('compactPrices refuses an empty or unusable set rather than writing a file', () => {
  assert.throws(() => compactPrices([]), /no usable/);
  assert.throws(() => compactPrices(undefined), /no usable/);
  assert.throws(() => compactPrices([rec('2026-10-23T22:00:00', 'DE', 1)]), /no usable/);
  assert.throws(() => compactPrices([rec('nonsense', 'DK1', 1)]), /no usable/);
  // a span longer than four days is not a day-ahead file
  assert.throws(() => compactPrices([rec('2026-10-01T00:00:00', 'DK1', 1), rec('2026-10-09T00:00:00', 'DK1', 1)]), /spans/);
});

test('the defaults are the two Danish price areas in quarters', () => {
  assert.deepEqual(AREAS, ['DK1', 'DK2']);
  assert.equal(STEP, 15);
});

test('worker/worker.js carries the same compactPrices() as prices.js', () => {
  const fn = src => {
    const m = src.match(/\nfunction compactPrices\([\s\S]*?\n}\n/);
    assert.ok(m, 'compactPrices not found');
    return m[0];
  };
  const a = fn(fs.readFileSync(path.join(__dirname, '..', 'prices.js'), 'utf8'));
  const b = fn(fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8'));
  assert.equal(b, a);
});

test('requiring prices.js does not run the poller', () => {
  // it exported its functions above without touching the network or writing a file
  assert.equal(typeof compactPrices, 'function');
  assert.ok(!fs.existsSync(path.join(__dirname, 'prices.json')));
});
