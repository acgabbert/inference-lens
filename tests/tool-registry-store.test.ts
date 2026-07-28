import assert from "node:assert/strict";
import test from "node:test";

import {
  FileToolRegistryStore,
  resolveReplaceToolRegistryRequest,
} from "../services/api/src/tool-registry-store.ts";
import { ToolRegistryConflictError, ToolRegistryValidationError, createRegistryTool } from "../packages/core/src/tool-registry.ts";

class MemoryFilesystem {
  readonly files = new Map<string, string>();
  failWrite = false;
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    }
    return value;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    if (this.failWrite) throw new Error("write failed");
    this.files.set(path, contents);
  }
  async rename(from: string, to: string): Promise<void> {
    const contents = await this.readFile(from);
    this.files.set(to, contents);
    this.files.delete(from);
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }
}

const registry = {
  schemaVersion: 1 as const,
  tools: [createRegistryTool("registry-tool_search", "2026-07-24T12:00:00.000Z", 0)],
};

test("file registry is strict, atomically CAS-replaced, and recovers its mutex", async () => {
  const filesystem = new MemoryFilesystem();
  const store = new FileToolRegistryStore("/data", filesystem);
  assert.deepEqual(await store.load(), { registry: { schemaVersion: 1, tools: [] }, revision: null });
  const saved = await store.replace(registry, null);
  assert.match(saved.revision ?? "", /^[a-f0-9]{64}$/);
  await assert.rejects(() => store.replace(registry, null), ToolRegistryConflictError);
  filesystem.failWrite = true;
  await assert.rejects(() => store.replace(registry, saved.revision), /write failed/);
  filesystem.failWrite = false;
  assert.equal((await store.replace(registry, saved.revision)).registry.tools[0]?.id, "registry-tool_search");
  assert.equal([...filesystem.files.keys()].some((path) => path.endsWith(".tmp")), false);
});

test("concurrent replaces allow exactly one writer and envelope parsing is strict", async () => {
  const filesystem = new MemoryFilesystem();
  const store = new FileToolRegistryStore("/data", filesystem);
  const one = store.replace(registry, null);
  const two = store.replace(registry, null);
  const settled = await Promise.allSettled([one, two]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.throws(() => resolveReplaceToolRegistryRequest({ registry }), ToolRegistryValidationError);
  assert.deepEqual(resolveReplaceToolRegistryRequest({ registry, expectedRevision: null }), { registry, expectedRevision: null });
});
