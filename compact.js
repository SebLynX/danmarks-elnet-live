// Convert history.json (fetch.js output, array of hourly records) into the
// columnar hist_compact.json that build.js embeds. Prices are stored as
// integers ×10 (data.js divides by 10 on read); nulls are preserved.
// Row index is NOT the hour offset — the source can have gaps — so hour
// offsets from t0 are stored explicitly in `off`.
const fs = require('fs');

const series = JSON.parse(fs.readFileSync('history.json', 'utf8'));
if (!series.length) throw new Error('history.json is empty');

const XK = ['DK1_DE', 'DK1_NL', 'DK1_GB', 'DK1_NO', 'DK1_SE', 'DK1_DK2', 'DK2_DE', 'DK2_SE', 'BH_SE'];
const PK = ['DK1', 'DK2', 'DE', 'NO2', 'SE3', 'SE4'];

const t0 = series[0].t;
const hourMs = 3600000;
const base = Date.parse(t0 + ':00:00Z');

const out = {
  t0,
  n: series.length,
  off: series.map(r => Math.round((Date.parse(r.t + ':00:00Z') - base) / hourMs)),
  co2: series.map(r => r.co2),
  wOff: series.map(r => r.wOff),
  wOn: series.map(r => r.wOn),
  sol: series.map(r => r.sol),
  cen: series.map(r => r.cen),
  dec: series.map(r => r.dec),
  sum: series.map(r => r.sum),
  x: {},
  p: {}
};
XK.forEach(k => out.x[k] = series.map(r => r.x[k]));
PK.forEach(k => out.p[k] = series.map(r => r.p[k] === null ? null : Math.round(r.p[k] * 10)));

fs.writeFileSync('hist_compact.json', JSON.stringify(out));
console.log(`hist_compact.json: ${out.n} hours, ${t0} .. ${series[series.length - 1].t}, ` +
  (fs.statSync('hist_compact.json').size / 1024).toFixed(0) + ' KB');
