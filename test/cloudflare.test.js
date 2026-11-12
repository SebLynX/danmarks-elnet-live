/* Tests for the Cloudflare variant that is not deployed yet:
   worker/worker.js snapshot routes (/hist.json, /data.json, /prices.json)
   and cloudflare/site.js (CORS on those files, everything else passed
   through). The live /elnet/* routes are covered by test/worker.test.js
   and must keep their answers. Node 18+, no packages.

   Run:  node --test
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

function loadWorker(rel) {
  const src = read(rel);
  assert.equal(src.split('export default {').length - 1, 1, rel + ' has one default export');
  return vm.runInThisContext('(() => {' + src.replace('export default {', 'const __w = {') + ';return __w;})()', { filename: rel });
}

const api = loadWorker('worker/worker.js');
const site = loadWorker('cloudflare/site.js');

const ORIGIN = 'https://el-gridkort.example.workers.dev';
let store, calls, inits, answer, pending;
function fresh() {
  store = new Map(); calls = []; inits = []; pending = [];
  globalThis.caches = { default: {
    match: async req => { const r = store.get(req.url); return r ? r.clone() : undefined; },
    put: async (req, res) => { store.set(req.url, res); }
  } };
  globalThis.fetch = async (url, init) => { calls.push(String(url)); inits.push(init || {}); return answer(String(url), init); };
}
const ctx = () => ({ waitUntil: p => pending.push(p) });
const settle = () => Promise.all(pending);
const fileBody = name => '{"file":"' + name + '","n":700}';

function apiGet(pathname, origin, env) {
  return api.fetch(new Request('https://api.gridkort.dk' + pathname, { headers: origin ? { Origin: origin } : {} }), env || {}, ctx());
}

test('the Pages fetch ladder in index.html is unchanged', () => {
  const html = read('index.html');
  assert.ok(html.includes("const HIST_URLS = [\n  'hist.json',\n  'https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/hist.json'\n];"));
  assert.ok(html.includes("'https://api.gridkort.dk/elnet/now.json',\n  'data.json',"));
  assert.ok(html.includes("'https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/data.json',\n  'https://seblynx.github.io/danmarks-elnet-live/data.json'"));
  assert.ok(html.includes("'https://api.gridkort.dk/elnet/prices.json',\n  'prices.json',\n  'https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/prices.json'"));
  assert.ok(html.includes('rel="canonical" href="https://el.gridkort.dk/"'));
  assert.ok(html.includes('property="og:url" content="https://el.gridkort.dk/"'));
  assert.ok(html.includes('property="og:locale:alternate" content="en_GB"'));
  assert.ok(html.includes("if (QP.get('lang') === 'en') LANG = 'en';"));
});

test('snapshot routes 503 until DATA_ORIGIN is set, and do not call fetch', async () => {
  fresh(); answer = () => { throw new Error('should not fetch'); };
  const r = await apiGet('/hist.json', 'https://expo.energinet.dk'); await settle();
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://expo.energinet.dk');
  assert.equal(r.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await r.json()).error, 'DATA binding is not set, and DATA_ORIGIN is not set');
  for (const bad of ['http://el-gridkort.example.workers.dev', 'https://user:pw@el-gridkort.example.workers.dev/hist.json', 'https://el-gridkort.example.workers.dev/subdir']) {
    const denied = await api.fetch(new Request('https://api.gridkort.dk/data.json'), { DATA_ORIGIN: bad }, ctx());
    assert.equal(denied.status, 503, bad);
    assert.match((await denied.json()).error, /https origin/);
  }
});

test('GET /hist.json /data.json /prices.json returns the pipeline bytes with reflected CORS and no credentials', async () => {
  fresh();
  answer = (url, init) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, undefined);
    assert.equal(init.headers['User-Agent'], 'gridkort-api (gridkort.dk, hobby map)');
    const name = url.slice(url.lastIndexOf('/') + 1);
    return new Response(fileBody(name), { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
  };
  const env = { DATA_ORIGIN: ORIGIN + '/' };
  for (const [pathName, file] of [['/hist.json', 'hist.json'], ['/data.json', 'data.json'], ['/prices.json', 'prices.json']]) {
    const r = await apiGet(pathName, 'https://expo.energinet.dk', env); await settle();
    assert.equal(r.status, 200, pathName);
    assert.equal(await r.text(), fileBody(file));
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://expo.energinet.dk');
    assert.equal(r.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.equal(r.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(calls.at(-1), ORIGIN + '/' + file);
  }
  const disk = await apiGet('/hist.json', 'null', env); await settle();
  assert.equal(disk.headers.get('Access-Control-Allow-Origin'), 'null');
  const oldHost = await apiGet('/data.json', 'https://seblynx.github.io', env); await settle();
  assert.equal(oldHost.headers.get('Access-Control-Allow-Origin'), 'https://seblynx.github.io');
  const own = await apiGet('/data.json', 'https://el.gridkort.dk', env); await settle();
  assert.equal(own.headers.get('Access-Control-Allow-Origin'), 'https://el.gridkort.dk');
  const front = await apiGet('/data.json', 'https://gridkort.dk', env); await settle();
  assert.equal(front.headers.get('Access-Control-Allow-Origin'), 'https://gridkort.dk');
  for (const origin of ['https://evil.gridkort.dk', 'https://not.energinet.dk', 'https://vind.gridkort.dk', 'https://www.gridkort.dk']) {
    const denied = await apiGet('/prices.json', origin, env); await settle();
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null, origin);
  }
  const liveWild = await api.fetch(new Request('https://api.gridkort.dk/elnet/prices.json', { method: 'OPTIONS', headers: { Origin: 'https://vind.gridkort.dk' } }), env, ctx());
  assert.equal(liveWild.headers.get('Access-Control-Allow-Origin'), 'https://vind.gridkort.dk');
  const liveEnergi = await api.fetch(new Request('https://api.gridkort.dk/elnet/now.json', { method: 'OPTIONS', headers: { Origin: 'https://not.energinet.dk' } }), env, ctx());
  assert.equal(liveEnergi.headers.get('Access-Control-Allow-Origin'), 'https://not.energinet.dk');
  const foreign = await apiGet('/prices.json', 'https://example.com', env); await settle();
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await foreign.text()).includes('"prices.json"'), true);
});

test('a service binding is used instead of fetch() when env.DATA is set', async () => {
  fresh();
  answer = () => { throw new Error('public fetch must not run'); };
  const seen = [];
  const env = {
    DATA_ORIGIN: ORIGIN,
    DATA: { fetch: async (req) => { seen.push(req.url); return new Response(fileBody('hist.json'), { status: 200 }); } }
  };
  const r = await apiGet('/hist.json', 'https://el.gridkort.dk', env); await settle();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), fileBody('hist.json'));
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0]).pathname, '/hist.json');
  await apiGet('/hist.json', 'https://el.gridkort.dk', env); await settle();
  assert.equal(seen.length, 1, 'the binding answer is cached');
  fresh();
  const bad = { DATA: { fetch: async () => new Response('no', { status: 500 }) } };
  const failed = await apiGet('/data.json', 'https://expo.energinet.dk', bad); await settle();
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error, 'snapshot unavailable');
});

test('a snapshot is cached: the second GET does not fetch DATA_ORIGIN again', async () => {
  fresh();
  answer = () => new Response(fileBody('hist.json'), { status: 200 });
  const env = { DATA_ORIGIN: ORIGIN };
  await apiGet('/hist.json', 'https://el.gridkort.dk', env); await settle();
  await apiGet('/hist.json', 'https://el.gridkort.dk', env); await settle();
  assert.equal(calls.length, 1);
  assert.equal(store.get('https://api.gridkort.dk/__cache/snapshot-hist.json').headers.get('Cache-Control'), 'public, max-age=60');
});

test('a failed snapshot is 502 and is not cached, and the live /elnet routes are untouched', async () => {
  fresh();
  answer = (url) => String(url).startsWith(ORIGIN)
    ? new Response('', { status: 302, headers: { Location: 'https://example.com/hist.json' } })
    : new Response(JSON.stringify({ records: [] }), { status: 200 });
  const env = { DATA_ORIGIN: ORIGIN };
  const r = await apiGet('/hist.json', 'https://expo.energinet.dk', env); await settle();
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'snapshot unavailable');
  assert.equal(store.has('https://api.gridkort.dk/__cache/snapshot-hist.json'), false);
  const live = await apiGet('/elnet/prices.json', 'https://el.gridkort.dk', env); await settle();
  assert.equal(live.status, 502);
  assert.match((await live.json()).error, /no usable|HTTP|empty/);
  assert.equal((await apiGet('/nope.json', 'https://el.gridkort.dk', env)).status, 404);
  assert.equal((await api.fetch(new Request('https://api.gridkort.dk/hist.json', { method: 'POST' }), env, ctx())).status, 405);
  const opt = await api.fetch(new Request('https://api.gridkort.dk/hist.json', { method: 'OPTIONS', headers: { Origin: 'https://expo.energinet.dk' } }), env, ctx());
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), 'https://expo.energinet.dk');
  assert.equal(opt.headers.get('Access-Control-Allow-Methods'), 'GET');
  assert.equal(opt.headers.get('Access-Control-Allow-Credentials'), null);
});

function siteAssets(dir) {
  return { fetch: async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) return new Response('no', { status: 403 });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('missing', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' } });
  } };
}

test('the site Worker serves the three JSON files with reflected CORS and passes other paths through', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'elnet-site-'));
  fs.writeFileSync(path.join(dir, 'hist.json'), fileBody('hist.json'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>Danmarks Elnet · Live</title>');
  const env = { ASSETS: siteAssets(dir) };
  const get = (pathname, origin, method = 'GET') => site.fetch(new Request('https://el.gridkort.dk' + pathname, { method, headers: origin ? { Origin: origin } : {} }), env);
  const hist = await get('/hist.json?t=1', 'https://expo.energinet.dk');
  assert.equal(hist.status, 200);
  assert.equal(await hist.text(), fileBody('hist.json'));
  assert.equal(hist.headers.get('Access-Control-Allow-Origin'), 'https://expo.energinet.dk');
  assert.equal(hist.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(hist.headers.get('Cache-Control'), 'no-store');
  assert.equal(hist.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const opt = await get('/prices.json', 'https://el.gridkort.dk', 'OPTIONS');
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Methods'), 'GET');
  assert.equal(opt.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await get('/data.json', 'https://example.com')).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await get('/data.json', 'https://evil.gridkort.dk')).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await get('/data.json', 'https://gridkort.dk')).headers.get('Access-Control-Allow-Origin'), 'https://gridkort.dk');
  assert.equal((await get('/data.json', 'https://www.gridkort.dk')).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await get('/hist.json', 'null')).headers.get('Access-Control-Allow-Origin'), 'null');
  assert.equal((await get('/hist.json', 'https://expo.energinet.dk', 'POST')).status, 405);
  const page = await get('/index.html', 'https://expo.energinet.dk');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<title>Danmarks Elnet · Live</title>');
  assert.equal(page.headers.get('Access-Control-Allow-Origin'), '*', 'non-JSON paths are the asset, unchanged');
  const missing = await get('/hist.json', 'null');
  fs.rmSync(path.join(dir, 'hist.json'));
  const gone = await get('/hist.json', 'https://expo.energinet.dk');
  assert.equal(gone.status, 404);
  assert.equal(gone.headers.get('Access-Control-Allow-Origin'), 'https://expo.energinet.dk');
  assert.equal(gone.headers.get('Access-Control-Allow-Origin') === '*', false);
  assert.equal(missing.status, 200);
});

test('assemble.js copies the published site unchanged and adds only Cloudflare rules', () => {
  const built = spawnSync(process.execPath, ['cloudflare/assemble.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const dist = path.join(root, 'cloudflare', 'dist');
  for (const rel of ['index.html', '404.html', 'robots.txt', 'sitemap.xml', 'llms.txt', 'preview.png', 'data.json', 'hist.json', 'prices.json', path.join('tv2', 'index.html')]) {
    assert.deepEqual(fs.readFileSync(path.join(dist, rel)), fs.readFileSync(path.join(root, rel)), rel);
  }
  assert.equal(fs.existsSync(path.join(dist, 'en', 'index.html')), false);
  assert.equal(fs.readFileSync(path.join(dist, '_redirects'), 'utf8'), '/tv2 /tv2/ 301\n');
  const headers = fs.readFileSync(path.join(dist, '_headers'), 'utf8');
  assert.match(headers, /\/hist\.json\n {2}Cache-Control: no-store/);
  assert.match(headers, /\/data\.json\n {2}Cache-Control: no-store/);
  assert.match(headers, /\/prices\.json\n {2}Cache-Control: no-store/);
  assert.equal(headers.includes('*'), false);
  const cfg = read('cloudflare/wrangler.jsonc');
  assert.match(cfg, /"name": "el-gridkort"/);
  assert.match(cfg, /"not_found_handling": "404-page"/);
  assert.match(cfg, /"html_handling": "auto-trailing-slash"/);
  assert.match(cfg, /"\/hist\.json", "\/data\.json", "\/prices\.json"/);
  assert.equal(cfg.includes('"route"'), false, 'the config must not attach el.gridkort.dk');
  assert.equal(cfg.includes('"routes"'), false);
  assert.equal(cfg.includes('custom_domain'), false);
  assert.match(cfg, /"preview_urls": false/);
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(html.includes('https://el.gridkort.dk/preview.png'));
  assert.ok(html.includes("statsNote: 'Anonymous visitor statistics via Cloudflare Web Analytics – no cookies.'"));
  assert.ok(fs.readFileSync(path.join(dist, '404.html'), 'utf8').includes('Siden findes ikke'));
  assert.ok(fs.readFileSync(path.join(dist, 'robots.txt'), 'utf8').includes('Sitemap: https://el.gridkort.dk/sitemap.xml'));
  assert.ok(fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8').includes('https://el.gridkort.dk/'));
  assert.ok(fs.readFileSync(path.join(dist, 'llms.txt'), 'utf8').includes('?lang=en'));
});

test('deploy-cloudflare.yml is manual, read-only, and splits install from deploy', () => {
  const yml = read('.github/workflows/deploy-cloudflare.yml');
  const header = yml.split(/^jobs:/m)[0];
  assert.match(header, /workflow_dispatch/);
  assert.equal(/^\s*(schedule|push|pull_request):/m.test(header), false);
  assert.match(yml, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /environment: cloudflare-production/);
  assert.match(yml, /contents: read/);
  assert.equal(yml.includes('contents: write'), false);
  assert.equal(yml.includes('actions: write'), false);
  const steps = yml.split(/\n {6}- /);
  const ciStep = steps.find(step => step.includes('npm ci --ignore-scripts'));
  const deployStep = steps.find(step => step.includes('npm exec --no -- wrangler deploy --config cloudflare/wrangler.jsonc'));
  assert.ok(ciStep);
  assert.ok(deployStep);
  assert.equal(ciStep.includes('CLOUDFLARE_'), false);
  assert.match(deployStep, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(deployStep, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  for (const uses of yml.match(/uses: \S+/g)) {
    assert.match(uses, /@[0-9a-f]{40}$/);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies), ['wrangler']);
  assert.equal(pkg.devDependencies.wrangler, '4.160.1');
});
