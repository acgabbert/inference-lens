import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("runs the Vite-bundled Safe Regex v1 contract in Chromium", async (t) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "warn",
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const baseUrl = server.resolvedUrls?.local[0];
  assert.ok(baseUrl, "Vite did not expose its local fixture URL.");
  const page = await browser.newPage();
  await page.goto(new URL("tests/fixtures/safe-regex-browser.html", baseUrl).href);
  const result = JSON.parse(await page.locator("#result").textContent());
  assert.deepEqual(result, {
    match: "matched",
    adversarial: "not-matched",
    unsupported: "lookahead",
  });
});
