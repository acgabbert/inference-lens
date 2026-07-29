import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFolder,
  downloadProjectFile,
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

test("browser creation removes a partial bundle so creation can be retried", async () => {
  const writes: string[] = [];
  const parent = new MemoryDirectory(
    "code-repository",
    writes,
    new Set(["project.json"]),
  );

  await assert.rejects(
    () =>
      withDirectoryPicker(parent, () =>
        createProjectFolder(project(), {
          name: "Prompt Lab",
          protectFromGit: true,
        }),
      ),
    /Could not write project\.json/,
  );
  assert.equal(parent.entries.has("Prompt Lab.inference-lens"), false);

  const opened = await withDirectoryPicker(parent, () =>
    createProjectFolder(project(), {
      name: "Prompt Lab",
      protectFromGit: true,
    }),
  );
  assert.ok(opened);
});

test("project downloads use the sanitized project name", () => {
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
    value: () => undefined,
  });

  try {
    downloadProjectFile(project());
    assert.equal(link.download, "Prompt Lab.project.json");
    assert.equal(link.clicked, true);
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
