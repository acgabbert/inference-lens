import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  serializeExperimentPlan,
  type RepeatedExperimentPlanV1,
} from "../../packages/core/src/experiment";
import { createProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../../packages/core/src/types";

function interruptedPlan(): RepeatedExperimentPlanV1 {
  const createdAt = "2026-07-31T12:00:00.000Z";
  return {
    schemaVersion: 1,
    experimentId: createEntityId("experiment", "browser-history"),
    kind: "repeated-request",
    createdAt,
    commonInput: {
      conversationId: createEntityId("conversation", "browser-history"),
      conversationRevisionId: createEntityId("revision", "browser-history"),
      target: {
        profileId: createEntityId("profile", "browser-history"),
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: "history-fixture-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [{
        id: createEntityId("message", "browser-history"),
        role: "user",
        content: [{ type: "text", text: "Repeat this" }],
      }],
      templateResolutions: [],
      responseMode: "streaming",
      options: {},
      tools: [],
      resolvedAt: createdAt,
    },
    cells: [1, 2].map((ordinal) => ({
      cellId: createEntityId("experiment-cell", `browser-history-${ordinal}`),
      ordinal,
      runId: createEntityId("run", `browser-history-${ordinal}`),
    })),
  };
}

async function installProjectFolderFixture(page: Page): Promise<void> {
  const project = createProjectFile({
    name: "Experiment history fixture",
    idSuffix: "browser-history",
    createdAt: "2026-07-31T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "history-fixture-model",
      messages: [{ role: "user", content: "Repeat this" }],
    },
  });
  const plan = interruptedPlan();
  await page.addInitScript(({ projectJson, planJson, planName }) => {
    class MemoryFileHandle {
      readonly kind = "file";
      constructor(readonly name: string, public contents: string) {}
      async getFile() { return new File([this.contents], this.name, { type: "application/json" }); }
      async createWritable() {
        return {
          write: async (value: string) => { this.contents = value; },
          close: async () => {},
        };
      }
    }
    class MemoryDirectoryHandle {
      readonly kind = "directory";
      readonly entries = new Map<string, MemoryFileHandle | MemoryDirectoryHandle>();
      constructor(readonly name: string) {}
      async queryPermission() { return "granted" as const; }
      async requestPermission() { return "granted" as const; }
      async *values() { yield* this.entries.values(); }
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const current = this.entries.get(name);
        if (current?.kind === "file") return current;
        if (!current && options?.create) {
          const created = new MemoryFileHandle(name, "");
          this.entries.set(name, created);
          return created;
        }
        throw new DOMException("Not found", "NotFoundError");
      }
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const current = this.entries.get(name);
        if (current?.kind === "directory") return current;
        if (!current && options?.create) {
          const created = new MemoryDirectoryHandle(name);
          this.entries.set(name, created);
          return created;
        }
        throw new DOMException("Not found", "NotFoundError");
      }
      async removeEntry(name: string) { this.entries.delete(name); }
    }
    const root = new MemoryDirectoryHandle("experiment-history-fixture");
    root.entries.set("project.json", new MemoryFileHandle("project.json", projectJson));
    root.entries.set("traces", new MemoryDirectoryHandle("traces"));
    const experiments = new MemoryDirectoryHandle("experiments");
    experiments.entries.set(planName, new MemoryFileHandle(planName, planJson));
    root.entries.set("experiments", experiments);
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => root,
    });
  }, {
    projectJson: serializeProjectFile(project),
    planJson: serializeExperimentPlan(plan),
    planName: `${plan.experimentId}.plan.json`,
  });
}

test("opens an interrupted experiment from grouped browser history", async ({ page }) => {
  await installProjectFolderFixture(page);
  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  // The topbar renders the project name inside its subtitle line, so this
  // asserts on the line that actually carries it rather than on a node whose
  // whole text is the name.
  await expect(page.getByText(/Inspect every model run · Experiment history fixture/))
    .toBeVisible();

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history…" }).click();
  const grouped = page.locator(".run-history-item.experiment");
  await expect(grouped).toHaveCount(1);
  await expect(grouped).toContainText("Repeated experiment · history-fixture-model");
  await expect(grouped).toContainText("interrupted");
  await grouped.click();

  const workspace = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(workspace).toBeVisible();
  await expect(workspace).toContainText("2 requested repetitions");
  await expect(workspace).toContainText("2 not run · 0 missing trace");

  // A saved experiment has no live progress to report. Reopening one must not
  // describe an interrupted plan as finished, run a session clock against its
  // creation time, or claim its unstarted repetitions are queued.
  await expect(workspace.locator(".run-history-status").first()).toHaveText("interrupted");
  await expect(workspace).not.toContainText("elapsed");
  await expect(workspace).not.toContainText("finished");
  await expect(workspace).not.toContainText("Waiting");
  await expect(workspace.getByRole("progressbar")).toHaveCount(0);
  await expect(workspace.getByRole("button", { name: "Stop remaining" })).toHaveCount(0);
  await expect(workspace).not.toHaveAttribute("aria-busy", "true");
  await expect(workspace.locator(".repeated-experiment-row-pending").first()).toHaveText("Not run");
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});
