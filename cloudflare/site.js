/* ============================================================
   el-gridkort  ->  the static site (Workers static assets)
   ------------------------------------------------------------
   GitHub Pages serves the same files today. This Worker only runs
   for the three pipeline JSON files, so a browser on another host
   (the EXPO build, a copy opened from disk) can read them after the
   repo is private. Every other URL is the asset itself: index.html,
   tv2/, 404.html, robots.txt, sitemap.xml, llms.txt, preview.png.

   CORS is the requesting origin when it is on the allowlist, never
   "*". Credentials are not allowed. GET and OPTIONS only.

   The allowlist matches worker/worker.js: exact origins only, plus
   'null' for a map opened from disk. No subdomain wildcards.
   ============================================================ */
const FILES = { '/hist.json': 1, '/data.json': 1, '/prices.json': 1 };
const ALLOW = new Set([
  'https://el.gridkort.dk',
  'https://seblynx.github.io',
  'https://expo.energinet.dk',
  'null'
]);
const cors = origin => origin && ALLOW.has(origin)
  ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!FILES[url.pathname]) return env.ASSETS.fetch(req);
    const h = cors(req.headers.get('Origin'));
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...h, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: h });
    let asset;
    try {
      asset = await env.ASSETS.fetch(req);
    } catch (e) {
      console.error(JSON.stringify({ message: 'asset fetch failed', path: url.pathname, error: String(e && e.message || e) }));
      return new Response(JSON.stringify({ error: 'asset unavailable' }), { status: 502, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const headers = new Headers(asset.headers);
    if (headers.get('Access-Control-Allow-Origin') === '*') headers.delete('Access-Control-Allow-Origin');
    headers.delete('Access-Control-Allow-Credentials');
    for (const [k, v] of Object.entries(h)) headers.set(k, v);
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(asset.body, { status: asset.status, headers });
  }
};
