# danmarks-elnet-live - the built 3D map of the Danish power system at el.gridkort.dk, plus its data job

## Commands

- Check everything (this is "green"): `bash .claude/hooks/check.sh`
- Setup once: `npm ci && pip install pre-commit && npx playwright install chromium && pre-commit install --hook-type pre-commit --hook-type pre-push`
- Tests only: `npx playwright test`
- Run locally: `npx http-server -p 8080 -c-1 .` and open http://localhost:8080/ (4173 is the tests' port; a server left there is reused by them)

## Rules

- Follow the vibecoding protocol: grill before build, one failing test first, green, refactor, review.
- Existing tests are read-only. Never edit, delete, skip or weaken a test to get green - stop and report instead.
- Done means `bash .claude/hooks/check.sh` exits 0 and you show its output. No coverage targets.
- Ask before touching: `.env*`, lockfiles, `.pre-commit-config.yaml`, `.github/workflows/`, `.claude/`.
- New dependency: confirm it exists on the registry with real history before adding it.

## Environment

- index.html is build output; its source lives in a private repo. data.json and hist.json are written by the data job - never edit them by hand.
- Never set "type": "module" in package.json: poll.js, fetch.js and compact.js are CommonJS and the data job runs them with node.
- Deploy: update-data.yml publishes to GitHub Pages in the same run that commits data (schedule, hourly dispatch, push to main). ci.yml only checks.
