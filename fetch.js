// Pull 30 days of Danish grid history + prices from Energinet's open data API
const fs = require('fs');

const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) { await sleep(900); return await r.json(); }
      console.error('HTTP', r.status, url.slice(0, 110));
    } catch (e) { console.error('ERR', e.message); }
    await sleep(3000 * (i + 1));
  }
  throw new Error('failed: ' + url);
}

(async () => {
  const now = new Date();
  const days = [];
  for (let i = 30; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    days.push(dstr(d));
  }
  // days[] ends at TODAY, so every window below stops at midnight. Reaching
  // one day past the end is what lets the last window include today itself.
  const tomorrow = dstr(new Date(now.getTime() + 86400000));

  // ---- 1. PowerSystemRightNow, day by day, aggregated to hourly ----
  const hourly = new Map(); // "YYYY-MM-DDTHH" -> {sum fields, n}
  const FIELDS = ['CO2Emission', 'ProductionGe100MW', 'ProductionLt100MW', 'SolarPower',
    'OffshoreWindPower', 'OnshoreWindPower', 'Exchange_Sum', 'Exchange_DK1_DE',
    'Exchange_DK1_NL', 'Exchange_DK1_GB', 'Exchange_DK1_NO', 'Exchange_DK1_SE',
    'Exchange_DK1_DK2', 'Exchange_DK2_DE', 'Exchange_DK2_SE', 'Exchange_Bornholm_SE'];

  const cacheFile = 'power_raw.json';
  let cached = null;
  if (fs.existsSync(cacheFile)) {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // the cache exists to resume an interrupted fetch — only trust it if it
    // already covers the newest full day, otherwise refetch everything
    const newest = Object.keys(raw).sort().pop() || '';
    const wantLast = days[days.length - 2] + 'T23';
    if (newest >= wantLast) {
      cached = raw;
      for (const [k, v] of Object.entries(cached)) hourly.set(k, v);
      console.error('loaded cache:', hourly.size, 'hours');
    } else {
      console.error(`cache stale (ends ${newest}, need ${wantLast}) — refetching`);
    }
  }

  for (let i = 0; i < days.length - 1 && !cached; i++) {
    const url = `https://api.energidataservice.dk/dataset/PowerSystemRightNow?start=${days[i]}T00:00&end=${days[i + 1]}T00:00&limit=1600&sort=Minutes1DK%20ASC`;
    const j = await getJSON(url);
    for (const rec of j.records) {
      const key = rec.Minutes1DK.slice(0, 13); // YYYY-MM-DDTHH
      let a = hourly.get(key);
      if (!a) { a = { n: 0 }; FIELDS.forEach(f => a[f] = 0); hourly.set(key, a); }
      a.n++;
      for (const f of FIELDS) a[f] += (rec[f] ?? 0);
    }
    process.stderr.write(`\r${days[i]} -> ${j.records.length} recs, ${hourly.size} hours`);
  }
  console.error('');
  if (!cached) fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(hourly)));

  /* ---- 1b. today ----------------------------------------------------------
     The loop above walks WHOLE days: its last window is yesterday 00:00 ->
     today 00:00, so the newest hour it can produce is yesterday 23:00. When
     the timeline was rebuilt by hand that lag did not matter. Now that it is
     refreshed several times a day, that lag IS the problem being fixed - it
     leaves a rolling one-to-two day hole between the right-hand end of the
     scrubber and the live reading.

     Today is fetched on its own, outside the cache path, because today is by
     definition incomplete and must never be written into a cache that a later
     run would trust. */
  {
    const today = days[days.length - 1];
    const url = `https://api.energidataservice.dk/dataset/PowerSystemRightNow?start=${today}T00:00&end=${tomorrow}T00:00&limit=1600&sort=Minutes1DK%20ASC`;
    const j = await getJSON(url);
    for (const rec of j.records) {
      const key = rec.Minutes1DK.slice(0, 13);
      let a = hourly.get(key);
      if (!a) { a = { n: 0 }; FIELDS.forEach(f => a[f] = 0); hourly.set(key, a); }
      a.n++;
      for (const f of FIELDS) a[f] += (rec[f] ?? 0);
    }
    console.error(`today ${today} -> ${j.records.length} recs, ${hourly.size} hours total`);
  }

  /* Drop the hour still in progress. PowerSystemRightNow publishes once a
     minute, so a finished hour carries ~60 readings and the running one carries
     however many have happened so far. Averaging a part-hour is not wrong, but
     it makes the last point of the scrubber twitch as the hour fills, so cut any
     trailing hour that is less than three quarters observed. */
  for (;;) {
    const ks = [...hourly.keys()].sort();
    const last = ks[ks.length - 1];
    if (!last || hourly.get(last).n >= 45) break;
    console.error(`dropping part-hour ${last} (${hourly.get(last).n} readings)`);
    hourly.delete(last);
  }

  // ---- 2. DayAheadPrices for the same window ----
  const areas = ['DK1', 'DK2', 'DE', 'NO2', 'SE3', 'SE4', 'NL'];
  const priceByHour = new Map(); // key -> {DK1:..,DK2:..}
  for (let i = 0; i < days.length - 1; i += 2) {
    // reach past the end on the final window, so today carries prices too -
    // otherwise the newest hours arrive with a null price and the price line
    // in the scrubber stops short of the rest of the series
    const end = i + 2 >= days.length - 1 ? tomorrow : days[i + 2];
    const url = `https://api.energidataservice.dk/dataset/DayAheadPrices?start=${days[i]}T00:00&end=${end}T00:00&limit=6000&sort=TimeDK%20ASC`;
    const j = await getJSON(url);
    for (const rec of j.records) {
      if (!areas.includes(rec.PriceArea)) continue;
      const key = rec.TimeDK.slice(0, 13);
      let a = priceByHour.get(key);
      if (!a) { a = {}; priceByHour.set(key, a); }
      const cur = a[rec.PriceArea];
      // average the 15-min MTUs into the hour
      if (!cur) a[rec.PriceArea] = { s: rec.DayAheadPriceEUR, n: 1 };
      else { cur.s += rec.DayAheadPriceEUR; cur.n++; }
    }
    process.stderr.write(`\rprices ${days[i]} -> ${j.records.length} recs, ${priceByHour.size} hours`);
  }
  console.error('');

  // ---- 3. merge to a compact series ----
  const keys = [...hourly.keys()].sort();
  const series = keys.map(k => {
    const a = hourly.get(k);
    const n = a.n || 1;
    const p = priceByHour.get(k) || {};
    const pv = area => (p[area] ? Math.round(p[area].s / p[area].n * 10) / 10 : null);
    const r = v => Math.round(a[v] / n);
    return {
      t: k,
      co2: Math.round(a.CO2Emission / n),
      wOff: r('OffshoreWindPower'), wOn: r('OnshoreWindPower'), sol: r('SolarPower'),
      cen: r('ProductionGe100MW'), dec: r('ProductionLt100MW'),
      x: {
        DK1_DE: r('Exchange_DK1_DE'), DK1_NL: r('Exchange_DK1_NL'), DK1_GB: r('Exchange_DK1_GB'),
        DK1_NO: r('Exchange_DK1_NO'), DK1_SE: r('Exchange_DK1_SE'), DK1_DK2: r('Exchange_DK1_DK2'),
        DK2_DE: r('Exchange_DK2_DE'), DK2_SE: r('Exchange_DK2_SE'), BH_SE: r('Exchange_Bornholm_SE')
      },
      sum: r('Exchange_Sum'),
      p: { DK1: pv('DK1'), DK2: pv('DK2'), DE: pv('DE'), NO2: pv('NO2'), SE3: pv('SE3'), SE4: pv('SE4'), NL: pv('NL') }
    };
  });

  fs.writeFileSync('history.json', JSON.stringify(series));
  console.error(`\nWrote ${series.length} hours, ${(JSON.stringify(series).length / 1024).toFixed(0)} KB`);
  console.error('first', series[0].t, 'last', series[series.length - 1].t);
  console.error('sample', JSON.stringify(series[series.length - 1]));

  // quick stats to sanity check
  const maxWind = Math.max(...series.map(s => s.wOff + s.wOn));
  const maxSol = Math.max(...series.map(s => s.sol));
  const maxP = Math.max(...series.map(s => s.p.DK1 ?? 0));
  const minP = Math.min(...series.map(s => s.p.DK1 ?? 0));
  console.error({ maxWind, maxSol, maxPriceDK1: maxP, minPriceDK1: minP });
})();
