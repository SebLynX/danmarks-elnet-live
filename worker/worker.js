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

   The same three pipeline files are also served here, unchanged, at
   /hist.json, /data.json and /prices.json. They are read from
   env.DATA_ORIGIN (the el-gridkort Worker's https origin, no path) so a
   private repo does not take the EXPO build's copies with it.
   /elnet/now.json and /elnet/prices.json stay the live routes.

   Why a Worker at all: api.energidataservice.dk answers every
   request that carries an Origin header (= every browser request)
   with an empty 200. A Worker is not a browser; it sends no Origin
   and gets the data. It then hands the frame to the map with a CORS
   header naming the map's own address.

   Politeness towards Energinet: their API guide asks for one request
   per dataset per update cycle, and Energinet now enforces it with
   per-dataset rate limits (HTTP 429 "Rate limit is exceeded. Try again
   in X seconds"; asking again before then can keep the block going).
   PowerSystemRightNow updates every minute, so the frame is cached for
   60 s. Day-ahead prices change once a day, so they are cached for an
   hour. A 429 pauses that one dataset for the whole wait Energinet
   names (block marker below), and nothing is sent for it until then.
   The frame no longer stands or falls with the prices: if they are
   refused, the last good ones are used.

   03-11-2026: the Worker had been answering 502 "HTTP 429" since the
   morning. It asked for prices every 15 min per Cloudflare location on
   two routes, read the wait only from a Retry-After header and capped
   it at 5 min, so it kept asking during the block.
   ============================================================ */
const API = 'https://api.energidataservice.dk/dataset/';
const FRAME_TTL = 60, PRICE_TTL = 3600, FAIL_TTL = 30;
const WAIT_DEFAULT = 900, WAIT_MAX = 6 * 3600, LAST_TTL = 2 * 86400;

/* must stay identical to XK / PK in the map (src/data.js) and poll.js */
const XK = ['DK1_DE', 'DK1_NL', 'DK1_GB', 'DK1_NO', 'DK1_SE', 'DK1_DK2', 'DK2_DE', 'DK2_SE', 'BH_SE'];
const PK = ['DK1', 'DK2', 'DE', 'NO2', 'SE3', 'SE4'];

/* Exact origins, no subdomain wildcards. Checked 2026-11-12: the live
   el.gridkort.dk page and the EXPO build both fetch this host. The same
   index.html is what seblynx.github.io would run; that host 301s to
   el.gridkort.dk today. 'null' is a map opened from disk (file://).
   The data is public and read-only, and credentials are not allowed.
   gridkort.dk, vind.gridkort.dk and energinet.dk do not call this API. */
const ALLOW = new Set([
  'https://el.gridkort.dk',
  'https://seblynx.github.io',
  'https://expo.energinet.dk',
  'null'
]);
const cors = origin => origin && ALLOW.has(origin)
  ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };

/* One dataset at a time. While a dataset's block marker is in the cache,
   it is not asked at all. An HTTP 429 sets the marker for the wait
   Energinet names - Retry-After, or "Try again in X seconds" in the body,
   else 15 min - up to 6 h. */
const datasetOf = url => url.slice(API.length).split('?')[0];
const key = name => new Request('https://api.gridkort.dk/__cache/' + name);
async function getJSON(url) {
  const ds = datasetOf(url);
  const blocked = await caches.default.match(key('block-' + ds));
  if (blocked) { const b = await blocked.json(); throw new Error('HTTP 429 (' + ds + ' paused until ' + b.until + ')'); }
  const r = await fetch(url, { headers: { 'User-Agent': 'gridkort-api (gridkort.dk, hobby map)' }, signal: AbortSignal.timeout(8000) });
  if (r.status === 429) {
    const body = await r.text().catch(() => '');
    const m = /try again in\s+(\d+)\s*s/i.exec(body);
    const wait = Math.min(WAIT_MAX, Number(r.headers.get('Retry-After')) || (m ? Number(m[1]) : 0) || WAIT_DEFAULT);
    const until = new Date(Date.now() + wait * 1000).toISOString();
    await caches.default.put(key('block-' + ds), new Response(JSON.stringify({ until, wait, said: body.slice(0, 200) }),
      { headers: { 'Cache-Control': 'public, max-age=' + wait } }));
    throw new Error('HTTP 429 (' + ds + ' paused until ' + until + ')');
  }
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

/* cache helper: Cloudflare's per-location cache, keyed by a private URL.
   A good value is also kept for two days as 'last-<name>', for lastGood(). */
async function cached(ctx, name, ttl, make) {
  const cache = caches.default;
  const hit = await cache.match(key(name));
  if (hit) return hit.json();
  const val = await make();
  const body = JSON.stringify(val);
  ctx.waitUntil(Promise.all([
    cache.put(key(name), new Response(body, { headers: { 'Cache-Control': 'public, max-age=' + ttl } })),
    cache.put(key('last-' + name), new Response(body, { headers: { 'Cache-Control': 'public, max-age=' + LAST_TTL } }))
  ]));
  return val;
}
async function lastGood(name) {
  const hit = await caches.default.match(key('last-' + name));
  return hit ? hit.json() : null;
}

async function buildFrame(ctx) {
  const nowStr = dkClock(0);
  /* the prices are a side dish: refused or failing, the frame uses the last good ones (or none) */
  const [psr, dap] = await Promise.all([
    getJSON(`${API}PowerSystemRightNow?limit=1&sort=Minutes1DK%20DESC`),
    cached(ctx, 'elnet-prices', PRICE_TTL, () =>
      getJSON(`${API}DayAheadPrices?start=${dkClock(-5)}&end=${dkClock(1)}&limit=400&sort=TimeDK%20DESC`))
      .catch(async () => (await lastGood('elnet-prices')) || { records: [] })
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
   the auction result lands between 13:00 and 14:00 CET. Cached an hour, like
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

/* Pipeline files published by the el-gridkort Worker. Not the live
   /elnet/now.json and /elnet/prices.json routes: those still ask Energinet.
   Prefer env.DATA, a service binding to el-gridkort. Plain fetch() to that
   Worker's workers.dev hostname on the same account fails; see
   https://developers.cloudflare.com/workers/runtime-apis/fetch/
   DATA_ORIGIN is only the fallback when the binding is absent, and it must
   be an https origin with no path that is not a same-account Worker. */
const SNAPSHOT_TTL = 60;
const SNAPSHOTS = { '/hist.json': 'hist.json', '/data.json': 'data.json', '/prices.json': 'prices.json' };
function snapshotOrigin(env) {
  const raw = env && typeof env.DATA_ORIGIN === 'string' ? env.DATA_ORIGIN.trim() : '';
  if (!raw) return { error: 'DATA_ORIGIN is not set' };
  let u;
  try { u = new URL(raw); } catch (e) { return { error: 'DATA_ORIGIN must be an https origin' }; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return { error: 'DATA_ORIGIN must be an https origin' };
  if (u.pathname !== '/' && u.pathname !== '') return { error: 'DATA_ORIGIN must be an https origin' };
  return { origin: u.origin };
}
function snapHeaders(h) {
  return { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}
async function readSnapshot(r) {
  if (r.status >= 300 && r.status < 400) throw new Error('redirect refused');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const body = await r.text();
  if (!body.trim() || body.length > 2000000) throw new Error('unexpected snapshot size');
  return body;
}
async function fetchSnapshot(env, file) {
  if (env && env.DATA && typeof env.DATA.fetch === 'function') {
    return readSnapshot(await env.DATA.fetch(new Request('https://el-gridkort.internal/' + file, { method: 'GET' })));
  }
  const where = snapshotOrigin(env);
  if (!where.origin) {
    const err = new Error(where.error);
    err.code = 503;
    throw err;
  }
  return readSnapshot(await fetch(where.origin + '/' + file, {
    method: 'GET', redirect: 'manual',
    headers: { 'User-Agent': 'gridkort-api (gridkort.dk, hobby map)' },
    signal: AbortSignal.timeout(8000)
  }));
}
async function serveSnapshot(env, ctx, file, h) {
  const cacheName = 'snapshot-' + file;
  try {
    const hit = await caches.default.match(key(cacheName));
    if (hit) return new Response(await hit.text(), { status: 200, headers: snapHeaders(h) });
    const body = await fetchSnapshot(env, file);
    if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(key(cacheName),
      new Response(body, { headers: { 'Cache-Control': 'public, max-age=' + SNAPSHOT_TTL } })));
    return new Response(body, { status: 200, headers: snapHeaders(h) });
  } catch (e) {
    if (e && e.code === 503) return new Response(JSON.stringify({ error: e.message }), { status: 503, headers: snapHeaders(h) });
    console.error(JSON.stringify({ message: 'snapshot failed', file, error: String(e && e.message || e) }));
    return new Response(JSON.stringify({ error: 'snapshot unavailable' }), { status: 502, headers: snapHeaders(h) });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), h = cors(req.headers.get('Origin'));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...h, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: h });
    if (SNAPSHOTS[url.pathname]) return serveSnapshot(env, ctx, SNAPSHOTS[url.pathname], h);
    if (url.pathname === '/') return new Response('gridkort.dk data service. Energinet Energi Data Service, cached. Map: https://el.gridkort.dk/\n', { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } });
    /* what this Cloudflare location is waiting for: one line per paused dataset */
    if (url.pathname === '/elnet/status') {
      const out = { checked: new Date().toISOString(), paused: {} };
      for (const ds of ['PowerSystemRightNow', 'DayAheadPrices']) {
        const b = await caches.default.match(key('block-' + ds));
        if (b) out.paused[ds] = await b.json();
      }
      return new Response(JSON.stringify(out), { headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    /* two routes, one cache name and TTL each. A failure is cached for 30 s
       under the same name; a 429 is held per dataset by getJSON's block
       marker, however long Energinet asks. The quarters ahead fall back to
       the last good series while it still reaches past now. */
    const route = url.pathname === '/elnet/now.json' ? ['elnet-now', FRAME_TTL, () => buildFrame(ctx)]
      : url.pathname === '/elnet/prices.json' ? ['elnet-prices-ahead', PRICE_TTL, buildPrices] : null;
    if (!route) return new Response('Not found', { status: 404, headers: h });
    const [name, ttl, make] = route;
    let out, status = 200;
    try { out = await cached(ctx, name, ttl, make); }
    catch (e) {
      const last = name === 'elnet-prices-ahead' ? await lastGood(name) : null;
      if (last && Date.parse(last.t0) + last.n * last.step * 60000 > Date.now()) out = last;
      else {
        out = { error: String(e.message || e) }; status = 502;
        ctx.waitUntil(caches.default.put(key(name),
          new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'public, max-age=' + FAIL_TTL } })));
      }
    }
    if (out && out.error) status = 502;
    return new Response(JSON.stringify(out), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
};
