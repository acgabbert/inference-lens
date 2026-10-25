import { expect, test, type Page } from "@playwright/test";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROFILE_STORAGE_KEY,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * The browser's half of several server-held connections
 * (docs/SERVER_CONNECTIONS_DESIGN.md, slice 2). The status route is stubbed:
 * the suite's dev server runs with no catalog, and what is under test here is
 * how the page provisions, locks and selects from whatever the server lists.
 * Releasing each key only to its own origin is the server's, and is covered by
 * tests/server-connections.test.ts.
 */

const WEB_CREDENTIAL_MODES_STORAGE_KEY = "inference-lens:web-credential-modes:v1";

const chat = {
  id: "chat",
  name: "Chat gateway",
  endpoint: BUFFERED_FIXTURE_ENDPOINT,
  model: "buffered-test-model",
  protocols: ["openai-compatible-chat-completions"],
  systemOne: false,
  credentialConfigured: true,
};

const decide = {
  id: "decide",
  name: "Decision models",
  endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`,
  model: "local-decision",
  protocols: [],
  systemOne: true,
  credentialConfigured: true,
};

interface StoredProfile {
  id: string;
  name: string;
  endpoint: string;
  credentialRef?: string;
}

async function storedProfiles(page: Page): Promise<StoredProfile[]> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "{}").profiles ?? [],
    PROFILE_STORAGE_KEY,
  );
}

/** Serves whatever `status()` returns at the time of each probe. */
async function serveStatus(page: Page, status: () => Record<string, unknown>): Promise<void> {
  await page.route("**/api/runtime-status", (route) =>
    route.fulfill({ json: { containerized: false, ...status() } }),
  );
}

async function openConnections(page: Page) {
  await page.locator(".target-menu > summary").click();
  await page.getByRole("button", { name: /Manage connections/ }).click();
  return page.getByRole("dialog", { name: "Connections" });
}

test("a first run adopts every catalog connection, each locked and using its own key", async ({ page }) => {
  await serveStatus(page, () => ({ connections: [chat, decide] }));
  await page.goto("/");
  await waitForHydration(page, "Chat gateway");

  await expect.poll(async () => (await storedProfiles(page)).map(({ id, credentialRef }) => [id, credentialRef]))
    .toEqual([
      ["server-chat", "environment-default:chat"],
      ["server-decide", "environment-default:decide"],
    ]);

  const drawer = await openConnections(page);
  await expect(drawer.getByRole("textbox", { name: /^Endpoint/ })).toBeDisabled();
  await expect(drawer.getByLabel("Authentication")).toHaveValue("environment-default:chat");
  await expect(drawer.getByLabel("Authentication").locator("option:checked")).toHaveText("Server: Chat gateway");
  await drawer.getByRole("combobox", { name: "Profile", exact: true }).selectOption("server-decide");
  await expect(drawer.getByRole("textbox", { name: /^Endpoint/ })).toHaveValue(decide.endpoint);
  await expect(drawer.getByRole("textbox", { name: /^Endpoint/ })).toBeDisabled();
  await expect(drawer.getByLabel("Authentication")).toHaveValue("environment-default:decide");
  await expect(drawer).toContainText("INFERENCE_LENS_CONNECTIONS");
  const systemOne = drawer.getByRole("checkbox", { name: /System One/ });
  await expect(systemOne).toBeChecked();
  await expect(systemOne).toBeDisabled();
  // Server profiles cannot be deleted from here; the refusal names the catalog.
  await expect(drawer.getByRole("button", { name: "Delete" })).toHaveAttribute(
    "title",
    /Remove "decide" from the INFERENCE_LENS_CONNECTIONS catalog/,
  );
  await drawer.getByRole("combobox", { name: "Profile", exact: true }).selectOption("server-chat");
  await drawer.getByRole("button", { name: /close/i }).first().click();

  // The run names the connection; the browser never holds the key.
  const outgoing = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/inference");
  await page.getByRole("button", { name: /run current conversation/i }).first().click();
  const request = await outgoing;
  expect((request.postDataJSON() as { credential: unknown }).credential)
    .toEqual({ kind: "environment-default", connectionId: "chat" });
  // This server holds no catalog, so it refuses the id; what matters is that
  // the browser named it. Waiting for the answer keeps the page open until the
  // request completes: closing it mid-body makes the dev server raise an
  // overlay that Vite broadcasts to every other spec's page.
  expect((await request.response())?.status()).toBe(400);
});

test("an existing device is offered new server profiles rather than switched to them", async ({ page }) => {
  await seedProfile(page);
  await serveStatus(page, () => ({ connections: [chat, decide] }));
  await page.goto("/");
  await waitForHydration(page);

  const banner = page.locator('[data-app-banner="server-default-profile"]');
  await expect(banner).toContainText("Server connections available");
  await expect(banner).toContainText('"Chat gateway", "Decision models"');
  await expect(page.locator(".topbar")).toContainText("Buffered fixture");

  await banner.getByRole("button", { name: 'Use "Chat gateway"' }).click();
  await expect(page.locator(".topbar")).toContainText("Chat gateway");
  await expect(banner).toHaveCount(0);
});

test("a removed connection releases its profile, and a refused catalog releases nothing", async ({ page }) => {
  let status: Record<string, unknown> = { connections: [chat, decide] };
  await serveStatus(page, () => status);
  await page.goto("/");
  await waitForHydration(page, "Chat gateway");
  await expect.poll(async () => (await storedProfiles(page)).length).toBe(2);

  // A typo in the catalog says nothing about whether its connections exist.
  status = { connections: [], catalogProblem: "Its JSON is invalid." };
  await page.reload();
  await waitForHydration(page, "Chat gateway");
  const refused = page.locator('[data-app-banner="server-catalog-invalid"]');
  await expect(refused).toContainText("The server's connection catalog was refused");
  await expect(refused).toContainText("Its JSON is invalid.");
  expect((await storedProfiles(page)).map(({ credentialRef }) => credentialRef)).toEqual([
    "environment-default:chat",
    "environment-default:decide",
  ]);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), WEB_CREDENTIAL_MODES_STORAGE_KEY),
  ).toBeNull();

  // A whole answer that no longer lists "decide" releases it, and keeps it.
  status = { connections: [chat] };
  await page.reload();
  await waitForHydration(page, "Chat gateway");
  await expect
    .poll(async () => (await storedProfiles(page)).map(({ id, credentialRef }) => [id, credentialRef ?? "none"]))
    .toEqual([
      ["server-chat", "environment-default:chat"],
      ["server-decide", "none"],
    ]);
  await expect(page.locator('[data-app-banner="server-catalog-invalid"]')).toHaveCount(0);

  const drawer = await openConnections(page);
  await drawer.getByRole("combobox", { name: "Profile", exact: true }).selectOption("server-decide");
  await expect(drawer.getByRole("textbox", { name: /^Endpoint/ })).toBeEnabled();
  await expect(drawer.getByLabel("Authentication")).toHaveValue("none");
});

test("a user-made profile is offered a catalog key only at that key's origin", async ({ page }) => {
  await seedProfile(page);
  await serveStatus(page, () => ({ connections: [chat, decide] }));
  await page.goto("/");
  await waitForHydration(page);
  await page.locator('[data-app-banner="server-default-profile"]').getByRole("button", { name: "Dismiss" }).click();

  const drawer = await openConnections(page);
  const authentication = drawer.getByLabel("Authentication");
  // The seeded profile dials the buffered fixture, which is where "chat" lives.
  await expect(authentication.locator("option")).toHaveText([
    "No authentication",
    "Server default (.env) — not configured",
    "Server: Chat gateway",
    "Session key",
  ]);
  await authentication.selectOption("environment-default:chat");
  await expect(drawer).toContainText("sends its credential only to its configured origin");
  await drawer.getByRole("button", { name: /close/i }).first().click();

  const outgoing = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/inference");
  await page.getByRole("button", { name: /run current conversation/i }).first().click();
  const request = await outgoing;
  expect((request.postDataJSON() as { credential: unknown }).credential)
    .toEqual({ kind: "environment-default", connectionId: "chat" });
  // This server holds no catalog, so it refuses the id; what matters is that
  // the browser named it. Waiting for the answer keeps the page open until the
  // request completes: closing it mid-body makes the dev server raise an
  // overlay that Vite broadcasts to every other spec's page.
  expect((await request.response())?.status()).toBe(400);

  // The choice survives a reload in the stored string form.
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), WEB_CREDENTIAL_MODES_STORAGE_KEY),
  ).toEqual({ buffered: "environment-default:chat" });
});
