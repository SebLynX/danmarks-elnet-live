/* ============================================================
   gridkort-api  ->  https://api.gridkort.dk/elnet/now.json
                     https://api.gridkort.dk/elnet/prices.json
   ------------------------------------------------------------
   One fresh "right now" frame for Danmarks Elnet, in exactly the
   shape poll.js writes to data.json, so the map reads it with the
   code it already has - and, the same way, the day-ahead quarters
   for DK1 and DK2 (today and tomorrow, DayAheadPriceDKK) in exactly
   the shape prices.js writes to prices.json, for the "Kommende
   elpriser" strip and the DK1/DK2 cards. The map tries this Worker
   first and the pipeline's files second, so the Worker being down
   costs freshness, never the feature.

   Why a Worker at all: api.energidataservice.dk answers every
   request that carries an Origin header (= every browser request)
   with an empty 200. A Worker is not a browser; it sends no Origin
   and gets the data. It then hands the frame to the map with a CORS
   header naming the map's own address.

   Politeness towards Energinet: their API guide asks for one request
   per dataset per update cycle. PowerSystemRightNow updates every
   minute, prices every 15 minutes. So the finished frame is cached
   for 60 s and the prices for 15 min. However many people have the
   map open, Energinet sees about one call a minute from each
   Cloudflare location. Failures are cached for 30 s, so a hiccup at
   Energinet is not answered with a flood of retries.
   ============================================================ */
const API = 'https://api.energidataservice.dk/dataset/';
const FRAME_TTL = 60, PRICE_TTL = 900, FAIL_TTL = 30;

/* must stay identical to XK / PK in the map (src/data.js) and poll.js */
const XK = ['DK1_DE', 'DK1_NL', 'DK1_GB', 'DK1_NO', 'DK1_SE', 'DK1_DK2', 'DK2_DE', 'DK2_SE', 'BH_SE'];
const PK = ['DK1', 'DK2', 'DE', 'NO2', 'SE3', 'SE4'];

/* who may read the frame from a browser: the maps, the old GitHub
   address, Energinet's internal hosting, and a copy opened from disk */
const ALLOW = [
  /^https:\/\/([a-z0-9-]+\.)*gridkort\.dk$/,
  /^https:\/\/seblynx\.github\.io$/,
  /^https:\/\/([a-z0-9-]+\.)*energinet\.dk$/,
  /^null$/
];
const cors = origin => origin && ALLOW.some(re => re.test(origin))
  ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };

/* An HTTP 429 carries Energinet's Retry-After out with the error: the route
   caches the failure for that long (capped at 5 min), so the Worker answers
   from that cache instead of asking Energinet again before it may. */
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'gridkort-api (gridkort.dk, hobby map)' }, signal: AbortSignal.timeout(8000) });
  if (r.status === 429) { const e = new Error('HTTP 429'); e.retryAfter = Number(r.headers.get('Retry-After')) || 60; throw e; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  if (!t.trim()) throw new Error('empty 200');
  return JSON.parse(t);
}

/* Danish wall-clock offset by `hours`, "YYYY-MM-DDTHH:mm" (mirrors poll.js) */
function dkClock(hours = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => parts.find(x => x.type === t).value;
  const d = new Date(Date.UTC(+g('year'), +g('month') - 1, +g('day'), +(g('hour') === '24' ? '00' : g('hour')), +g('minute')));
  d.setUTCHours(d.getUTCHours() + hours);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const fmtDK = dt => { const p = n => String(n).padStart(2, '0');
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`; };

/* cache helper: Cloudflare's per-location cache, keyed by a private URL */
async function cached(ctx, name, ttl, make) {
  const cache = caches.default, key = new Request('https://api.gridkort.dk/__cache/' + name);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const val = await make();
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(val), { headers: { 'Cache-Control': 'public, max-age=' + ttl } })));
  return val;
}

async function buildFrame(ctx) {
  const nowStr = dkClock(0);
  const [psr, dap] = await Promise.all([
    getJSON(`${API}PowerSystemRightNow?limit=1&sort=Minutes1DK%20DESC`),
    cached(ctx, 'elnet-prices', PRICE_TTL, () =>
      getJSON(`${API}DayAheadPrices?start=${dkClock(-5)}&end=${dkClock(1)}&limit=400&sort=TimeDK%20DESC`))
  ]);
  const r = psr.records && psr.records[0];
  if (!r) throw new Error('PowerSystemRightNow returned no records');
  const p = {};
  PK.forEach(k => p[k] = null);
  for (const rec of dap.records) {
    if (rec.TimeDK.slice(0, 16) > nowStr) continue;
    if (PK.includes(rec.PriceArea) && p[rec.PriceArea] === null) p[rec.PriceArea] = Math.round(rec.DayAheadPriceEUR * 10) / 10;
  }
  if (PK.every(k => p[k] === null)) for (const rec of dap.records)
    if (PK.includes(rec.PriceArea) && p[rec.PriceArea] === null) p[rec.PriceArea] = Math.round(rec.DayAheadPriceEUR * 10) / 10;
  const x = {};
  XK.forEach(k => x[k] = Math.round(r['Exchange_' + (k === 'BH_SE' ? 'Bornholm_SE' : k)]));
  const frame = {
    time: fmtDK(new Date(r.Minutes1DK + 'Z')), co2: Math.round(r.CO2Emission),
    wOff: Math.round(r.OffshoreWindPower), wOn: Math.round(r.OnshoreWindPower), sol: Math.round(r.SolarPower),
    cen: Math.round(r.ProductionGe100MW), dec: Math.round(r.ProductionLt100MW),
    x, sum: Math.round(r.Exchange_Sum), p, live: true
  };
  /* same sanity gate as poll.js: never hand out a frame that renders as nonsense */
  const nums = [frame.co2, frame.wOff, frame.wOn, frame.sol, frame.cen, frame.dec, frame.sum, ...Object.values(x)];
  if (nums.some(v => !Number.isFinite(v))) throw new Error('non-numeric field in frame');
  return { generated: new Date().toISOString(), measured: r.Minutes1UTC + 'Z',
    source: 'Energinet Energi Data Service · PowerSystemRightNow + DayAheadPrices (via api.gridkort.dk)', frame };
}

/* ---- /elnet/prices.json: the quarters ahead ----
   DayAheadPriceDKK for DK1 and DK2 from the start of today (Danish time) to
   the last quarter Energinet has published - normally tomorrow 23:45 once
   the auction result lands between 13:00 and 14:00 CET. Cached 15 min, like
   the current prices in the frame; the series changes once a day. */
const AREAS = ['DK1', 'DK2'];
const STEP = 15;             // minutes - the dataset's resolution (PT15M)
const FIELD = 'DayAheadPriceDKK';
const dkDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/* API records -> the columnar series above. Identical to compactPrices() in
   prices.js, where it is documented; test/prices.test.js compares the two, so
   a change goes in both places. */
function compactPrices(records, areas = AREAS, step = STEP, field = FIELD) {
  const stepMs = step * 60000;
  const utc = s => Date.parse(/Z$/.test(s) ? s : s + 'Z');
  const rows = (records || []).filter(r => r && areas.includes(r.PriceArea) &&
    typeof r.TimeUTC === 'string' && Number.isFinite(utc(r.TimeUTC)) && Number.isFinite(r[field]));
  if (!rows.length) throw new Error('no usable price records');
  let t0 = Infinity, tEnd = -Infinity;
  for (const r of rows) { const t = utc(r.TimeUTC); if (t < t0) t0 = t; if (t > tEnd) tEnd = t; }
  const n = Math.round((tEnd - t0) / stepMs) + 1;
  if (n < 1 || n > 4 * 24 * 60 / step) throw new Error('series spans ' + n + ' slots - refusing');
  const p = {};
  areas.forEach(a => { p[a] = new Array(n).fill(null); });
  for (const r of rows) {
    const k = (utc(r.TimeUTC) - t0) / stepMs;
    if (!Number.isInteger(k)) continue;
    const v = Math.round(r[field]);
    p[r.PriceArea][k] = v === 0 ? 0 : v;   // never -0, it serialises oddly
  }
  return { t0: new Date(t0).toISOString().slice(0, 19) + 'Z', step, n, p };
}

async function buildPrices() {
  const filter = encodeURIComponent(JSON.stringify({ PriceArea: AREAS }));
  const j = await getJSON(`${API}DayAheadPrices?start=${dkDate()}T00:00&filter=${filter}` +
    `&columns=TimeUTC,PriceArea,${FIELD}&sort=TimeUTC%20ASC&limit=1000`);
  const d = compactPrices(j.records);
  /* same gate as prices.js: both areas with at least six hours, horizon ahead of now */
  for (const a of AREAS) {
    const have = d.p[a].filter(v => v !== null).length;
    if (have < 6 * 60 / STEP) throw new Error(a + ': only ' + have + ' quarters');
  }
  if (!(Date.parse(d.t0) + d.n * STEP * 60000 > Date.now())) throw new Error('series ends in the past');
  return { generated: new Date().toISOString(), source: 'Energinet (www.energidataservice.dk) · DayAheadPrices · CC BY 4.0 (via api.gridkort.dk)', unit: 'DKK/MWh', ...d };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), h = cors(req.headers.get('Origin'));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...h, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: h });
    if (url.pathname === '/') return new Response('gridkort.dk data service. Energinet Energi Data Service, cached. Map: https://el.gridkort.dk/\n', { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } });
    /* two routes, one cache name and TTL each. A failure is cached briefly
       under the same name - for Retry-After seconds after a 429 - so a
       hiccup at Energinet is not met with a flood of retries. */
    const route = url.pathname === '/elnet/now.json' ? ['elnet-now', FRAME_TTL, () => buildFrame(ctx)]
      : url.pathname === '/elnet/prices.json' ? ['elnet-prices-ahead', PRICE_TTL, buildPrices] : null;
    if (!route) return new Response('Not found', { status: 404, headers: h });
    const [name, ttl, make] = route;
    let out, status = 200;
    try { out = await cached(ctx, name, ttl, make); }
    catch (e) {
      out = { error: String(e.message || e) }; status = 502;
      const hold = Math.min(300, Math.max(FAIL_TTL, e.retryAfter || 0));
      ctx.waitUntil(caches.default.put(new Request('https://api.gridkort.dk/__cache/' + name),
        new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'public, max-age=' + hold } })));
    }
    if (out && out.error) status = 502;
    return new Response(JSON.stringify(out), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
};
