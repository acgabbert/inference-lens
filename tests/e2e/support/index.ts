/**
 * Shared drivers for the browser suite.
 *
 * These recipes used to live as prose in docs/PROVIDER_FIXTURES.md, which meant
 * every spec retyped them and each copy drifted. They are code here so that a
 * trap fixed once stays fixed. The traps are documented at each helper, because
 * every one of them has silently produced a passing test that proved nothing.
 */
import { expect } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";

import { serializeProjectFile } from "../../../packages/core/src/project";
import type { ProjectFile } from "../../../packages/core/src/project";

export const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
export const STREAMING_STORAGE_KEY = "inference-lens:streaming-preference:v1";
export const PROJECT_PROFILE_MAP_STORAGE_KEY =
  "inference-lens:project-profile-map:v2";
export const PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY =
  "inference-lens:project-profile-map:v3";

/** The buffered fixture provider started by playwright.config.ts. */
export const BUFFERED_FIXTURE_ENDPOINT = "http://127.0.0.1:44014/v1";
/** The Responses API fixture (`scripts/responses-provider.mjs`). */
export const RESPONSES_FIXTURE_ENDPOINT = "http://127.0.0.1:44026/v1";
/** The Anthropic Messages fixture (`scripts/anthropic-provider.mjs`). */
export const ANTHROPIC_FIXTURE_ENDPOINT = "http://127.0.0.1:44027/v1";
/**
 * The System One capture replay (`scripts/system-one-provider.mjs`). Append a
 * runtime and `/v1`: `llamacpp`, `ollama`, `ollama-proxied`, or `openrouter`.
 */
export const SYSTEM_ONE_FIXTURE_ORIGIN = "http://127.0.0.1:44028";

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
  /** The device-local System One declaration (D9-B). */
  systemOne?: true;
}

export interface SeededProfile extends SeedProfileOptions {
  id: string;
  instanceId: string;
}

/** Seeds several profiles without selecting or mapping any project requirement. */
export async function seedProfiles(
  page: Page,
  profiles: readonly SeededProfile[],
  activeProfileId: string,
  streaming: "buffered" | "stream" = "buffered",
): Promise<void> {
  await page.addInitScript(({ profileKey, streamingKey, profiles, activeProfileId, streaming }) => {
    localStorage.setItem(profileKey, JSON.stringify({
      profiles: profiles.map((profile) => ({
        id: profile.id,
        instanceId: profile.instanceId,
        name: profile.name ?? "Buffered fixture",
        provider: "openai-compatible",
        endpoint: profile.endpoint ?? "",
        model: profile.model ?? "buffered-test-model",
        ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
        ...(profile.favoriteModels ? { favoriteModels: profile.favoriteModels } : {}),
        ...(profile.capabilityOverrides ? { capabilityOverrides: profile.capabilityOverrides } : {}),
        ...(profile.systemOne ? { systemOne: true } : {}),
      })),
      activeProfileId,
    }));
    localStorage.setItem(streamingKey, streaming);
  }, { profileKey: PROFILE_STORAGE_KEY, streamingKey: STREAMING_STORAGE_KEY, profiles, activeProfileId, streaming });
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
 *
 * The timeout is a readiness bound, not an assertion about the app. The first
 * pages a cold dev server serves compile client code, which takes 2–4 s on an
 * idle four-core machine and passed the 5 s default under load, failing the
 * first specs of a run before hydration rather than on anything they test.
 */
export async function waitForHydration(
  page: Page,
  profileName = "Buffered fixture",
): Promise<void> {
  await expect(page.locator(".topbar")).toContainText(profileName, { timeout: 30_000 });
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
  mode: "Compose" | "Prompts" | "Evaluations" | "Runs",
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
 * in the topbar — Compose's `Run current conversation` and Evaluations' `Start evaluation…`.
 * Specs ask for it by mode rather than by label so that a spec reads as "the
 * primary action is refused" rather than restating which button that is.
 */
/**
 * Every tool reaches a request through the attached list's one "Attach tool"
 * menu. With a destination, picks it before returning the open menu; without
 * one, leaves the default ("This tab only") untouched. Expects the Tools tab
 * to be open already.
 */
export async function openAttachToolMenu(
  page: Page,
  destination?: "This tab only" | "Project",
): Promise<Locator> {
  await page.getByRole("button", { name: "Attach tool", exact: true }).click();
  const menu = page.getByRole("group", { name: "Attach a tool" });
  if (destination) await menu.getByRole("radio", { name: destination }).check();
  return menu;
}

/** Adds a blank project tool (attached) and returns its project card. */
export async function addProjectTool(page: Page): Promise<Locator> {
  const menu = await openAttachToolMenu(page, "Project");
  await menu.getByRole("button", { name: "New definition" }).click();
  return page.locator(".tool-list > .tool-editor").last();
}

/** The MCP discovery panel is closed until the menu opens it. */
export async function openMcpServers(
  page: Page,
  destination?: "This tab only" | "Project",
): Promise<Locator> {
  const menu = await openAttachToolMenu(page, destination);
  await menu.getByRole("button", { name: "From MCP server…" }).click();
  return page.getByRole("region", { name: "MCP servers" });
}

/** Opens the local library, attaching to the menu's destination. */
export async function openToolLibrary(
  page: Page,
  destination?: "This tab only" | "Project",
): Promise<Locator> {
  const menu = await openAttachToolMenu(page, destination);
  await menu.getByRole("button", { name: "From local library…" }).click();
  return page.getByRole("dialog", { name: "Local tool library" });
}

export function primaryAction(page: Page, mode: "compose" | "evaluations"): Locator {
  return page.getByRole("button", {
    name: mode === "compose" ? /^Run current conversation/ : /^Start evaluation…/,
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
 * Most tests should dismiss it through the UI. This helper remains useful for
 * import drivers that set a hidden file input directly and therefore do not
 * produce the pointer or keyboard event that ordinarily closes the menu.
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
  options?: { replaceDirty: "discard" },
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
  if (options?.replaceDirty === "discard") {
    await page
      .getByRole("dialog", { name: "Save changes before switching projects?" })
      .getByRole("button", { name: "Discard and switch", exact: true })
      .click();
  }
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
  /** Deterministic write failure used to prove save-before-switch safety. */
  writeError?: string;
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
        if (tree.writeError) throw new Error(tree.writeError);
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

export interface SharedProjectDirectory {
  /** Completed writes in commit order, with the page that made each one. */
  readonly writes: ReadonlyArray<{ page: Page; path: string; contents: string }>;
  read(path: string): string | undefined;
}

/**
 * One directory that every page of a browser context sees, for proving how
 * tabs coordinate. `stubProjectDirectory` gives each page its own copy, which
 * cannot show one tab's write reaching another.
 *
 * The files live in the test process behind a binding, so `writes` records
 * which page committed each file. A writable commits on `close`, as the real
 * API does; an abandoned writable leaves the file unchanged.
 */
export async function stubSharedProjectDirectory(
  context: BrowserContext,
  fixture: Omit<ProjectDirectoryFixture, "writeError">,
): Promise<SharedProjectDirectory> {
  const files = new Map(Object.entries(fixture.files).map(([path, contents]) => [path.split("/").filter(Boolean).join("/"), contents]));
  const directories = new Set<string>([""]);
  const parentsOf = (path: string) => {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
  };
  for (const path of files.keys()) parentsOf(path);
  for (const path of fixture.directories ?? []) parentsOf(`${path.split("/").filter(Boolean).join("/")}/`);
  const writes: Array<{ page: Page; path: string; contents: string }> = [];

  await context.exposeBinding(
    "__inferenceLensSharedDirectory",
    ({ page }, operation: string, path: string, contents?: string) => {
      switch (operation) {
        case "kind":
          return files.has(path) ? "file" : directories.has(path) ? "directory" : null;
        case "read":
          return files.get(path) ?? null;
        case "write":
          parentsOf(path);
          files.set(path, contents ?? "");
          if (contents !== undefined) writes.push({ page, path, contents });
          return null;
        case "mkdir":
          parentsOf(`${path}/`);
          return null;
        case "list": {
          const prefix = path ? `${path}/` : "";
          const children = new Map<string, "file" | "directory">();
          for (const candidate of [...files.keys(), ...directories]) {
            if (!candidate.startsWith(prefix) || candidate === path) continue;
            const [name, ...rest] = candidate.slice(prefix.length).split("/");
            if (name) children.set(name, rest.length > 0 || directories.has(prefix + name) ? "directory" : "file");
          }
          return [...children].map(([name, kind]) => ({ name, kind }));
        }
        case "remove":
          files.delete(path);
          for (const candidate of [...files.keys()]) if (candidate.startsWith(`${path}/`)) files.delete(candidate);
          for (const candidate of [...directories]) if (candidate === path || candidate.startsWith(`${path}/`)) directories.delete(candidate);
          return null;
        default:
          throw new Error(`Unknown shared directory operation ${operation}`);
      }
    },
  );

  await context.addInitScript((name) => {
    type Call = (operation: string, path: string, contents?: string) => Promise<unknown>;
    const call = (globalThis as unknown as { __inferenceLensSharedDirectory: Call }).__inferenceLensSharedDirectory;
    const join = (parent: string, child: string) => (parent ? `${parent}/${child}` : child);
    const missing = () => new DOMException("Not found", "NotFoundError");

    class SharedFileHandle {
      readonly kind = "file";
      constructor(readonly name: string, readonly path: string) {}
      async getFile() {
        const contents = await call("read", this.path);
        if (contents === null) throw missing();
        return new File([contents as string], this.name, { type: "application/json" });
      }
      async createWritable() {
        let pending = "";
        return {
          write: async (value: string) => { pending += value; },
          close: async () => { await call("write", this.path, pending); },
        };
      }
    }
    class SharedDirectoryHandle {
      readonly kind = "directory";
      constructor(readonly name: string, readonly path: string) {}
      async queryPermission() { return "granted" as const; }
      async requestPermission() { return "granted" as const; }
      async *values() {
        const children = await call("list", this.path) as Array<{ name: string; kind: string }>;
        for (const child of children) {
          const path = join(this.path, child.name);
          yield child.kind === "file" ? new SharedFileHandle(child.name, path) : new SharedDirectoryHandle(child.name, path);
        }
      }
      async getFileHandle(childName: string, options?: { create?: boolean }) {
        const path = join(this.path, childName);
        const kind = await call("kind", path);
        if (kind === "file") return new SharedFileHandle(childName, path);
        if (kind === null && options?.create) {
          await call("write", path);
          return new SharedFileHandle(childName, path);
        }
        throw missing();
      }
      async getDirectoryHandle(childName: string, options?: { create?: boolean }) {
        const path = join(this.path, childName);
        const kind = await call("kind", path);
        if (kind === "directory") return new SharedDirectoryHandle(childName, path);
        if (kind === null && options?.create) {
          await call("mkdir", path);
          return new SharedDirectoryHandle(childName, path);
        }
        throw missing();
      }
      async removeEntry(childName: string) { await call("remove", join(this.path, childName)); }
    }

    const root = new SharedDirectoryHandle(name, "");
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => root,
    });
  }, fixture.name);

  return { writes, read: (path) => files.get(path) };
}

// Hold the real browser task boundary so loading/cancellation assertions do not
// depend on schema cost or machine speed. Checks and the provider remain real.
export async function holdDerivations(page: Page) {
  await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      scheduler: { yield(): Promise<void> };
      checkGate?: { hold: boolean; waiting: Array<() => void> };
    };
    if (browser.checkGate) { browser.checkGate.hold = true; return; }
    const gate = { hold: true, waiting: [] as Array<() => void> };
    browser.checkGate = gate;
    const original = browser.scheduler.yield.bind(browser.scheduler);
    browser.scheduler.yield = () => gate.hold
      ? new Promise<void>((resolve) => gate.waiting.push(resolve))
      : original();
  });
}

export async function releaseDerivations(page: Page) {
  await page.evaluate(() => {
    const gate = (globalThis as typeof globalThis & {
      checkGate?: { hold: boolean; waiting: Array<() => void> };
    }).checkGate!;
    gate.hold = false;
    gate.waiting.splice(0).forEach((resume) => resume());
  });
}
