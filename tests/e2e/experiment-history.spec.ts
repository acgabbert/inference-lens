import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  serializeExperimentPlan,
  type RepeatedExperimentPlanV2,
} from "../../packages/core/src/experiment";
import { createProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../../packages/core/src/types";

function interruptedPlan(): RepeatedExperimentPlanV2 {
  const createdAt = "2026-07-31T12:00:00.000Z";
  return {
    schemaVersion: 2,
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

/**
 * The one project folder both storage adapters are asked to reproduce: a
 * project manifest, an empty traces directory, and one interrupted experiment
 * plan with no result artifact.
 */
function historyFixture() {
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
  return {
    projectJson: serializeProjectFile(project),
    planJson: serializeExperimentPlan(plan),
    planName: `${plan.experimentId}.plan.json`,
  };
}

async function installProjectFolderFixture(page: Page): Promise<void> {
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
  }, historyFixture());
}

/**
 * Puts the app on its desktop storage path by installing the object Tauri's own
 * `invoke` calls: `@tauri-apps/api/core` dispatches through
 * `window.__TAURI_INTERNALS__.invoke`, and `isTauriRuntime` keys off the same
 * property. Everything above that boundary is the shipped code — the runtime
 * check, `nativeWorkspaceHandle`, every command name and argument, the
 * experiment filename guards, and the whole grouped-history read model.
 *
 * The backend behind the boundary is a stand-in for `src-tauri`, so this proves
 * the webview half of the desktop contract, not the Rust half. It is paired
 * with `cargo test`, which exercises the same commands against a real
 * filesystem, and the assertions below pin the wire shape the two sides agree
 * on so a rename in either cannot pass both.
 */
async function installNativeWorkspaceFixture(page: Page): Promise<void> {
  await page.addInitScript(({ projectJson, planJson, planName }) => {
    const WORKSPACE_ID = "workspace-fixture";
    const experiments = new Map<string, string>([[planName, planJson]]);
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    (window as unknown as { __nativeCalls: typeof calls }).__nativeCalls = calls;

    function assertWorkspace(args: Record<string, unknown>): void {
      if (args.workspaceId !== WORKSPACE_ID) {
        throw new Error(`This project folder is no longer open: ${String(args.workspaceId)}`);
      }
    }

    // Mirrors `is_experiment_entry_name` in src-tauri/src/lib.rs. A native
    // command rejects a traversing or unexpected name rather than reading it.
    function isExperimentEntryName(name: string): boolean {
      return /^experiment_[A-Za-z0-9_-]+\.(plan|result)\.json$/.test(name)
        && !name.includes("..");
    }

    const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
      open_project_workspace: () => ({
        workspaceId: WORKSPACE_ID,
        displayName: "experiment-history-fixture",
        displayPath: "/fixtures/experiment-history-fixture",
        contents: projectJson,
      }),
      list_run_traces: (args) => {
        assertWorkspace(args);
        return [];
      },
      read_run_trace: (args) => {
        assertWorkspace(args);
        throw new Error(`Could not read ${String(args.fileName)}: not found`);
      },
      list_experiment_artifacts: (args) => {
        assertWorkspace(args);
        return [...experiments]
          .map(([fileName, contents]) => ({ fileName, contents }))
          .sort((left, right) => (left.fileName < right.fileName ? -1 : 1));
      },
      read_experiment_artifact: (args) => {
        assertWorkspace(args);
        const fileName = String(args.fileName);
        if (!isExperimentEntryName(fileName)) {
          throw new Error(`${fileName} is not an experiment artifact file name.`);
        }
        const contents = experiments.get(fileName);
        if (contents === undefined) throw new Error(`Could not read ${fileName}: not found`);
        return contents;
      },
      save_experiment_artifact: (args) => {
        assertWorkspace(args);
        const fileName = String(args.fileName);
        if (!isExperimentEntryName(fileName)) {
          throw new Error(`${fileName} is not an experiment artifact file name.`);
        }
        const existing = experiments.get(fileName);
        const contents = String(args.contents);
        if (existing !== undefined && existing !== contents) {
          throw new Error(`${fileName} already exists with different contents.`);
        }
        experiments.set(fileName, contents);
      },
      credential_status: () => ({ kind: "missing" }),
    };

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          const handler = commands[command];
          if (!handler) throw new Error(`Unhandled native command ${command}.`);
          return handler(args);
        },
      },
    });
  }, historyFixture());
}

/** The disposition every storage adapter must report for the same folder. */
async function expectInterruptedExperiment(page: Page): Promise<void> {
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
  await expect(workspace).toContainText("2 not run");
  await expect(workspace).not.toContainText("missing trace");

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

  await expectInterruptedExperiment(page);
});

test("opens an interrupted experiment from grouped desktop history", async ({ page }) => {
  await installNativeWorkspaceFixture(page);
  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.getByText(/Inspect every model run · Experiment history fixture/))
    .toBeVisible();

  await expectInterruptedExperiment(page);

  // The desktop adapter is only correct if it speaks the commands `src-tauri`
  // actually exposes. Pin the names and argument keys so a rename on either
  // side of the IPC boundary fails here instead of only at runtime on a desktop
  // build that no suite exercises.
  const calls = await page.evaluate(
    () => (window as unknown as {
      __nativeCalls: Array<{ command: string; args: Record<string, unknown> }>;
    }).__nativeCalls,
  );
  const commands = calls.map((call) => call.command);
  expect(commands).toContain("open_project_workspace");
  expect(commands).toContain("list_run_traces");
  expect(commands).toContain("list_experiment_artifacts");
  expect(commands).toContain("read_experiment_artifact");

  const read = calls.find((call) => call.command === "read_experiment_artifact");
  expect(Object.keys(read!.args).sort()).toEqual(["fileName", "workspaceId"]);
  expect(read!.args.fileName).toMatch(/^experiment_[A-Za-z0-9_-]+\.plan\.json$/);
  expect(read!.args.workspaceId).toBe("workspace-fixture");

  const listed = calls.find((call) => call.command === "list_experiment_artifacts");
  expect(Object.keys(listed!.args)).toEqual(["workspaceId"]);
});
