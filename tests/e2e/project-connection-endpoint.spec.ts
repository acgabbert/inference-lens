import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";

const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
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

/**
 * The export revokes its object URL in the same tick as the click, so awaiting
 * a download event is unreliable. The serialized bytes are captured where they
 * are created, which is what the file would have contained.
 */
async function captureExportedBytes(page: Page) {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (object instanceof Blob) {
        (window as unknown as { __exported?: Promise<string> }).__exported =
          object.text();
      }
      return create(object);
    };
  });
}

test("moving a project's declared endpoint reaches the project file", async ({
  page,
}) => {
  await seedProfile(page);
  await captureExportedBytes(page);
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
  await page.getByRole("button", { name: "Export project…" }).click();
  const exported = await page.evaluate(
    () => (window as unknown as { __exported?: Promise<string> }).__exported,
  );
  const contents = JSON.parse(exported ?? "null");

  expect(contents.connectionRequirements[0].endpoint).toBe(PROFILE_ENDPOINT);
  // The old declaration is gone from the document, not merely hidden in the UI.
  expect(exported).not.toContain("127.0.0.1:8080");
  // A credential never follows the endpoint into the portable file.
  expect(exported).not.toMatch(/api[-_]?key/i);
});
