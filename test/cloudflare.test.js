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

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '#') break;
    out += c;
  }
  return out.trimEnd();
}

function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquote(text) {
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
  return text;
}

/* A one-line `{ key: value, ... }` map. `${{ }}` is one token, so the
   braces inside an expression do not close the map. */
function parseFlow(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1);
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '$' && inner.slice(i, i + 3) === '${{') {
      const end = inner.indexOf('}}', i + 3);
      if (end < 0) return null;
      cur += inner.slice(i, end + 2);
      i = end + 1;
      continue;
    }
    if (c === '{' || c === '[') { depth++; cur += c; continue; }
    if (c === '}' || c === ']') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  const obj = {};
  for (const part of parts) {
    if (!part) continue;
    const kv = splitKey(part);
    if (!kv) return null;
    const nested = kv.rest.startsWith('{') ? parseFlow(kv.rest) : null;
    obj[kv.key] = nested || unquote(kv.rest);
  }
  return obj;
}

function parseNode(lines, start, indent) {
  let i = start;
  while (i < lines.length && (lines[i].trim() === '' || /^\s*#/.test(lines[i]))) i++;
  if (i >= lines.length || indentOf(lines[i]) < indent) return { node: {}, next: i };
  const first = stripComment(lines[i]).trim();
  if (first.startsWith('- ')) return parseSequence(lines, i, indent);
  const map = {};
  while (i < lines.length) {
    if (lines[i].trim() === '' || /^\s*#/.test(lines[i])) { i++; continue; }
    const ind = indentOf(lines[i]);
    if (ind < indent) break;
    if (ind !== indent) throw new Error('line ' + (i + 1) + ': expected indent ' + indent);
    const text = stripComment(lines[i]).trim();
    if (text.startsWith('- ')) throw new Error('line ' + (i + 1) + ': list item in a mapping');
    const assigned = assignKey(map, text, lines, i, indent);
    i = assigned.next;
  }
  return { node: map, next: i };
}

function parseSequence(lines, start, indent) {
  const seq = [];
  let i = start;
  while (i < lines.length) {
    if (lines[i].trim() === '' || /^\s*#/.test(lines[i])) { i++; continue; }
    const ind = indentOf(lines[i]);
    if (ind < indent) break;
    if (ind !== indent) throw new Error('line ' + (i + 1) + ': expected indent ' + indent);
    const text = stripComment(lines[i]).trim();
    if (!text.startsWith('- ')) throw new Error('line ' + (i + 1) + ': expected a list item');
    const rest = text.slice(2).trim();
    const keyIndent = indent + 2;
    if (rest === '') {
      const nested = parseNode(lines, i + 1, keyIndent);
      seq.push(nested.node);
      i = nested.next;
      continue;
    }
    const parts = splitKey(rest);
    if (!parts) { seq.push(unquote(rest)); i++; continue; }
    const map = {};
    let assigned = assignKey(map, rest, lines, i, keyIndent);
    i = assigned.next;
    while (i < lines.length) {
      if (lines[i].trim() === '' || /^\s*#/.test(lines[i])) { i++; continue; }
      const ind2 = indentOf(lines[i]);
      if (ind2 < keyIndent) break;
      if (ind2 !== keyIndent) throw new Error('line ' + (i + 1) + ': expected indent ' + keyIndent);
      const text2 = stripComment(lines[i]).trim();
      if (text2.startsWith('- ')) break;
      assigned = assignKey(map, text2, lines, i, keyIndent);
      i = assigned.next;
    }
    seq.push(map);
  }
  return { node: seq, next: i };
}

function assignKey(map, text, lines, lineIndex, keyIndent) {
  const parts = splitKey(text);
  if (!parts) throw new Error('line ' + (lineIndex + 1) + ': expected a key');
  const { key, rest } = parts;
  if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
    const body = [];
    let i = lineIndex + 1;
    let blockIndent = null;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { body.push(''); i++; continue; }
      const ind = indentOf(line);
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) break;
      body.push(line.slice(blockIndent));
      i++;
    }
    map[key] = body.join('\n').replace(/\n+$/, '');
    return { next: i };
  }
  if (rest === '') {
    const nested = parseNode(lines, lineIndex + 1, keyIndent + 2);
    map[key] = nested.node;
    return { next: nested.next };
  }
  if (rest.startsWith('{')) {
    const flow = parseFlow(rest);
    if (!flow) throw new Error('line ' + (lineIndex + 1) + ': unparsed flow map');
    map[key] = flow;
    return { next: lineIndex + 1 };
  }
  map[key] = unquote(rest);
  return { next: lineIndex + 1 };
}

function permProblems(where, perms) {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return [where + ' permissions missing'];
  const problems = [];
  const keys = Object.keys(perms);
  if (keys.length !== 1 || keys[0] !== 'contents') problems.push(where + ' permissions are not only contents');
  if (String(perms.contents) !== 'read') problems.push(where + ' contents is not read');
  for (const [key, value] of Object.entries(perms)) {
    if (String(value) === 'write') problems.push(where + ' grants ' + key + ': write');
  }
  return problems;
}

function envHasCloudflare(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  return Object.keys(env).some(key => key.startsWith('CLOUDFLARE_'));
}

const DEPLOY_RUN = 'npm exec --no -- wrangler deploy --config cloudflare/wrangler.jsonc';
const CI_RUN = 'npm ci --ignore-scripts';
const ASSEMBLE_RUN = 'node cloudflare/assemble.js';
/* Checkout and setup-node are the only steps with no run. Every run
   must be one of these three commands. */
const ALLOWED_RUNS = new Set([CI_RUN, ASSEMBLE_RUN, DEPLOY_RUN]);
const SECRET_RE = /\bsecrets\b/i;
const RUN_SECRET_RE = /CLOUDFLARE_|\bsecrets\b/i;

function walkValues(node, path, fn) {
  if (typeof node === 'string') { fn(node, path); return; }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkValues(item, path + '[' + i + ']', fn));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (SECRET_RE.test(key)) fn(key, path + '.' + key);
      walkValues(value, path + '.' + key, fn);
    }
  }
}

function isAllowedSecretPath(doc, path) {
  const match = path.match(/^\.jobs\.([^.[\]]+)\.steps\[(\d+)\]\.env\.(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)$/);
  if (!match) return false;
  const step = doc.jobs[match[1]].steps[Number(match[2])];
  return String(step.run || '').trim() === DEPLOY_RUN;
}

/* Indentation parse of a GitHub Actions workflow. An empty list means
   the file matches the deploy rules. */
function workflowProblems(src) {
  let doc;
  try {
    doc = parseNode(String(src).split('\n'), 0, 0).node;
  } catch (err) {
    return ['parse: ' + err.message];
  }
  const problems = [];
  const on = doc.on;
  if (!on || typeof on !== 'object' || Array.isArray(on)) problems.push('on: missing');
  else {
    const keys = Object.keys(on);
    if (!keys.includes('workflow_dispatch')) problems.push('on: missing workflow_dispatch');
    for (const key of keys) {
      if (key !== 'workflow_dispatch') problems.push('on: has ' + key);
    }
  }
  if (envHasCloudflare(doc.env)) problems.push('workflow env has CLOUDFLARE_');
  problems.push(...permProblems('workflow', doc.permissions));
  walkValues(doc, '', (value, path) => {
    if (SECRET_RE.test(value) && !isAllowedSecretPath(doc, path)) problems.push('secrets reference outside deploy env: ' + path);
  });
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    problems.push('jobs missing');
    return problems;
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (String(job.if || '') !== "github.ref == 'refs/heads/main'") problems.push(name + ' if is not exactly github.ref == refs/heads/main');
    if (String(job.environment || '') !== 'cloudflare-production') problems.push(name + ' environment is not cloudflare-production');
    if (envHasCloudflare(job.env)) problems.push(name + ' job env has CLOUDFLARE_');
    problems.push(...permProblems(name, job.permissions));
    if (!Array.isArray(job.steps)) { problems.push(name + ' steps missing'); continue; }
    let ci = -1;
    let assemble = -1;
    let deploy = -1;
    job.steps.forEach((step, idx) => {
      if (step.uses !== undefined && !/^[^@\s]+@[0-9a-f]{40}$/.test(String(step.uses))) {
        problems.push(name + ' uses is not a 40-hex pin: ' + step.uses);
      }
      const hasRun = step.run !== undefined;
      const run = String(step.run || '').trim();
      if (hasRun) {
        if (!ALLOWED_RUNS.has(run)) problems.push(name + ' run command is not allowlisted: ' + run);
        if (run !== DEPLOY_RUN && run.includes('wrangler deploy')) problems.push(name + ' deploy run is not the pinned command');
        if (RUN_SECRET_RE.test(run)) problems.push(name + ' step run references a secret or CLOUDFLARE_');
      } else if (!/^actions\/(checkout|setup-node)@/.test(String(step.uses || ''))) {
        problems.push(name + ' step is not checkout, setup-node, or an allowlisted run');
      }
      if (run === CI_RUN) ci = idx;
      if (run === ASSEMBLE_RUN) assemble = idx;
      if (run === DEPLOY_RUN) deploy = idx;
      if (step.permissions) problems.push(...permProblems(name + ' step ' + idx, step.permissions));
    });
    if (ci < 0) problems.push(name + ' has no npm ci --ignore-scripts step');
    if (assemble < 0) problems.push(name + ' has no assemble step');
    if (deploy < 0) problems.push(name + ' has no deploy step');
    if (!(ci >= 0 && assemble >= 0 && deploy >= 0 && ci < deploy && assemble < deploy)) {
      problems.push(name + ' ci and assemble must come before deploy');
    }
    job.steps.forEach((step, idx) => {
      const blob = JSON.stringify(step);
      const hasSecret = blob.includes('CLOUDFLARE_API_TOKEN') || blob.includes('CLOUDFLARE_ACCOUNT_ID');
      if (hasSecret && idx !== deploy) problems.push(name + ' CLOUDFLARE secret outside the deploy step');
      if (idx === deploy) {
        const env = step.env || {};
        if (!String(env.CLOUDFLARE_API_TOKEN || '').includes('secrets.CLOUDFLARE_API_TOKEN')) problems.push(name + ' deploy step missing CLOUDFLARE_API_TOKEN');
        if (!String(env.CLOUDFLARE_ACCOUNT_ID || '').includes('secrets.CLOUDFLARE_ACCOUNT_ID')) problems.push(name + ' deploy step missing CLOUDFLARE_ACCOUNT_ID');
      }
    });
    const checkouts = job.steps.filter(step => String(step.uses || '').startsWith('actions/checkout@'));
    if (checkouts.length === 0) problems.push(name + ' has no checkout step');
    checkouts.forEach(step => {
      const persist = step.with && step.with['persist-credentials'];
      if (String(persist) !== 'false') problems.push(name + ' checkout persist-credentials is not false');
    });
    const setup = job.steps.find(step => String(step.uses || '').startsWith('actions/setup-node@'));
    const nodeVersion = setup && setup.with && setup.with['node-version'];
    if (!/^22\.\d+\.\d+$/.test(String(nodeVersion || ''))) problems.push(name + ' node-version is not an exact 22 patch');
  }
  return problems;
}

test('deploy-cloudflare.yml is a manual main-only deploy', () => {
  const yml = read('.github/workflows/deploy-cloudflare.yml');
  assert.deepEqual(workflowProblems(yml), []);
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies), ['wrangler']);
  assert.equal(pkg.devDependencies.wrangler, '4.160.1');
});

test('workflow parser rejects a push trigger and a job-level Cloudflare token', () => {
  const yml = read('.github/workflows/deploy-cloudflare.yml');
  const withPush = yml.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n    branches: [main]\n');
  const pushProblems = workflowProblems(withPush);
  assert.ok(pushProblems.some(problem => problem === 'on: has push'), pushProblems.join('; '));

  const moved = yml
    .replace('    environment: cloudflare-production\n', '    environment: cloudflare-production\n    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n')
    .replace('        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n', '');
  const envProblems = workflowProblems(moved);
  assert.ok(envProblems.some(problem => problem.includes('job env has CLOUDFLARE_')), envProblems.join('; '));
  assert.ok(envProblems.some(problem => problem.includes('missing CLOUDFLARE_API_TOKEN')), envProblems.join('; '));

  const notEqual = yml.replace("github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/main'");
  assert.ok(workflowProblems(notEqual).some(problem => problem.includes('if is not exactly')));
  const always = yml.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/main' || always()");
  assert.ok(workflowProblems(always).some(problem => problem.includes('if is not exactly')));
  const orTrue = yml.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/main' || true");
  assert.ok(workflowProblems(orTrue).some(problem => problem.includes('if is not exactly')));

  const unpinned = yml.replace('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5', 'actions/checkout@v4');
  assert.ok(workflowProblems(unpinned).some(problem => problem.includes('uses is not a 40-hex pin')));
  const write = yml.replace('      contents: read\n    steps:', '      contents: read\n      actions: write\n    steps:');
  assert.ok(workflowProblems(write).some(problem => problem.includes('actions: write')));
  const plainCi = yml.replace('npm ci --ignore-scripts', 'npm ci');
  assert.ok(workflowProblems(plainCi).some(problem => problem.includes('run command is not allowlisted')));
  for (const extra of ['npm install', 'npm rebuild', 'npx wrangler deploy']) {
    const added = yml.replace(
      '        run: node cloudflare/assemble.js\n',
      '        run: node cloudflare/assemble.js\n      - name: Extra\n        run: ' + extra + '\n'
    );
    assert.ok(workflowProblems(added).some(problem => problem.includes('run command is not allowlisted: ' + extra)), extra);
  }
  const toJson = yml.replace('run: node cloudflare/assemble.js', 'run: echo ${{ toJson(secrets) }}');
  assert.ok(workflowProblems(toJson).some(problem => problem.includes('secrets reference outside deploy env')));
  const secondCheckout = yml.replace(
    '          persist-credentials: false\n',
    '          persist-credentials: false\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          persist-credentials: true\n'
  );
  assert.ok(workflowProblems(secondCheckout).some(problem => problem.includes('checkout persist-credentials is not false')));

  const echoed = yml.replace('run: node cloudflare/assemble.js', 'run: echo $CLOUDFLARE_API_TOKEN');
  assert.ok(workflowProblems(echoed).some(problem => problem.includes('step run references a secret or CLOUDFLARE_')));
  const dumped = yml.replace('run: node cloudflare/assemble.js', 'run: echo ${{ toJSON(secrets) }}');
  assert.ok(workflowProblems(dumped).some(problem => problem.includes('step run references a secret or CLOUDFLARE_')));
  assert.ok(workflowProblems(dumped).some(problem => problem.includes('secrets reference outside deploy env')));

  const noEnv = yml.replace('    environment: cloudflare-production\n', '');
  assert.ok(workflowProblems(noEnv).some(problem => problem.includes('environment is not cloudflare-production')));
  const otherCmd = yml.replace(DEPLOY_RUN, 'npm exec -- wrangler deploy --config cloudflare/wrangler.jsonc');
  assert.ok(workflowProblems(otherCmd).some(problem => problem.includes('deploy run is not the pinned command')));
  const flow = yml.replace(
    '    environment: cloudflare-production\n',
    '    environment: cloudflare-production\n    env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }} }\n'
  );
  const flowProblems = workflowProblems(flow);
  assert.ok(flowProblems.some(problem => problem.includes('job env has CLOUDFLARE_')), flowProblems.join('; '));
  assert.ok(flowProblems.some(problem => problem.includes('secrets reference outside deploy env')), flowProblems.join('; '));
});
