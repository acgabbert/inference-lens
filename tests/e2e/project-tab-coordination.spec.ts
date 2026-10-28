import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type { FileSystemDirectoryHandleLike } from "../../app/project-directory.client";
import { DECISIONS_API_PATH, INFERENCE_API_PATH } from "../../packages/contracts/src";
import { updateDecisionRequestDraft } from "../../packages/core/src/decision-request";
import type { DecisionInput } from "../../packages/core/src/decision";

import {
  createProjectFile,
  createPromptTemplate,
  serializeProjectFile,
} from "../../packages/core/src/project";
import {
  closeProjectMenu,
  importProject,
  openMode,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  primaryAction,
  seedProfile,
  seedProfiles,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  stubSharedProjectDirectory,
  waitForHydration,
} from "./support";
import type { SharedProjectDirectory } from "./support";

const FOLDER = "tab-coordination.inference-lens";
const SECONDARY_LABEL = "Not saved — another tab is editing this project";
const SECONDARY_TITLE = "Another tab is editing this project. Changes in this tab are not saved.";
const SAVED_PROMPT = "Saved router prompt";

function project() {
  return createPromptTemplate(
    createProjectFile({
      name: "Tab coordination",
      request: {
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:44014/v1",
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Coordinate the tabs." }],
      },
      idSuffix: "tab-coordination",
      createdAt: "2026-10-28T12:00:00.000Z",
    }),
    {
      name: "Router prompt",
      messages: [{ role: "user", content: SAVED_PROMPT }],
      idSuffix: "tab-coordination-prompt",
      revisionIdSuffix: "tab-coordination-revision",
      createdAt: "2026-10-28T12:01:00.000Z",
    },
  );
}

async function sharedProject(context: BrowserContext, document = project()): Promise<SharedProjectDirectory> {
  return stubSharedProjectDirectory(context, {
    name: FOLDER,
    files: { "project.json": serializeProjectFile(document) },
    directories: ["traces"],
  });
}

/**
 * Pages load before any of them opens the folder: an open remembers the
 * directory handle, and a page loaded afterwards would try to resume it.
 */
async function loadTabs(context: BrowserContext, count: number, decision = false): Promise<Page[]> {
  const pages: Page[] = [];
  for (let index = 0; index < count; index += 1) {
    const page = await context.newPage();
    if (decision) {
      await seedProfiles(page, [
        { id: "buffered", instanceId: "profile-instance-buffered", name: "Buffered fixture" },
        {
          id: "decisions", instanceId: "decisions-instance", name: "Decision fixture",
          endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`, systemOne: true,
        },
      ], "buffered");
    } else {
      await seedProfile(page, { instanceId: "profile-instance-buffered" });
    }
    await page.addInitScript(({ key, projectId, requirementId }) => {
      localStorage.setItem(key, JSON.stringify({
        [projectId]: { [requirementId]: { profileId: "buffered", profileInstanceId: "profile-instance-buffered" } },
      }));
    }, {
      key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
      projectId: project().projectId,
      requirementId: project().defaults.target.connectionRequirementId,
    });
    await page.goto("/");
    await waitForHydration(page);
    pages.push(page);
  }
  return pages;
}

async function openFolder(page: Page): Promise<void> {
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Tab coordination");
  await closeProjectMenu(page);
}

async function editPrompt(page: Page, content: string): Promise<void> {
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill(content);
}

function promptContent(page: Page) {
  return page.getByLabel("Prompt content", { exact: true });
}

function tabBanner(page: Page) {
  return page.locator('[data-app-banner="project-tab"]');
}

function manifestWriters(directory: SharedProjectDirectory): Page[] {
  return directory.writes.filter(({ path }) => path === "project.json").map(({ page }) => page);
}

/**
 * Holds this page's timers of half a second or more until released, so its
 * autosave stays pending. `page.clock` cannot do this for one tab: the clock
 * belongs to the browser context and would hold every tab's timers.
 */
/**
 * Stands in for a tab the browser froze in the background: it hears nothing
 * from other tabs, so it cannot answer a handover request. CDP's lifecycle
 * freeze would be the real thing, but Chromium declines to freeze a visible
 * page, and every page of a headless context is visible.
 */
async function muteTabMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Native = BroadcastChannel;
    window.BroadcastChannel = class extends Native {
      override set onmessage(handler: ((event: MessageEvent) => void) | null) {
        super.onmessage = handler && (() => undefined);
      }
      override get onmessage() {
        return super.onmessage;
      }
    };
  });
}

async function holdLongTimers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = new Map<number, () => void>();
    const nativeSet = window.setTimeout.bind(window);
    const nativeClear = window.clearTimeout.bind(window);
    (window as unknown as { releaseLongTimers(): void }).releaseLongTimers = () => {
      const due = [...held.values()];
      held.clear();
      for (const run of due) run();
    };
    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) => {
      if (timeout < 500 || typeof handler !== "function") return nativeSet(handler, timeout, ...args);
      const id = nativeSet(() => undefined, 0);
      held.set(id, () => handler(...args));
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) held.delete(id);
      nativeClear(id);
    }) as typeof window.clearTimeout;
  });
}

test("a second tab edits without a conflict, and only the editor tab writes project.json", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await openFolder(editor!);
  await openFolder(second!);

  await editPrompt(editor!, "Router prompt edited in the editor tab");
  await expect(editor!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);

  await editPrompt(second!, "Specialist prompt tried in the second tab");
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);
  await expect(second!.getByText(/changed outside Inference Lens/)).toHaveCount(0);
  await expect(tabBanner(second!)).toContainText(SECONDARY_TITLE);

  expect(manifestWriters(directory)).toEqual([editor]);
  expect(directory.read("project.json")).toContain("Router prompt edited in the editor tab");
});

test("every tab runs, and every tab's traces reach the folder", async ({ context }) => {
  const directory = await sharedProject(context);
  const tabs = await loadTabs(context, 2);
  for (const tab of tabs) await openFolder(tab);
  await expect(tabs[1]!.locator(".brand")).toContainText(SECONDARY_LABEL);

  for (const tab of tabs) {
    await openMode(tab, "Compose");
    await primaryAction(tab, "compose").click();
  }
  const traceWriters = () => directory.writes
    .filter(({ path }) => path.startsWith("traces/"))
    .map(({ page }) => tabs.indexOf(page));
  await expect.poll(() => new Set(traceWriters())).toEqual(new Set([0, 1]));
  expect(manifestWriters(directory).every((page) => page === tabs[0])).toBe(true);
});

test("Edit here flushes the editor's pending change before this tab reloads", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await openFolder(editor!);
  await openFolder(second!);
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);

  // Held timers keep the editor's autosave pending, so only the handover can write it.
  await holdLongTimers(editor!);
  await editPrompt(editor!, "Pending in the editor when the handover arrives");
  await expect(editor!.locator(".brand")).toContainText(`Saving to ${FOLDER}…`);
  expect(manifestWriters(directory)).toEqual([]);

  await openMode(second!, "Prompts");
  await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();

  await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await expect(tabBanner(second!)).toHaveCount(0);
  await expect(promptContent(second!)).toHaveValue("Pending in the editor when the handover arrives");
  await expect(editor!.locator(".brand")).toContainText(SECONDARY_LABEL);
  expect(manifestWriters(directory)).toEqual([editor]);

  await promptContent(second!).fill("Saved from the new editor");
  await expect.poll(() => manifestWriters(directory)).toEqual([editor, second]);
  expect(directory.read("project.json")).toContain("Saved from the new editor");
});

test("Edit here in a tab with its own edits asks before discarding them", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await openFolder(editor!);
  await openFolder(second!);
  await editPrompt(second!, "Only in the second tab");

  await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
  await expect(tabBanner(second!)).toContainText("Edit here and discard this tab's unsaved changes?");
  await expect(tabBanner(second!).getByRole("button", { name: "Export JSON copy…", exact: true })).toBeVisible();
  await tabBanner(second!).getByRole("button", { name: "Not now", exact: true }).click();
  await expect(tabBanner(second!)).toContainText(SECONDARY_TITLE);
  await expect(promptContent(second!)).toHaveValue("Only in the second tab");

  await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
  await tabBanner(second!).getByRole("button", { name: "Discard and edit here", exact: true }).click();
  await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await expect(promptContent(second!)).toHaveValue(SAVED_PROMPT);
  await expect(editor!.locator(".brand")).toContainText(SECONDARY_LABEL);
  expect(manifestWriters(directory)).toEqual([]);
});

test("an editor that does not answer loses the role to a steal and says its edits were not saved", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await muteTabMessages(editor!);
  await openFolder(editor!);
  await openFolder(second!);
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);
  await openMode(second!, "Prompts");

  await holdLongTimers(editor!);
  await editPrompt(editor!, "Never flushed by the silent editor");
  await expect(editor!.locator(".brand")).toContainText(`Saving to ${FOLDER}…`);

  await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
  // No reply arrives, so the second tab steals after the handover timeout.
  await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await expect(promptContent(second!)).toHaveValue(SAVED_PROMPT);

  // Its pending autosave, once allowed to run, must not reach the folder.
  await editor!.evaluate(() => (window as unknown as { releaseLongTimers(): void }).releaseLongTimers());
  await expect(tabBanner(editor!)).toContainText(
    "Another tab took over editing before this tab's changes were saved.",
  );
  await expect(editor!.locator(".brand")).toContainText(SECONDARY_LABEL);
  await expect(promptContent(editor!)).toHaveValue("Never flushed by the silent editor");
  expect(manifestWriters(directory)).toEqual([]);
});

test("closing the editor promotes an unedited tab, which then saves", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await openFolder(editor!);
  await openFolder(second!);
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);

  await editPrompt(editor!, "Saved before the editor closed");
  await expect(editor!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await editor!.close();

  await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await expect(tabBanner(second!)).toHaveCount(0);
  await openMode(second!, "Prompts");
  await expect(promptContent(second!)).toHaveValue("Saved before the editor closed");
  await promptContent(second!).fill("Saved by the promoted tab");
  await expect.poll(() => manifestWriters(directory)).toEqual([editor, second]);
});

test("closing the editor asks an edited tab before it reloads", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await openFolder(editor!);
  await openFolder(second!);
  await editPrompt(second!, "Unsaved in the second tab");
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);

  await editor!.close();
  await expect(tabBanner(second!)).toContainText(
    "The tab that was editing this project closed. Edit here and discard this tab's unsaved changes?",
  );
  await expect(promptContent(second!)).toHaveValue("Unsaved in the second tab");
  await tabBanner(second!).getByRole("button", { name: "Discard and edit here", exact: true }).click();
  await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await expect(promptContent(second!)).toHaveValue(SAVED_PROMPT);
  expect(manifestWriters(directory)).toEqual([]);
});

test("replacing the project releases the editor role", async ({ context }) => {
  await sharedProject(context);
  const [editor, second] = await loadTabs(context, 2);
  await openFolder(editor!);
  await openFolder(second!);
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);

  const other = createProjectFile({
    name: "Other project",
    request: {
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:44014/v1",
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Elsewhere." }],
    },
    idSuffix: "tab-coordination-other",
    createdAt: "2026-10-28T12:02:00.000Z",
  });
  await importProject(editor!, other, "Other project");
  await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
  await expect(tabBanner(second!)).toHaveCount(0);
});

test("a tab asked about the closed editor yields quietly when another tab takes over", async ({ context }) => {
  const directory = await sharedProject(context);
  const [editor, edited, third] = await loadTabs(context, 3);
  await openFolder(editor!);
  await openFolder(edited!);
  await openFolder(third!);
  await editPrompt(edited!, "Kept in the edited tab");

  // The edited tab queued first, so it receives the lock and asks before reloading.
  await editor!.close();
  await expect(tabBanner(edited!)).toContainText("The tab that was editing this project closed.");

  await openMode(third!, "Prompts");
  await tabBanner(third!).getByRole("button", { name: "Edit here", exact: true }).click();
  await expect(third!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);

  await expect(tabBanner(edited!)).toContainText(SECONDARY_TITLE);
  await expect(tabBanner(edited!)).not.toContainText("took over editing before");
  await expect(promptContent(edited!)).toHaveValue("Kept in the edited tab");
  expect(manifestWriters(directory)).toEqual([]);
});


/** Delay folder I/O, keeping the actual Web Locks and adoption path intact. */
async function holdNextManifestRead(page: Page) {
  type ReadGateWindow = Window & {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandleLike>;
    manifestReadWaiting?: boolean;
    releaseManifestRead?(): void;
  };
  await page.evaluate(async () => {
    const state = window as unknown as ReadGateWindow;
    const root = await state.showDirectoryPicker();
    const original = root.getFileHandle.bind(root);
    let held = false;
    root.getFileHandle = async (name, options) => {
      const file = await original(name, options);
      if (name === "project.json" && !held) {
        held = true;
        const read = file.getFile.bind(file);
        file.getFile = async () => {
          state.manifestReadWaiting = true;
          await new Promise<void>((resolve) => { state.releaseManifestRead = resolve; });
          return read();
        };
      }
      return file;
    };
  });
  return {
    async wait() {
      await expect.poll(() => page.evaluate(() => (window as unknown as ReadGateWindow).manifestReadWaiting)).toBe(true);
    },
    async release() {
      await page.evaluate(() => (window as unknown as ReadGateWindow).releaseManifestRead?.());
    },
  };
}

async function editorClient(page: Page) {
  return page.evaluate(async () => (await navigator.locks.query()).held!
    .find((lock) => lock.name!.startsWith("inference-lens:project-editor:"))?.clientId);
}

for (const kind of ["chat", "decision"] as const) {
  test(`promotion preserves another tab's active ${kind} run and its completed trace`, async ({ context }) => {
    const capture = JSON.parse(readFileSync(
      new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8",
    )).request as DecisionInput;
    const document = kind === "chat" ? project() : updateDecisionRequestDraft(project(), {
      decision: { state: capture.state, questions: capture.questions },
      values: {}, branch: false, idSuffix: "tab-decision", createdAt: "2026-10-28T12:00:00.000Z",
    });
    const directory = await sharedProject(context, document);
    const [editor, second] = await loadTabs(context, 2, kind === "decision");
    await openFolder(editor!);
    await openFolder(second!);
    await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);
    let arrived = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api = kind === "chat" ? INFERENCE_API_PATH : DECISIONS_API_PATH;
    await second!.route(`**${api}`, async (route) => {
      arrived = true;
      await gate;
      await route.continue().catch(() => undefined);
    });
    try {
      await openMode(second!, "Compose");
      if (kind === "decision") {
        await second!.getByRole("radio", { name: "Decision", exact: true }).click();
        const model = second!.getByRole("region", { name: "Decision request" }).getByRole("combobox", { name: "Model" });
        await model.fill("all-types");
        await model.press("Escape");
      }
      if (kind === "decision") await second!.getByRole("button", { name: /^Run decision/ }).click();
      else await primaryAction(second!, "compose").click();
      await expect.poll(() => arrived).toBe(true);
      await editor!.close();
      await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
      release();
      await expect.poll(() => directory.writes
        .filter(({ path }) => path.startsWith("traces/"))
        .map(({ contents }) => JSON.parse(contents).status.kind)).toEqual(["completed"]);
      if (kind === "chat") await expect(second!.getByLabel("Run summary")).toContainText("Completed");
      else await expect(second!.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
    } finally {
      release();
    }
  });
}

for (const during of ["handover", "reload", "vacancy reload"] as const) {
  test(`edits during ${during} require fresh discard consent`, async ({ context }) => {
    const directory = await sharedProject(context);
    const [editor, second] = await loadTabs(context, 2);
    if (during === "handover") await muteTabMessages(editor!);
    await openFolder(editor!);
    await openFolder(second!);
    await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);
    await openMode(second!, "Prompts");
    const readGate = during === "handover" ? undefined : await holdNextManifestRead(second!);
    try {
      if (during === "vacancy reload") await editor!.close();
      else await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
      await expect(tabBanner(second!).getByRole("button", { name: "Switching…", exact: true })).toBeVisible();
      await readGate?.wait();
      const typed = `Typed during ${during}`;
      await promptContent(second!).fill(typed);
      await expect(promptContent(second!)).toHaveValue(typed);
      await readGate?.release();
      // Both the broken adoption and a guarded confirmation finish switching;
      // assert on the actual draft before checking the new confirmation UI.
      await expect(tabBanner(second!).getByRole("button", { name: "Switching…", exact: true })).toHaveCount(0);
      await expect(promptContent(second!)).toHaveValue(typed);
      await expect(tabBanner(second!)).toContainText("discard this tab's unsaved changes?");
      expect(manifestWriters(directory)).toEqual([]);
      await tabBanner(second!).getByRole("button", { name: "Not now", exact: true }).click();
      await expect(promptContent(second!)).toHaveValue(typed);
      await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
      await tabBanner(second!).getByRole("button", { name: "Discard and edit here", exact: true }).click();
      await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
      await expect(promptContent(second!)).toHaveValue(SAVED_PROMPT);
    } finally {
      await readGate?.release();
    }
  });
}

test("a reload cannot restore an editor role that moved to a third tab", async ({ context }) => {
  await sharedProject(context);
  const [editor, second, third] = await loadTabs(context, 3);
  for (const tab of [editor!, second!, third!]) await openFolder(tab);
  await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);
  const readGate = await holdNextManifestRead(second!);
  try {
    await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
    await readGate.wait();
    const heldBefore = await editorClient(second!);
    expect(heldBefore).toBeTruthy();
    await tabBanner(third!).getByRole("button", { name: "Edit here", exact: true }).click();
    await expect.poll(() => editorClient(third!)).not.toBe(heldBefore);
    await readGate.release();
    await expect(third!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
    await expect(second!.locator(".brand")).toContainText(SECONDARY_LABEL);
    // Its stale finally must not leave the next takeover stuck on Switching.
    await tabBanner(second!).getByRole("button", { name: "Edit here", exact: true }).click();
    await expect(second!.locator(".brand")).toContainText(`Saved to ${FOLDER}`);
    await expect(third!.locator(".brand")).toContainText(SECONDARY_LABEL);
  } finally {
    await readGate.release();
  }
});
