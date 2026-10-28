import { expect, test } from "@playwright/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  waitForHydration,
} from "./support";
import { expectModalContract } from "./support/modal";

const PROJECT_NAME = "Template revision switch fixture";

function templateWithNewerRevision() {
  let project = createPromptTemplate(
    createProjectFile({
      name: PROJECT_NAME,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Unused draft" }],
      },
      idSuffix: "template-revision-switch",
      createdAt: "2026-08-11T12:00:00.000Z",
    }),
    {
      name: "Incident prompt",
      messages: [{ role: "user", content: "Investigate {{topic}} for {{audience}}." }],
      variableDefaults: {},
      idSuffix: "incident",
      revisionIdSuffix: "incident-1",
      createdAt: "2026-08-11T12:00:01.000Z",
    },
  );
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.conversationRevisions[0]!.id,
    templateId: "template_incident",
    values: {},
    idSuffix: "incident",
    outputMessageIdSuffixes: ["incident"],
  });
  return appendPromptTemplateRevision(project, {
    templateId: "template_incident",
    name: "Careful pass",
    messages: [{ role: "user", content: "Carefully investigate {{topic}} at {{severity}}." }],
    variableDefaults: {},
    idSuffix: "incident-2",
    createdAt: "2026-08-11T12:00:02.000Z",
  });
}

test("Compose switches a pinned prompt between named revisions after a summarized review", async ({
  page,
}) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, templateWithNewerRevision(), PROJECT_NAME);

  const templateUse = page.locator(".template-use-card");
  const variable = (name: string) => templateUse.locator(`textarea[data-template-variable="${name}"]`);
  await variable("topic").fill("database rollback");
  await variable("audience").fill("on-call team");

  const pinnedRevision = templateUse.getByLabel("Pinned revision");
  await expect(pinnedRevision.locator("option")).toHaveText(["Careful pass (current)", "Revision 1"]);
  await expect(pinnedRevision.locator("option:checked")).toHaveText("Revision 1");
  await pinnedRevision.selectOption({ label: "Careful pass (current)" });

  const review = page.getByRole("dialog", { name: 'Switch "Incident prompt"' });
  await expect(review).toContainText("Revision 1 → Careful pass (current)");
  const variableChanges = review.getByRole("region", { name: "Variable changes" });
  await expect(variableChanges.locator("dt")).toHaveText(["Values cleared", "Needs a value", "Added", "Removed"]);
  await expect(variableChanges.locator("dd")).toHaveText(["{{audience}}", "{{severity}}", "{{severity}}", "{{audience}}"]);
  const contentChanges = review.locator("details.revision-switch-diff");
  await expect(contentChanges.locator("> summary")).toHaveText("Content changes · 1 message change");
  await expect(contentChanges).not.toHaveAttribute("open");
  await review.getByRole("button", { name: "Switch revision", exact: true }).click();

  await expect(pinnedRevision.locator("option:checked")).toHaveText("Careful pass (current)");
  await expect(variable("topic")).toHaveValue("database rollback");
  await expect(variable("audience")).toHaveCount(0);
  await expect(variable("severity")).toHaveValue("");

  // Moving back to an older revision is the same reviewed switch.
  await pinnedRevision.selectOption({ label: "Revision 1" });
  await review.getByRole("button", { name: "Switch revision", exact: true }).click();
  await expect(pinnedRevision.locator("option:checked")).toHaveText("Revision 1");
  await expect(variable("topic")).toHaveValue("database rollback");
  await expect(variable("audience")).toHaveValue("");
});

test("the revision switch review follows the modal contract and returns focus to the revision picker", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, templateWithNewerRevision(), PROJECT_NAME);

  const pinnedRevision = page.locator(".template-use-card").getByLabel("Pinned revision");
  await expectModalContract(page, {
    open: async () => {
      await pinnedRevision.focus();
      await pinnedRevision.selectOption({ label: "Careful pass (current)" });
    },
    dialog: page.getByRole("dialog", { name: 'Switch "Incident prompt"' }),
    restoreTo: pinnedRevision,
  });
  await expect(pinnedRevision.locator("option:checked")).toHaveText("Revision 1");
});
