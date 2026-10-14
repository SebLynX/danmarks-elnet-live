// Playwright config for a framework-free static site. Serves the repo root on :4173 and runs
// tests/*.spec.mjs against it. The .mjs extension stands in for "type": "module", which
// package.json must not set: the data job runs poll.js, fetch.js and compact.js as CommonJS.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx --no-install http-server -p 4173 -s -c-1 .",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
