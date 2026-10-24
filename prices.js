/* ============================================================
   PRICE POLLER  ->  prices.json
   ------------------------------------------------------------
   Day-ahead prices for DK1 and DK2 in 15-minute resolution, from the
   start of today (Danish time) to the end of what Energinet has
   published - normally through tomorrow 23:45 once the day-ahead
   auction result lands between 13:00 and 14:00 CET. The map draws
   them as the "Kommende elpriser" strip under the timeline and finds
   the cheapest 1, 3 and 8 hour windows in them.

   The browser never calls Energinet for this. Energinet asks sites to
   download the data and serve it themselves, so this runs in the
   update pipeline (.github/workflows/update-data.yml, like poll.js)
   and the page reads the file it writes.

   Source: dataset DayAheadPrices, field DayAheadPriceDKK (DKK/MWh;
   kr./kWh = value / 1000). Licence CC BY 4.0 - the map credits
   "Energinet (www.energidataservice.dk)" and says the figures are
   processed. Elspotprices (hourly) stopped in September 2025 and is
   not used.

   Output is columnar like hist.json. Prices are whole DKK/MWh, null
   where a quarter is missing. The axis is UTC on purpose: Danish
   wall-clock jumps on the DST days (25-10-2026 has 25 hours), and
   the map makes the labels per slot with Intl.

     { source, unit: "DKK/MWh", t0: "YYYY-MM-DDTHH:mm:ssZ", step: 15, n,
       p: { DK1: [...], DK2: [...] } }

   Politeness: one request per run, two more at most while waiting
   for tomorrow's prices after 13:00, and a pause before any retry
   after HTTP 429 (Retry-After when sent, else a growing back-off).

   Usage:  node prices.js [outfile]       (default: prices.json)
   Exit code 1 on failure, and the file is then NOT written, so the
   previous prices.json stays in place.
   ============================================================ */
const fs = require('fs');

const API = 'https://api.energidataservice.dk/dataset/';
const AREAS = ['DK1', 'DK2'];
const STEP = 15;             // minutes - the dataset's resolution (PT15M)
const FIELD = 'DayAheadPriceDKK';
const PUBLISH_HOUR = 13;     // Danish local time from which tomorrow's prices are expected
const WAIT_TRIES = 4, WAIT_MS = 120000;   // how long a run waits for them: 4 × 2 min

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

/* GET + JSON with retries. HTTP 429 is answered with a pause - Retry-After
   when Energinet sends one, otherwise 30 s doubling - never a tight loop.
   `sleep` and `fetchFn` are injectable so the tests can run this without
   the network or the waiting. */
async function getJSON(url, { tries = 5, sleep = defaultSleep, fetchFn = fetch, log = () => {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchFn(url, { headers: { 'User-Agent': 'danmarks-elnet-poller (gridkort.dk)' } });
      if (r.status === 429) {
        const ra = Number(r.headers && r.headers.get && r.headers.get('Retry-After'));
        const wait = Math.min(300, Number.isFinite(ra) && ra > 0 ? ra : 30 * 2 ** i) * 1000;
        log(`HTTP 429 - backing off ${wait / 1000} s`);
        last = new Error('HTTP 429');
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (!text.trim()) throw new Error('empty 200 — request was treated as browser traffic');
      return JSON.parse(text);
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`${last.message}  <- ${url.slice(0, 120)}`);
}

/* Danish wall-clock date and hour of a UTC millisecond stamp */
const DKF = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function dkParts(ms) {
  const o = {};
  DKF.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour % 24 };
}

/* API records -> the columnar series above. Pure, so test/prices.test.js can
   run it. Records from other areas, without a usable price, or off the
   quarter-hour grid are left out rather than guessed at. */
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

/* Does the series reach into tomorrow (Danish calendar) as seen from `now`? */
function coversTomorrow(d, now = Date.now()) {
  const last = Date.parse(d.t0) + (d.n - 1) * d.step * 60000;
  return dkParts(last).date > dkParts(now).date;
}

async function fetchSeries(log) {
  const today = dkParts(Date.now()).date;
  const filter = encodeURIComponent(JSON.stringify({ PriceArea: AREAS }));
  const url = `${API}DayAheadPrices?start=${today}T00:00&filter=${filter}` +
    `&columns=TimeUTC,PriceArea,${FIELD}&sort=TimeUTC%20ASC&limit=1000`;
  return compactPrices((await getJSON(url, { log })).records);
}

async function main() {
  const OUT = process.argv[2] || 'prices.json';
  const log = m => console.log('  ' + m);
  let d = await fetchSeries(log);

  /* After 13:00 Danish time tomorrow's quarters are due. If they are not in
     yet, wait and ask again a few times, so the run that happens to land in
     the publication window brings them home instead of leaving the map
     without an evening-to-morning horizon until the next run. */
  for (let i = 0; i < WAIT_TRIES && dkParts(Date.now()).hour >= PUBLISH_HOUR && !coversTomorrow(d); i++) {
    log(`tomorrow not published yet - waiting ${WAIT_MS / 60000} min (${i + 1}/${WAIT_TRIES})`);
    await defaultSleep(WAIT_MS);
    try { d = await fetchSeries(log); } catch (e) { log('retry failed: ' + e.message); }
  }

  /* Sanity gate, same spirit as poll.js: never publish a series the map would
     draw as nonsense. Both areas present with at least six hours each, and a
     horizon that has not already passed. */
  for (const a of AREAS) {
    const have = d.p[a].filter(v => v !== null).length;
    if (have < 6 * 60 / STEP) throw new Error(`${a}: only ${have} quarters - not publishing`);
  }
  const end = Date.parse(d.t0) + d.n * STEP * 60000;
  if (!(end > Date.now())) throw new Error('series ends in the past - not publishing');

  const out = { source: 'Energinet (www.energidataservice.dk) · DayAheadPrices · CC BY 4.0', unit: 'DKK/MWh', ...d };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const hoursAhead = Math.round((end - Date.now()) / 3600000);
  console.log(`wrote ${OUT}  (${JSON.stringify(out).length} bytes)`);
  console.log(`  ${d.n} quarters from ${d.t0}, ends ${hoursAhead} h from now, tomorrow ${coversTomorrow(d) ? 'included' : 'not yet published'}`);
  console.log(`  DK1 ${d.p.DK1.filter(v => v !== null).length} values, DK2 ${d.p.DK2.filter(v => v !== null).length} values`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('PRICES FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { compactPrices, coversTomorrow, getJSON, AREAS, STEP, FIELD };
