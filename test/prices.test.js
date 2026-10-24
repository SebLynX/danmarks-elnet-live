/* Tests for prices.js: API records -> the columnar prices.json series, the
   HTTP 429 back-off, and the "has tomorrow arrived" check behind the
   after-13:00 retries.

   Run:  node --test            (Node 18+, no packages)                      */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { compactPrices, coversTomorrow, getJSON, AREAS, STEP, FIELD } = require('../prices.js');

const rec = (TimeUTC, PriceArea, DayAheadPriceDKK) => ({ TimeUTC, PriceArea, DayAheadPriceDKK });

test('compactPrices lays both areas on one UTC quarter grid in whole DKK/MWh, nulls where a quarter is missing', () => {
  const records = [
    rec('2026-10-23T22:00:00', 'DK2', 305.495069),
    rec('2026-10-23T22:00:00', 'DK1', 275.3),
    rec('2026-10-23T22:15:00', 'DK1', 261.49),
    // DK2 22:15 missing on purpose
    rec('2026-10-23T22:30:00', 'DK1', 36.551772),
    rec('2026-10-23T22:30:00', 'DK2', -0.07),
    rec('2026-10-23T22:30:00', 'DE', 800),          // another area: ignored
    rec('2026-10-23T22:37:00', 'DK1', 1),           // off the quarter grid: ignored
    rec('2026-10-23T22:45:00', 'DK1', null),        // no price: ignored, stays a gap
    rec('2026-10-23T22:45:00', 'DK2', 92.1)
  ];
  const d = compactPrices(records);
  assert.equal(d.t0, '2026-10-23T22:00:00Z');
  assert.equal(d.step, 15);
  assert.equal(d.n, 4);
  assert.deepEqual(d.p.DK1, [275, 261, 37, null]);
  assert.deepEqual(d.p.DK2, [305, null, 0, 92]);
  assert.ok(Object.is(d.p.DK2[2], 0), 'a rounded -0.07 must be 0, not -0');
  assert.deepEqual(Object.keys(d.p), ['DK1', 'DK2']);
});

test('compactPrices reads DayAheadPriceDKK, not the EUR field', () => {
  const d = compactPrices([{ TimeUTC: '2026-10-23T22:00:00', PriceArea: 'DK1', DayAheadPriceEUR: 40.87, DayAheadPriceDKK: 305 }]);
  assert.deepEqual(d.p.DK1, [305]);
  assert.equal(FIELD, 'DayAheadPriceDKK');
  assert.throws(() => compactPrices([{ TimeUTC: '2026-10-23T22:00:00', PriceArea: 'DK1', DayAheadPriceEUR: 40.87 }]), /no usable/);
});

test('compactPrices accepts stamps with or without a trailing Z', () => {
  const d = compactPrices([rec('2026-10-23T22:00:00Z', 'DK1', 10), rec('2026-10-23T22:15:00', 'DK2', 20)]);
  assert.equal(d.n, 2);
  assert.deepEqual(d.p.DK1, [10, null]);
  assert.deepEqual(d.p.DK2, [null, 20]);
});

test('compactPrices spans a 25-hour DST day as 100 quarters', () => {
  // 25-10-2026 00:00 to 23:45 Danish time is 22:00Z the day before to 22:45Z
  const records = [];
  for (let t = Date.UTC(2026, 9, 24, 22); t <= Date.UTC(2026, 9, 25, 22, 45); t += 15 * 60000) {
    records.push(rec(new Date(t).toISOString().slice(0, 19), 'DK1', 100));
    records.push(rec(new Date(t).toISOString().slice(0, 19), 'DK2', 200));
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

test('coversTomorrow tells whether the series reaches the next Danish calendar day', () => {
  const now = Date.UTC(2026, 10, 3, 12, 30);              // 03-11-2026 13:30 CET
  const today = { t0: '2026-11-02T23:00:00Z', step: 15, n: 96 };      // 03-11 00:00 .. 23:45
  const both = { t0: '2026-11-02T23:00:00Z', step: 15, n: 192 };      // .. 04-11 23:45
  assert.equal(coversTomorrow(today, now), false);
  assert.equal(coversTomorrow(both, now), true);
  // one quarter into tomorrow is enough to count, and the day flips on Danish midnight, not UTC
  assert.equal(coversTomorrow({ t0: '2026-11-02T23:00:00Z', step: 15, n: 97 }, now), true);
  assert.equal(coversTomorrow({ t0: '2026-11-02T23:00:00Z', step: 15, n: 96 }, Date.UTC(2026, 10, 3, 23, 30)), false);  // 04-11 00:30 CET: "today" is already the 4th
});

/* a fake fetch: answers in order, each entry { status, body, retryAfter } */
const fakeFetch = answers => {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    const a = answers.shift() || { status: 200, body: '{}' };
    return { status: a.status, ok: a.status >= 200 && a.status < 300,
      headers: { get: h => (h === 'Retry-After' && a.retryAfter !== undefined ? String(a.retryAfter) : null) },
      text: async () => a.body || '' };
  };
  fn.calls = calls;
  return fn;
};
const recorder = () => { const waits = []; const sleep = async ms => { waits.push(ms); }; sleep.waits = waits; return sleep; };

test('getJSON backs off on HTTP 429 for Retry-After seconds, then succeeds', async () => {
  const fetchFn = fakeFetch([{ status: 429, retryAfter: 7 }, { status: 200, body: '{"records":[1]}' }]);
  const sleep = recorder();
  const j = await getJSON('https://x/', { fetchFn, sleep });
  assert.deepEqual(j, { records: [1] });
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(sleep.waits, [7000]);
});

test('getJSON backs off 30 s, 60 s, 120 s ... on 429 without Retry-After, capped at 5 min', async () => {
  const fetchFn = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429, retryAfter: 9999 }, { status: 200, body: '{"ok":true}' }]);
  const sleep = recorder();
  const j = await getJSON('https://x/', { fetchFn, sleep, tries: 5 });
  assert.deepEqual(j, { ok: true });
  assert.deepEqual(sleep.waits, [30000, 60000, 120000, 300000]);
});

test('getJSON gives up after `tries` and names the last error', async () => {
  const fetchFn = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
  const sleep = recorder();
  await assert.rejects(getJSON('https://x/', { fetchFn, sleep, tries: 3 }), /HTTP 429/);
  assert.equal(fetchFn.calls.length, 3);
});

test('getJSON treats an empty 200 as an error and retries other failures with a short pause', async () => {
  const fetchFn = fakeFetch([{ status: 200, body: '' }, { status: 503 }, { status: 200, body: '{"n":1}' }]);
  const sleep = recorder();
  const j = await getJSON('https://x/', { fetchFn, sleep });
  assert.deepEqual(j, { n: 1 });
  assert.deepEqual(sleep.waits, [2000, 4000]);
});

test('the defaults are the two Danish price areas in quarters', () => {
  assert.deepEqual(AREAS, ['DK1', 'DK2']);
  assert.equal(STEP, 15);
});

test('requiring prices.js does not run the poller', () => {
  // it exported its functions above without touching the network or writing a file
  assert.equal(typeof compactPrices, 'function');
  assert.ok(!fs.existsSync(path.join(__dirname, 'prices.json')));
});

test('prices.js asks for DayAheadPrices only, never Elspotprices, and the page never calls the API for prices', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'prices.js'), 'utf8');
  assert.ok(src.includes('DayAheadPrices?'));
  assert.ok(!/Elspotprices\?/.test(src));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const urls = html.match(/const SPOT_URLS = \[([\s\S]*?)\];/)[1];
  assert.ok(urls.includes("'prices.json'"));
  assert.ok(!/energidataservice|api\.gridkort/.test(urls), 'the strip reads static prices.json only');
});
