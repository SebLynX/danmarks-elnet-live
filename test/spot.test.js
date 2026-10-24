/* Tests for the SPOT block in index.html: the cheapest-window maths and the
   SVG/HTML rendering of the upcoming-prices strip. The block is pure, so it
   is cut out of the shipped index.html by its markers and run here as-is -
   what is tested is exactly what the browser gets.

   Run:  node --test            (Node 18+, no packages)                      */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const block = html.match(/\/\* SPOT-LIB:BEGIN \*\/([\s\S]*?)\/\* SPOT-LIB:END \*\//);
assert.ok(block, 'index.html must carry the SPOT-LIB block');
// run in this realm (not a fresh context) so the objects it returns share our
// prototypes and assert.deepEqual can compare them
const SPOT = vm.runInThisContext('(() => {' + block[1] + ';return SPOT;})()');

/* A series in the shape prices.js writes: t0 is UTC on a full hour, quarters,
   prices in whole DKK/MWh (kr./kWh = value / 1000). */
function series(t0, dk1, dk2 = dk1) {
  return { t0, step: 15, n: dk1.length, p: { DK1: dk1.slice(), DK2: dk2.slice() } };
}
const flat = (n, v) => new Array(n).fill(v);
const T0 = '2026-10-20T12:00:00Z';                     // 14:00 Danish summer time, a plain Tuesday
const at = (h, m = 0) => Date.parse(T0) + (h * 60 + m) * 60000;

/* ------------------------------------------------------------------ maths */
test('cheapestWindow finds the lowest-sum run and reports its average', () => {
  const p = [10, 9, 8, 1, 1, 1, 1, 9, 9, 9];
  assert.deepEqual(SPOT.cheapestWindow(p, 0, 4), { i: 3, len: 4, avg: 1 });
  assert.deepEqual(SPOT.cheapestWindow(p, 0, 2), { i: 3, len: 2, avg: 1 });
});

test('cheapestWindow never starts before `from` - a quarter already running does not count', () => {
  const p = [1, 1, 1, 1, 5, 5, 2, 2, 2, 2];
  assert.equal(SPOT.cheapestWindow(p, 4, 4).i, 6);
  assert.equal(SPOT.cheapestWindow(p, 0, 4).i, 0);
});

test('cheapestWindow breaks ties towards the earliest start', () => {
  const p = [3, 3, 3, 3, 3, 3, 3, 3];
  assert.equal(SPOT.cheapestWindow(p, 0, 4).i, 0);
  assert.equal(SPOT.cheapestWindow(p, 2, 4).i, 2);
});

test('cheapestWindow refuses to span a gap (null) in the series', () => {
  const p = [1, 1, null, 1, 1, 6, 6, 6, 6];
  // the cheapest looking run 0..3 contains the gap; the best run that does not is 3..6
  assert.deepEqual(SPOT.cheapestWindow(p, 0, 4), { i: 3, len: 4, avg: 3.5 });
  assert.deepEqual(SPOT.cheapestWindow([1, 1, null, 6, 6, 6, 6], 0, 4), { i: 3, len: 4, avg: 6 });
  assert.equal(SPOT.cheapestWindow([1, null, 1], 0, 2), null);
});

test('cheapestWindow returns null when the series ahead is too short', () => {
  assert.equal(SPOT.cheapestWindow([1, 2, 3], 0, 4), null);
  assert.equal(SPOT.cheapestWindow([1, 2, 3, 4], 1, 4), null);
  assert.equal(SPOT.cheapestWindow([], 0, 1), null);
});

test('cheapestWindow handles negative prices - the most negative run wins', () => {
  const p = [5, 5, -3, -4, -1, 5, 5, 5];
  assert.deepEqual(SPOT.cheapestWindow(p, 0, 2), { i: 2, len: 2, avg: -3.5 });
});

test('windows() gives 1, 3 and 8 hour runs in quarters, from the first future quarter', () => {
  // 40 quarters = 10 h from 14:00; cheap quarters 20..31 (19:00-22:00)
  const dk1 = flat(40, 50).map((v, i) => (i >= 20 && i < 32 ? 5 : v));
  const d = series(T0, dk1);
  const now = at(0, 7);                                  // 14:07 - the running quarter is index 0
  const [w1, w3, w8] = SPOT.windows(d, 'DK1', now);
  assert.equal(w1.len, 4); assert.equal(w3.len, 12); assert.equal(w8.len, 32);
  assert.equal(w1.i, 20); assert.equal(w3.i, 20);
  assert.equal(w1.avg, 5); assert.equal(w3.avg, 5);
  assert.equal(w1.start, at(5)); assert.equal(w1.end, at(6));
  assert.equal(w3.end, at(8));
  // the 8 h run must include the whole cheap block: 12 cheap + 20 dear quarters
  assert.ok(w8.i <= 20 && w8.i + 32 >= 32);
  assert.ok(Math.abs(w8.avg - (12 * 5 + 20 * 50) / 32) < 1e-9);
});

test('windows() may begin at the very next quarter but not in the running one', () => {
  const dk1 = [1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9, 9].concat(flat(28, 9));
  const d = series(T0, dk1);
  const w = SPOT.windows(d, 'DK1', at(0, 1), [1])[0];   // 14:01 -> first eligible start is 14:15
  assert.equal(w.i, 1);
  assert.equal(SPOT.windows(d, 'DK1', at(0, 0), [1])[0].i, 0);   // exactly on the boundary: eligible
});

test('windows() reports null for lengths the horizon cannot hold', () => {
  const d = series(T0, flat(12, 10));                    // 3 h of data
  const [w1, w3, w8] = SPOT.windows(d, 'DK1', at(0));
  assert.ok(w1 && w3); assert.equal(w8, null);
});

test('looksSane rejects what render() and windows() could not read', () => {
  const ok = series(T0, flat(8, 1));
  assert.ok(SPOT.looksSane(ok));
  assert.equal(SPOT.looksSane(null), false);
  assert.equal(SPOT.looksSane({}), false);
  assert.equal(SPOT.looksSane({ ...ok, t0: '2026-10-24T12:30:00Z' }), false);      // not on a full hour
  assert.equal(SPOT.looksSane({ ...ok, step: 7 }), false);
  assert.equal(SPOT.looksSane({ ...ok, n: 9 }), false);                            // arrays do not match n
  assert.equal(SPOT.looksSane({ ...ok, p: { DK1: ok.p.DK1 } }), false);            // DK2 missing
  assert.equal(SPOT.looksSane({ ...ok, p: { DK1: ok.p.DK1, DK2: [1, 'x', 1, 1, 1, 1, 1, 1] } }), false);
  assert.equal(SPOT.looksSane(series(T0, flat(400, 1))), false);                   // more than four days
});

test('Danish wall-clock labels are right across the autumn DST change', () => {
  // 25-10-2026: 03:00 CEST becomes 02:00 CET, so 00:00Z and 01:00Z are both 02:00
  assert.equal(SPOT.dkParts(Date.UTC(2026, 9, 25, 0, 0)).hm, '02:00');
  assert.equal(SPOT.dkParts(Date.UTC(2026, 9, 25, 1, 0)).hm, '02:00');
  assert.equal(SPOT.dkParts(Date.UTC(2026, 9, 25, 2, 0)).hm, '03:00');
  assert.equal(SPOT.dkParts(Date.UTC(2026, 9, 24, 22, 0)).hm, '00:00');         // never "24:00"
  assert.equal(SPOT.dkParts(Date.UTC(2026, 9, 24, 22, 0)).date, '2026-10-25');
  // "tomorrow" in the first hour of the DST day is still the next calendar day
  assert.equal(SPOT.tomorrowDate(Date.UTC(2026, 9, 24, 22, 30)), '2026-10-26');
  assert.equal(SPOT.tomorrowDate(Date.UTC(2026, 9, 24, 12, 0)), '2026-10-25');
});

test('spanLabel says "i morgen" / "tomorrow" only for windows starting on the next day', () => {
  const now = at(0);                                     // 14:00 on 20-10
  const today = { start: at(5), end: at(6) };            // 19:00-20:00
  const tomorrow = { start: at(12), end: at(15) };       // 02:00-05:00 on 21-10
  assert.equal(SPOT.spanLabel(today, now, SPOT.I18N.da), '19:00–20:00');
  assert.equal(SPOT.spanLabel(tomorrow, now, SPOT.I18N.da), 'i morgen 02:00–05:00');
  assert.equal(SPOT.spanLabel(tomorrow, now, SPOT.I18N.en), 'tomorrow 02:00–05:00');
});

/* -------------------------------------------------------------- rendering */
/* 48 quarters = 14:00 today to 02:00 tomorrow, DKK/MWh. DK1 is 600 (0,60
   kr./kWh), cheap at 30 (0,03) 19:00-22:00 and negative for one quarter at
   14:30; DK2 is cheap 20:00-23:00. */
const real = series(T0, flat(48, 600).map((v, i) => (i >= 20 && i < 32 ? 30 : i === 2 ? -30 : v)),
  flat(48, 600).map((v, i) => (i >= 24 && i < 36 ? 30 : v)));
const opts = { w: 900, h: 74, lang: 'da', now: at(0, 7), mark: false, hi: 1000 };
const count = (s, re) => (s.match(re) || []).length;

test('render() draws one bar per quarter in each area, past quarters dimmed', () => {
  const svg = SPOT.render(real, opts);
  assert.ok(svg.startsWith('<svg class="spotsvg"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(count(svg, /<rect class="b[ "]/g), 96);          // 48 quarters x 2 areas
  assert.equal(count(svg, /class="b past/g), 0);                 // 14:07: the running quarter is not past
  const later = SPOT.render(real, { ...opts, now: at(1, 37) });  // 15:37: six quarters are, in each row
  assert.equal(count(later, /class="b past/g), 12);
  assert.equal(count(later, /<rect class="b[ "]/g), 96);        // the strip keeps two hours of context
  assert.ok(svg.includes('>DK1</text>') && svg.includes('>DK2</text>'));
  assert.equal(count(svg, /<title>/g), 96);                      // a hover title on every bar
});

test('render() marks negative and expensive quarters and draws the zero line', () => {
  const svg = SPOT.render(real, { ...opts, hi: 500 });
  assert.equal(count(svg, /class="b neg"/g), 1);
  assert.equal(count(svg, /class="b hi"/g), 48 - 12 - 1 + 48 - 12);   // every 600 quarter in both rows
  assert.equal(count(svg, /class="zero"/g), 2);
  const positive = SPOT.render(series(T0, flat(8, 50)), opts);
  assert.equal(count(positive, /class="zero"/g), 0);
});

test('render() places the "nu" marker and the midnight / "i morgen" label', () => {
  const svg = SPOT.render(real, opts);
  assert.equal(count(svg, /class="now"/g), 1);
  assert.ok(svg.includes('class="nowlbl"') && svg.includes('>nu</text>'));
  // 48 quarters from 14:00 pass midnight -> the midnight line and the label for tomorrow
  assert.equal(count(svg, /class="day"/g), 1);
  assert.ok(svg.includes('>i morgen</text>'));
  const en = SPOT.render(real, { ...opts, lang: 'en' });
  assert.ok(en.includes('>now</text>') && en.includes('>tomorrow</text>'));
  // hour ticks in Danish 24-hour form with a colon
  assert.ok(/>1[5-9]:00<\/text>/.test(svg));
});

test('render() with mark draws the 1, 3 and 8 hour bands on both rows, labelled', () => {
  const off = SPOT.render(real, opts);
  assert.equal(count(off, /class="win /g), 0);
  const on = SPOT.render(real, { ...opts, mark: true });
  for (const h of [1, 3, 8]) assert.equal(count(on, new RegExp(`class="win win-${h}"`, 'g')), 2);
  assert.ok(on.includes('>1 t</text>') && on.includes('>3 t</text>') && on.includes('>8 t</text>'));
  const en = SPOT.render(real, { ...opts, mark: true, lang: 'en' });
  assert.ok(en.includes('>1 h</text>') && en.includes('>8 h</text>'));
  // the 1 h band sits inside the cheap block: x of band = x of quarter 20
  const band = on.match(/<rect class="win win-1" x="([\d.]+)"/)[1];
  const bar = on.match(/<rect class="b" x="([\d.]+)"[^>]*><title>19:00–19:15/)[1];
  assert.equal(band, bar);
});

test('render() degrades to a one-line note without data or without a future', () => {
  const none = SPOT.render(null, opts);
  assert.ok(none.includes('Kommende priser kunne ikke hentes'));
  assert.equal(count(none, /<rect/g), 0);
  const en = SPOT.render(undefined, { ...opts, lang: 'en' });
  assert.ok(en.includes('Upcoming prices could not be fetched'));
  const stale = SPOT.render(real, { ...opts, now: at(13) });    // the series ended at 02:00
  assert.ok(stale.includes('Kommende priser kunne ikke hentes'));
  const broken = SPOT.render({ t0: 'x' }, opts);
  assert.ok(broken.includes('Kommende priser kunne ikke hentes'));
});

test('render() says "ingen data" for an area with no values', () => {
  const d = series(T0, flat(8, 50), flat(8, null));
  const svg = SPOT.render(d, opts);
  assert.ok(svg.includes('>ingen data</text>'));
  assert.equal(count(svg, /<rect class="b"/g), 8);
  assert.doesNotThrow(() => SPOT.render(d, { ...opts, mark: true }));
});

test('render() output is well-formed XML at any width, phone to kiosk', () => {
  for (const [w, h, scale] of [[320, 60, 1], [900, 74, 1], [1400, 210, 2.2]]) {
    const svg = SPOT.render(real, { ...opts, w, h, scale, mark: true });
    assert.equal(count(svg, /<rect/g), count(svg, /<rect[^>]*\/>/g) + count(svg, /<\/rect>/g));
    assert.equal(count(svg, /<line/g), count(svg, /<line[^>]*\/>/g));
    assert.equal(count(svg, /<text/g), count(svg, /<\/text>/g));
    assert.equal(count(svg, /<title>/g), count(svg, /<\/title>/g));
    assert.ok(svg.includes(`viewBox="0 0 ${w} ${h}"`));
    assert.ok(!/NaN|undefined/.test(svg), 'no NaN or undefined in the markup');
  }
});

test('summary() lists the three windows per area with Danish letters and the unit once', () => {
  const html = SPOT.summary(real, { ...opts, mark: true });
  assert.ok(html.includes('<b>DK1 Vest</b>') && html.includes('<b>DK2 Øst</b>'));
  assert.ok(html.includes('billigst:'));
  assert.ok(html.includes('<b>1 t</b> 19:00–20:00 <b>0,03</b>'));     // 30 DKK/MWh = 0,03 kr./kWh
  assert.equal(count(html, /kr\.\/kWh/g), 2);
  assert.ok(html.includes('<b>8 t</b>'));
  const en = SPOT.summary(real, { ...opts, lang: 'en' });
  assert.ok(en.includes('DK1 West') && en.includes('cheapest:') && en.includes('DKK/kWh'));
  assert.equal(SPOT.summary(null, opts), '');
});

test('summary() and the bar titles show DKK/MWh ÷ 1000 as kr./kWh with two decimals', () => {
  const d = series(T0, flat(40, 754));                   // 754 DKK/MWh = 0,754 -> 0,75 kr./kWh
  const html = SPOT.summary(d, { ...opts, now: at(0) });
  assert.ok(html.includes('<b>0,75</b>'));
  assert.equal(SPOT.kr(754), 0.75);
  assert.equal(SPOT.kr(1234.5), 1.23);
  assert.equal(SPOT.kr(-4), 0);                           // never "-0,00"
  assert.ok(Object.is(SPOT.kr(-4), 0));
  const svg = SPOT.render(d, { ...opts, now: at(0) });
  assert.ok(svg.includes('<title>14:00–14:15 · 0,75 kr./kWh</title>'));
  const en = SPOT.render(d, { ...opts, now: at(0), lang: 'en' });
  assert.ok(en.includes('<title>14:00–14:15 · 0.75 DKK/kWh</title>'));
});

/* ---------------------------------------------------- the page around it */
test('the Danish UI texts carry proper æ, ø and å, the agreed label and the CC BY 4.0 credit', () => {
  assert.equal(SPOT.I18N.da.btn, 'Hvornår er det billigst?');
  assert.equal(SPOT.I18N.da.area.DK2, 'DK2 Øst');
  assert.equal(SPOT.I18N.da.note, 'spotpris, før nettarif, afgifter og moms');
  assert.equal(SPOT.I18N.da.src, 'Kilde: Energinet (www.energidataservice.dk), CC BY 4.0 · tallene er bearbejdet (omregnet til kr./kWh)');
  assert.equal(SPOT.I18N.en.note, 'spot price, before grid tariff, taxes and VAT');
  assert.ok(SPOT.I18N.en.src.startsWith('Source: Energinet (www.energidataservice.dk), CC BY 4.0'));
  assert.equal(SPOT.I18N.en.btn, 'When is it cheapest?');
  for (const k of Object.keys(SPOT.I18N.da)) assert.ok(k in SPOT.I18N.en, 'en lacks ' + k);
});

test('index.html carries the strip, the button, the label and the CC BY 4.0 credit', () => {
  assert.ok(html.includes('id="cheapBtn"') && html.includes('>Hvornår er det billigst?</button>'));
  assert.ok(html.includes('id="spotStrip"') && html.includes('id="spotSum"'));
  assert.ok(html.includes('<span class="n">spotpris, før nettarif, afgifter og moms</span>'));
  assert.ok(html.includes('href="https://www.energidataservice.dk/tso-electricity/DayAheadPrices"'));
  assert.ok(html.includes('>Kilde: Energinet (www.energidataservice.dk), CC BY 4.0 · tallene er bearbejdet (omregnet til kr./kWh)</a>'));
  // credit, licence and "processed" in both languages' info text; the kiosk line carries the label
  assert.ok(html.includes('Kilde: Energinet (www.energidataservice.dk), licens CC BY 4.0. Tallene er bearbejdet'));
  assert.ok(html.includes('Source: Energinet (www.energidataservice.dk), licence CC BY 4.0. Figures are processed'));
  assert.ok(html.includes('spotpris, før nettarif, afgifter og moms\'],'));
  assert.ok(!html.includes('Conditions for use of Danish public-sector data'));
  // the kiosk shows the strip as a beat of its own
  assert.ok(html.includes('<div class="kg"></div>') && html.includes('KIOSK_PRICE_STEP'));
  assert.ok(html.includes("kPriceTag: 'KOMMENDE PRISER'") && html.includes("kPriceTag: 'UPCOMING PRICES'"));
});
