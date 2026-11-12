# Cloudflare migration for el.gridkort.dk

This repo is ready to be served from Cloudflare. Nothing here changes what GitHub Pages serves today: `CNAME` is not a file in this repo (the custom domain is a Pages setting and stays), `.github/workflows/update-data.yml` is untouched, and `index.html` still requests the same URLs. No Cloudflare resource is created by this change. Wrangler is not a dependency of the repo.

Checked against the live site on 2026-11-12.

## Current architecture

`el.gridkort.dk` is a CNAME to `seblynx.github.io`. The zone `gridkort.dk` is already on Cloudflare (`chase.ns.cloudflare.com`, `nadia.ns.cloudflare.com`). The CNAME is DNS-only: responses come from GitHub (`server: GitHub.com`), not through the Cloudflare proxy.

GitHub Pages publishes the whole repository (`path: .` in `.github/workflows/update-data.yml`) on every run, including when the data files did not change. There is no `CNAME` file and no build step. The map in `index.html` is already the built page. There is no `package.json`.

The scheduled job (cron `7,22,37,52 * * * *`, plus `workflow_dispatch` and push to `main`) writes:

| File | What it is | When it is rewritten |
|---|---|---|
| `data.json` | One measurement, the shape `poll.js` writes | Every run that produces a valid frame |
| `prices.json` | DK1/DK2 quarter-hour prices, the shape `prices.js` writes | Every run, but a failure still publishes `data.json` |
| `hist.json` | About 30 days of hourly history, the shape `compact.js` writes | When `hist.json` is missing or older than 6 hours |

Live numbers on the map do not wait for that job. The browser asks `https://api.gridkort.dk/elnet/now.json` first. That is the existing Worker `gridkort-api` (`worker/worker.js`), which calls Energinet with no `Origin` header and caches the frame for 60 seconds. `data.json` beside the page is the next try, then the public raw URL, then `seblynx.github.io`. Prices follow the same idea: `https://api.gridkort.dk/elnet/prices.json`, then `prices.json`, then the raw URL. The browser never calls `api.energidataservice.dk`. The old same-host `/api/` proxy is not in the page anymore.

`hist.json` is requested as a relative URL first, then from `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/hist.json`. Whichever copy ends later wins. The copy baked into `index.html` is the last resort.

Pages also serves `tv2/` (GET `/tv2` is a 301 to `/tv2/`), `404.html` (status 404, including for `/en` and `/en/`), `robots.txt`, `sitemap.xml`, `llms.txt`, and `preview.png`. English is not a path. It is `https://el.gridkort.dk/?lang=en`, applied in the page after load. `/en` today is the custom 404.

`https://seblynx.github.io/danmarks-elnet-live/` is a 301 to `https://el.gridkort.dk/`. That redirect is GitHub Pages seeing the custom domain. It disappears when Pages is turned off.

A second copy of the map is the Energinet-branded build at `https://expo.energinet.dk/sbw/danmarks-elnet-live-mainv3/`. Its source is not in this repo. See [EXPO build](#expo-build).

## Target architecture

Two Workers, both already the kind of thing this account runs. No Pages project, no KV, no R2, no Cloudflare Cron Trigger.

1. **`el-gridkort`** (new). Workers static assets. The public site: the same HTML, `tv2/`, `404.html`, the SEO files, `preview.png`, and `data.json`, `hist.json`, `prices.json`. `cloudflare/site.js` runs only for the three JSON files, to set CORS. `wrangler.jsonc` does not attach `el.gridkort.dk`. The first deploy only creates the `workers.dev` hostname.
2. **`gridkort-api`** (existing, `api.gridkort.dk`). Unchanged live routes: `/elnet/now.json`, `/elnet/prices.json`, `/elnet/status`. New read-only GET routes `/hist.json`, `/data.json`, and `/prices.json` serve the pipeline files by fetching `env.DATA_ORIGIN` (the `el-gridkort` origin). They are not a second copy of the data and they do not call Energinet.

`DATA_ORIGIN` is how the API keeps serving the files after DNS moves and after the repo is private. It must be the `workers.dev` origin, not `https://el.gridkort.dk`, so it does not follow the custom domain back to GitHub Pages and does not depend on the cutover.

The map on `el.gridkort.dk` keeps using relative `hist.json`, `data.json`, and `prices.json`. Once the hostname points at `el-gridkort`, those requests hit the static assets. The raw GitHub URLs stay in `index.html` as later fallbacks so the Pages site does not change. After the repo is private they fail, and the page uses the relative file (on the Worker) or the history baked into `index.html` (a file opened from disk).

There is no Cloudflare cron. The 31 Energinet calls that build `hist.json`, and the gates in `poll.js` and `prices.js`, stay in the GitHub Action. A Worker cron would be a second implementation of those scripts, and a single invocation can run out of subrequests. The files are the bytes those scripts already write.

## Why this option

Workers static assets, not a new Pages project. Cloudflare treats Pages as the legacy path for a new site, and this account already runs the API as a Worker. A Pages project would still need a Function or a Worker for CORS, because a `_headers` file can set only one `Access-Control-Allow-Origin` value. Reflecting the caller's origin (and refusing `*` and credentials) has to be code.

Static files on `el-gridkort`, not KV or R2. The pipeline already produces the three files. The Worker stores them as assets and the API reads that origin. A KV namespace would be another id to keep out of the repo, another secret, and the same bytes. Generating `hist.json` inside `gridkort-api` would duplicate `fetch.js` and `compact.js`.

CORS on the JSON routes:

- Allowed origins are the ones already allowed by `gridkort-api`: `https://*.gridkort.dk`, `https://gridkort.dk`, `https://seblynx.github.io`, `https://*.energinet.dk`, `https://energinet.dk`, and `null` (a file opened from disk). `https://expo.energinet.dk` is listed on its own as well.
- The response header is that exact origin. It is never `*`.
- `Access-Control-Allow-Credentials` is not set.
- Methods: GET, plus OPTIONS preflight. Anything else is 405.
- `Cache-Control: no-store` on the three files, so a shared cache cannot keep yesterday's measurement. Pages today sends `max-age=600` and ignores the page's cache-buster. `no-store` is the behaviour `README.md` already asks of a self-hosted copy.

`/en` stays a 404. `not_found_handling` is `404-page`, not single-page application, so an unknown path does not return `index.html` with status 200. English stays `/?lang=en`.

## What the owner sets up

Do these before any DNS change. After step 3 the live site is still GitHub Pages.

1. **API token.** Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.
   - Permission: Account → Workers Scripts → Edit.
   - Account: the account that already owns Worker `gridkort-api`.
   - Do not grant Zone → DNS → Edit. This token must not be able to move `el.gridkort.dk`.
   - Do not grant Workers KV, R2, or Cloudflare Pages.
   - If the token can be limited to the script name `el-gridkort`, limit it. It must not be able to edit `gridkort-api`.
2. **GitHub Actions secrets**, on this repo → Settings → Secrets and variables → Actions → New repository secret. Values stay in GitHub. They are not written into the repo.
   - `CLOUDFLARE_API_TOKEN` — the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID` — the account id (the id in the Workers & Pages URL). The name is all this repo stores.
3. **Create Worker `el-gridkort`** from a checkout of the reviewed branch, once:

   ```
   node cloudflare/assemble.js
   npx --yes wrangler@4.160.1 deploy --config cloudflare/wrangler.jsonc
   ```

   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must be in the environment for that command. Wrangler is not installed into the repo; `npx` fetches the pinned version. The config name is `el-gridkort`. `workers_dev` is true. There is no route and no custom domain in the config, so this does not change DNS. There is no dashboard build command and no Pages output directory: the asset directory is `cloudflare/dist`, produced by `assemble.js`, and `main` is `cloudflare/site.js`. Compatibility date is `2026-11-12`. Logs are enabled and traces are sampled at 1%.
4. **Copy the `workers.dev` origin** from Workers & Pages → `el-gridkort` → Settings → Domains & Routes. It looks like `https://el-gridkort.<subdomain>.workers.dev`. No path, no trailing slash.
5. **Variable on the existing API Worker.** Workers & Pages → `gridkort-api` → Settings → Variables and Secrets → Add.
   - Type: plain text, not a secret (it is a public origin).
   - Name: `DATA_ORIGIN`
   - Value: the origin from step 4.
   - Do not add a KV namespace, an R2 bucket, or a Cron Trigger. Do not rename the Worker. Do not change the route `api.gridkort.dk/*`.
6. **Deploy the new `worker/worker.js` onto `gridkort-api`.** Same way it is deployed today: Workers & Pages → `gridkort-api` → Edit code → replace with the file from this repo → Deploy. Or, from a checkout:

   ```
   npx --yes wrangler@4.160.1 deploy worker/worker.js --name gridkort-api --keep-vars
   ```

   `--keep-vars` keeps `DATA_ORIGIN`. Do not pass a route. Do not deploy `cloudflare/wrangler.jsonc` under the name `gridkort-api`.
7. **Check the new URLs** before anyone depends on them. From a machine, with the real origin:

   ```
   curl -sD - -o /dev/null -H 'Origin: https://expo.energinet.dk' https://api.gridkort.dk/hist.json
   curl -sD - -o /dev/null -H 'Origin: https://expo.energinet.dk' https://api.gridkort.dk/data.json
   curl -sD - -o /dev/null -H 'Origin: https://expo.energinet.dk' https://api.gridkort.dk/prices.json
   curl -sD - -o /dev/null -H 'Origin: https://example.com' https://api.gridkort.dk/hist.json
   ```

   Use GET, not `curl -I`. Those three routes answer `405` to HEAD on purpose: the only methods are GET and OPTIONS. The first three must be `200`, `content-type` JSON, `cache-control: no-store`, and `access-control-allow-origin: https://expo.energinet.dk`. They must not send `access-control-allow-credentials`. `https://example.com` must not receive `access-control-allow-origin`. `https://api.gridkort.dk/elnet/now.json` and `https://api.gridkort.dk/elnet/prices.json` must still be the live routes. GET `https://<workers.dev>/hist.json` with the same `Origin` must be `200` with the same CORS. `https://el.gridkort.dk/` must still be GitHub (`server: GitHub.com`).
8. **After a security review**, move `docs/proposed-workflows/update-data-cloudflare.yml` to `.github/workflows/update-data-cloudflare.yml` and disable `.github/workflows/update-data.yml` in that same commit (delete it, or remove its `on:` triggers). Do not run both. The new job is the same fetch, the same commit to `main`, and then `node cloudflare/assemble.js` plus `npx --yes wrangler@4.160.1 deploy`. Its cron is unchanged: `7,22,37,52 * * * *`. Its permissions are `contents: write` only. It has no `pages: write` and no `id-token: write`.

Until step 8 has run at least once, `workers.dev` holds the files from the manual deploy in step 3. Run the new workflow once by hand (Actions → Opdater data (Cloudflare) → Run workflow) before the EXPO upload if that deploy is more than a few hours old.

## EXPO build

The source of `https://expo.energinet.dk/sbw/danmarks-elnet-live-mainv3/` is not in this repository. Nothing here can be built into that upload. The deployed HTML was fetched on 2026-11-12. It is a branded build of the same page, and the four absolute GitHub URLs are the ones that break when this repo is private.

Relative `hist.json` and `data.json` on that host exist and were last modified **2026-09-30**. They lose to a fresher absolute URL, which is why the timeline still moves today. Relative `prices.json` on that host is **404**. Leave the three relative strings as they are. Uploading fresh JSON beside the HTML would go stale again at the next hand-upload.

Edit these four lines in the private source that produces the build, or in the built HTML if that is what gets uploaded. Then rebuild if there is a source, and hand-upload. That upload is [cutover step A](#cutover).

| File | Line (deployed HTML, 2026-11-12) | Old URL | New URL |
|---|---|---|---|
| the built page | 2501, in `HIST_URLS` | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/hist.json` | `https://api.gridkort.dk/hist.json` |
| the built page | 2644, in `DATA_URLS` | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/data.json` | `https://api.gridkort.dk/data.json` |
| the built page | 2645, in `DATA_URLS` | `https://seblynx.github.io/danmarks-elnet-live/data.json` | `https://el.gridkort.dk/data.json` |
| the built page | 3435, in `SPOT_URLS` | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/prices.json` | `https://el.gridkort.dk/prices.json` |

`https://seblynx.github.io/danmarks-elnet-live/data.json` already answers `301` to `https://el.gridkort.dk/data.json`, so that replacement is the URL the browser lands on today.

Lines that stay:

| Line | What it is | Why it stays |
|---|---|---|
| 2500 | `'hist.json'` | Same-origin file on the expo host. Stale, but a valid older copy. |
| 2637 | `https://api.gridkort.dk/elnet/now.json` | Already the live frame. |
| 2638 | `'data.json'` | Same-origin file. Stale. The new absolute URL is the fresh fallback. |
| 3433 | `https://api.gridkort.dk/elnet/prices.json` | Already the live prices. |
| 3434 | `'prices.json'` | 404 on the expo host today. The next URL is the one that changes. |

`https://api.gridkort.dk/prices.json` is the same pipeline file as `https://el.gridkort.dk/prices.json`. The EXPO line uses `el.gridkort.dk` because `https://api.gridkort.dk/elnet/prices.json` is already the first prices URL. A fallback on the same Worker would not help when that Worker is down. `el.gridkort.dk/prices.json` and `el.gridkort.dk/data.json` answer from GitHub Pages until DNS moves (with `Access-Control-Allow-Origin: *`, which Expo can read) and from `el-gridkort` after DNS moves (reflected CORS). The two `api.gridkort.dk` URLs do not depend on DNS. Do the API deploy in the setup list before this upload, or `hist.json` and `data.json` 404.

The same four constants in **this** repo's `index.html` are not changed. On the hosted map the relative file is tried first and wins. Changing them would change the Pages site and would fail `test/spot.test.js`, which pins the prices list.

## Every GitHub URL

Searched the repo for `raw.githubusercontent.com`, `github.io`, `seblynx.github.io`, and `api.github.com`. There is no `api.github.com` URL.

| Where | Line | URL | What replaces it when the repo is private | Changed in this PR? |
|---|---|---|---|---|
| `index.html` | 2410 | `hist.json` (relative) | The static asset on `el-gridkort` | No. It already wins on the hosted page. |
| `index.html` | 2411 | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/hist.json` | Nothing new in the page. The relative file wins on the Worker. A file opened from disk skips the relative URL, this one fails, and the baked-in history remains. | No |
| `index.html` | 2547 | `https://api.gridkort.dk/elnet/now.json` | Stays. Already Cloudflare. | No |
| `index.html` | 2548 | `data.json` (relative) | The static asset on `el-gridkort` | No |
| `index.html` | 2554 | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/data.json` | Later fallback. The Worker and the relative file are tried first. | No |
| `index.html` | 2555 | `https://seblynx.github.io/danmarks-elnet-live/data.json` | Dies when Pages is disabled. Same ladder: it is the last data URL. | No |
| `index.html` | 3332 | `https://api.gridkort.dk/elnet/prices.json` | Stays. Already Cloudflare. | No |
| `index.html` | 3333 | `prices.json` (relative) | The static asset on `el-gridkort` | No |
| `index.html` | 3334 | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/prices.json` | Later fallback. Live prices and the relative file are tried first. | No |
| EXPO built HTML | 2501, 2644, 2645, 3435 | the four URLs in the table above | The new URLs in that table | No. The source is not in this repo. Hand-upload, cutover step A. |
| `test/spot.test.js` | 382 | asserts the prices URL list | Not a consumer | No |
| `worker/worker.js` | allowlist | `https://seblynx.github.io` | Not a fetch. Browsers on the old host may still read the API until Pages is off. | Kept, and `https://expo.energinet.dk` added beside it |
| `README.md` | 10 | prose about the `github.io` redirect | Not a fetch | No |
| `SERVER-SETUP.md` | 113–115 | prose that `hist.json` is fetched from the public repo | Not a fetch. The new source is this document. | No |

## CUTOVER

Do this only after the setup list, including one successful run of the new workflow so `workers.dev` has fresh files, and after the curl checks pass. Each step has its own rollback. Roll back in reverse order if you stop halfway.

### A. Hand-upload the EXPO build

Before the repo is made private. The page at `expo.energinet.dk` keeps working on the old URLs until this upload, and those URLs die at step C or earlier if Pages is already off.

1. Edit the four lines in [EXPO build](#expo-build).
2. Rebuild from the private source if that is how the file is produced.
3. Upload the new build over `https://expo.energinet.dk/sbw/danmarks-elnet-live-mainv3/` the same way the current file was uploaded.
4. Open that URL. The LIVE badge is green, the timeline reaches the last few hours (not 2026-09-30), and the price strip has data. In the browser's network log, `hist.json` and `data.json` come from `api.gridkort.dk`, and `prices.json` comes from `el.gridkort.dk` (or from `api.gridkort.dk/elnet/prices.json` first, which was already the case).

**Rollback:** upload the previous build again. The old file still works as long as the repo is public and Pages is still on.

### B. Switch DNS for el.gridkort.dk

1. Workers & Pages → `el-gridkort` → Settings → Domains & Routes → Add → Custom domain → `el.gridkort.dk`.
2. The zone is already on this account. Accept the DNS record Cloudflare offers for that hostname. Today the record is CNAME `el` → `seblynx.github.io`, proxy status DNS only (grey cloud).
3. Wait until `curl -sI https://el.gridkort.dk/` shows `server: cloudflare` and `200`. Then check `/`, `/?lang=en` (same `index.html`), `/tv2` (one redirect to `/tv2/`, then `200`), `/tv2/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/preview.png`, `/data.json`, `/hist.json`, `/prices.json`, and a missing path such as `/en` (status `404`, body is `404.html`, title "Siden findes ikke"). JSON responses to `Origin: https://expo.energinet.dk` carry that origin and `cache-control: no-store`, and do not carry `access-control-allow-credentials`.
4. The LIVE badge on `https://el.gridkort.dk/` is green. That request still goes to `api.gridkort.dk/elnet/now.json`.

**Rollback:** Workers & Pages → `el-gridkort` → the `el.gridkort.dk` domain → Remove. Then DNS → Records for `gridkort.dk`: restore CNAME `el` → `seblynx.github.io`, proxy status DNS only. Do not leave the hostname pointing at neither place. Pages must still be enabled for this rollback to serve the site.

### C. Disable GitHub Pages

Repo → Settings → Pages → Build and deployment → Source: None. There is no `CNAME` file to delete. Leave the Pages custom-domain field empty if GitHub still shows one, so GitHub does not keep trying to claim `el.gridkort.dk` while the Worker owns it.

This stops `https://seblynx.github.io/danmarks-elnet-live/` from redirecting to the map. That redirect cannot be kept without leaving Pages on. The map itself is on `el.gridkort.dk`.

**Rollback:** Settings → Pages → Deploy from a branch → `main` → folder `/ (root)`. Do not set the custom domain on Pages while the Worker still has `el.gridkort.dk`. The `github.io` URL will 301 to `el.gridkort.dk` again only if the custom domain is configured on Pages; skip that until a full DNS rollback (step B) is also done.

### D. Make the repo private

Repo → Settings → General → Danger Zone → Change repository visibility → Private.

Anonymous `raw.githubusercontent.com` and `github.io` URLs start failing. The hosted map uses the Worker assets. EXPO uses the URLs from step A. Actions on a private repo draw minutes from the plan. The schedule still stops after 60 days without a commit; the heartbeat commit in the workflow is what prevents that, same as today.

**Rollback:** Settings → General → Change repository visibility → Public. The raw URLs work again. The Cloudflare site does not have to be reverted for that.

## What was tested here, and what a preview still has to show

`node --test` runs the existing tests and `test/cloudflare.test.js`. The new tests load `worker/worker.js` and `cloudflare/site.js` under Node with a stubbed `fetch` and cache. They check the three snapshot routes, the reflected CORS, the missing `DATA_ORIGIN` case, the redirect refusal, the cache, that `/elnet/prices.json` is still the live route, and that `assemble.js` copies `index.html`, `404.html`, `tv2/index.html`, `robots.txt`, `sitemap.xml`, `llms.txt`, `preview.png`, and the three JSON files byte for byte. There is no package script named `build`. `node cloudflare/assemble.js` is the whole build: it copies the page that is already built.

`npx --yes wrangler@4.160.1 dev --config cloudflare/wrangler.jsonc --local` (wrangler 4.160.1, not installed into the repo) was run against `cloudflare/dist`. It parsed 1 redirect rule and 3 header rules. On that local server:

- `GET /` and `GET /?lang=en` are `200` `index.html`, with the canonical URL, `og:image`, `og:locale:alternate`, the JSON-LD block, and `max-image-preview:large`.
- `GET /tv2` is one `301` to `/tv2/`, and `GET /tv2/` is `200`. The `_redirects` line and `html_handling` do not produce a second hop.
- `GET /en`, `GET /en/`, and an unknown path are `404` with the body of `404.html` ("Siden findes ikke").
- `GET /robots.txt`, `/sitemap.xml`, `/llms.txt`, and `/preview.png` are `200`.
- `GET /hist.json?t=99` with `Origin: https://expo.energinet.dk` is `200`, `content-type: application/json`, `cache-control: no-store`, `access-control-allow-origin: https://expo.energinet.dk`, no credentials header. `hist.json` had `n` 725. `Origin: https://example.com` gets the bytes and no allow-origin. `Origin: null` is allowed. OPTIONS is `204` with `access-control-allow-methods: GET`. HEAD and POST are `405`.

What that local preview does not show, and a real Cloudflare deploy still has to confirm:

- The certificate and the DNS change for `el.gridkort.dk` (step B). Do not point the hostname at a local preview.
- `gridkort-api` actually fetching `DATA_ORIGIN` (the unit test stubs `fetch`).
- The LIVE badge, the timeline, and the price strip in a browser on the `workers.dev` origin, then again on `el.gridkort.dk` after step B, then on the EXPO page after step A.
- Workers logs and traces showing up in the dashboard.
