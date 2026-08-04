import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
  updateEvaluationCheck,
  updateEvaluationSuiteExecution,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  importProject,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * Results left the pane the user was looking at, so the Runs dot is the only
 * standing record that a batch finished. These specs check the two things that
 * makes it worth having: it says *what* finished, not merely *that* something
 * did, and it stops saying it once the results have been read.
 *
 * The tone vocabulary is the evaluation one, so a batch cannot read as a
 * success on the strip and as a partial failure in the history list.
 */

const PROJECT_NAME = "Runs indicator fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";
const SLOW_MODEL = "slow-answer-model";
const SLOW_FAILING_MODEL = "slow-failing-answer-model";
const SLOW_PARTIAL_MODEL = "slow-partial-answer-model";

/**
 * Two cases checked for text the fixture's answer either does or does not
 * contain, so the pass rate is decided by the provider's real output.
 *
 * `model` picks which fixture answers. Both are deliberately slow, so leaving
 * the mode before the batch ends is a real sequence rather than a race; they
 * differ only in whether the answer satisfies the check, so the pass rate comes
 * from the provider rather than from a broken suite.
 */
function runnableProject(model: string): ProjectFile {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "runs-indicator",
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-08-04T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });

  const candidates = evaluationBindingCandidates(
    project,
    project.defaults.conversationRevisionId,
  );
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  for (const [index, value] of ["migrations", "replication"].entries()) {
    const added = addEvaluationCase(project, created.suiteId, () => `case-${index}`);
    project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
    });
    project = addEvaluationCheck(
      project,
      created.suiteId,
      added.caseId,
      { kind: "contains" },
      () => `check-${index}`,
    );
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, created.suiteId, added.caseId, {
      checkId: check.checkId,
      kind: "contains",
      // Both cases look for the same phrase, which every fixture answer either
      // carries or does not. The model alone decides the pass rate.
      label: "Mentions the fixture",
      value: "Buffered fixture",
    });
  }
  const suite = project.evaluationSuites[0]!;
  project = updateEvaluationSuiteExecution(project, created.suiteId, {
    ...suite.execution,
    target: { ...suite.execution.target, model },
  });
  return project;
}

async function openProject(page: Page, model: string): Promise<void> {
  const project = runnableProject(model);
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: PROFILE_INSTANCE_ID,
  });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
        }),
      );
    },
    {
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      instanceId: PROFILE_INSTANCE_ID,
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);
  await openMode(page, "Evaluations");
}

function runsDot(page: Page) {
  return page
    .getByRole("navigation", { name: "Application mode" })
    .getByRole("button", { name: "Runs" })
    .locator("[data-mode-indicator]");
}

async function startEvaluation(page: Page): Promise<void> {
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Ready to run");
  await editor.getByRole("button", { name: "Start evaluation…" }).click();
  await page.getByRole("dialog", { name: /Start “Topics”/ })
    .getByRole("button", { name: "Start 2 calls" })
    .click();
}

test("the Runs dot reports a running batch, then its outcome, from another mode", async ({ page }) => {
  await openProject(page, SLOW_MODEL);
  await startEvaluation(page);

  // Starting an evaluation lands in Runs. Leaving while it is still going is
  // the situation the dot exists for, and the slow fixture is what makes that
  // reachable rather than a race against an instant answer.
  await openMode(page, "Compose");
  await expect(runsDot(page)).toHaveAttribute("data-mode-indicator", "running");

  // Both cases check for text the ordinary fixture answer carries, so a
  // complete batch under this model passes every one of them.
  await expect(runsDot(page)).toHaveAttribute("data-mode-indicator", "passed", {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: /Runs/ }))
    .toContainText("2/2 cases passed");

  // Reading the results is what retires the marker.
  await openMode(page, "Runs");
  await expect(page.locator(".evaluation-results-workspace")).toContainText("2 / 2 passed");
  await expect(runsDot(page)).toHaveCount(0);

  // And it stays retired: leaving Runs must not re-raise a batch already read.
  await openMode(page, "Compose");
  await expect(runsDot(page)).toHaveCount(0);
});

test("a batch that did not pass is not coloured as a success", async ({ page }) => {
  await openProject(page, SLOW_FAILING_MODEL);
  await startEvaluation(page);
  await openMode(page, "Compose");

  // Both cases fail their check against this model's answer, so nothing here
  // may read as green. The label carries the rate the colour is standing for.
  await expect(runsDot(page)).toHaveAttribute("data-mode-indicator", "failed", {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: /Runs/ }))
    .toContainText("0/2 cases passed");

  await openMode(page, "Runs");
  await expect(page.locator(".evaluation-results-workspace")).toContainText("0 / 2 passed");
  await expect(runsDot(page)).toHaveCount(0);
});

/**
 * The case a single "finished" colour reports worst. Half the suite regressed,
 * and a green dot would say so only by omission — which is the whole reason the
 * indicator carries the outcome rather than just the completion.
 */
test("a partly-passing batch reads as neither success nor failure", async ({ page }) => {
  await openProject(page, SLOW_PARTIAL_MODEL);
  await startEvaluation(page);
  await openMode(page, "Compose");

  await expect(runsDot(page)).toHaveAttribute("data-mode-indicator", "partial", {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: /Runs/ }))
    .toContainText("1/2 cases passed");

  await openMode(page, "Runs");
  await expect(page.locator(".evaluation-results-workspace")).toContainText("1 / 2 passed");
});
