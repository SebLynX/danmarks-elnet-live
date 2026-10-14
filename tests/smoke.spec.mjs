// Day-one smoke test for a static site: every .html page in the repo root (and one level down)
// must load with HTTP < 400, have a title, throw no JavaScript errors, log no console errors
// caused by the site itself, load its own scripts, styles and images, and every internal link
// must resolve.
//
// Data requests (fetch/XHR) that fail are reported but do not fail the test. The map walks a
// fallback chain on purpose (api.gridkort.dk, data.json, /api/ on the same host, GitHub Pages,
// embedded history), and on localhost most links in that chain refuse: the worker's CORS list
// does not include localhost, and there is no /api/ proxy. External resources that fail are
// reported too - they are not the site's bug and they make CI flaky.
// The agent extends this suite one failing test at a time (see /tdd). Never loosen it to pass.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "tests",
  "test-results",
  "playwright-report",
  "_site",
  ".git",
  ".github",
  ".claude",
]);

// Console messages the browser writes for a failed network request. The request itself is
// judged below by its type and origin, so the console copy is not counted twice.
const NETWORK_CONSOLE =
  /^(Failed to load resource|Access to (fetch|XMLHttpRequest) at .* blocked by CORS policy)/;

function htmlPages(dir = ".", depth = 0) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (depth < 1 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        out.push(...htmlPages(path.join(dir, entry.name), depth + 1));
      }
    } else if (entry.name.endsWith(".html")) {
      out.push(path.join(dir, entry.name).replace(/^\.\//, "").split(path.sep).join("/"));
    }
  }
  return out;
}

const pages = htmlPages();
test("at least one html page exists", () => expect(pages.length).toBeGreaterThan(0));

for (const file of pages) {
  test(`${file} loads clean`, async ({ page, request, baseURL }) => {
    const siteErrors = [];
    const networkNoise = [];
    const isOwn = (url) => url.startsWith(baseURL);
    const isData = (req) => ["fetch", "xhr"].includes(req.resourceType());

    page.on("pageerror", (err) => siteErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const url = msg.location()?.url ?? "";
      const line = `${msg.text()} @ ${url}`;
      if (NETWORK_CONSOLE.test(msg.text()) || (url && !isOwn(url))) networkNoise.push(line);
      else siteErrors.push(line);
    });
    page.on("response", (r) => {
      if (r.status() < 400) return;
      const line = `HTTP ${r.status()} ${r.url()}`;
      if (isOwn(r.url()) && !isData(r.request())) siteErrors.push(`missing own file: ${line}`);
      else networkNoise.push(line);
    });
    page.on("requestfailed", (req) => {
      const line = `${req.failure()?.errorText} ${req.url()}`;
      if (isOwn(req.url()) && !isData(req)) siteErrors.push(`own file failed: ${line}`);
      else networkNoise.push(line);
    });

    const response = await page.goto(`/${file}`);
    expect(response?.status(), `HTTP status for ${file}`).toBeLessThan(400);
    await expect(page).toHaveTitle(/.+/);
    // Bounded: an external host that hangs must not eat the whole test timeout.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    const internal = hrefs.filter(
      (h) => h && !/^(https?:|mailto:|tel:|#|javascript:|data:)/i.test(h),
    );
    for (const href of internal) {
      const target = new URL(href, `${baseURL}/${file}`).toString();
      const r = await request.get(target);
      expect(r.status(), `broken internal link "${href}" on ${file}`).toBeLessThan(400);
    }

    if (networkNoise.length)
      console.warn(
        `[${file}] data or external requests failed (not failing the test):\n  ${networkNoise.join("\n  ")}`,
      );
    expect(siteErrors, `errors raised by ${file} itself`).toEqual([]);
  });
}

// The live map, as it is on 14-10-2026. Lengths are ranges, not exact text, so wording can
// change without touching this file; a missing, empty or broken tag cannot.
test.describe("index.html", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/index.html");
  });

  test("map canvas is present", async ({ page }) => {
    const canvas = page.locator("canvas#gl");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width, "canvas width").toBeGreaterThan(0);
    expect(box?.height, "canvas height").toBeGreaterThan(0);
  });

  test("title is in range", async ({ page }) => {
    const title = await page.title();
    expect(title.length, `title "${title}"`).toBeGreaterThanOrEqual(10);
    expect(title.length, `title "${title}"`).toBeLessThanOrEqual(70);
  });

  test("meta description exists once and is in range", async ({ page }) => {
    const tags = page.locator('meta[name="description"]');
    await expect(tags).toHaveCount(1);
    const text = (await tags.getAttribute("content")) ?? "";
    expect(text.length, "meta description length").toBeGreaterThanOrEqual(50);
    expect(text.length, "meta description length").toBeLessThanOrEqual(300);
  });

  test("canonical exists once and is an absolute https URL", async ({ page }) => {
    const tags = page.locator('link[rel="canonical"]');
    await expect(tags).toHaveCount(1);
    const href = (await tags.getAttribute("href")) ?? "";
    expect(href.length, "canonical length").toBeGreaterThanOrEqual(12);
    expect(href.length, "canonical length").toBeLessThanOrEqual(200);
    expect(new URL(href).protocol, `canonical "${href}"`).toBe("https:");
  });

  test("JSON-LD exists, parses and names schema.org", async ({ page }) => {
    const blocks = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
    expect(blocks.length, "JSON-LD blocks").toBeGreaterThan(0);
    for (const raw of blocks) {
      expect(raw.length, "JSON-LD length").toBeGreaterThanOrEqual(100);
      expect(raw.length, "JSON-LD length").toBeLessThanOrEqual(20000);
      const data = JSON.parse(raw);
      expect(String(data["@context"]), "JSON-LD @context").toMatch(/schema\.org/);
    }
  });
});
