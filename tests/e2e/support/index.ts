/**
 * Shared drivers for the browser suite.
 *
 * These recipes used to live as prose in docs/PROVIDER_FIXTURES.md, which meant
 * every spec retyped them and each copy drifted. They are code here so that a
 * trap fixed once stays fixed. The traps are documented at each helper, because
 * every one of them has silently produced a passing test that proved nothing.
 */
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { serializeProjectFile } from "../../../packages/core/src/project";
import type { ProjectFile } from "../../../packages/core/src/project";

export const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
export const STREAMING_STORAGE_KEY = "inference-lens:streaming-preference:v1";
export const PROJECT_PROFILE_MAP_STORAGE_KEY =
  "inference-lens:project-profile-map:v2";

/** The buffered fixture provider started by playwright.config.ts. */
export const BUFFERED_FIXTURE_ENDPOINT = "http://127.0.0.1:44014/v1";

export interface SeedProfileOptions {
  endpoint?: string;
  model?: string;
  name?: string;
  /** Model ids pinned in the picker's Favorites group. */
  favoriteModels?: string[];
  /** Written to the streaming preference key; "buffered" disables streaming. */
  streaming?: "buffered" | "stream";
  /** Omitted to exercise the provider/model's own sampling default. */
  temperature?: number;
  instanceId?: string;
  /**
   * Capabilities this profile states differently from the openai-compatible
   * baseline. Tool calling is off in that baseline, so a spec that sends tools
   * has to pass `{ tools: true }` — otherwise the request is built without
   * them and the assertion passes against an empty manifest.
   */
  capabilityOverrides?: Record<string, boolean>;
}

/**
 * Seeds a connection profile directly, which is a shortcut through the
 * connection drawer rather than a substitute for testing it. When the drawer
 * itself is what changed, drive the drawer.
 *
 * Credentials are never persisted here and a fixture needs no key.
 */
export async function seedProfile(
  page: Page,
  options: SeedProfileOptions = {},
): Promise<void> {
  const {
    endpoint = BUFFERED_FIXTURE_ENDPOINT,
    model = "buffered-test-model",
    name = "Buffered fixture",
    favoriteModels,
    streaming = "buffered",
    temperature,
    instanceId,
    capabilityOverrides,
  } = options;
  await page.addInitScript(
    (seed) => {
      localStorage.setItem(
        seed.profileKey,
        JSON.stringify({
          profiles: [
            {
              id: "buffered",
              ...(seed.instanceId ? { instanceId: seed.instanceId } : {}),
              name: seed.name,
              provider: "openai-compatible",
              endpoint: seed.endpoint,
              model: seed.model,
              ...(seed.temperature === undefined
                ? {}
                : { temperature: seed.temperature }),
              ...(seed.favoriteModels
                ? { favoriteModels: seed.favoriteModels }
                : {}),
              ...(seed.capabilityOverrides
                ? { capabilityOverrides: seed.capabilityOverrides }
                : {}),
            },
          ],
          activeProfileId: "buffered",
        }),
      );
      localStorage.setItem(seed.streamingKey, seed.streaming);
    },
    {
      profileKey: PROFILE_STORAGE_KEY,
      streamingKey: STREAMING_STORAGE_KEY,
      endpoint,
      model,
      name,
      favoriteModels,
      streaming,
      temperature,
      instanceId,
      capabilityOverrides,
    },
  );
}

/**
 * Waits for React to attach its handlers.
 *
 * This is not politeness. `setInputFiles` and other synthetic events dispatch
 * against the DOM directly, and anything fired before hydration is dropped with
 * no error — the import simply never happens and the app stays on its initial
 * state, which is easy to mistake for a passing test.
 *
 * The seeded profile's name is the signal because it can only come from
 * localStorage, so it cannot be in the server-rendered HTML. Waiting on an
 * element that is server-rendered — the streaming checkbox, say — proves
 * nothing, since it is visible before hydration.
 */
export async function waitForHydration(
  page: Page,
  profileName = "Buffered fixture",
): Promise<void> {
  await expect(page.locator(".topbar")).toContainText(profileName);
}

/**
 * Expands an inference settings panel and returns it.
 *
 * The panel is collapsed by default on every surface that mounts it, so its
 * controls are not in the document at all — not merely hidden. `getByLabel`
 * against a collapsed panel resolves to nothing and the assertion times out
 * with no hint that a disclosure was the reason, so open it explicitly.
 *
 * Idempotent: an already-expanded panel is left alone rather than toggled shut,
 * which is what makes it safe to call before each group of settings assertions.
 */
export async function openInferenceSettings(
  page: Page,
  label = "Run settings",
): Promise<Locator> {
  const panel = page.locator(`[aria-label="${label}"]`);
  const toggle = panel.locator(".inference-settings-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return panel;
}

/**
 * Switches the application mode and waits for the switch to actually take.
 *
 * The modes are top-level destinations, not tabs of a pane: each one owns its
 * own layout and its own primary action, so a spec that wants the evaluation
 * surface has to navigate rather than click a tab in the composer. Asserting on
 * `aria-current` rather than on mode content is deliberate — it separates "the
 * navigation happened" from "the destination rendered what I expected", so a
 * failure in the second does not look like a failure in the first.
 */
export async function openMode(
  page: Page,
  mode: "Compose" | "Evaluations" | "Runs",
): Promise<void> {
  const strip = page.getByRole("navigation", { name: "Application mode" });
  // Not `exact`: the Runs button also carries a "running" label while a batch
  // is in flight, which is exactly when a spec is most likely to navigate.
  const button = strip.getByRole("button", { name: mode });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "page");
}

/**
 * The primary action for the mode on screen. There is exactly one, and it lives
 * in the topbar — Compose's `Run request` and Evaluations' `Start evaluation…`.
 * Specs ask for it by mode rather than by label so that a spec reads as "the
 * primary action is refused" rather than restating which button that is.
 */
export function primaryAction(page: Page, mode: "compose" | "evaluations"): Locator {
  return page.getByRole("button", {
    name: mode === "compose" ? /^Run request/ : /^Start evaluation…/,
  });
}

/**
 * The evaluation preflight chip, with its disclosure opened when it has one.
 *
 * The chip states the first blocker in visible text and holds the rest behind
 * `Details`, so a spec that asserts on a specific issue has to expand it. The
 * summary line is asserted directly — see `preflightSummary` — precisely
 * because it is the part that must never need an expansion.
 */
export async function expandedPreflight(page: Page): Promise<Locator> {
  const preflight = page.locator(".evaluation-preflight");
  await expect(preflight).toBeVisible();
  // Idempotent: `Details` is a toggle, so a spec that expands twice would
  // otherwise shut the disclosure it just opened and assert against a chip
  // holding only its summary.
  const details = preflight.getByRole("button", { name: "Details" });
  if (await details.count() > 0 && (await details.getAttribute("aria-expanded")) === "false") {
    await details.click();
  }
  return preflight;
}

/** The always-visible reason line a disabled primary action points at. */
export function preflightSummary(page: Page): Locator {
  return page.locator("#evaluation-preflight-summary");
}

/**
 * A toast by its title.
 *
 * Two traps live here. The first is that a toast **expires** — six seconds, or
 * twelve when it carries an action — so an assertion placed after several
 * seconds of other work is racing a timer, and the failure reads as "the
 * feature did not fire" rather than "the spec was slow". Assert on the toast as
 * the next thing after the action that publishes it.
 *
 * The second is that touching it **pauses** it: the region freezes every
 * lifetime while it has hover or focus. That is what makes clicking a toast's
 * action safe — but it also means a spec that hovers to inspect a toast has
 * stopped the clock it is about to assert on, so `not.toBeVisible()` after a
 * hover will never come true until the pointer leaves.
 */
export function toast(page: Page, title: string | RegExp): Locator {
  return page
    .getByRole("list", { name: "Notifications" })
    .getByRole("listitem")
    .filter({ hasText: title });
}

/**
 * Closes the Project menu.
 *
 * It is a `<details>`, so Escape does not close it and a second click on the
 * summary toggles it back open. Left open it overlays the request pane and
 * swallows clicks meant for the controls underneath.
 */
export async function closeProjectMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
}

/**
 * Imports a project through the Project menu's hidden file input and waits for
 * it to actually be open.
 *
 * `expectedName` is required on purpose. Waiting on a control that renders with
 * or without a project — `Run target:` is the trap — passes vacuously when the
 * import is dropped, so the spec goes green while testing the no-project path.
 * The project's name in the brand is the signal that it is really loaded.
 */
export async function importProject(
  page: Page,
  project: ProjectFile,
  expectedName: string,
): Promise<void> {
  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "fixture.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(project)),
    },
  );
  await expect(page.locator(".brand")).toContainText(expectedName);
  await closeProjectMenu(page);
}

export interface ProjectDirectoryFixture {
  /** Folder name the picker reports, e.g. "history-demo.inference-lens". */
  name: string;
  /** Slash-separated paths to file contents, e.g. "experiments/plan.json". */
  files: Record<string, string>;
  /** Paths that must exist as empty directories, e.g. "traces". */
  directories?: string[];
}

/**
 * Replaces `showDirectoryPicker` with an in-memory directory.
 *
 * The picker is a native dialog Playwright cannot drive and there is no
 * permission to grant, so project-backed features are otherwise unreachable in
 * a browser. Only the picker is replaced: everything past it, including the
 * workspace adapter, takes handles through the `FileSystemDirectoryHandleLike`
 * and `FileSystemFileHandleLike` shapes in app/project-directory.client.ts, so
 * the real application code runs against these objects.
 *
 * Generate contents with `serializeProjectFile` / `serializeRunTrace` rather
 * than hand-written JSON, so the page validates real artifacts. Including one
 * deliberately damaged file is usually the interesting case: the assertion is
 * that it is disclosed without hiding the good ones.
 */
export async function stubProjectDirectory(
  page: Page,
  fixture: ProjectDirectoryFixture,
): Promise<void> {
  await page.addInitScript((tree) => {
    class MemoryFileHandle {
      readonly kind = "file";
      constructor(
        readonly name: string,
        public contents: string,
      ) {}
      async getFile() {
        return new File([this.contents], this.name, {
          type: "application/json",
        });
      }
      async createWritable() {
        return {
          write: async (value: string) => {
            this.contents = value;
          },
          close: async () => {},
        };
      }
    }
    class MemoryDirectoryHandle {
      readonly kind = "directory";
      readonly entries = new Map<
        string,
        MemoryFileHandle | MemoryDirectoryHandle
      >();
      constructor(readonly name: string) {}
      async queryPermission() {
        return "granted" as const;
      }
      async requestPermission() {
        return "granted" as const;
      }
      async *values() {
        yield* this.entries.values();
      }
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
      async removeEntry(name: string) {
        this.entries.delete(name);
      }
    }

    const root = new MemoryDirectoryHandle(tree.name);
    const directoryAt = (segments: string[]): MemoryDirectoryHandle =>
      segments.reduce((parent, segment) => {
        const existing = parent.entries.get(segment);
        if (existing?.kind === "directory") return existing;
        const created = new MemoryDirectoryHandle(segment);
        parent.entries.set(segment, created);
        return created;
      }, root);

    for (const path of tree.directories ?? []) {
      directoryAt(path.split("/").filter(Boolean));
    }
    for (const [path, contents] of Object.entries(tree.files)) {
      const segments = path.split("/").filter(Boolean);
      const fileName = segments.pop()!;
      directoryAt(segments).entries.set(
        fileName,
        new MemoryFileHandle(fileName, contents),
      );
    }

    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => root,
    });
  }, fixture);
}
