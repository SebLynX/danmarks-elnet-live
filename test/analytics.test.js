/* Tests for the visitor statistics: every published page on el.gridkort.dk
   carries the Cloudflare Web Analytics beacon, once, right before </body>,
   and the map says so in its info panel (the i button), in Danish and
   English. The workflow that publishes the site does not run the tests, so
   this guard runs whenever someone runs them, e.g. at the next rebuild of
   index.html - a build without the beacon or the line fails here.

   Run:  node --test            (Node 18+, no packages)                      */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SNIPPET = '<!-- Cloudflare Web Analytics --><script type=\'module\' src=\'https://static.cloudflareinsights.com/beacon.min.js\' data-cf-beacon=\'{"token": "997c43f2165a4453a7bbd7a132ce5c1d"}\'></script><!-- End Cloudflare Web Analytics -->';
const PAGES = ['index.html', '404.html', path.join('tv2', 'index.html')];
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

const STATS_DIV = '<div class="priv stats" data-i18n="statsNote">Anonym besøgsstatistik via Cloudflare Web Analytics – ingen cookies.</div>';

/* The #infoPan element, from its opening tag to the </div> that closes it. */
function infoPan(html) {
  const start = html.indexOf('<div id="infoPan"');
  assert.ok(start >= 0, 'index.html must carry #infoPan');
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0, m;
  while ((m = tag.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.lastIndex);
  }
  assert.fail('#infoPan is never closed');
}

for (const page of PAGES) {
  test(`${page} carries the beacon once, directly before its only </body>`, () => {
    const html = read(page);
    assert.equal(count(html, '</body>'), 1, 'one </body>');
    assert.equal(count(html, SNIPPET), 1, 'the exact snippet, once');
    assert.equal(count(html, 'static.cloudflareinsights.com'), 1, 'no second beacon in another shape');
    assert.ok(html.includes(SNIPPET + '</body>'), 'the snippet sits directly before </body>');
  });
}

test('index.html says so in the info panel, in Danish and English', () => {
  const html = read('index.html');
  assert.ok(infoPan(html).includes(STATS_DIV), 'the statsNote line sits inside #infoPan');
  // only there: the line is never always visible on the map
  assert.equal(count(html, 'data-i18n="statsNote"'), 1, 'the statsNote line is in #infoPan only');
  assert.ok(html.includes("statsNote: 'Anonym besøgsstatistik via Cloudflare Web Analytics – ingen cookies.'"));
  assert.ok(html.includes("statsNote: 'Anonymous visitor statistics via Cloudflare Web Analytics – no cookies.'"));
});
