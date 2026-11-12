/* Copy the files GitHub Pages serves today into cloudflare/dist, and
   add the Cloudflare-only header and redirect rules. Does not modify
   the sources. Node 18+, no packages.

   Usage:  node cloudflare/assemble.js
*/
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(__dirname, 'dist');

const FILES = [
  'index.html',
  '404.html',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  'preview.png',
  'data.json',
  'hist.json',
  'prices.json',
  path.join('tv2', 'index.html')
];

/* GitHub Pages answers GET /tv2 with 301 to /tv2/. html_handling in
   wrangler.jsonc does the directory index; this rule pins the status
   code Pages uses. */
const REDIRECTS = '/tv2 /tv2/ 301\n';

/* Backup for the three JSON files when the asset layer serves them
   directly. The Worker sets the same Cache-Control itself, because
   _headers is not applied to responses the Worker builds. No
   Access-Control-Allow-Origin here: a static header cannot reflect
   one origin without falling back to "*". */
const HEADERS = [
  '/hist.json',
  '  Cache-Control: no-store',
  '/data.json',
  '  Cache-Control: no-store',
  '/prices.json',
  '  Cache-Control: no-store',
  ''
].join('\n');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const rel of FILES) {
  const from = path.join(root, rel);
  const to = path.join(dist, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
fs.writeFileSync(path.join(dist, '_redirects'), REDIRECTS);
fs.writeFileSync(path.join(dist, '_headers'), HEADERS);
console.log('assembled ' + FILES.length + ' files into cloudflare/dist');
