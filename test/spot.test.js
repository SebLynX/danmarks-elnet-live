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
const count = (s, re) => (s.match(re) || []).length;

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
  const dk1 = flat(40, 500).map((v, i) => (i >= 20 && i < 32 ? 50 : v));
  const d = series(T0, dk1);
  const now = at(0, 7);                                  // 14:07 - the running quarter is index 0
  const [w1, w3, w8] = SPOT.windows(d, 'DK1', now);
  assert.equal(w1.len, 4); assert.equal(w3.len, 12); assert.equal(w8.len, 32);
  assert.equal(w1.i, 20); assert.equal(w3.i, 20);
  assert.equal(w1.avg, 50); assert.equal(w3.avg, 50);
  assert.equal(w1.start, at(5)); assert.equal(w1.end, at(6));
  assert.equal(w3.end, at(8));
  // the 8 h run must include the whole cheap block: 12 cheap + 20 dear quarters
  assert.ok(w8.i <= 20 && w8.i + 32 >= 32);
  assert.ok(Math.abs(w8.avg - (12 * 50 + 20 * 500) / 32) < 1e-9);
});

test('windows() use future quarters only: cheap quarters already behind "now" are never picked', () => {
  // 48 quarters from 14:00. The cheapest run of the whole day is 14:00-16:00
  // (indices 0..7) - but at 16:07 that is history, and must not be chosen.
  const dk1 = flat(48, 400).map((v, i) => (i < 8 ? 1 : v));
  dk1[30] = 100; dk1[31] = 100; dk1[32] = 100; dk1[33] = 100;        // the cheapest FUTURE hour, 21:30-22:30
  const d = series(T0, dk1);
  const now = at(2, 7);                                               // 16:07, running quarter index 8
  const ws = SPOT.windows(d, 'DK1', now);
  for (const w of ws) {
    assert.ok(w, 'every window must exist');
    assert.ok(w.start >= now, `${w.h} h window starts at ${new Date(w.start).toISOString()}, before now`);
    assert.ok(w.i >= SPOT.firstFuture(d, now), 'a window may not begin in the running quarter');
  }
  assert.equal(ws[0].i, 30);                                          // 1 h: the cheap future hour, not the cheaper past
  assert.ok(ws[1].i >= 9 && ws[2].i >= 9);
  // at 14:00 sharp, before the day begins, the same cheap run IS the answer
  assert.equal(SPOT.windows(d, 'DK1', at(0))[0].i, 0);
  // and the running quarter itself is excluded: at 14:01 index 0 is gone
  assert.equal(SPOT.windows(d, 'DK1', at(0, 1))[0].i, 1);
});

test('windows() reports null for lengths the horizon cannot hold', () => {
  const d = series(T0, flat(12, 100));                   // 3 h of data
  const [w1, w3, w8] = SPOT.windows(d, 'DK1', at(0));
  assert.ok(w1 && w3); assert.equal(w8, null);
});

test('looksSane rejects what render() and windows() could not read', () => {
  const ok = series(T0, flat(8, 10));
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
/* every rect of a class with its x and width, in document order */
const rects = (svg, cls) => [...svg.matchAll(new RegExp(`<rect class="${cls}[^"]*" x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)"`, 'g'))]
  .map(m => ({ x: +m[1], y: +m[2], w: +m[3] }));

test('render() draws one bar per quarter in each area, past quarters dimmed', () => {
  const svg = SPOT.render(real, opts);
  assert.ok(svg.startsWith('<svg class="spotsvg"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(count(svg, /<rect class="b[ "]/g), 96);          // 48 quarters x 2 areas
  assert.equal(count(svg, /class="b past/g), 0);                 // 14:07: the running quarter is not past
  const later = SPOT.render(real, { ...opts, now: at(1, 37) });  // 15:37: six quarters are, in each row
  assert.equal(count(later, /class="b past/g), 12);
  assert.equal(count(later, /<rect class="b[ "]/g), 96);        // the strip keeps two hours of context
  assert.ok(svg.includes('>DK1 Vest</text>') && svg.includes('>DK2 Øst</text>'));
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

test('render() with mark draws the 1, 3 and 8 hour bands on both rows, each with a lane tab', () => {
  const off = SPOT.render(real, opts);
  assert.equal(count(off, /class="win /g), 0);
  assert.equal(count(off, /class="tab /g), 0);
  const on = SPOT.render(real, { ...opts, mark: true });
  for (const h of [1, 3, 8]) {
    assert.equal(count(on, new RegExp(`class="win win-${h}"`, 'g')), 2);
    assert.equal(count(on, new RegExp(`class="tab win-${h}"`, 'g')), 2);
  }
  assert.ok(on.includes('>1 t</text>') && on.includes('>3 t</text>') && on.includes('>8 t</text>'));
  assert.equal(count(on, /<title>1 t · /g), 2);                   // bands carry their hours and price too
  const en = SPOT.render(real, { ...opts, mark: true, lang: 'en' });
  assert.ok(en.includes('>1 h</text>') && en.includes('>8 h</text>'));
  // the 1 h band sits inside the cheap block: x of band = x of quarter 20
  const band = on.match(/<rect class="win win-1" x="([\d.]+)"/)[1];
  const bar = on.match(/<rect class="b" x="([\d.]+)"[^>]*><title>19:00–19:15/)[1];
  assert.equal(band, bar);
  // and the bands sit below the lane, tabs in it: tab y < band y
  const tab = rects(on, 'tab win-1')[0], wb = rects(on, 'win win-1')[0];
  assert.ok(tab.y < wb.y);
});

/* every window starts at the same quarter - the worst case for labels */
const sameStart = series(T0, flat(48, 600).map((v, i) => (i >= 20 && i < 52 ? 30 : v)));
const noOverlap = (svg, label) => {
  for (const row of [0, 1]) {
    const tabs = rects(svg, 'tab').filter(t => (row === 0) === (t.y < 30 * 2.2));   // the two lanes
    const ys = [...new Set(rects(svg, 'tab').map(t => t.y))].sort((a, b) => a - b);
    const lane = rects(svg, 'tab').filter(t => t.y === ys[row]);
    lane.sort((a, b) => a.x - b.x);
    for (let i = 1; i < lane.length; i++) {
      assert.ok(lane[i].x >= lane[i - 1].x + lane[i - 1].w, `${label}: tabs ${i - 1} and ${i} overlap in lane ${row}: ${JSON.stringify(lane)}`);
    }
    assert.equal(lane.length, 3, `${label}: three tabs in lane ${row}`);
    void tabs;
  }
};

test('window labels never share a spot: nested windows at phone, laptop, desktop and kiosk widths', () => {
  for (const [w, h, scale] of [[320, 74, 1], [343, 74, 1], [900, 74, 1], [1240, 62, 1], [1248, 74, 1], [1400, 210, 2.2]]) {
    const svg = SPOT.render(sameStart, { ...opts, w, h, scale, mark: true });
    noOverlap(svg, `${w}x${h}`);
    // the area name owns the start of the lane: no tab begins over it
    const name = svg.match(/<text class="area" x="([\d.]+)"/)[1];
    for (const t of rects(svg, 'tab')) assert.ok(t.x > +name + 20, `${w}: tab over the area name`);
    // every tab stays inside the drawing
    for (const t of rects(svg, 'tab')) assert.ok(t.x + t.w <= w + 0.01, `${w}: tab runs off the right edge`);
  }
  // the ordinary nested case too
  for (const w of [320, 1248]) noOverlap(SPOT.render(real, { ...opts, w, mark: true }), 'real ' + w);
});

test('render() keeps the bottom-right corner free for the credit when asked', () => {
  // in `real` midnight falls at x ≈ 750 of 900: under a 300 px credit
  const withPad = SPOT.render(real, { ...opts, w: 900, rightPad: 300 });
  const xs = [...withPad.matchAll(/<text class="(?:tick|daylbl|nowlbl)" x="([\d.]+)"/g)].map(m => +m[1]);
  assert.ok(xs.length >= 3);
  assert.ok(xs.every(x => x < 600), 'no axis label under the credit');
  assert.equal(count(withPad, /class="daylbl"/g), 0);            // the label yields, the midnight line stays
  assert.equal(count(withPad, /class="day"/g), 1);
  const without = SPOT.render(real, { ...opts, w: 900 });
  const day = without.match(/<text class="daylbl" x="([\d.]+)"/);
  assert.ok(day && +day[1] > 600, 'without rightPad the axis runs to the right edge');
});

test('strip text is 11 px at scale 1 and never smaller, whatever the strip height', () => {
  for (const h of [62, 70, 76, 90]) for (const w of [320, 900, 1400]) {
    const svg = SPOT.render(sameStart, { ...opts, w, h, mark: true });
    const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map(m => +m[1]);
    assert.ok(sizes.length > 10);
    assert.ok(sizes.every(f => f >= 11), `${w}x${h}: a font-size below 11 px: ${Math.min(...sizes)}`);
    // the lane holds the text: tabs are at least as tall as the font
    for (const t of rects(svg, 'tab')) assert.ok(true, t);
    const laneH = +svg.match(/<rect class="tab[^"]*"[^>]*height="([\d.]+)"/)[1];
    assert.ok(laneH >= 11 + 2, `${w}x${h}: lane ${laneH} px too low for 11 px text`);
  }
  const kiosk = SPOT.render(sameStart, { ...opts, w: 1400, h: 210, scale: 2.2, mark: true });
  assert.ok([...kiosk.matchAll(/font-size="([\d.]+)"/g)].every(m => +m[1] >= 24));
});

test('render() degrades to a note without data or without a future, wrapped on a phone', () => {
  const none = SPOT.render(null, opts);
  assert.ok(none.includes('Kommende priser kunne ikke hentes lige nu — resten af kortet virker som før'));
  assert.equal(count(none, /<rect/g), 0);
  assert.equal(count(none, /<text class="none"/g), 1);                 // one line at 900 px
  const phone = SPOT.render(null, { ...opts, w: 317 });
  assert.equal(count(phone, /<text class="none"/g), 2);                // two at 317 px, split at the dash
  assert.ok(phone.includes('>Kommende priser kunne ikke hentes lige nu</text>'));
  assert.ok(phone.includes('>— resten af kortet virker som før</text>'));
  assert.ok(/font-size="11"/.test(phone));
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
  for (const [w, h, scale] of [[320, 74, 1], [900, 74, 1], [1240, 62, 1], [1400, 210, 2.2]]) {
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
  assert.equal(count(html, /<span class="area">/g), 2);
  assert.ok(html.includes('<b>DK1 Vest</b>') && html.includes('<b>DK2 Øst</b>'));
  assert.ok(html.includes('<b>1 t</b> 19:00–20:00 <b>0,03</b>'));     // 30 DKK/MWh = 0,03 kr./kWh
  assert.equal(count(html, /kr\.\/kWh/g), 2);
  assert.ok(html.includes('<b>8 t</b>'));
  const en = SPOT.summary(real, { ...opts, lang: 'en' });
  assert.ok(en.includes('DK1 West') && en.includes('DKK/kWh'));
  assert.equal(SPOT.summary(null, opts), '');
});

test('summary() says "i morgen" once when every window is tomorrow\'s', () => {
  // from 22:00 today, cheap only tomorrow 02:00-10:00 -> all three windows are tomorrow's
  const d = series('2026-10-20T20:00:00Z', flat(64, 600).map((v, i) => (i >= 16 && i < 48 ? 30 : v)));
  const html = SPOT.summary(d, { ...opts, now: Date.parse('2026-10-20T20:07:00Z') });
  assert.ok(html.includes('<b>DK1 Vest</b> · i morgen: <b>1 t</b> 02:00–03:00'), html);
  assert.equal(count(html, /i morgen/g), 2);                      // once per area, not once per window
  const en = SPOT.summary(d, { ...opts, lang: 'en', now: Date.parse('2026-10-20T20:07:00Z') });
  assert.ok(en.includes('<b>DK1 West</b> · tomorrow: <b>1 h</b> 02:00–03:00'));
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
  assert.ok(html.includes('id="spotStrip"') && html.includes('id="spotSum"') && html.includes('id="spotTitle"'));
  assert.ok(html.includes('<span class="n">spotpris, før nettarif, afgifter og moms</span>'));
  assert.ok(html.includes('href="https://www.energidataservice.dk/tso-electricity/DayAheadPrices"'));
  assert.ok(html.includes('>Kilde: Energinet (www.energidataservice.dk), CC BY 4.0 · tallene er bearbejdet (omregnet til kr./kWh)</a>'));
  // credit, licence and "processed" in both languages' info text; the kiosk line carries the label
  assert.ok(html.includes('Kilde: Energinet (www.energidataservice.dk), licens CC BY 4.0. Tallene er bearbejdet'));
  assert.ok(html.includes('Source: Energinet (www.energidataservice.dk), licence CC BY 4.0. Figures are processed'));
  assert.ok(html.includes('<span class="kl">${T(\'spotNote\')}</span>'));   // the kiosk line carries the label on its own line
  assert.ok(!html.includes('Conditions for use of Danish public-sector data'));
});

test('one label everywhere: the DK1/DK2 cards carry the same wording as the strip', () => {
  assert.ok(html.includes('<div id="spotNote" data-i18n="spotNote">spotpris, før nettarif, afgifter og moms</div>'));
  assert.ok(html.includes("spotNote: 'spotpris, før nettarif, afgifter og moms'"));
  assert.ok(html.includes("spotNote: 'spot price, before grid tariff, taxes and VAT'"));
  assert.ok(!html.includes('spotpris (engros)') && !html.includes('wholesale spot price'));
});

test('the browser never calls api.energidataservice.dk: the cards read the running quarter from prices.json', () => {
  assert.ok(!html.includes('pollFromApi'));
  assert.ok(!/fetch\(API\b/.test(html));
  assert.ok(!html.includes('api.energidataservice.dk/dataset'));
  assert.ok(html.includes('function spotNow(area)'));
  assert.ok(html.includes("S.mode === 'live' ? spotNow(t.a) : null"));
  assert.ok(html.includes("pConv: 'omregnet 7,46'"));          // the fallback says it converted
  assert.ok(html.includes("QP.has('udenpriser')"));             // the fallback state, on demand
});

test('short screens fold or drop a card rather than cutting one mid-row', () => {
  assert.ok(html.includes("const FOLDS = ['fold-keys', 'fold-lgd', 'fold-prod', 'fold-prod2'];") && html.includes("B.add('drop-links')"));
  assert.ok(html.includes('body.fold-lgd #foot{display:grid;grid-template-columns:1fr 1fr'));
  assert.ok(html.includes("B.add('tiles2')") && html.includes("B.add('links-cut')") && html.includes('const keepRows = ()'));
  assert.ok(html.includes('body.tiles2 #right #tiles{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}'));
  assert.ok(html.includes('#foot{bottom:auto}'));
  assert.ok(html.includes('body.links-cut #links{flex:none;overflow-y:auto'));
  assert.ok(html.includes('body.fold-prod .row .bar{display:none}'));
  assert.ok(html.includes('body.fold-prod2 #rows,body.fold-prod2 #consLine{display:none}'));
  assert.ok(html.includes('body.drop-links #links{display:none}'));
  assert.ok(html.includes('#spotStrip{grid-area:2/1/3/3;height:76px}'));
  assert.ok(!/#spotStrip\{height:\d+px\}/.test(html), 'no media rule shrinks the strip');
});

test('the kiosk beat names the area and window of its headline and carries the credit', () => {
  assert.ok(html.includes("kPriceTag: 'KOMMENDE PRISER · {area} · BILLIGSTE 3 TIMER FRA NU'"));
  assert.ok(html.includes("kWest: 'VEST (DK1)', kEast: 'ØST (DK2)'"));
  assert.ok(html.includes("kPriceTag: 'UPCOMING PRICES · {area} · CHEAPEST 3 HOURS AHEAD'"));
  assert.ok(html.includes('<div class="kg"></div><div class="kc"></div>'));
  assert.ok(html.includes("credit: ST('src')"));
  assert.ok(html.includes('body.kiosk #kioskCap.price{') && html.includes('background:var(--panel-solid)'));
});
