// Search-result details of the live map that the smoke test does not pin: the description fits
// a result snippet, and the tab has an icon that needs no extra request.

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
});

test("meta description fits a search snippet (at most 160 characters)", async ({ page }) => {
  const text = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
  expect(text.length, `meta description "${text}"`).toBeLessThanOrEqual(160);
});

test("icon is one inline SVG that renders", async ({ page }) => {
  const icons = page.locator('link[rel="icon"]');
  await expect(icons).toHaveCount(1);
  const href = (await icons.getAttribute("href")) ?? "";
  expect(href, "icon href").toMatch(/^data:image\/svg\+xml,/);

  const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
  const parsed = await page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, "image/svg+xml");
    return {
      error: doc.querySelector("parsererror")?.textContent ?? null,
      root: doc.documentElement.nodeName,
    };
  }, svg);
  expect(parsed.error, "SVG parse error").toBeNull();
  expect(parsed.root).toBe("svg");

  // Draw it at tab size and count pixels that are neither transparent nor the light tile, so an
  // empty or blank SVG (which still loads with a width) does not pass.
  const inked = await page.evaluate(
    (src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = c.height = 32;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, 32, 32);
          const px = ctx.getImageData(0, 0, 32, 32).data;
          let n = 0;
          for (let i = 0; i < px.length; i += 4)
            if (px[i + 3] > 128 && px[i] + px[i + 1] + px[i + 2] < 600) n++;
          resolve(n / (32 * 32));
        };
        img.onerror = () => resolve(0);
        img.src = src;
      }),
    href,
  );
  expect(inked, "share of the icon that is drawn on the tile").toBeGreaterThan(0.05);
});
