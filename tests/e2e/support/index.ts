/**
 * Shared drivers for the browser suite.
 *
 * These recipes used to live as prose in docs/PROVIDER_FIXTURES.md, which meant
 * every spec retyped them and each copy drifted. They are code here so that a
 * trap fixed once stays fixed. The traps are documented at each helper, because
 * every one of them has silently produced a passing test that proved nothing.
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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
