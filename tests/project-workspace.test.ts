import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFolder,
} from "../app/project-workspace.client.ts";
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from "../app/project-directory.client.ts";
import {
  createProjectFile,
  parseProjectJson,
} from "../packages/core/src/project.ts";

class MemoryFile implements FileSystemFileHandleLike {
  readonly kind = "file";
  readonly name: string;
  contents = "";
  private readonly writes: string[];

  constructor(name: string, writes: string[]) {
    this.name = name;
    this.writes = writes;
  }

  async getFile(): Promise<File> {
    return { text: async () => this.contents } as File;
  }

  async createWritable() {
    return {
      write: async (data: string) => {
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

  constructor(name: string, writes: string[]) {
    this.name = name;
    this.writes = writes;
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
    const created = new MemoryFile(name, this.writes);
    this.entries.set(name, created);
    return created;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !options?.create) {
      throw new DOMException("missing", "NotFoundError");
    }
    const created = new MemoryDirectory(name, this.writes);
    this.entries.set(name, created);
    return created;
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
      protectFromGit: true,
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
      protectFromGit: false,
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
          protectFromGit: true,
        }),
      ),
    /already exists/,
  );
  assert.deepEqual(writes, []);
});
