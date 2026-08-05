import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const appPort = 4300;
const bufferedFixturePort = 44014;
const flakyFixturePort = 44015;

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

/**
 * The specs whose assertions a colour scheme can actually change.
 *
 * These read resolved styles — `getComputedStyle` for a disabled control's
 * colour and opacity, for a field's border before focus — and the tokens behind
 * them are `light-dark()`, so "disabled reads as disabled" is a claim that has
 * to hold in each scheme separately.
 *
 * Every other spec asserts on text and roles, which the scheme cannot affect.
 * Running the whole suite twice cost about half the suite's wall clock and
 * could not fail for a reason the light run would not also catch. A spec that
 * starts reading resolved styles belongs on this list.
 */
const themeSensitiveSpecs = [
  "control-affordance.spec.ts",
  "evaluation-suite-execution-settings.spec.ts",
  "inference-settings-panel.spec.ts",
  "pr2-workbench.spec.ts",
];

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // A backstop for the suite as a whole. Per-test timeouts bound a test that
  // wedges; they do not bound a run that keeps starting new ones, and CI has no
  // reason to sit on a job that has already been going for half an hour.
  globalTimeout: 30 * 60 * 1000,
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
      testMatch: themeSensitiveSpecs,
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
    {
      command: `INFERENCE_LENS_FLAKY_PORT=${flakyFixturePort} npm run dev:flaky-provider`,
      url: `http://127.0.0.1:${flakyFixturePort}/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
