/* ============================================================
   PRICE POLLER  ->  prices.json
   ------------------------------------------------------------
   Day-ahead prices for DK1 and DK2 in 15-minute resolution, from the
   start of today (Danish time) to the end of what Energinet has
   published - normally through tomorrow 23:45 once the day-ahead
   auction result lands around 13:00 CET. The map draws them as the
   "Kommende spotpriser" strip under the timeline and finds the
   cheapest 1, 3 and 8 hour windows in them.

   Why a script and not the browser: the same reason as poll.js -
   api.energidataservice.dk answers every request that carries an
   Origin header with an empty 200.

   Output is columnar like hist.json. Prices are EUR/MWh x 10 as
   integers, null where a quarter is missing. The axis is UTC on
   purpose: Danish wall-clock jumps on the DST days (25-10-2026 has
   25 hours), and the map makes the labels per slot with Intl.

     { source, t0: "YYYY-MM-DDTHH:mm:ssZ", step: 15, n,
       p: { DK1: [...], DK2: [...] } }

   Usage:  node prices.js [outfile]       (default: prices.json)
   Exit code 1 on failure, and the file is then NOT written, so the
   previous prices.json stays in place.
   ============================================================ */
const fs = require('fs');

const API = 'https://api.energidataservice.dk/dataset/';
const AREAS = ['DK1', 'DK2'];
const STEP = 15;   // minutes - the dataset's resolution (PT15M)

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'danmarks-elnet-poller' } });
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

/* today's date on the Danish wall clock, "YYYY-MM-DD" - the API's start/end
   parameters are read as Danish time (see poll.js) */
function dkDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/* API records -> the columnar series above. Pure, so test/prices.test.js can
   run it. Copied verbatim into worker/worker.js - keep the two identical
   (the test compares them). Records from other areas, without a usable price,
   or off the quarter-hour grid are left out rather than guessed at. */
function compactPrices(records, areas = AREAS, step = STEP) {
  const stepMs = step * 60000;
  const utc = s => Date.parse(/Z$/.test(s) ? s : s + 'Z');
  const rows = (records || []).filter(r => r && areas.includes(r.PriceArea) &&
    typeof r.TimeUTC === 'string' && Number.isFinite(utc(r.TimeUTC)) && Number.isFinite(r.DayAheadPriceEUR));
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
    const v = Math.round(r.DayAheadPriceEUR * 10);
    p[r.PriceArea][k] = v === 0 ? 0 : v;   // never -0, it serialises oddly
  }
  return { t0: new Date(t0).toISOString().slice(0, 19) + 'Z', step, n, p };
}

async function main() {
  const OUT = process.argv[2] || 'prices.json';
  const filter = encodeURIComponent(JSON.stringify({ PriceArea: AREAS }));
  const url = `${API}DayAheadPrices?start=${dkDate()}T00:00&filter=${filter}` +
    '&columns=TimeUTC,PriceArea,DayAheadPriceEUR&sort=TimeUTC%20ASC&limit=1000';
  const j = await getJSON(url);
  const d = compactPrices(j.records);

  /* Sanity gate, same spirit as poll.js: never publish a series the map would
     draw as nonsense. Both areas present with at least six hours each, and a
     horizon that has not already passed. */
  for (const a of AREAS) {
    const have = d.p[a].filter(v => v !== null).length;
    if (have < 6 * 60 / STEP) throw new Error(`${a}: only ${have} quarters - not publishing`);
  }
  const end = Date.parse(d.t0) + d.n * STEP * 60000;
  if (!(end > Date.now())) throw new Error('series ends in the past - not publishing');

  const out = { source: 'Energinet Energi Data Service · DayAheadPrices', ...d };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const hoursAhead = Math.round((end - Date.now()) / 3600000);
  console.log(`wrote ${OUT}  (${JSON.stringify(out).length} bytes)`);
  console.log(`  ${d.n} quarters from ${d.t0}, ends ${hoursAhead} h from now`);
  console.log(`  DK1 ${d.p.DK1.filter(v => v !== null).length} values, DK2 ${d.p.DK2.filter(v => v !== null).length} values`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('PRICES FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { compactPrices, AREAS, STEP };
