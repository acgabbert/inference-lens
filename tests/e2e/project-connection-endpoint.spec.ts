import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";

const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
const PROJECT_PROFILE_MAP_STORAGE_KEY =
  "inference-lens:project-profile-map:v2";
const STREAMING_STORAGE_KEY = "inference-lens:streaming-preference:v1";
const PROFILE_ENDPOINT = "http://127.0.0.1:44014/v1";
const DECLARED_ENDPOINT = "http://127.0.0.1:8080/v1";

/**
 * A project whose declared connection points somewhere the mapped profile does
 * not: the state a project reaches when its work moves off the machine it was
 * created against.
 */
function movedProjectContents(): string {
  return serializeProjectFile(
    createProjectFile({
      name: "Endpoint move fixture",
      request: {
        provider: "openai-compatible",
        endpoint: DECLARED_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.4,
      },
      idSuffix: "endpoint-move",
      createdAt: "2026-07-30T12:00:00.000Z",
    }),
  );
}

async function seedProfile(page: Page) {
  await page.addInitScript(({ profileKey, endpoint }) => {
    localStorage.setItem(
      profileKey,
      JSON.stringify({
        profiles: [
          {
            id: "buffered",
            name: "Buffered fixture",
            provider: "openai-compatible",
            endpoint,
            model: "buffered-test-model",
            temperature: 0.7,
          },
        ],
        activeProfileId: "buffered",
      }),
    );
  }, { profileKey: PROFILE_STORAGE_KEY, endpoint: PROFILE_ENDPOINT });
}

test("adopting a mapped project activates the exact mapped profile instance", async ({
  page,
}) => {
  const project = createProjectFile({
    name: "Mapped profile fixture",
    request: {
      provider: "openai-compatible",
      endpoint: PROFILE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "mapped-profile",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  await page.addInitScript(
    ({ profileKey, mapKey, streamingKey, projectId, endpoint }) => {
      localStorage.setItem(
        profileKey,
        JSON.stringify({
          profiles: [
            {
              id: "wrong-active",
              instanceId: "profile-instance-wrong",
              name: "Wrong active fixture",
              provider: "openai-compatible",
              endpoint: "http://127.0.0.1:1/v1",
              model: "wrong-model",
              temperature: 0.7,
            },
            {
              id: "buffered",
              instanceId: "profile-instance-buffered",
              name: "Buffered mapped fixture",
              provider: "openai-compatible",
              endpoint,
              model: "buffered-test-model",
              temperature: 0.7,
            },
          ],
          activeProfileId: "wrong-active",
        }),
      );
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: {
            profileId: "buffered",
            profileInstanceId: "profile-instance-buffered",
          },
        }),
      );
      localStorage.setItem(streamingKey, "buffered");
    },
    {
      profileKey: PROFILE_STORAGE_KEY,
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      streamingKey: STREAMING_STORAGE_KEY,
      projectId: project.projectId,
      endpoint: PROFILE_ENDPOINT,
    },
  );
  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Wrong active fixture");

  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "mapped-profile.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(project)),
    },
  );

  await expect(page.getByLabel(/^Run target:/)).toHaveAccessibleName(
    /Buffered mapped fixture/,
  );
  await expect(page.getByRole("button", { name: /run request/i })).toBeEnabled();
  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response: 2 + 2 = 4.",
  );
});

test("moving a project's declared endpoint reaches the project file", async ({
  page,
}) => {
  await seedProfile(page);
  await page.goto("/");

  // The seeded profile appears only once the client has hydrated and restored
  // it; importing before that lands on a form with no handler attached.
  await expect(page.locator(".topbar")).toContainText("Buffered fixture");
  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "endpoint-move.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(movedProjectContents()),
    },
  );
  await expect(page.locator(".brand")).toContainText("Endpoint move fixture");
  await page.keyboard.press("Escape");

  await page.getByLabel(/^Run target:/).click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  const mapping = page.locator(".connection-mapping");
  await expect(mapping).toContainText("Connection mapping required");
  await expect(mapping).toContainText(DECLARED_ENDPOINT);

  await mapping.getByRole("button", { name: /use .* for this project/i }).click();
  await expect(mapping).toContainText("Mapped to a different endpoint");
  await expect(mapping).toContainText(PROFILE_ENDPOINT);

  // What is being replaced is shown before it is replaced: the declaration
  // travels in the shared project file and the old value does not survive.
  await mapping.getByRole("button", { name: /to expect this endpoint/i }).click();
  const dialog = page.getByRole("dialog", { name: /declared endpoint/i });
  await expect(dialog).toContainText(DECLARED_ENDPOINT);
  await expect(dialog).toContainText(PROFILE_ENDPOINT);
  await dialog.getByRole("button", { name: "Update project" }).click();

  await expect(mapping).toContainText("Project connection mapped");
  await expect(mapping).not.toContainText("Mapped to a different endpoint");
  await expect(mapping).toContainText(PROFILE_ENDPOINT);

  // A base URL and the request URL built from it dial the same place, so the
  // advisory must not return for a profile that merely spells it out.
  const endpointField = page.getByLabel("Endpoint", { exact: true });
  await endpointField.fill(`${PROFILE_ENDPOINT}/chat/completions`);
  await expect(mapping).toContainText("Project connection mapped");
  await expect(mapping).not.toContainText("Mapped to a different endpoint");

  // A genuinely different target still reports, so the check has not gone soft.
  await endpointField.fill("http://127.0.0.1:9999/v1");
  await expect(mapping).toContainText("Mapped to a different endpoint");
  await endpointField.fill(PROFILE_ENDPOINT);

  expect(await page.locator("body").innerText()).not.toMatch(
    /NaN|undefined|Infinity/,
  );

  await page.getByRole("button", { name: "Close Connections" }).click();
  await page.evaluate(() => {
    document.querySelector<HTMLDetailsElement>(".project-menu")!.open = true;
  });
  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export project…" }).click();
  const download = await downloadStarted;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = Buffer.concat(chunks).toString("utf8");
  const contents = JSON.parse(exported);

  expect(contents.connectionRequirements[0].endpoint).toBe(PROFILE_ENDPOINT);
  // The old declaration is gone from the document, not merely hidden in the UI.
  expect(exported).not.toContain("127.0.0.1:8080");
  // A credential never follows the endpoint into the portable file.
  expect(exported).not.toMatch(/api[-_]?key/i);
});
