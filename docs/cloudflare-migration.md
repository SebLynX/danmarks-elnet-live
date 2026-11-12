# Cloudflare migration for el.gridkort.dk

This repo is ready to be served from Cloudflare. The repo is already public. Merging this pull request is a push to `main`, and that push runs `.github/workflows/update-data.yml`, which is not changed here. That workflow publishes the whole checkout to GitHub Pages (`path: .`). After the next successful run, `package.json`, `package-lock.json`, and `.github/workflows/deploy-cloudflare.yml` are reachable on the live site, along with the files already published. None of those files contain a token, an account id, or a secret. The new workflow does not run on that push: its only trigger is `workflow_dispatch`, and its job runs only on `refs/heads/main`. `index.html` still requests the same URLs. There is no `CNAME` file; the custom domain stays a Pages setting until cutover. No Cloudflare resource is created by this change. The only dependency is the devDependency `wrangler` at exactly `4.160.1`.

Checked against the live site on 2026-11-12.

## Current architecture

`el.gridkort.dk` is a CNAME to `seblynx.github.io`. The zone `gridkort.dk` is already on Cloudflare (`chase.ns.cloudflare.com`, `nadia.ns.cloudflare.com`). The CNAME is DNS-only: responses come from GitHub (`server: GitHub.com`), not through the Cloudflare proxy.

GitHub Pages publishes the whole repository (`path: .` in `.github/workflows/update-data.yml`) on every run, including when the data files did not change. There is no `CNAME` file and no build step. The map in `index.html` is already the built page. `package.json` is private and lists one devDependency, `wrangler` at exactly `4.160.1`. The page itself has no dependency.

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
2. **`gridkort-api`** (existing, `api.gridkort.dk`). Unchanged live routes: `/elnet/now.json`, `/elnet/prices.json`, `/elnet/status`. New read-only GET routes `/hist.json`, `/data.json`, and `/prices.json` serve the pipeline files. They read them through the service binding `env.DATA` (Worker `el-gridkort`). `DATA_ORIGIN` is only the fallback when that binding is absent.

A plain `fetch()` from `gridkort-api` to `el-gridkort`'s `workers.dev` hostname fails: both Workers are on the same account. Cloudflare documents that Worker-to-Worker `fetch` needs a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) or the [`global_fetch_strictly_public` compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), and that [fetch to another Worker on the same zone without a service binding fails](https://developers.cloudflare.com/workers/platform/limits/#worker-to-worker-subrequests). This plan uses the binding. Do not point `DATA_ORIGIN` at the `workers.dev` host. Do not set `global_fetch_strictly_public` on `gridkort-api`.

The map on `el.gridkort.dk` keeps using relative `hist.json`, `data.json`, and `prices.json`. Once the hostname points at `el-gridkort`, those requests hit the static assets. The raw GitHub URLs stay in `index.html` as later fallbacks so the Pages site does not change. After the repo is private they fail, and the page uses the relative file (on the Worker) or the history baked into `index.html` (a file opened from disk).

There is no Cloudflare cron. The 31 Energinet calls that build `hist.json`, and the gates in `poll.js` and `prices.js`, stay in the GitHub Action. A Worker cron would be a second implementation of those scripts, and a single invocation can run out of subrequests. The files are the bytes those scripts already write.

## Why this option

Workers static assets, not a new Pages project. Cloudflare treats Pages as the legacy path for a new site, and this account already runs the API as a Worker. A Pages project would still need a Function or a Worker for CORS, because a `_headers` file can set only one `Access-Control-Allow-Origin` value. Reflecting the caller's origin (and refusing `*` and credentials) has to be code.

Static files on `el-gridkort`, not KV or R2. The pipeline already produces the three files. The Worker stores them as assets and the API reads that origin. A KV namespace would be another id to keep out of the repo, another secret, and the same bytes. Generating `hist.json` inside `gridkort-api` would duplicate `fetch.js` and `compact.js`.

`/elnet/*` keeps the CORS allowlist from `main`, wildcards included: `https://*.gridkort.dk`, `https://gridkort.dk`, `https://seblynx.github.io`, `https://*.energinet.dk`, `https://energinet.dk`, and `null`. Those routes are not narrowed.

`/hist.json`, `/data.json`, `/prices.json`, and `cloudflare/site.js`, use an exact list. No subdomain wildcard.

Checked on 2026-11-12:

| Origin | What it does | Snapshot list? |
|---|---|---|
| `https://el.gridkort.dk` | Fetches `/elnet/now.json` and `/elnet/prices.json`. | Yes |
| `https://expo.energinet.dk` | The EXPO build fetches the same two URLs. | Yes |
| `https://gridkort.dk` | Homepage line 230 sets `ELNET_DATA` to the raw `data.json` in this repo and fetches it. It does not call `api.gridkort.dk` today. Its own pull request may switch that to `/data.json` only after steps 6 and 7 have passed. | Yes |
| `https://www.gridkort.dk` | Redirects to `https://gridkort.dk/` and does not serve its own page. | No |
| `https://seblynx.github.io` | 301s to `el.gridkort.dk` today. The same `index.html` would send this origin if Pages served it. Stays until step C, then comes off the snapshot list. | Yes, until step C |
| `null` | A map opened from disk. The JSON is public and read-only, and credentials are not allowed. | Yes |
| `https://vind.gridkort.dk` | Rescanned. No `raw.githubusercontent.com`, `github.io`, or `api.gridkort.dk` reference to this repo. | No |
| `https://energinet.dk` | Redirects to `https://www.energinet.dk`. Does not call this API. | No |

On the snapshot routes, `https://evil.gridkort.dk` and `https://not.energinet.dk` get no `Access-Control-Allow-Origin`. On `/elnet/*` those origins still match the wildcards from `main`.

- The response header is that exact origin. It is never `*`.
- `Access-Control-Allow-Credentials` is not set.
- Methods: GET, plus OPTIONS preflight. Anything else is 405.
- `Cache-Control: no-store` on the three files, so a shared cache cannot keep yesterday's measurement. Pages today sends `max-age=600` and ignores the page's cache-buster. `no-store` is the behaviour `README.md` already asks of a self-hosted copy.

`/en` stays a 404. `not_found_handling` is `404-page`, not single-page application, so an unknown path does not return `index.html` with status 200. English stays `/?lang=en`.

## What the owner sets up

Do these before any DNS change. After step 3 the live site is still GitHub Pages.

1. **API token.** Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.
   - Permission: Account → Workers Scripts → Edit. Cloudflare's permission is account-wide: a token with it can edit `gridkort-api` as well as `el-gridkort`. It cannot be limited to one script. See [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
   - Account resources: only the one account that already owns `gridkort-api`. No other account.
   - Set a TTL (token start and end). Pick an end date you will actually rotate.
   - Do not grant Zone → DNS → Edit. This token must not be able to move `el.gridkort.dk`.
   - Do not grant Workers KV, R2, or Cloudflare Pages.
   - Create a second token, separate from the one that will live in GitHub, for any one-off call a person makes: short TTL (hours, not months) and Client IP Address Filtering locked to that person's current IP. Delete it when the call is done. Do not use it with `npx --yes`, and do not store it in GitHub. The deploy in step 3 does not use this token.
2. **GitHub environment, not repository secrets.** Repo → Settings → Environments → New environment → name `cloudflare-production`.
   - Deployment branches: Selected branches → add `main` only.
   - Environment secrets (not repository secrets, not organization secrets): `CLOUDFLARE_API_TOKEN` (the CI token from step 1) and `CLOUDFLARE_ACCOUNT_ID` (the account id in the Workers & Pages URL). The names are all this repo stores.
3. **Run `.github/workflows/deploy-cloudflare.yml`.** Actions → that workflow → Run workflow, branch `main`. Do this only after steps 1 and 2. The only trigger is `workflow_dispatch`. The job runs only when `github.ref == 'refs/heads/main'`, on `ubuntu-latest` with Node `22.23.5`, in the environment `cloudflare-production`. Permissions are `contents: read` at the top of the file and on the job. There is no `actions: write`. `npm ci --ignore-scripts` is its own step and has no Cloudflare environment variables. The following step runs `node cloudflare/assemble.js`. The deploy step is the only one that receives `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment secrets, and it runs `npm exec --no -- wrangler deploy --config cloudflare/wrangler.jsonc`. It is not the scheduled file in `docs/proposed-workflows/`. There is no laptop deploy and no `npx --yes`. The config name is `el-gridkort`. `workers_dev` is true. `preview_urls` is false. There is no `route`, no `routes`, and no `custom_domain`, so the deploy does not change DNS. The asset directory is `cloudflare/dist`, produced by `assemble.js`, and `main` is `cloudflare/site.js`. Compatibility date in that config is `2026-11-12`. Logs are enabled and traces are sampled at 1%. The first successful run creates the Worker.
4. **Confirm `workers.dev` is on** for `el-gridkort` (Settings → Domains & Routes). The hostname is only for your own checks. `gridkort-api` does not fetch it.
5. **Service binding on the existing API Worker.** Workers & Pages → `gridkort-api` → Settings → Bindings → Add → Service binding.
   - Variable name: `DATA`
   - Service: `el-gridkort`
   - Do not add a KV namespace, an R2 bucket, or a Cron Trigger. Do not rename the Worker. Do not change the route `api.gridkort.dk/*`. Do not change the compatibility date or flags here; that is step 6.
   - Optional fallback only: Settings → Variables and Secrets → Add a plain-text variable named `DATA_ORIGIN`. Leave it unset in production. If you set it, it must be an https origin with no path, and it must not be the `workers.dev` hostname (plain `fetch` to that host fails; the binding is the path that works). The code uses `env.DATA` whenever the binding exists and ignores `DATA_ORIGIN` in that case.
6. **Deploy the new `worker/worker.js` onto `gridkort-api` from the dashboard only.**
   - Workers & Pages → `gridkort-api` → Deployments. Write down the version id of the deployment that is serving now. Rollback is that row → Rollback. One click, no CLI.
   - Settings → check the Compatibility date and Compatibility flags that are already set. Write them down. The dashboard editor must keep those values. Do not adopt the `2026-11-12` date from `cloudflare/wrangler.jsonc`. That file is for `el-gridkort` only.
   - Edit code → replace the script with `worker/worker.js` from the merged commit → Deploy.
   - There is no CLI step. Do not run `wrangler deploy` against `gridkort-api`.
7. **Check the new URLs** before anyone depends on them. Stop here if any check fails. Do not upload the EXPO build and do not touch DNS. From a machine:

   ```
   curl -sD - -o /dev/null -H 'Origin: https://expo.energinet.dk' https://api.gridkort.dk/hist.json
   curl -sD - -o /dev/null -H 'Origin: https://expo.energinet.dk' https://api.gridkort.dk/data.json
   curl -sD - -o /dev/null -H 'Origin: https://expo.energinet.dk' https://api.gridkort.dk/prices.json
   curl -sD - -o /dev/null -H 'Origin: https://example.com' https://api.gridkort.dk/hist.json
   ```

   Use GET, not `curl -I`. Those three routes answer `405` to HEAD on purpose: the only methods are GET and OPTIONS. The first three must be `200`, `content-type` JSON, `cache-control: no-store`, and `access-control-allow-origin: https://expo.energinet.dk`. They must not send `access-control-allow-credentials`. `https://example.com`, `https://evil.gridkort.dk`, and `https://not.energinet.dk` must not receive `access-control-allow-origin`. `Origin: null` must receive `access-control-allow-origin: null`. `https://api.gridkort.dk/elnet/now.json` and `https://api.gridkort.dk/elnet/prices.json` must still be the live routes. GET `https://<workers.dev>/hist.json` with `Origin: https://expo.energinet.dk` must be `200` with that allow-origin. `https://el.gridkort.dk/` must still be GitHub (`server: GitHub.com`). If any of those checks fail, stop. Do not continue to step 8, the EXPO upload, or DNS.
8. **Blocked.** Do not move the proposed workflow into `.github/` until a separate security review has accepted the final file and the lockfile from [Wrangler lockfile](#wrangler-lockfile). This pull request is not that review. When that review passes, the move and the disabling of `.github/workflows/update-data.yml` happen in one commit. Do not run both. The proposed file's `deploy` job runs only when `github.ref == 'refs/heads/main'`, in the environment `cloudflare-production`. Its `commit` job has `contents: write` and does not have `actions: write`. Its `deploy` job has only `contents: read`, `persist-credentials: false`, and installs wrangler with `npm ci --ignore-scripts` in its own step, with no Cloudflare variables. The deploy step is separate. It is the only step that receives `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and it runs `npm exec --no -- wrangler deploy --config cloudflare/wrangler.jsonc`.

After step 8, `update-data.yml` no longer republishes GitHub Pages, and `el.gridkort.dk` still points at Pages. The JSON on that hostname stays frozen at the last Pages publish until cutover step B moves DNS. Run step 8, cutover step A, and cutover step B in one sitting.

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
| `SebLynX/gridkort` homepage, served as `https://gridkort.dk/` | 230 (`const ELNET_DATA=…`) and the fetch at 372 | `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/data.json` | `https://api.gridkort.dk/data.json`, in a separate pull request on that repo. This PR does not edit it. | No |
| `worker/worker.js` | `/elnet/*` allowlist | same wildcards as `main` | Unchanged for those routes. | Restored |
| `worker/worker.js` and `cloudflare/site.js` | snapshot allowlist | `https://el.gridkort.dk`, `https://gridkort.dk`, `https://seblynx.github.io`, `https://expo.energinet.dk`, `null` | Exact origins. `https://seblynx.github.io` is removed after step C. | Yes |
| `README.md` | 10 | prose about the `github.io` redirect | Not a fetch | No |
| `SERVER-SETUP.md` | 113–115 | prose that `hist.json` is fetched from the public repo | Not a fetch. The new source is this document. | No |

## CUTOVER

Do this only after the setup list, including one successful run of the reviewed deploy so `workers.dev` has fresh files, and after the curl checks pass. One extra DNS record needs approval before step C: proxied AAAA `parked.gridkort.dk` → `100::`. It is created beside `el` and does not replace it. `100::` is Cloudflare's originless placeholder; with a Worker route on the name that points at it, Cloudflare answers the request and does not contact that address ([originless setups](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/#originless-setups), [routes with a proxied record](https://developers.cloudflare.com/workers/configuration/routing/routes/), and the same pattern on [preview hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/)).

After step B, leave GitHub Pages on, with its custom domain `el.gridkort.dk`, for at least 7 days before step C. During that soak, rolling back B is [Rollback while Pages is still on](#rollback-while-pages-is-still-on). Rolling back after C is [Rollback after step C](#rollback-after-step-c): Pages on, then the CNAME back to `seblynx.github.io` as DNS only, then remove the route.

`update-data.yml` is already off after the sitting that does steps 8, A, and B. Live JSON stays fresh only if the Cloudflare deploy is running. During the 7 days, watch three things: the snapshot is newer than the last Pages publish, the Worker is not returning errors, and the account is not near the free daily request limit shared with `gridkort-api`. Concrete check, once a day: `curl -s https://api.gridkort.dk/data.json` and compare `generated` (or `measured`) with the latest run of the Cloudflare deploy in Actions. If that run is missing or the timestamp is stuck, the soak is not safe to continue.

### A. Hand-upload the EXPO build

Before the repo is made private. The page at `expo.energinet.dk` keeps working on the old URLs until this upload, and those URLs die at step C or earlier if Pages is already off.

1. Edit the four lines in [EXPO build](#expo-build).
2. Rebuild from the private source if that is how the file is produced.
3. Upload the new build over `https://expo.energinet.dk/sbw/danmarks-elnet-live-mainv3/` the same way the current file was uploaded.
4. Open that URL. The LIVE badge is green, the timeline reaches the last few hours (not 2026-09-30), and the price strip has data. In the browser's network log, `hist.json` and `data.json` come from `api.gridkort.dk`, and `prices.json` comes from `el.gridkort.dk` (or from `api.gridkort.dk/elnet/prices.json` first, which was already the case).

**Rollback:** upload the previous build again. The old file still works as long as the repo is public and Pages is still on.

### B. Switch DNS for el.gridkort.dk

Do not add a Custom Domain. Cloudflare will not create one on a hostname that already has a CNAME: ["You cannot create a Custom Domain on a hostname with an existing CNAME DNS record"](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Deleting that CNAME first removes the only record. The zone SOA minimum is 1800 seconds (`dig SOA gridkort.dk` on 2026-11-12: `… 1800`), which is how long a resolver may cache the negative answer. That is a gap. This cutover does not delete the record.

The record today is CNAME `el` → `seblynx.github.io`, DNS only (grey cloud). A lookup on 2026-11-12 still had 182 seconds of a 300 second TTL left. A [route](https://developers.cloudflare.com/workers/configuration/routing/routes/) runs only when that hostname is proxied. Edit the existing record in place, then attach the route. Nothing is deleted, so there is no negative cache.

Before the first edit: SSL/TLS → Overview for the zone `gridkort.dk`. The mode is zone-wide, so it also covers `gridkort.dk`, `www.gridkort.dk`, `vind.gridkort.dk`, and `api.gridkort.dk` ([SSL modes](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)). Flexible or Off: stop. Do not proxy `el`. If the mode is already **Full (strict)**, continue. If it is **Full** (not strict): open every proxied host on `gridkort.dk` and check that its origin certificate is valid for that name. If any certificate fails, stop and report which host. If every one passes, switching the zone to Full (strict) is a Cloudflare change and needs Sebastian's yes on that exact item before you do it. Do not proxy `el` until that yes, or until the zone is already Full (strict).

1. DNS → Records for `gridkort.dk` → edit `el`. Leave the type CNAME and the target `seblynx.github.io`. Set Proxy status to Proxied. Save. Keep the time until the route in the next step is saved as short as you can. A proxied CNAME to `seblynx.github.io` with no Worker route does not, by itself, keep serving the current site. It depends on the SSL mode and on the name GitHub sees in SNI, and it can answer 526 or a redirect loop. If the site shows an error in this window, set Proxy status back to DNS only at once.
2. Workers & Pages → `el-gridkort` → Settings → Domains & Routes → Add → Route. Zone `gridkort.dk`, route `el.gridkort.dk/*`, Worker `el-gridkort`. Do not choose Custom Domain. On that route, set the daily-request mode to **Fail closed**. Cloudflare names the two modes Fail open and Fail closed, and says you configure the fail mode by toggling the corresponding route ([Daily requests](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)). The published docs do not give a longer dashboard label, so do not look for a control called "Request limit failure mode". Fail closed returns error 1027 when the account passes the free-plan daily request limit. That limit is shared with `gridkort-api`. Fail open would skip the Worker and send the request to the CNAME target. Worker errors are a separate case: neither `worker/worker.js` nor `cloudflare/site.js` calls `ctx.passThroughOnException()` ([Go to origin on error](https://developers.cloudflare.com/workers/observability/errors/#go-to-origin-on-error)). An exception in the Worker becomes Cloudflare's 1101 page, or a 502 or 503 the script returned. It does not fall through to the origin.
3. `dig @1.1.1.1 el.gridkort.dk` should show Cloudflare addresses, and `curl -sI https://el.gridkort.dk/` should show `server: cloudflare` and `200`. Then check `/`, `/?lang=en` (same `index.html`), `/tv2` (one redirect to `/tv2/`, then `200`), `/tv2/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/preview.png`, `/data.json`, `/hist.json`, `/prices.json`, and a missing path such as `/en` (status `404`, body is `404.html`, title "Siden findes ikke"). JSON responses to `Origin: https://expo.energinet.dk` carry that origin and `cache-control: no-store`, and do not carry `access-control-allow-credentials`.
4. The LIVE badge on `https://el.gridkort.dk/` is green. That request still goes to `api.gridkort.dk/elnet/now.json`.
5. Soak. Keep GitHub Pages on, custom domain still `el.gridkort.dk`, for at least 7 days. Do not start step C in that time. The CNAME target is still `seblynx.github.io`. Step C must be done before **2026-12-20**, one week before the certificate below expires. While B is in place, GitHub's HTTP-01 challenge hits the Worker, so GitHub likely cannot renew that certificate, and a re-read will probably not show a fresh `notAfter`. If **2026-12-20** passes before C, undo B with the soak rollback, let GitHub renew, then redo B and a new 7-day soak. The new deadline is 7 days before the new `notAfter`. Each day of the soak, run the curl-and-Actions check in the cutover introduction: snapshot `generated` or `measured` moves when the Cloudflare deploy runs, the Worker responses are not errors, and the shared daily request limit is not close. `update-data.yml` is already off, so a quiet Actions list means the JSON on the Worker is frozen.

**Rollback during the soak:** use [Rollback while Pages is still on](#rollback-while-pages-is-still-on). Pages is already on and the CNAME target is already `seblynx.github.io`, so you confirm those two and then remove the route. This relies on GitHub's certificate for `el.gridkort.dk` that is already installed. Checked 2026-11-12, while the `el` record was still DNS only, with `openssl s_client -servername el.gridkort.dk -connect el.gridkort.dk:443` and `openssl x509 -noout -issuer -dates`: issuer `Let's Encrypt`, `CN = YR1`, subject `CN = el.gridkort.dk`, notBefore `Sep 28 16:21:35 2026 GMT`, notAfter `Dec 27 16:21:34 2026 GMT`. The HTTPS response that same minute had `server: GitHub.com`, so the certificate is GitHub Pages', not Cloudflare's. Once `el` is proxied, connecting to `el.gridkort.dk:443` returns Cloudflare's edge certificate, not GitHub's. Re-read GitHub's certificate with `openssl s_client -connect seblynx.github.io:443 -servername el.gridkort.dk </dev/null | openssl x509 -noout -issuer -subject -dates`. The subject must be `CN = el.gridkort.dk`. While B is in place that command will probably not show a fresh `notAfter`, because the challenge hits the Worker. If **2026-12-20** passes before C, this rollback is how you undo B. Leave the record DNS only until that command shows subject `CN = el.gridkort.dk` and a `notAfter` later than `Dec 27 16:21:34 2026 GMT`. Then redo B and a new 7-day soak. The new deadline is 7 days before that new `notAfter`. If step C has already been done, do not use this short path. Use [Rollback after step C](#rollback-after-step-c).

### C. Disable GitHub Pages

Before this step, GitHub → Settings → Pages → Verified domains must already list `el.gridkort.dk` ([verifying a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages)). If it does not, add the TXT record GitHub shows and wait until the domain shows as verified. Verifying the apex `gridkort.dk` is the better check: GitHub treats a verified apex as covering its subdomains, including `el.gridkort.dk`. That stops another account from attaching the hostname to Pages after this site's Pages is turned off.

Do not start this step until the 7-day soak in step B has finished. Step C must happen before **2026-12-20**. If that date passes before C, a re-read while B is still on will probably not show a fresh `notAfter`, because GitHub's HTTP-01 challenge hits the Worker. Undo B with [Rollback while Pages is still on](#rollback-while-pages-is-still-on), leave the name DNS only, and let GitHub renew. Check with `openssl s_client -connect seblynx.github.io:443 -servername el.gridkort.dk </dev/null | openssl x509 -noout -issuer -subject -dates` until the subject is `CN = el.gridkort.dk` and `notAfter` is later than `Dec 27 16:21:34 2026 GMT`. Then redo B and a new 7-day soak. The new deadline is 7 days before that new `notAfter`. Then wait at least 5 minutes after the last DNS edit as well. The CNAME TTL is 300 seconds, so a resolver can still be using an older answer until then. After the wait, `dig` and `curl -sI https://el.gridkort.dk/` again and confirm `server: cloudflare` before you continue.

1. **Needs Sebastian's yes.** Create `parked.gridkort.dk` as a proxied AAAA record to `100::`. Do not edit `el` yet. Check: `dig parked.gridkort.dk` returns Cloudflare addresses (the name is proxied, not the discard address `100::` itself), and `curl -sI https://el.gridkort.dk/` is still `200` with `server: cloudflare` (the route is still serving `el` through the existing CNAME to `seblynx.github.io`). If either check fails, stop. Do not turn Pages off.
2. Edit the `el` CNAME in place so its target is `parked.gridkort.dk`. Leave the type CNAME and leave it proxied. Immediately after that save, Repo → Settings → Pages → Build and deployment → Source: None. DNS must not still point at GitHub while Pages is off. Do not delete `el`. Do not point it at `*.workers.dev`. That name is on Cloudflare's account, not this zone, and a proxied CNAME to another account is [Error 1014: CNAME Cross-User Banned](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014/). The request hits that error if the route is removed or the daily-limit mode is Fail open. `parked.gridkort.dk` is in this zone. The route `el.gridkort.dk/*` still answers the hostname. There is no `CNAME` file to delete. Leave the Pages custom-domain field empty if GitHub still shows one.
3. Remove `https://seblynx.github.io` from `SNAP_ALLOW` in `worker/worker.js` and from the set in `cloudflare/site.js`, and deploy those two scripts again.

The parked name plus the route is a fine permanent state. A Worker Custom Domain is optional, and only later, in a quiet hour. It is the one exception to "never delete the `el` record." The [routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) page says to use a Custom Domain when the Worker is the whole site. To get there: delete the `el` CNAME and immediately add Custom Domain `el.gridkort.dk` on `el-gridkort`, then remove the route `el.gridkort.dk/*`. That delete-then-add moment can briefly leave no record. Resolvers may cache the negative answer for the zone SOA minimum, 1800 seconds. That is why it is optional.

**Rollback of that Custom Domain:** Cloudflare allows a route on a hostname that already has a Custom Domain. The [routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) page says routes take precedence if configured on the same hostname, and the [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#interaction-with-routes) page shows a route added on a hostname that already has a Custom Domain. Add the route `el.gridkort.dk/*` first, then remove the Custom Domain, then recreate the `el` CNAME to `parked.gridkort.dk` and set it proxied. Removing the Custom Domain deletes the DNS record Cloudflare created, so recreate that CNAME in the same minute. When a Worker Custom Domain is removed, open SSL/TLS → Edge Certificates and list the certificates. Delete only the Advanced certificate whose hostname list is exactly `el.gridkort.dk`. Do that after another active certificate is confirmed to cover `el.gridkort.dk` (Universal SSL covers the apex and one subdomain level, which includes this name, if it is still enabled) and only with Sebastian's yes on that exact deletion. Cloudflare says the Advanced Certificate created for the Custom Domain is not deleted with it ([Certificates](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#certificates)). Delete `parked.gridkort.dk` only after a separate yes from Sebastian. Otherwise keep it.

This stops `https://seblynx.github.io/danmarks-elnet-live/` from redirecting to the map. That redirect cannot be kept without leaving Pages on. The map itself is on `el.gridkort.dk`.

**Rollback of step C:** use [Rollback after step C](#rollback-after-step-c). Order: Pages on, then the `el` CNAME back to `seblynx.github.io` as DNS only, then remove the route.

### D. Make the repo private

Prerequisite, in a separate pull request on `SebLynX/gridkort`, not in this repo: change `ELNET_DATA` in the homepage (served today at `https://gridkort.dk/`, line 230) from `https://raw.githubusercontent.com/SebLynX/danmarks-elnet-live/main/data.json` to `https://api.gridkort.dk/data.json`. That page goes live only after steps 6 and 7 have passed. Do not deploy it before those checks. A rescan of `https://vind.gridkort.dk/` on 2026-11-12 found no `raw.githubusercontent.com` or `github.io` reference to this repo. `https://www.gridkort.dk/` only redirects to `https://gridkort.dk/`.

Repo → Settings → General → Danger Zone → Change repository visibility → Private.

Anonymous `raw.githubusercontent.com` and `github.io` URLs start failing. The hosted map uses the Worker assets. EXPO uses the URLs from step A. Actions on a private repo draw minutes from the plan. The schedule still stops after 60 days without a commit; the heartbeat commit in the workflow is what prevents that, same as today.

**Rollback:** Settings → General → Change repository visibility → Public. The raw URLs work again. The Cloudflare site does not have to be reverted for that.

### Rollback while Pages is still on

Use this when step C has not been done. The CNAME target is still `seblynx.github.io` and Pages is still on. Do not use this section after C. The target is then `parked.gridkort.dk`, and removing the route from that state is the wrong step.

Confirm Pages is on and the custom domain is `el.gridkort.dk`. Confirm the CNAME target is `seblynx.github.io`. Then remove the route `el.gridkort.dk/*`. That removal is when a 526 or a redirect loop can start, because the name is still proxied and no longer has a route. If the site shows an error, set Proxy status to DNS only at once. When the site answers from GitHub, set Proxy status to DNS only and leave the target as `seblynx.github.io`. This uses the certificate checked on 2026-11-12, which expires `Dec 27 16:21:34 2026 GMT`. If **2026-12-20** has passed before C, this rollback is what lets GitHub renew: leave the record DNS only, and check with `openssl s_client -connect seblynx.github.io:443 -servername el.gridkort.dk </dev/null | openssl x509 -noout -issuer -subject -dates` until the subject is `CN = el.gridkort.dk` and `notAfter` is later than `Dec 27 16:21:34 2026 GMT`. While B stays on, the challenge hits the Worker, so that command will probably not show a fresh `notAfter`. Then redo B and a new 7-day soak. The new deadline is 7 days before the new `notAfter`.

### Rollback after step C

Use this when Pages is off and `el` points at `parked.gridkort.dk` with the route still on. While that is true, visitors still get the Worker. There is no 526 yet. GitHub's HTTP-01 challenge and its DNS check also hit the Worker, so a certificate you wait for in this state stalls instead of arriving, and the site visitors see does not change. Do not remove the route while the target is `parked.gridkort.dk`. The TLS or 526 window starts only when you take the DNS-only step below, or if the route is removed while the name is still proxied.

[GitHub's HTTPS page](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https) says provisioning "may take some time" and does not give a duration. Any figure of about a day is an unsourced estimate, not a GitHub commitment.

1. Re-enable Pages: the repo that publishes the map → Settings → Pages → Deploy from branch `main`, folder `/ (root)`, custom domain `el.gridkort.dk`. Do not wait here for the certificate. `el` is still proxied at `parked.gridkort.dk` with the route on, so the check hits the Worker and may never finish. Visitors still see the Worker.
2. DNS → Records → edit `el`. Leave the type CNAME. Set the target back to `seblynx.github.io` and set Proxy status to DNS only. Do not delete the record. Do not remove the route in this step. This DNS-only change is when the TLS window starts. The route does not apply while the record is grey-cloud, so GitHub's checks can reach GitHub.
3. When `https://el.gridkort.dk/` answers from GitHub (`server: GitHub.com`), or you have accepted that the certificate is still pending, remove the route `el.gridkort.dk/*`. The target stays `seblynx.github.io` and the record stays DNS only. Removing the route while the name is still proxied would also open the 526 window. This order unproxies first, so that window is the DNS-only step, not a proxied name with no route.

## Wrangler lockfile

`package.json` is private. Its only dependency is the devDependency `wrangler` at exactly `4.160.1`. That is the `latest` tag on `https://registry.npmjs.org/wrangler`, published `2026-11-11T14:45:38.079Z`. `package-lock.json` is the install of that file (`npm` 10.9.9, lockfileVersion 3). Every `resolved` URL starts with `https://registry.npmjs.org/` and every package has an `integrity` hash.

Three packages in the tree set `hasInstallScript`:

| Package | Role | Script |
|---|---|---|
| `esbuild@0.28.2` | dependency of wrangler | `postinstall`: `node install.js`, which downloads a binary only when the optional platform package is absent |
| `workerd@1.20261110.1` | dependency of wrangler | `postinstall`: `node install.js`, same pattern |
| `fsevents@2.3.3` | optional, `os: darwin` | install script. npm does not install it on `ubuntu-latest` |

`wrangler@4.160.1` has no install script. `miniflare@5.20261110.1-beta` has no install script. The workflow runs `npm ci --ignore-scripts` in its own step, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` unset. The Linux binaries are files inside `@esbuild/linux-x64@0.28.2` and `@cloudflare/workerd-linux-64@1.20261110.1`, which `npm ci` installs without running scripts. Checked on 2026-11-12, with those variables unset: `npm ci --ignore-scripts`, then `npx --no wrangler deploy --dry-run --config cloudflare/wrangler.jsonc`. Wrangler 4.160.1 read 13 files from `cloudflare/dist` and exited 0 at `--dry-run: exiting now`. The deploy step that follows install is `npm exec --no -- wrangler deploy --config cloudflare/wrangler.jsonc`, so npm does not fetch a package that is not in the lockfile. `.github/workflows/deploy-cloudflare.yml` has no `actions: write`.

## Open items

- **R1. `npm ci` without a token, deploy via `npm exec --no`.** Status: done in this pull request. `.github/workflows/deploy-cloudflare.yml` runs `npm ci --ignore-scripts` in its own step, and that step has no `CLOUDFLARE_API_TOKEN` and no `CLOUDFLARE_ACCOUNT_ID`. The deploy step is the only one that receives those two secrets, and its command is `npm exec --no -- wrangler deploy --config cloudflare/wrangler.jsonc`. The proposed data workflow's deploy job is written the same way.
- **R2. `actions: write` on the proposed data workflow.** Status: removed from the `commit` job in `docs/proposed-workflows/update-data-cloudflare.yml`. That job uploads `elnet-json` with `actions/upload-artifact` at `ea165f8d65b6e75b540449e92b4886f43607fa02`. The action calls `@actions/artifact`, and that library reads `ACTIONS_RUNTIME_TOKEN` ([config.ts](https://github.com/actions/toolkit/blob/main/packages/artifact/src/internal/shared/config.ts)). The runner sets that token for the job. It is not `GITHUB_TOKEN`, and it does not use the `actions` permission. `actions: write` on `GITHUB_TOKEN` is what lets a job cancel a workflow run or call the Actions REST API ([workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defining-access-for-the-github_token-scopes)). The commit job does not do that. It keeps `contents: write`, which is the permission the push uses. The deploy job downloads the artifact in the same run, again with the runtime token, and its permissions stay `contents: read` only.

## What was tested here, and what a preview still has to show

`node --test` runs the existing tests and `test/cloudflare.test.js`. The new tests load `worker/worker.js` and `cloudflare/site.js` under Node with a stubbed `fetch` and cache. They check the three snapshot routes, the reflected CORS, the missing `DATA_ORIGIN` case, the redirect refusal, the cache, that `/elnet/prices.json` is still the live route, and that `assemble.js` copies `index.html`, `404.html`, `tv2/index.html`, `robots.txt`, `sitemap.xml`, `llms.txt`, `preview.png`, and the three JSON files byte for byte. There is no package script named `build`. `node cloudflare/assemble.js` is the whole build: it copies the page that is already built.

`npx --yes wrangler@4.160.1 dev --config cloudflare/wrangler.jsonc --local` was run against `cloudflare/dist` before wrangler was a dependency of the repo. That preview is not the deploy path. Deploy uses the lockfile, not `npx --yes`. It parsed 1 redirect rule and 3 header rules. On that local server:

- `GET /` and `GET /?lang=en` are `200` `index.html`, with the canonical URL, `og:image`, `og:locale:alternate`, the JSON-LD block, and `max-image-preview:large`.
- `GET /tv2` is one `301` to `/tv2/`, and `GET /tv2/` is `200`. The `_redirects` line and `html_handling` do not produce a second hop.
- `GET /en`, `GET /en/`, and an unknown path are `404` with the body of `404.html` ("Siden findes ikke").
- `GET /robots.txt`, `/sitemap.xml`, `/llms.txt`, and `/preview.png` are `200`.
- `GET /hist.json?t=99` with `Origin: https://expo.energinet.dk` is `200`, `content-type: application/json`, `cache-control: no-store`, `access-control-allow-origin: https://expo.energinet.dk`, no credentials header. `hist.json` had `n` 725. `Origin: https://example.com` gets the bytes and no allow-origin. `Origin: null` is allowed. OPTIONS is `204` with `access-control-allow-methods: GET`. HEAD and POST are `405`.

What that local preview does not show, and a real Cloudflare deploy still has to confirm:

- The certificate and the DNS change for `el.gridkort.dk` (step B). Do not point the hostname at a local preview.
- `gridkort-api` calling `el-gridkort` through the `DATA` service binding (the unit test stubs `env.DATA.fetch`).
- The LIVE badge, the timeline, and the price strip in a browser on the `workers.dev` origin, then again on `el.gridkort.dk` after step B, then on the EXPO page after step A.
- Workers logs and traces showing up in the dashboard.
