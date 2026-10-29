import { readFileSync } from "node:fs";
import type { DecisionInput } from "../../packages/core/src/decision";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace";
import { systemOneAdapter } from "../../packages/core/src/system-one";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../../packages/core/src/types";
import { DECISIONS_API_PATH, INFERENCE_API_PATH } from "../../packages/contracts/src";
import { PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY } from "./support";
import { parseSavedRunTraceJson, serializeDecisionRunTrace } from "../../packages/core/src/run-trace";
import { importProject, openMode } from "./support";
import { expect, test, type Page } from "./support/test";
import { createProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import { RunCoordinator, createRunTrace } from "../../packages/core/src/run-kernel";
import { createResolvedRunInput } from "../../packages/core/src/run-kernel/run-execution";
import { serializeRunTrace } from "../../packages/core/src/run-trace";
import { seedProfile, stubPersistentProjectDirectories, waitForHydration } from "./support";

function savedProject(suffix: string) {
  const request = { provider: "openai-compatible" as const, endpoint: "http://127.0.0.1:44014/v1", model: "saved-history-model", messages: [{ role: "user" as const, content: `Question ${suffix}` }] };
  const project = createProjectFile({ name: `Project ${suffix}`, request, idSuffix: suffix });
  const input = createResolvedRunInput(request, {
    conversationId: project.conversations[0]!.id,
    conversationRevisionId: project.defaults.conversationRevisionId,
  }, [], [], suffix, "2026-10-28T10:00:00.000Z");
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  const source = { exchangeId: execution.exchangeId, frameIndex: 0 };
  coordinator.accept({ type: "text_delta", text: `Evidence for ${suffix}`, source });
  coordinator.accept({ type: "completed", finishReason: { normalized: "stop" }, source });
  coordinator.finishTurnStream();
  const trace = createRunTrace(coordinator.state);
  return { project, trace, directory: { name: `${suffix}.inference-lens`, files: { "project.json": serializeProjectFile(project), [`traces/${trace.runId}.json`]: serializeRunTrace(trace) }, directories: ["traces", "experiments"] } };
}
async function openFolder(page: Page, name: string) {
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText(name);
}

test("cold entry resolves the requested saved evidence instead of the last project", async ({ page, context }) => {
  const wanted = savedProject("wanted");
  const other = savedProject("other");
  await stubPersistentProjectDirectories(context, [wanted.directory, other.directory]);
  await seedProfile(page, { endpoint: "", name: "Buffered fixture" });
  await page.goto("/");
  await waitForHydration(page);
  await openFolder(page, wanted.project.name);
  await openFolder(page, other.project.name);
  const requests: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && [INFERENCE_API_PATH, DECISIONS_API_PATH].includes(new URL(request.url()).pathname)) requests.push(request.url()); });
  // A changed query forces document navigation; a hash-only goto stays in-page.
  await page.goto(`/?cold-entry=1#/run/v1?project=${wanted.project.projectId}&run=${wanted.trace.runId}`);
  await waitForHydration(page);
  // Body assertion intentionally exposes the actual wrong/missing evidence on red.
  await expect(page.locator("body")).toContainText("Evidence for wanted");
  await expect(page.locator(".brand")).toContainText(wanted.project.name);
  await expect(page.getByRole("region", { name: "Selected run evidence" })).toContainText(wanted.trace.runId);
  const manifest = await page.evaluate(async name => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    return (await (await folder.getFileHandle("project.json")).getFile()).text();
  }, wanted.directory.name);
  expect(manifest).toBe(wanted.directory.files["project.json"]);
  expect(requests).toEqual([]);
});

function savedDecisionTrace(): DecisionRunTrace {
  const capture = JSON.parse(
    readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
  ) as { request: DecisionInput & { model: string }; response: { body: unknown } };
  const { model, state, questions } = capture.request;
  const runId = "run_saved-decision" as const;
  const input = {
    runId,
    resolvedAt: "2026-09-21T22:00:00.000Z",
    target: {
      profileId: "profile_saved-decision" as const,
      protocol: "systemone" as const,
      endpoint: "http://127.0.0.1:44016/llamacpp/v1",
      model,
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
    decision: { state, questions },
  };
  const raw = JSON.stringify(capture.response.body);
  const exchange = (attempt: number, status: number, body: string) => ({
    exchangeId: `exchange_saved-decision_${attempt}` as const,
    attempt,
    response: { status, headers: { "content-type": "application/json" } },
    frames: [{ index: 0, raw: body }],
  });
  return {
    schemaVersion: 8,
    kind: "decision",
    runId,
    input,
    status: { kind: "completed", completedAt: "2026-09-21T22:00:02.500Z" },
    attempts: [
      {
        attempt: 1,
        exchangeId: "exchange_saved-decision_1",
        status: "failed",
        error: { code: "provider_error", message: "slow down", providerStatus: 429, retryable: true },
      },
      {
        attempt: 2,
        exchangeId: "exchange_saved-decision_2",
        status: "completed",
        result: systemOneAdapter.normalizeResponse(input, raw),
      },
    ],
    exchanges: {
      "exchange_saved-decision_1": exchange(1, 429, "slow down"),
      "exchange_saved-decision_2": exchange(2, 200, raw),
    },
    startedAt: "2026-09-21T22:00:00.000Z",
    endedAt: "2026-09-21T22:00:02.500Z",
  };
}


test("saved decision inspection preserves Compose without adopting the trace", async ({ page, context }) => {
  const fixture = savedProject("decision-home");
  const decision = savedDecisionTrace();
  await stubPersistentProjectDirectories(context, [{ ...fixture.directory, files: { ...fixture.directory.files, [`traces/${decision.runId}.json`]: serializeDecisionRunTrace(decision) } }]);
  await seedProfile(page, { endpoint: "", name: "Buffered fixture" });
  await page.goto("/");
  await waitForHydration(page);
  await openFolder(page, fixture.project.name);
  const executionRequests: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && [INFERENCE_API_PATH, DECISIONS_API_PATH].includes(new URL(request.url()).pathname)) executionRequests.push(request.url());
  });
  await openMode(page, "Runs");
  await page.getByRole("navigation", { name: "Run evidence" }).getByRole("button").filter({ hasText: decision.input.target.model }).click();
  await expect(page.getByRole("navigation", { name: "Application mode" }).getByRole("button", { name: "Runs", exact: true })).toHaveAttribute("aria-current", "page");
  await openMode(page, "Compose");
  await expect(page.getByRole("radio", { name: "Chat", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Question decision-home");
  await openMode(page, "Runs");
  await expect(page.getByRole("region", { name: "Selected run evidence" })).toContainText(decision.runId);
  expect(executionRequests).toEqual([]);
});

const link = (fixture: ReturnType<typeof savedProject>, runId = fixture.trace.runId) => `/#/run/v1?project=${fixture.project.projectId}&run=${runId}`;
async function start(page: Page) { await seedProfile(page, { endpoint: "" }); await page.goto("/"); await waitForHydration(page); }
async function navigateLink(page: Page, path: string) { await page.evaluate(hash => { window.location.hash = hash; }, path.slice(path.indexOf("#"))); }
const selected = (page: Page) => page.getByRole("region", { name: "Selected run evidence" });

test("editor promotion preserves linked evidence in the same project folder", async ({ page, context }) => {
  const fixture = savedProject("promoted-inspection");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  const second = await context.newPage();
  await second.goto("/"); await waitForHydration(second);
  await expect(second.locator(".brand")).toContainText("another tab is editing");
  await navigateLink(second, link(fixture));
  await expect(selected(second)).toContainText("Evidence for promoted-inspection");
  await page.close();
  await expect(second.locator(".brand")).toContainText(`Saved to ${fixture.directory.name}`);
  await expect(selected(second)).toContainText("Evidence for promoted-inspection");
  await expect(second).toHaveURL(new RegExp(fixture.trace.runId));
});

test("opening a different folder copy with the same project ID clears linked inspection", async ({ page, context }) => {
  const fixture = savedProject("copy-inspection");
  const copy = { ...fixture.directory, name: "separate-copy.inference-lens" };
  await stubPersistentProjectDirectories(context, [fixture.directory, copy]);
  await start(page); await openFolder(page, fixture.project.name);
  await navigateLink(page, link(fixture));
  await expect(selected(page)).toContainText("Evidence for copy-inspection");
  await openFolder(page, fixture.project.name);
  await expect(page.locator(".brand")).toContainText("Saved to separate-copy.inference-lens");
  await expect(selected(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/run\//);
});

test("dismissing a link replaces its history entry", async ({ page }) => {
  await start(page);
  await navigateLink(page, "/#/run/v99?project=project_unknown&run=run_unknown");
  const recovery = page.getByRole("region", { name: "Saved run link" });
  await expect(recovery).toBeVisible();
  const length = await page.evaluate(() => history.length);
  await recovery.getByRole("button", { name: "Dismiss link" }).click();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await expect(page).not.toHaveURL(/#\/run\//);
});

for (const fragment of ["#/run/v99?project=project_unknown&run=run_unknown", "#/run/v1?project=project_unknown&run=run_unknown"]) {
  test(`dismissing a cold link resumes the last project: ${fragment}`, async ({ page, context }) => {
    const fixture = savedProject("deferred-restore");
    await stubPersistentProjectDirectories(context, [fixture.directory]);
    await start(page); await openFolder(page, fixture.project.name);
    await page.goto(`/?deferred-restore=1${fragment}`); await waitForHydration(page);
    const recovery = page.getByRole("region", { name: "Saved run link" });
    await expect(recovery).toBeVisible();
    await recovery.getByRole("button", { name: "Dismiss link" }).click();
    await expect(page.locator(".brand")).toContainText(fixture.project.name);
    await expect(page.getByLabel("Message 1 content")).toHaveValue("Question deferred-restore");
  });
}

async function storedRecordId(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("inference-lens"); r.onsuccess = () => resolve(r.result); });
    const record = await new Promise<{ recordId: string }>(resolve => { const r = db.transaction("workspace-handles").objectStore("workspace-handles").get("last-project"); r.onsuccess = () => resolve(r.result); });
    db.close(); return record?.recordId;
  });
}

test("startup restore preserves the accepted folder's last-project record ID", async ({ page, context }) => {
  const fixture = savedProject("stable-record");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  await expect.poll(() => storedRecordId(page)).toBeTruthy();
  const before = await storedRecordId(page);
  await page.reload(); await waitForHydration(page);
  await expect(page.locator(".brand")).toContainText(fixture.project.name);
  // Discovery persistence follows adoption; flush it before comparing records.
  await page.evaluate(() => navigator.locks.request("inference-lens:project-locations", () => undefined));
  expect(await storedRecordId(page)).toBe(before);
});

test("legacy folders without permission are labelled as unverified guesses", async ({ page, context }) => {
  const last = savedProject("legacy-last"), target = savedProject("unknown-target");
  await stubPersistentProjectDirectories(context, [last.directory]);
  await start(page); await openFolder(page, last.project.name);
  await expect.poll(() => storedRecordId(page)).toBeTruthy();
  await page.evaluate(async () => {
    await navigator.locks.request("inference-lens:project-locations", async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("inference-lens"); r.onsuccess = () => resolve(r.result); });
      await new Promise<void>(resolve => { const tx = db.transaction("project-locations", "readwrite"); tx.objectStore("project-locations").clear(); tx.oncomplete = () => resolve(); }); db.close();
    });
  });
  await page.addInitScript(() => Object.defineProperty(FileSystemHandle.prototype, "queryPermission", { configurable: true, value: async () => "prompt" }));
  await page.goto(`/?unverified=1${link(target).slice(1)}`); await waitForHydration(page);
  const reconnect = page.getByRole("region", { name: "Saved run link" }).getByRole("button", { name: /^Reconnect/ });
  await expect(reconnect).toContainText(/unverified/i);
  await expect(reconnect).toContainText(last.project.name);
});

test("run history reports the real file read error", async ({ page, context }) => {
  const fixture = savedProject("unreadable-history");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  await page.evaluate(runId => {
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function() {
      if (this.name === `${runId}.json`) return Promise.reject(new Error("Fixture permission denied"));
      return getFile.call(this);
    };
  }, fixture.trace.runId);
  await openMode(page, "Runs");
  await page.locator(".run-history-failures summary").click();
  await expect(page.locator(".run-history-failures")).toContainText("Fixture permission denied");
});

test("unknown folder and wrong-folder recovery retain the requested IDs", async ({ page, context }) => {
  const wanted = savedProject("locate-target"), wrong = savedProject("wrong-choice");
  await stubPersistentProjectDirectories(context, [wrong.directory, wanted.directory]);
  await start(page);
  await navigateLink(page, link(wanted));
  const recovery = page.getByRole("region", { name: "Saved run link" });
  await expect(recovery).toContainText(wanted.trace.runId);
  await recovery.getByRole("button", { name: "Locate project folder…" }).click();
  await expect(recovery).toContainText("Wrong project");
  await expect(page.locator(".brand")).toContainText("No project open");
  await recovery.getByRole("button", { name: "Locate project folder…" }).click();
  await expect(selected(page)).toContainText("Evidence for locate-target");
  // Only the accepted folder enters local discovery.
  const ids = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open("inference-lens"); request.onsuccess = () => resolve(request.result); });
    const records = await new Promise<Array<{ projectId: string }>>(resolve => { const request = db.transaction("project-locations").objectStore("project-locations").getAll(); request.onsuccess = () => resolve(request.result); }); db.close();
    return records.map(r => r.projectId);
  });
  expect(ids).not.toContain(wrong.project.projectId);
});

test("missing evidence is preflighted before replacing the current project", async ({ page, context }) => {
  const target = savedProject("missing-target"), current = savedProject("still-open");
  delete target.directory.files[`traces/${target.trace.runId}.json`];
  await stubPersistentProjectDirectories(context, [target.directory, current.directory]);
  await start(page); await openFolder(page, target.project.name); await openFolder(page, current.project.name);
  await navigateLink(page, link(target));
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("Git may exclude run history");
  await expect(page.locator(".brand")).toContainText(current.project.name);
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Question still-open");
});

test("handoff reaches the editor without transferring its role, and open-here inspects locally", async ({ page, context }) => {
  const fixture = savedProject("handoff");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  await page.getByLabel("Message 1 content").fill("Draft stays in editor");
  const second = await context.newPage();
  await second.goto(link(fixture)); await waitForHydration(second);
  await expect(second.getByRole("region", { name: "Saved run link" })).toContainText("Opened in your other tab");
  await expect(selected(page)).toContainText("Evidence for handoff");
  await second.getByRole("button", { name: "Open here instead" }).click();
  await expect(selected(second)).toContainText("Evidence for handoff");
  await expect(second.locator("body")).toContainText("another tab is editing this project");
  await openMode(page, "Compose");
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Draft stays in editor");
});

test("fragment history, refresh and native-link paste select the exact evidence", async ({ page, context }) => {
  const first = savedProject("history-first"), second = savedProject("history-second");
  await stubPersistentProjectDirectories(context, [first.directory, second.directory]);
  await start(page); await openFolder(page, first.project.name); await openFolder(page, second.project.name);
  await navigateLink(page, link(first)); await expect(selected(page)).toContainText("Evidence for history-first");
  await navigateLink(page, link(second)); await expect(selected(page)).toContainText("Evidence for history-second");
  await page.goBack(); await expect(selected(page)).toContainText("Evidence for history-first");
  await page.goForward(); await expect(selected(page)).toContainText("Evidence for history-second");
  await page.reload(); await expect(selected(page)).toContainText("Evidence for history-second");
  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Open saved run link…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open saved run link" });
  await dialog.getByLabel("Run link", { exact: true }).fill(`inference-lens://run/v1?project=${first.project.projectId}&run=${first.trace.runId}`);
  await dialog.getByRole("button", { name: "Open link", exact: true }).click();
  await expect(selected(page)).toContainText("Evidence for history-first");
});

test("clipboard failure exposes a selectable exact URL without changing history", async ({ page, context }) => {
  const fixture = savedProject("clipboard");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  await navigateLink(page, link(fixture)); await expect(selected(page)).toContainText("Evidence for clipboard");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
  const before = await page.evaluate(() => history.length);
  await selected(page).getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(selected(page).getByLabel("Saved run link", { exact: true })).toHaveValue(new URL(link(fixture), page.url()).href);
  expect(await page.evaluate(() => history.length)).toBe(before);
  await page.reload(); await expect(selected(page)).toContainText("Evidence for clipboard");
});

test("unsupported browsers and invalid versions explain the limitation", async ({ page }) => {
  const fixture = savedProject("unsupported");
  await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined }));
  await start(page); await navigateLink(page, link(fixture));
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("requires Chrome or Edge");
  await navigateLink(page, link(fixture).replace("/v1?", "/v2?"));
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("newer version");
  await page.getByRole("button", { name: "Dismiss link" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("unsaved-work cancellation and superseding links cannot later switch projects", async ({ page, context }) => {
  const target = savedProject("guard-target"), original = savedProject("guard-original");
  await stubPersistentProjectDirectories(context, [target.directory]);
  await start(page); await openFolder(page, target.project.name);
  await openMode(page, "Compose");
  await importProject(page, original.project, original.project.name);
  await page.getByLabel("Message 1 content").fill("Unsaved draft survives link cancellation");
  await navigateLink(page, link(target));
  const dialog = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(dialog).toContainText(target.project.name);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".brand")).toContainText(original.project.name);
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Unsaved draft survives link cancellation");
  await page.getByRole("region", { name: "Saved run link" }).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog).toBeVisible();
  // A newer same-workspace link dismisses the old adoption callback and dialog.
  await navigateLink(page, link(original));
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".brand")).toContainText(original.project.name);
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("Locate the project folder");
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Unsaved draft survives link cancellation");
});

test("a pending branch blocks replacement but permits inspecting another run in its workspace", async ({ page, context }) => {
  const current = savedProject("branch-home"), target = savedProject("branch-away");
  await stubPersistentProjectDirectories(context, [target.directory, current.directory]);
  await start(page); await openFolder(page, target.project.name); await openFolder(page, current.project.name);
  await navigateLink(page, link(current)); await expect(selected(page)).toContainText("Evidence for branch-home");
  await selected(page).getByRole("button", { name: "Branch from this run" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pending branch" })).toBeVisible();
  await navigateLink(page, link(target));
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("pending branch");
  await expect(page.locator(".brand")).toContainText(current.project.name);
  await navigateLink(page, link(current)); await expect(selected(page)).toContainText("Evidence for branch-home");
  await openMode(page, "Compose");
  await expect(page.getByRole("status").filter({ hasText: "Pending branch" })).toBeVisible();
});

test("remembered folder permissions require an explicit Reconnect and can be retried", async ({ page, context }) => {
  const fixture = savedProject("permission");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  await page.addInitScript(() => {
    Object.defineProperty(FileSystemHandle.prototype, "queryPermission", { configurable: true, value: async () => "prompt" });
    Object.defineProperty(FileSystemHandle.prototype, "requestPermission", { configurable: true, value: async () => sessionStorage.getItem("allow-folder") ? "granted" : "denied" });
  });
  await page.goto(`/?permission-entry=1${link(fixture).slice(1)}`); await waitForHydration(page);
  const recovery = page.getByRole("region", { name: "Saved run link" });
  await expect(recovery).toContainText("Reconnect the project folder");
  await recovery.getByRole("button", { name: /^Reconnect/ }).click();
  await expect(recovery).toContainText("Folder permission is still needed");
  await page.evaluate(() => sessionStorage.setItem("allow-folder", "yes"));
  await recovery.getByRole("button", { name: /^Reconnect/ }).click();
  await expect(selected(page)).toContainText("Evidence for permission");
});

test("multiple registered copies require a choice unless that project is already open", async ({ page, context }) => {
  const fixture = savedProject("copies"), other = savedProject("copies-other");
  const copy = { ...fixture.directory, name: "second-copy.inference-lens" };
  await stubPersistentProjectDirectories(context, [fixture.directory, copy, other.directory]);
  await start(page); await openFolder(page, fixture.project.name); await openFolder(page, fixture.project.name); await openFolder(page, other.project.name);
  await navigateLink(page, link(fixture));
  const recovery = page.getByRole("region", { name: "Saved run link" });
  await expect(recovery).toContainText("Choose which local copy");
  await recovery.getByRole("button", { name: /Reconnect.*second-copy/ }).click();
  await expect(selected(page)).toContainText("Evidence for copies");
  await page.evaluate(() => { location.hash = ""; });
  await navigateLink(page, link(fixture));
  await expect(selected(page)).toContainText("Evidence for copies");
  await expect(recovery).toHaveCount(0);
});

test("rapid links cannot publish evidence from a superseded folder read", async ({ page, context }) => {
  const slow = savedProject("slow-read"), fast = savedProject("fast-read");
  await stubPersistentProjectDirectories(context, [slow.directory, fast.directory]);
  await start(page); await openFolder(page, slow.project.name); await openFolder(page, fast.project.name);
  await page.evaluate(runId => {
    const original = FileSystemFileHandle.prototype.getFile;
    const browser = globalThis as typeof globalThis & { releaseSlowRead?: () => void; slowReadStarted?: boolean };
    FileSystemFileHandle.prototype.getFile = async function() {
      if (this.name === `${runId}.json`) {
        browser.slowReadStarted = true;
        await new Promise<void>(resolve => { browser.releaseSlowRead = resolve; });
      }
      return original.call(this);
    };
  }, slow.trace.runId);
  await navigateLink(page, link(slow));
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { slowReadStarted?: boolean }).slowReadStarted)).toBe(true);
  await navigateLink(page, link(fast)); await expect(selected(page)).toContainText("Evidence for fast-read");
  await page.evaluate(() => (globalThis as typeof globalThis & { releaseSlowRead?: () => void }).releaseSlowRead?.());
  await expect(selected(page)).toContainText("Evidence for fast-read");
  await expect(page.locator(".brand")).toContainText(fast.project.name);
});

async function connectedStart(page: Page, fixtures: ReturnType<typeof savedProject>[]) {
  await seedProfile(page, { instanceId: "run-links-profile" });
  await page.addInitScript(({ key, projects }) => {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(projects.map(project => [project.projectId, {
      [project.requirementId]: { profileId: "buffered", profileInstanceId: "run-links-profile" },
    }]))));
  }, { key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, projects: fixtures.map(f => ({ projectId: f.project.projectId, requirementId: f.project.defaults.target.connectionRequirementId })) });
  await page.goto("/"); await waitForHydration(page);
}

test("saved inspection preserves an active request and blocks a different-project switch", async ({ page, context }) => {
  const current = savedProject("active-home"), target = savedProject("active-away");
  await stubPersistentProjectDirectories(context, [target.directory, current.directory]);
  await connectedStart(page, [current, target]);
  await openFolder(page, target.project.name); await openFolder(page, current.project.name);
  let arrived = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${INFERENCE_API_PATH}`, async route => { arrived++; await gate; await route.continue().catch(() => undefined); });
  try {
    await page.getByRole("button", { name: /run current conversation/i }).click();
    await expect.poll(() => arrived).toBe(1);
    await navigateLink(page, link(target));
    await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("current chat run");
    await expect(page.locator(".brand")).toContainText(current.project.name);
    await navigateLink(page, link(current));
    await expect(selected(page)).toContainText("Evidence for active-home");
    release();
    await openMode(page, "Compose");
    await expect(page.locator(".response-pane")).toContainText("Buffered fixture response: 2 + 2 = 4.");
    await expect(page.getByLabel("Run summary")).toContainText("Completed");
    expect(arrived).toBe(1);
  } finally { release(); }
});

test("a UI-generated run copies a verified link and reopens the persisted output", async ({ page, context }, testInfo) => {
  const fixture = savedProject("generated");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await connectedStart(page, [fixture]); await openFolder(page, fixture.project.name);
  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response: 2 + 2 = 4.");
  await expect(page.locator(".response-pane")).toContainText("Run trace saved");
  const files = await page.evaluate(async name => {
    const root = await navigator.storage.getDirectory(); const folder = await root.getDirectoryHandle(name);
    const traces = await folder.getDirectoryHandle("traces"); const contents: string[] = [];
    for await (const file of (traces as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle> }).values()) if (file.kind === "file") contents.push(await (await (file as FileSystemFileHandle).getFile()).text());
    return contents;
  }, fixture.directory.name);
  const generated = files.map(text => ({ text, saved: parseSavedRunTraceJson(text) })).find(({ saved }) => saved.trace.runId !== fixture.trace.runId)!;
  expect(generated).toBeDefined(); expect(generated.text).toContain("Buffered fixture response: 2 + 2 = 4.");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (globalThis as typeof globalThis & { copiedRunLink?: string }).copiedRunLink = text; } } }));
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  const copied = await page.evaluate(() => (globalThis as typeof globalThis & { copiedRunLink?: string }).copiedRunLink);
  expect(copied).toBe(new URL(link(fixture, generated.saved.trace.runId), page.url()).href);
  await page.goto(copied!);
  await page.reload();
  await expect(selected(page)).toContainText("Buffered fixture response: 2 + 2 = 4.");
  await expect(selected(page)).toContainText(generated.saved.trace.runId);
  await expect(selected(page).getByText("Buffered fixture response: 2 + 2 = 4.", { exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("saved-run-link.png"), fullPage: true });
});

test("legacy last-project handles migrate additively when a link accepts the folder", async ({ page, context }) => {
  const fixture = savedProject("legacy");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await start(page); await openFolder(page, fixture.project.name);
  // Replace the local metadata with the exact v1 store shape used before links.
  await page.evaluate(async ({ name, projectName }) => {
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase("inference-lens"); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("inference-lens", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("workspace-handles");
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("workspace-handles", "readwrite");
      tx.objectStore("workspace-handles").put({ version: 1, recordId: "legacy-record", kind: "browser-directory", displayName: name, projectName, handle, savedAt: Date.now() }, "last-project");
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { name: fixture.directory.name, projectName: fixture.project.name });
  await page.goto(`/?legacy-entry=1${link(fixture).slice(1)}`);
  await expect(selected(page)).toContainText("Evidence for legacy");
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("inference-lens"); r.onsuccess = () => resolve(r.result); });
    const result = await new Promise<number>(resolve => { const r = db.transaction("project-locations").objectStore("project-locations").count(); r.onsuccess = () => resolve(r.result); }); db.close(); return result;
  })).toBe(1);
});

test("a picker cancellation retains the pending link and current project", async ({ page }) => {
  const fixture = savedProject("cancel-picker");
  await start(page);
  await page.evaluate(() => Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => { throw new DOMException("Cancelled", "AbortError"); } }));
  await navigateLink(page, link(fixture));
  await page.getByRole("button", { name: "Locate project folder…" }).click();
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("Folder selection cancelled");
  await expect(page).toHaveURL(new RegExp(fixture.trace.runId));
  await expect(page.locator(".brand")).toContainText("No project open");
});

test("a target folder changed during the replacement dialog cannot adopt stale evidence", async ({ page, context }) => {
  const target = savedProject("changed-target"), original = savedProject("unchanged-current"), replacement = savedProject("different-on-disk");
  await stubPersistentProjectDirectories(context, [target.directory]);
  await start(page); await openFolder(page, target.project.name);
  await importProject(page, original.project, original.project.name);
  await page.getByLabel("Message 1 content").fill("Keep this draft while the target changes");
  await navigateLink(page, link(target));
  const dialog = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(dialog).toBeVisible();
  await page.evaluate(async ({ name, contents }) => {
    const root = await navigator.storage.getDirectory(); const folder = await root.getDirectoryHandle(name);
    const writable = await (await folder.getFileHandle("project.json")).createWritable();
    await writable.write(contents); await writable.close();
  }, { name: target.directory.name, contents: serializeProjectFile(replacement.project) });
  await dialog.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.locator(".brand")).toContainText(original.project.name);
  await expect(page.getByRole("region", { name: "Saved run link" })).toContainText("different project");
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Keep this draft while the target changes");
});

test("Save and switch waits for a successful save before resolving the link", async ({ page, context }) => {
  const target = savedProject("save-target"), original = savedProject("save-original");
  await stubPersistentProjectDirectories(context, [target.directory, original.directory]);
  await start(page); await openFolder(page, target.project.name); await openFolder(page, original.project.name);
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    sessionStorage.setItem("refuse-write", "yes");
    FileSystemFileHandle.prototype.createWritable = function(options) {
      if (this.name === "project.json" && sessionStorage.getItem("refuse-write")) return Promise.reject(new Error("Fixture disk full"));
      return original.call(this, options);
    };
  });
  await page.getByLabel("Message 1 content").fill("Persist this draft before following the link");
  await navigateLink(page, link(target));
  const dialog = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await dialog.getByRole("button", { name: "Save and switch", exact: true }).click();
  await expect(dialog).toContainText("Fixture disk full");
  await expect(page.locator(".brand")).toContainText(original.project.name);
  await page.evaluate(() => sessionStorage.removeItem("refuse-write"));
  await dialog.getByRole("button", { name: "Save and switch", exact: true }).click();
  await expect(selected(page)).toContainText("Evidence for save-target");
  const contents = await page.evaluate(async name => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    return (await (await folder.getFileHandle("project.json")).getFile()).text();
  }, original.directory.name);
  expect(contents).toContain("Persist this draft before following the link");
});

test("a saved experiment member copies a standalone link without requiring its plan", async ({ page, context }) => {
  const fixture = savedProject("experiment-member");
  await stubPersistentProjectDirectories(context, [fixture.directory]);
  await connectedStart(page, [fixture]); await openFolder(page, fixture.project.name);
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", { name: "Run this frozen request repeatedly" });
  await dialog.getByLabel("Repetitions").fill("2");
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();
  const results = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(results).toContainText("2 completed");
  await results.getByRole("button", { name: "Open Response & Inspect" }).first().click();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (globalThis as typeof globalThis & { copiedMemberLink?: string }).copiedMemberLink = text; } } }));
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  const copied = await page.evaluate(() => (globalThis as typeof globalThis & { copiedMemberLink?: string }).copiedMemberLink);
  expect(copied).toBeDefined();
  const runId = new URLSearchParams(new URL(copied!).hash.split("?")[1]).get("run")!;
  expect(runId).not.toBe(fixture.trace.runId);
  const contents = await page.evaluate(async ({ name, runId }) => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    const traces = await folder.getDirectoryHandle("traces");
    const contents = await (await (await traces.getFileHandle(`${runId}.json`)).getFile()).text();
    await folder.removeEntry("experiments", { recursive: true });
    return contents;
  }, { name: fixture.directory.name, runId });
  expect(parseSavedRunTraceJson(contents).trace.runId).toBe(runId);
  expect(contents).toContain("Buffered fixture response: 2 + 2 = 4.");
  await page.goto(copied!); await page.reload();
  await expect(selected(page)).toContainText(runId);
  await expect(selected(page)).toContainText("Buffered fixture response: 2 + 2 = 4.");
});
