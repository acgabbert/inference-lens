import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const appPort = 4300;
const bufferedFixturePort = 44014;

/**
 * The only reason the suite's dev server can run anything at all.
 *
 * Command tools are declared by whoever runs the service, so the browser suite
 * has to declare them too — and it declares exactly the fixtures in
 * `tests/fixtures/command-tools`, never a shell.
 */
const commandToolCatalog = fileURLToPath(
  new URL("./tests/fixtures/command-tools/catalog.json", import.meta.url),
);

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
  projects: [
    {
      name: "chromium-light",
      use: { ...devices["Desktop Chrome"], colorScheme: "light" },
    },
    {
      name: "chromium-dark",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
  ],
  webServer: [
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${appPort}`,
      url: `http://127.0.0.1:${appPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      // A developer's repo-root `.env` must not decide what the suite sees.
      // With a server-side endpoint configured, the app provisions a server
      // default profile and shows the "Server default connection available"
      // notice, whose overlay silently intercepts clicks in specs that seed
      // their own profiles. Next.js leaves an already-set process variable
      // alone, so declaring these empty here neutralizes the file for every
      // machine rather than only the ones without an `.env`.
      env: {
        INFERENCE_LENS_API_ENDPOINT: "",
        INFERENCE_LENS_API_KEY: "",
        INFERENCE_LENS_MODEL: "",
        INFERENCE_LENS_N8N_BASE_URL: "",
        INFERENCE_LENS_N8N_API_KEY: "",
        INFERENCE_LENS_COMMAND_TOOLS: commandToolCatalog,
      },
    },
    {
      command: `INFERENCE_LENS_BUFFERED_PORT=${bufferedFixturePort} npm run dev:buffered-provider`,
      url: `http://127.0.0.1:${bufferedFixturePort}/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
