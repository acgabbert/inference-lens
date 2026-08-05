import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import { importProject, seedProfile, waitForHydration } from "./support";

function whitespaceTemplateProject() {
  let project = createProjectFile({
    name: "Whitespace template fixture",
    request: {
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:44014/v1",
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Unused draft" }],
    },
    idSuffix: "whitespace-template",
    createdAt: "2026-08-05T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Whitespace prompt",
    messages: [{
      role: "user",
      content: "Explain {{topic}} / {{ topic }} / {{\r\ntopic\r\n}}.",
    }],
    variableDefaults: { topic: "migration safety" },
    idSuffix: "whitespace-prompt",
    revisionIdSuffix: "whitespace-prompt-1",
    createdAt: "2026-08-05T12:01:00.000Z",
  });
  return project;
}

test("renders and resolves compact, spaced, and multiline native variables as one value", async ({
  page,
}) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(
    page,
    whitespaceTemplateProject(),
    "Whitespace template fixture",
  );

  await page.getByRole("tab", { name: /Prompts 1/ }).click();
  const editor = page.locator(".template-content-editor");
  await expect(editor.getByLabel("Prompt content")).toHaveValue(
    // Textareas expose CRLF-authored values with normalized LF line endings.
    "Explain {{topic}} / {{ topic }} / {{\ntopic\n}}.",
  );
  await expect(page.locator(".template-variable-rail")).toContainText("{{topic}}");
  await expect(page.getByLabel("{{topic}}")).toHaveValue(
    "migration safety",
  );
  await expect(page.locator(".template-notices")).toHaveCount(0);

  await page.getByRole("button", { name: "Add to conversation" }).click();
  const templateUse = page.locator(".template-use-card");
  await templateUse.getByRole("button", { name: "Resolved" }).click();
  await expect(templateUse).toContainText(
    "Explain migration safety / migration safety / migration safety.",
  );
  await expect(templateUse).not.toContainText(/NaN|Infinity|undefined/);
});
