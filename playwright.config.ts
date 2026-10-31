import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { CHROMIUM_OVERRIDE_ENV } from "./scripts/e2e-chromium.mjs";

// Fixed ports stay below 32768, where the OS never assigns an outgoing
// connection's local port; tests/fixture-ports.test.ts enforces it.
const appPort = 4300;
/**
 * The shared assets 2b gate's server (D2): the same app with
 * NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH on. Specs reach it through the
 * `personalWorkbench` option in `tests/e2e/support/test.ts`.
 */
const personalWorkbenchAppPort = 4301;
const bufferedFixturePort = 24014;
const flakyFixturePort = 24015;
const mcpFixturePort = 24018;
const mcpExecutionFixturePort = 24019;
const mcpBatchFixturePort = 24020;
const mcpInterruptionFixturePort = 24023;
const responsesFixturePort = 24026;
const anthropicFixturePort = 24027;
const systemOneFixturePort = 24028;

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
const mcpServerCatalog = fileURLToPath(
  new URL("./tests/fixtures/mcp-servers/catalog.json", import.meta.url),
);
/**
 * Linked prompt source folders. Both roots live under `test-results/`, where
 * each spec writes its own files (`tests/e2e/support/source-roots.ts`).
 */
const sourceRootCatalog = fileURLToPath(
  new URL("./tests/fixtures/source-roots/catalog.json", import.meta.url),
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

/**
 * A Chromium other than Playwright's pinned build, when one was named or
 * `scripts/run-e2e.mjs` fell back to one (see `scripts/e2e-chromium.mjs`).
 * Every project, including the opt-in configs built on this one, launches it.
 */
const chromiumOverride = process.env[CHROMIUM_OVERRIDE_ENV];
const launchOptions = chromiumOverride ? { executablePath: chromiumOverride } : {};

// A developer's repo-root `.env` must not decide what the suite sees.
// With a server-side endpoint configured, the app provisions a server
// default profile and shows the "Server default connection available"
// notice, whose overlay silently intercepts clicks in specs that seed
// their own profiles. Next.js leaves an already-set process variable
// alone, so declaring these empty here neutralizes the file for every
// machine rather than only the ones without an `.env`.
const appServerEnv = {
  INFERENCE_LENS_API_ENDPOINT: "",
  INFERENCE_LENS_API_KEY: "",
  INFERENCE_LENS_MODEL: "",
  INFERENCE_LENS_CONNECTIONS: "",
  INFERENCE_LENS_N8N_BASE_URL: "",
  INFERENCE_LENS_N8N_API_KEY: "",
  INFERENCE_LENS_COMMAND_TOOLS: commandToolCatalog,
  INFERENCE_LENS_MCP_SERVERS: mcpServerCatalog,
  INFERENCE_LENS_SOURCE_ROOTS: sourceRootCatalog,
  // The 2b gate is off on this server, whatever a developer's `.env` says.
  NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH: "",
};

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
      use: { ...devices["Desktop Chrome"], colorScheme: "light", launchOptions },
    },
    {
      name: "chromium-dark",
      testMatch: themeSensitiveSpecs,
      use: { ...devices["Desktop Chrome"], colorScheme: "dark", launchOptions },
    },
  ],
  webServer: [
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${appPort}`,
      url: `http://127.0.0.1:${appPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: appServerEnv,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${personalWorkbenchAppPort}`,
      url: `http://127.0.0.1:${personalWorkbenchAppPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...appServerEnv,
        NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH: "1",
        // vinext 1.3 allows one dev server per checkout. This is the suite's
        // second, so it skips the lock and keeps its own dependency cache
        // rather than racing the first server's.
        VINEXT_NO_DEV_LOCK: "1",
        INFERENCE_LENS_VITE_CACHE_DIR: "node_modules/.vite-personal-workbench",
      },
    },
    {
      command: `INFERENCE_LENS_BUFFERED_PORT=${bufferedFixturePort} npm run dev:buffered-provider`,
      url: `http://127.0.0.1:${bufferedFixturePort}/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_RESPONSES_PORT=${responsesFixturePort} npm run dev:responses-provider`,
      url: `http://127.0.0.1:${responsesFixturePort}/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_ANTHROPIC_PORT=${anthropicFixturePort} npm run dev:anthropic-provider`,
      url: `http://127.0.0.1:${anthropicFixturePort}/health`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      // Replays the committed System One captures (D11, D15, D21).
      command: `INFERENCE_LENS_SYSTEM_ONE_PORT=${systemOneFixturePort} npm run dev:systemone-provider`,
      url: `http://127.0.0.1:${systemOneFixturePort}/llamacpp/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_FLAKY_PORT=${flakyFixturePort} npm run dev:flaky-provider`,
      url: `http://127.0.0.1:${flakyFixturePort}/v1/models`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_MCP_FIXTURE_PORT=${mcpFixturePort} node scripts/mcp-discovery-fixture.mjs`,
      url: `http://127.0.0.1:${mcpFixturePort}/status`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_MCP_FIXTURE_PORT=${mcpExecutionFixturePort} node scripts/mcp-discovery-fixture.mjs`,
      url: `http://127.0.0.1:${mcpExecutionFixturePort}/status`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_MCP_FIXTURE_PORT=${mcpBatchFixturePort} node scripts/mcp-discovery-fixture.mjs`,
      url: `http://127.0.0.1:${mcpBatchFixturePort}/status`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `INFERENCE_LENS_MCP_FIXTURE_PORT=${mcpInterruptionFixturePort} node scripts/mcp-discovery-fixture.mjs`,
      url: `http://127.0.0.1:${mcpInterruptionFixturePort}/status`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
