import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createProjectFolder,
  downloadProjectFile,
  listExperimentArtifactsWorkspace,
  openProjectFolder,
  readExperimentArtifactWorkspace,
  saveExperimentPlanWorkspace,
  saveProjectWorkspace,
  savedRunReferenceForWorkspace,
} from "../app/project-workspace.client.ts";
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from "../app/project-directory.client.ts";
import {
  createProjectFile,
  parseProjectJson,
  serializeProjectFile,
} from "../packages/core/src/project.ts";
import { createResolvedRunInput } from "../packages/core/src/run-kernel/run-execution.ts";
import { WORKBENCH_GITIGNORE_CONTENTS } from "../packages/core/src/personal-workbench.ts";
import { openWorkbenchStore } from "../packages/core/src/workbench-store.ts";
import { coordinateProjectWrites } from "../app/workbench-directory.client.ts";
import type { RepeatedExperimentPlanV3 } from "../packages/core/src/experiment.ts";

class MemoryFile implements FileSystemFileHandleLike {
  readonly kind = "file";
  readonly name: string;
  contents = "";
  private readonly writes: string[];
  private readonly failingWrites: Set<string>;

  constructor(name: string, writes: string[], failingWrites: Set<string>) {
    this.name = name;
    this.writes = writes;
    this.failingWrites = failingWrites;
  }

  async getFile(): Promise<File> {
    return { text: async () => this.contents } as File;
  }

  async createWritable() {
    return {
      write: async (data: string) => {
        if (this.failingWrites.delete(this.name)) {
          throw new Error(`Could not write ${this.name}`);
        }
        this.writes.push(this.name);
        this.contents = data;
      },
      close: async () => {},
    };
  }
}

class MemoryDirectory implements FileSystemDirectoryHandleLike {
  readonly kind = "directory";
  readonly name: string;
  readonly entries = new Map<string, MemoryFile | MemoryDirectory>();
  private readonly writes: string[];
  private readonly failingWrites: Set<string>;

  constructor(
    name: string,
    writes: string[],
    failingWrites = new Set<string>(),
  ) {
    this.name = name;
    this.writes = writes;
    this.failingWrites = failingWrites;
  }

  async *values() {
    yield* this.entries.values();
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing?.kind === "file") return existing;
    if (existing || !options?.create) {
      throw new DOMException("missing", "NotFoundError");
    }
    const created = new MemoryFile(name, this.writes, this.failingWrites);
    this.entries.set(name, created);
    return created;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !options?.create) {
      throw new DOMException("missing", "NotFoundError");
    }
    const created = new MemoryDirectory(
      name,
      this.writes,
      this.failingWrites,
    );
    this.entries.set(name, created);
    return created;
  }

  async removeEntry(name: string) {
    if (!this.entries.delete(name)) {
      throw new DOMException("missing", "NotFoundError");
    }
  }
}

function project() {
  return createProjectFile({
    name: "Prompt Lab",
    idSuffix: "workspace-test",
    createdAt: "2026-07-29T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Keep this authored prompt private." }],
    },
  });
}

test("Copy link waits for the manifest write scope before reading project.json", async () => {
  const directory = new MemoryDirectory("copy-link", []);
  const manifest = await directory.getFileHandle("project.json", { create: true });
  manifest.contents = serializeProjectFile(project());
  const opened = await withDirectoryPicker(directory, () => openProjectFolder());
  assert.ok(opened);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const write = coordinateProjectWrites(project().projectId, async () => { entered(); await gate; });
  await started;
  let reads = 0;
  const original = manifest.getFile.bind(manifest);
  manifest.getFile = async () => { reads++; return original(); };
  // No trace is needed: the regression concerns when the manifest is read.
  const copy = savedRunReferenceForWorkspace(opened.handle, "run_missing").catch(() => undefined);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reads, 0, "manifest reads must wait while the write scope is held");
  } finally { release(); await write; await copy; }
  assert.equal(reads, 1);
});

function experimentPlan(): RepeatedExperimentPlanV3 {
  const input = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Repeat this request" }],
    },
    {
      conversationId: "conversation_workspace-experiment",
      conversationRevisionId: "revision_workspace-experiment",
    },
    [],
    [],
    "workspace-experiment-source",
    "2026-07-30T12:00:00.000Z",
  );
  const { runId: sourceRunId, ...commonInput } = input;
  assert.equal(sourceRunId, "run_workspace-experiment-source");
  return {
    schemaVersion: 7,
    experimentId: "experiment_workspace",
    kind: "repeated-request",
    createdAt: "2026-07-30T12:00:01.000Z",
    commonInput,
    cells: [
      { cellId: "experiment-cell_one", ordinal: 1, runId: "run_workspace-one" },
      { cellId: "experiment-cell_two", ordinal: 2, runId: "run_workspace-two" },
    ],
  };
}

async function withDirectoryPicker<T>(
  directory: MemoryDirectory,
  run: () => Promise<T>,
): Promise<T> {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { showDirectoryPicker: async () => directory },
  });
  try {
    return await run();
  } finally {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  }
}

test("browser creation writes Git protection before authored project data", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory("code-repository", writes);
  const opened = await withDirectoryPicker(parent, () =>
    createProjectFolder(project(), {
      name: "Prompt Lab",
      gitPolicy: "private",
    }),
  );

  assert.ok(opened);
  assert.equal(opened.handle.displayName, "Prompt Lab.inference-lens");
  const bundle = parent.entries.get("Prompt Lab.inference-lens");
  assert.equal(bundle?.kind, "directory");
  assert.deepEqual(writes, [".gitignore", "project.json"]);
  const ignoreFile = (bundle as MemoryDirectory).entries.get(".gitignore");
  assert.ok(ignoreFile instanceof MemoryFile);
  assert.equal(ignoreFile.contents, "*\n");
  const manifest = (bundle as MemoryDirectory).entries.get("project.json");
  assert.ok(manifest instanceof MemoryFile);
  assert.equal(parseProjectJson(manifest.contents).name, "Prompt Lab");
});

test("browser creation can deliberately leave a project visible to Git", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory("code-repository", writes);
  await withDirectoryPicker(parent, () =>
    createProjectFolder(project(), {
      name: "Shared Project",
      gitPolicy: "unmanaged",
    }),
  );

  const bundle = parent.entries.get("Shared Project.inference-lens");
  assert.equal(bundle?.kind, "directory");
  assert.deepEqual(writes, ["project.json"]);
  assert.equal(
    (bundle as MemoryDirectory).entries.has(".gitignore"),
    false,
  );
});

test("sharing definitions writes the exact allowlist before the manifest and preserves custom rules on save", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory("code-repository", writes);
  const opened = await withDirectoryPicker(parent, () =>
    createProjectFolder(project(), { name: "Prompt Lab", gitPolicy: "definitions" }),
  );
  assert.ok(opened);
  const bundle = parent.entries.get("Prompt Lab.inference-lens") as MemoryDirectory;
  const ignore = bundle.entries.get(".gitignore") as MemoryFile | undefined;
  assert.equal(ignore?.contents ?? null, "*\n!/.gitignore\n!/project.json\n");
  assert.deepEqual(writes, [".gitignore", "project.json"]);
  ignore!.contents = "# My custom policy\ntraces/\n";
  await saveProjectWorkspace(opened.handle, { ...project(), name: "Renamed" });
  assert.equal(ignore!.contents, "# My custom policy\ntraces/\n");
  assert.deepEqual(writes, [".gitignore", "project.json", "project.json"]);
});

test("definitions policy stages only definitions, excludes future nested files, and leaves tracked evidence alone", async () => {
  const parent = new MemoryDirectory("repository", []);
  await withDirectoryPicker(parent, () =>
    createProjectFolder(project(), { name: "Prompt Lab", gitPolicy: "definitions" }),
  );
  const bundle = parent.entries.get("Prompt Lab.inference-lens") as MemoryDirectory;
  const ignore = bundle.entries.get(".gitignore") as MemoryFile | undefined;
  assert.equal(ignore?.contents ?? null, "*\n!/.gitignore\n!/project.json\n");
  const repository = mkdtempSync(join(tmpdir(), "inference-lens-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  try {
    git("init", "--quiet");
    const directory = join(repository, bundle.name);
    mkdirSync(directory);
    for (const [name, entry] of bundle.entries) {
      if (entry.kind === "file") writeFileSync(join(directory, name), entry.contents);
    }
    const evidencePaths = [
      "traces/run_one.json",
      "experiments/experiment_one.plan.json",
      "experiments/experiment_one.result.json",
      "experiments/experiment_one.assessment_one.assessment.json",
      "evaluation-baselines.json",
      "evaluation-case-sources.json",
      "future/artifacts/nested/evidence.json",
      "future/project.json",
      "future/.gitignore",
      ".workbench/recovery.json",
    ];
    for (const path of evidencePaths) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), "{}\n");
    }
    git("add", ".");
    assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n"), [
      "Prompt Lab.inference-lens/.gitignore",
      "Prompt Lab.inference-lens/project.json",
    ]);
    // Ignore rules do not untrack existing evidence or prevent force-adding it.
    git("add", "--force", "Prompt Lab.inference-lens/traces/run_one.json");
    git("add", ".");
    assert.match(git("ls-files"), /traces\/run_one\.json/);
    assert.equal(readFileSync(join(directory, "traces/run_one.json"), "utf8"), "{}\n");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the workbench self-ignore protects records and legacy backups without a bundle ignore policy", () => {
  const repository = mkdtempSync(join(tmpdir(), "inference-lens-workbench-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  try {
    git("init", "--quiet");
    const directory = join(repository, "Prompt Lab.inference-lens");
    const workbench = join(directory, ".workbench");
    mkdirSync(workbench, { recursive: true });
    assert.equal(WORKBENCH_GITIGNORE_CONTENTS, "*\n");
    writeFileSync(join(workbench, ".gitignore"), WORKBENCH_GITIGNORE_CONTENTS);
    writeFileSync(join(directory, "project.json"), "{}\n");
    const paths = ["selections.json", "drafts/draft_one.json", "scratch/request_one.json", "migrations/one/journal.json", "migrations/one/source.project.json"];
    for (const path of paths) {
      mkdirSync(dirname(join(workbench, path)), { recursive: true });
      writeFileSync(join(workbench, path), "{}\n");
    }
    git("add", ".");
    assert.equal(git("ls-files").trim(), "Prompt Lab.inference-lens/project.json");
    for (const path of [".gitignore", ...paths]) {
      assert.equal(git("check-ignore", `Prompt Lab.inference-lens/.workbench/${path}`).trim(), `Prompt Lab.inference-lens/.workbench/${path}`);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("native creation receives the core-generated policy for all three presets", async () => {
  const originalWindow = globalThis.window;
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        return null; // A cancelled native picker performs no filesystem writes.
      },
    } },
  });
  try {
    for (const gitPolicy of ["private", "definitions", "unmanaged"] as const) {
      await createProjectFolder(project(), { name: "Prompt Lab", gitPolicy });
    }
    assert.deepEqual(calls.map(({ args }) => args.gitignoreContents), [
      "*\n", "*\n!/.gitignore\n!/project.json\n", null,
    ]);
    assert.ok(calls.every(({ command }) => command === "create_project_workspace"));
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("browser workspace handles expose opt-in recovery and reopening retains the stored selection", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory("repository", writes);
  const created = await withDirectoryPicker(parent, () => createProjectFolder(project(), { name: "Prompt Lab", gitPolicy: "unmanaged" }));
  assert.ok(created);
  const bundle = await parent.getDirectoryHandle("Prompt Lab.inference-lens");
  assert.equal(bundle.entries.has(".workbench"), false);
  const originalManifest = (await (await bundle.getFileHandle("project.json")).getFile()).text();
  const store = await openWorkbenchStore(created.handle.storage.workbench, created.project.projectId);
  assert.equal(bundle.entries.has(".workbench"), false);
  const selection = { schemaVersion: 1, kind: "selections", projectId: created.project.projectId } as const;
  assert.equal((await store.save(selection)).kind, "saved");
  const reopened = await withDirectoryPicker(bundle, () => openProjectFolder());
  assert.ok(reopened);
  const recovered = await openWorkbenchStore(reopened.handle.storage.workbench, reopened.project.projectId);
  assert.deepEqual(recovered.records.map(item => item.record), [selection]);
  assert.equal(await (await (await bundle.getFileHandle("project.json")).getFile()).text(), await originalManifest);
});

test("native recovery bridge passes workspace identity, expected contents and structured conflicts", async () => {
  const originalWindow = globalThis.window;
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const actualContents = "an external edit";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "open_project_workspace") return { workspaceId: "workspace_native-recovery", displayName: "Native", displayPath: "/Native", contents: serializeProjectFile(project()) };
        if (command === "list_workbench_records") return [];
        if (command === "mutate_workbench_record") return { kind: "conflict", phase: "before-write", actualContents };
        throw new Error(`Unexpected command ${command}`);
      },
    } },
  });
  try {
    const opened = await openProjectFolder();
    assert.ok(opened);
    assert.deepEqual(calls.map(call => call.command), ["open_project_workspace"]);
    const store = await openWorkbenchStore(opened.handle.storage.workbench, opened.project.projectId);
    const record = { schemaVersion: 1, kind: "selections", projectId: opened.project.projectId } as const;
    const result = await store.save(record);
    assert.equal(result.kind, "conflict");
    if (result.kind === "conflict") assert.equal(result.actualContents, actualContents);
    assert.deepEqual(calls[1], { command: "list_workbench_records", args: { workspaceId: "workspace_native-recovery" } });
    assert.equal(calls[2].args?.workspaceId, "workspace_native-recovery");
    assert.equal(calls[2].args?.projectId, opened.project.projectId);
    assert.equal(calls[2].args?.path, "selections.json");
    assert.equal(calls[2].args?.expectedContents, null);
    assert.equal(typeof calls[2].args?.contents, "string");
    assert.equal((await store.save(record)).kind, "blocked");
    assert.equal(calls.length, 3);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("opening a Project v6 workspace refuses the unsupported artifact without rewriting it", async () => {
  const writes: string[] = [];
  const directory = new MemoryDirectory("Legacy.inference-lens", writes);
  const current = project();
  const { evaluationSuites, ...version7WithoutSuites } = current;
  assert.deepEqual(evaluationSuites, []);
  const originalContents = `${JSON.stringify({
    ...version7WithoutSuites,
    schemaVersion: 6,
  })}\n`;
  const manifest = new MemoryFile("project.json", writes, new Set());
  manifest.contents = originalContents;
  directory.entries.set("project.json", manifest);

  await assert.rejects(() => withDirectoryPicker(directory, () => openProjectFolder()), /schema v6 is not supported/);
  assert.equal(manifest.contents, originalContents);
  assert.deepEqual(writes, []);
});

test("browser creation refuses to reuse an existing bundle", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory("code-repository", writes);
  await parent.getDirectoryHandle("Prompt Lab.inference-lens", {
    create: true,
  });

  await assert.rejects(
    () =>
      withDirectoryPicker(parent, () =>
        createProjectFolder(project(), {
          name: "Prompt Lab",
          gitPolicy: "private",
        }),
      ),
    /already exists/,
  );
  assert.deepEqual(writes, []);
});

for (const gitPolicy of ["private", "definitions", "unmanaged"] as const) {
  for (const failingFile of gitPolicy === "unmanaged" ? ["project.json"] : [".gitignore", "project.json"]) {
    test(`browser ${gitPolicy} creation rolls back a failed ${failingFile} write so it can be retried`, async () => {
      const writes: string[] = [];
      const parent = new MemoryDirectory(
        "code-repository",
        writes,
        new Set([failingFile]),
      );

      await assert.rejects(
        () =>
          withDirectoryPicker(parent, () =>
            createProjectFolder(project(), {
              name: "Prompt Lab",
              gitPolicy,
            }),
          ),
        (error: unknown) => error instanceof Error && error.message === `Could not write ${failingFile}`,
      );
      assert.equal(parent.entries.has("Prompt Lab.inference-lens"), false);

      const opened = await withDirectoryPicker(parent, () =>
        createProjectFolder(project(), {
          name: "Prompt Lab",
          gitPolicy,
        }),
      );
      assert.ok(opened);
    });
  }
}

test("browser workspaces save experiment artifacts once and list them separately from traces", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory("code-repository", writes);
  const opened = await withDirectoryPicker(parent, () =>
    createProjectFolder(project(), { name: "Prompt Lab", gitPolicy: "unmanaged" }),
  );
  assert.ok(opened);
  const plan = experimentPlan();

  await saveExperimentPlanWorkspace(opened.handle, plan);
  await saveExperimentPlanWorkspace(opened.handle, plan);
  assert.deepEqual(await listExperimentArtifactsWorkspace(opened.handle), [
    {
      fileName: "experiment_workspace.plan.json",
      contents: await readExperimentArtifactWorkspace(
        opened.handle,
        "experiment_workspace.plan.json",
      ),
    },
  ]);

  const changed = { ...plan, createdAt: "2026-07-30T12:00:02.000Z" };
  await assert.rejects(
    () => saveExperimentPlanWorkspace(opened.handle, changed),
    /immutable/,
  );
});

test("project downloads use the sanitized name and defer URL revocation", async () => {
  const originalDocument = globalThis.document;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const link = {
    href: "",
    download: "",
    clicked: false,
    click() {
      this.clicked = true;
    },
  };
  const revoked: string[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => link },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:project",
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });

  try {
    downloadProjectFile(project());
    assert.equal(link.download, "Prompt Lab.project.json");
    assert.equal(link.clicked, true);
    assert.deepEqual(revoked, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(revoked, ["blob:project"]);
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  }
});
