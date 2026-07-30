import { defineConfig, devices } from "@playwright/test";

const appPort = 4300;
const bufferedFixturePort = 44014;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${appPort}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${appPort}`,
      url: `http://127.0.0.1:${appPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `INFERENCE_LENS_BUFFERED_PORT=${bufferedFixturePort} npm run dev:buffered-provider`,
      url: `http://127.0.0.1:${bufferedFixturePort}/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
