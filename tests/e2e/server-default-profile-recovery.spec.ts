import { expect, test, type Page } from "@playwright/test";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROFILE_STORAGE_KEY,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  waitForHydration,
} from "./support";

const WEB_CREDENTIAL_MODES_STORAGE_KEY =
  "inference-lens:web-credential-modes:v1";

interface StoredProfileSnapshot {
  id: string;
  instanceId: string;
  name: string;
  credentialRef?: string;
}

async function storedProfiles(page: Page): Promise<StoredProfileSnapshot[]> {
  return page.evaluate((key) => {
    const snapshot = JSON.parse(localStorage.getItem(key) ?? "{}");
    return snapshot.profiles ?? [];
  }, PROFILE_STORAGE_KEY);
}

test("a failed runtime-status probe preserves the managed server profile", async ({
  page,
}) => {
  let runtimeStatusAvailable = true;
  await page.route("**/api/runtime-status", (route) =>
    runtimeStatusAvailable
      ? route.fulfill({
          json: {
            containerized: true,
            serverDefaultCredentialConfigured: true,
            endpoint: BUFFERED_FIXTURE_ENDPOINT,
            model: "buffered-test-model",
          },
        })
      : route.fulfill({ status: 503, body: "Temporary status outage" }),
  );

  await page.goto("/");
  await waitForHydration(page, "Server default");
  await expect.poll(async () => (await storedProfiles(page)).length).toBe(1);
  const managed = (await storedProfiles(page))[0]!;
  expect(managed.credentialRef).toBe("environment-default");

  await page.evaluate(
    ({ mappingKey, credentialModeKey, profile }) => {
      localStorage.setItem(
        mappingKey,
        JSON.stringify({
          "project-recovery": {
            "connection-requirement-recovery": {
              profileId: profile.id,
              profileInstanceId: profile.instanceId,
            },
          },
        }),
      );
      localStorage.setItem(
        credentialModeKey,
        JSON.stringify({ [profile.id]: "environment-default" }),
      );
    },
    {
      mappingKey: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
      credentialModeKey: WEB_CREDENTIAL_MODES_STORAGE_KEY,
      profile: managed,
    },
  );

  runtimeStatusAvailable = false;
  await page.reload();
  await waitForHydration(page, "Server default");

  await expect
    .poll(async () => (await storedProfiles(page))[0]?.credentialRef ?? "none")
    .toBe("environment-default");
  expect(await storedProfiles(page)).toEqual([managed]);
  await expect
    .poll(() =>
      page.evaluate(
        ({ mappingKey, credentialModeKey }) => ({
          mappings: JSON.parse(localStorage.getItem(mappingKey) ?? "{}"),
          credentialModes: JSON.parse(
            localStorage.getItem(credentialModeKey) ?? "{}",
          ),
        }),
        {
          mappingKey: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
          credentialModeKey: WEB_CREDENTIAL_MODES_STORAGE_KEY,
        },
      ),
    )
    .toEqual({
      mappings: {
        "project-recovery": {
          "connection-requirement-recovery": {
            profileId: managed.id,
            profileInstanceId: managed.instanceId,
          },
        },
      },
      credentialModes: { [managed.id]: "environment-default" },
    });

  runtimeStatusAvailable = true;
  await page.reload();
  await waitForHydration(page, "Server default");
  await expect.poll(async () => (await storedProfiles(page)).length).toBe(1);
  expect(await storedProfiles(page)).toEqual([managed]);
});

test("a confirmed unconfigured status releases the managed credential", async ({
  page,
}) => {
  let configured = true;
  await page.route("**/api/runtime-status", (route) =>
    route.fulfill({
      json: configured
        ? {
            containerized: true,
            serverDefaultCredentialConfigured: true,
            endpoint: BUFFERED_FIXTURE_ENDPOINT,
            model: "buffered-test-model",
          }
        : {
            containerized: true,
            serverDefaultCredentialConfigured: false,
          },
    }),
  );

  await page.goto("/");
  await waitForHydration(page, "Server default");
  await expect.poll(async () => (await storedProfiles(page)).length).toBe(1);
  const managed = (await storedProfiles(page))[0]!;
  expect(managed.credentialRef).toBe("environment-default");

  configured = false;
  await page.reload();
  await waitForHydration(page, "Server default");

  await expect
    .poll(async () => (await storedProfiles(page))[0]?.credentialRef ?? "none")
    .toBe("none");
  const released = (await storedProfiles(page))[0]!;
  expect(released).toEqual({ ...managed, credentialRef: undefined });
});
