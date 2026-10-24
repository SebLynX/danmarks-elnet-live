/* Tests for worker/worker.js under Node: the module is loaded with its
   `export default` turned into a value, Energinet is a stubbed fetch and
   Cloudflare's cache is a Map. Covers the two routes, the 15-minute cache,
   the sanity gate and the Retry-After failure cache after an HTTP 429.

   Run:  node --test            (Node 18+, no packages)                      */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---- load the Worker ---- */
const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
assert.ok(src.includes('export default {'), 'worker.js must export its handler as default');
const worker = vm.runInThisContext('(() => {' + src.replace('export default {', 'const __w = {') + ';return __w;})()', { filename: 'worker.js' });

/* ---- stubs: the cache and Energinet ---- */
let store, calls, answer, pending;
function fresh() {
  store = new Map(); calls = []; pending = [];
  globalThis.caches = { default: {
    match: async req => { const r = store.get(req.url); return r ? r.clone() : undefined; },
    put: async (req, res) => { store.set(req.url, res); }
  } };
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return answer(String(url), init); };
}
const ctx = () => ({ waitUntil: p => pending.push(p) });
const settle = () => Promise.all(pending);
const ok = body => new Response(JSON.stringify(body), { status: 200 });
const get = (pathname, origin = 'https://el.gridkort.dk') =>
  worker.fetch(new Request('https://api.gridkort.dk' + pathname, { headers: origin ? { Origin: origin } : {} }), {}, ctx());

/* 24 h of quarters for DK1 and DK2 from the start of this hour, DKK/MWh */
function priceRecords(hours = 24, areas = ['DK1', 'DK2']) {
  const start = Math.floor(Date.now() / 3600000) * 3600000, out = [];
  for (let i = 0; i < hours * 4; i++) for (const a of areas)
    out.push({ TimeUTC: new Date(start + i * 900000).toISOString().slice(0, 19), PriceArea: a, DayAheadPriceEUR: 20 + i / 10, DayAheadPriceDKK: (a === 'DK1' ? 150 : 160) + i });
  return out;
}
const psr = { records: [{ Minutes1DK: '2026-10-24T18:00:00', Minutes1UTC: '2026-10-24T16:00:00', CO2Emission: 80.4, OffshoreWindPower: 1500.2,
  OnshoreWindPower: 1200.7, SolarPower: 300.1, ProductionGe100MW: 200, ProductionLt100MW: 400, Exchange_Sum: 900,
  Exchange_DK1_DE: 100, Exchange_DK1_NL: 200, Exchange_DK1_GB: -300, Exchange_DK1_NO: 400, Exchange_DK1_SE: 50, Exchange_DK1_DK2: 60,
  Exchange_DK2_DE: 70, Exchange_DK2_SE: 80, Exchange_Bornholm_SE: -5 }] };
const dapNow = { records: [{ TimeDK: '2026-01-01T00:00:00', PriceArea: 'DK1', DayAheadPriceEUR: 40.87 }, { TimeDK: '2026-01-01T00:00:00', PriceArea: 'DK2', DayAheadPriceEUR: 41.2 }] };
const normal = url => url.includes('PowerSystemRightNow') ? ok(psr) : url.includes('TimeDK%20DESC') ? ok(dapNow) : ok({ records: priceRecords() });

test('/elnet/prices.json answers the prices.json shape with today and tomorrow in DKK/MWh, CORS for the map', async () => {
  fresh(); answer = normal;
  const r = await get('/elnet/prices.json'); await settle();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://el.gridkort.dk');
  const j = await r.json();
  assert.equal(j.unit, 'DKK/MWh');
  assert.ok(j.source.includes('DayAheadPrices') && j.source.includes('CC BY 4.0'));
  assert.equal(j.step, 15); assert.equal(j.n, 96);
  assert.equal(j.p.DK1[0], 150); assert.equal(j.p.DK2[95], 160 + 95);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(j.t0));
  // the request to Energinet asks for DayAheadPriceDKK from today's start, DK1 and DK2 only
  const url = decodeURIComponent(calls[0]);
  assert.ok(url.includes('DayAheadPrices?start=') && url.includes('T00:00') && url.includes('DayAheadPriceDKK') && url.includes('["DK1","DK2"]'));
  assert.ok(!url.includes('Elspotprices'));
});

test('the prices answer is cached: a second request within the TTL does not ask Energinet again', async () => {
  fresh(); answer = normal;
  await get('/elnet/prices.json'); await settle();
  await get('/elnet/prices.json'); await settle();
  assert.equal(calls.length, 1);
  const cachedRes = store.get('https://api.gridkort.dk/__cache/elnet-prices-ahead');
  assert.equal(cachedRes.headers.get('Cache-Control'), 'public, max-age=900');
});

test('an HTTP 429 becomes a 502 and is held for Retry-After seconds before Energinet is asked again', async () => {
  fresh();
  answer = () => new Response('slow down', { status: 429, headers: { 'Retry-After': '90' } });
  const r = await get('/elnet/prices.json'); await settle();
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'HTTP 429' });
  assert.equal(store.get('https://api.gridkort.dk/__cache/elnet-prices-ahead').headers.get('Cache-Control'), 'public, max-age=90');
  answer = normal;
  const again = await get('/elnet/prices.json'); await settle();
  assert.equal(again.status, 502, 'still answered from the failure cache');
  assert.equal(calls.length, 1, 'no new call to Energinet while the hold lasts');
});

test('a 429 without Retry-After and other failures are held 30 s; the hold is capped at 5 min', async () => {
  fresh(); answer = () => new Response('', { status: 429 });
  await get('/elnet/prices.json'); await settle();
  assert.equal(store.get('https://api.gridkort.dk/__cache/elnet-prices-ahead').headers.get('Cache-Control'), 'public, max-age=60');
  fresh(); answer = () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
  await get('/elnet/prices.json'); await settle();
  assert.equal(store.get('https://api.gridkort.dk/__cache/elnet-prices-ahead').headers.get('Cache-Control'), 'public, max-age=300');
  fresh(); answer = () => new Response('', { status: 503 });
  const r = await get('/elnet/prices.json'); await settle();
  assert.equal(r.status, 502);
  assert.equal(store.get('https://api.gridkort.dk/__cache/elnet-prices-ahead').headers.get('Cache-Control'), 'public, max-age=30');
});

test('the sanity gate refuses a series with an area missing or ending in the past', async () => {
  fresh(); answer = () => ok({ records: priceRecords(24, ['DK1']) });
  let r = await get('/elnet/prices.json'); await settle();
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /DK2: only 0 quarters/);
  fresh(); answer = () => ok({ records: priceRecords(24).map(x => ({ ...x, TimeUTC: '2020-01-01T' + x.TimeUTC.slice(11) })) });
  r = await get('/elnet/prices.json'); await settle();
  assert.equal(r.status, 502);
  fresh(); answer = () => ok({ records: [] });
  r = await get('/elnet/prices.json'); await settle();
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /no usable/);
});

test('/elnet/now.json still answers the data.json frame through the same route code', async () => {
  fresh(); answer = normal;
  const r = await get('/elnet/now.json'); await settle();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.frame.co2, 80); assert.equal(j.frame.wOff, 1500); assert.equal(j.frame.x.BH_SE, -5);
  assert.equal(j.frame.p.DK1, 40.9); assert.equal(j.frame.time, '24-10-2026 18:00');
  assert.equal(j.measured, '2026-10-24T16:00:00Z');
  assert.ok(store.has('https://api.gridkort.dk/__cache/elnet-now'));
});

test('unknown paths, other methods and foreign origins are handled as before', async () => {
  fresh(); answer = normal;
  assert.equal((await get('/elnet/other.json')).status, 404);
  assert.equal((await worker.fetch(new Request('https://api.gridkort.dk/elnet/prices.json', { method: 'POST' }), {}, ctx())).status, 405);
  const foreign = await get('/elnet/prices.json', 'https://example.com'); await settle();
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  const disk = await get('/elnet/prices.json', 'null'); await settle();
  assert.equal(disk.headers.get('Access-Control-Allow-Origin'), 'null');   // a copy opened from disk may read it
});
