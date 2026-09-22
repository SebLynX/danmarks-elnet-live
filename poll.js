/* ============================================================
   LIVE POLLER  ->  data.json
   ------------------------------------------------------------
   Why this exists: api.energidataservice.dk answers normally to
   requests WITHOUT an Origin header, and returns an empty 200 to
   every browser request (verified again 2026-09-22 — "null" and a
   real site origin both get 0 bytes). So the browser can never
   reach the API, but a script like this one can.

   This script runs somewhere that is not a browser, writes one
   small JSON file, and the static site reads that file from its
   own folder. Same origin, so CORS never enters the picture.

   Output shape is exactly the frame the app already uses
   internally, so the browser does no assembly work:

     { generated, source, frame: { time, co2, wOff, wOn, sol,
       cen, dec, x{...}, sum, p{...}, live } }

   Usage:  node poll.js [outfile]        (default: data.json)
   Exit code 1 on failure, so a scheduler shows the run as failed
   instead of silently writing nothing.
   ============================================================ */
const fs = require('fs');

const OUT = process.argv[2] || 'data.json';
const API = 'https://api.energidataservice.dk/dataset/';

/* must stay identical to XK / PK in src/data.js */
const XK = ['DK1_DE', 'DK1_NL', 'DK1_GB', 'DK1_NO', 'DK1_SE', 'DK1_DK2', 'DK2_DE', 'DK2_SE', 'BH_SE'];
const PK = ['DK1', 'DK2', 'DE', 'NO2', 'SE3', 'SE4'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'danmarks-elnet-poller' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      /* An empty 200 is the signature of the Origin allowlist rejecting us.
         Treat it as a hard error rather than letting JSON.parse throw a
         confusing "Unexpected end of JSON input". */
      if (!text.trim()) throw new Error('empty 200 — request was treated as browser traffic');
      return JSON.parse(text);
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`${last.message}  <- ${url.slice(0, 120)}`);
}

/* Danish wall-clock offset by `hours`, in the API's "YYYY-MM-DDTHH:mm" form.
   Mirrors dkClock() in src/data.js. */
function dkClock(hours = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => parts.find(x => x.type === t).value;
  const h24 = g('hour') === '24' ? '00' : g('hour');
  const d = new Date(Date.UTC(+g('year'), +g('month') - 1, +g('day'), +h24, +g('minute')));
  d.setUTCHours(d.getUTCHours() + hours);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/* "DD-MM-YYYY HH:MM". Minutes1DK is already Danish wall-clock, so we append
   Z and read the UTC parts back out — no timezone shifting. */
function fmtDK(dt) {
  const p = n => String(n).padStart(2, '0');
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

(async () => {
  const nowStr = dkClock(0);

  /* DayAheadPrices publishes tomorrow's intervals, so an unbounded query
     returns only future MTUs — ask for a window around now instead. */
  const priceUrl = `${API}DayAheadPrices?start=${dkClock(-5)}&end=${dkClock(1)}&limit=400&sort=TimeDK%20DESC`;

  const [psr, dap] = await Promise.all([
    getJSON(`${API}PowerSystemRightNow?limit=1&sort=Minutes1DK%20DESC`),
    getJSON(priceUrl)
  ]);

  const r = psr.records && psr.records[0];
  if (!r) throw new Error('PowerSystemRightNow returned no records');

  /* newest interval at or before now, per price area */
  const p = {};
  PK.forEach(k => p[k] = null);
  for (const rec of dap.records) {
    if (rec.TimeDK.slice(0, 16) > nowStr) continue;
    if (PK.includes(rec.PriceArea) && p[rec.PriceArea] === null) {
      p[rec.PriceArea] = Math.round(rec.DayAheadPriceEUR * 10) / 10;
    }
  }
  // clock-skew fallback: nothing resolved -> take the newest available
  if (PK.every(k => p[k] === null)) {
    for (const rec of dap.records) {
      if (PK.includes(rec.PriceArea) && p[rec.PriceArea] === null) {
        p[rec.PriceArea] = Math.round(rec.DayAheadPriceEUR * 10) / 10;
      }
    }
  }

  const x = {};
  XK.forEach(k => x[k] = Math.round(r['Exchange_' + (k === 'BH_SE' ? 'Bornholm_SE' : k)]));

  const frame = {
    time: fmtDK(new Date(r.Minutes1DK + 'Z')),
    co2: Math.round(r.CO2Emission),
    wOff: Math.round(r.OffshoreWindPower),
    wOn: Math.round(r.OnshoreWindPower),
    sol: Math.round(r.SolarPower),
    cen: Math.round(r.ProductionGe100MW),
    dec: Math.round(r.ProductionLt100MW),
    x, sum: Math.round(r.Exchange_Sum), p,
    live: true
  };

  /* Sanity gate: never publish a frame that would render as nonsense.
     Better to fail loudly and leave the previous data.json in place. */
  const nums = [frame.co2, frame.wOff, frame.wOn, frame.sol, frame.cen, frame.dec, frame.sum,
    ...Object.values(frame.x)];
  if (nums.some(v => !Number.isFinite(v))) throw new Error('non-numeric field in frame: ' + JSON.stringify(frame));
  if (!/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/.test(frame.time)) throw new Error('bad timestamp: ' + frame.time);

  const out = {
    generated: new Date().toISOString(),   // when this file was written (UTC)
    measured: r.Minutes1UTC + 'Z',         // when Energinet measured it (UTC)
    source: 'Energinet Energi Data Service · PowerSystemRightNow + DayAheadPrices',
    frame
  };

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`wrote ${OUT}  (${JSON.stringify(out).length} bytes)`);
  console.log(`  measured ${frame.time} DK   CO2 ${frame.co2} g/kWh   net ${frame.sum} MW`);
  console.log(`  wind ${frame.wOff + frame.wOn} MW   sol ${frame.sol} MW   DK1 ${p.DK1} EUR/MWh`);
})().catch(e => {
  console.error('POLL FAILED:', e.message);
  process.exit(1);
});
