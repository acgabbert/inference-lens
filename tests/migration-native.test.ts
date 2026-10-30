import assert from "node:assert/strict";
import test from "node:test";
import { nativeMigrationCompletionStorage, nativeMigrationStorage } from "../app/migration-native.client.ts";
import type { MigrationCompletionPlan } from "../packages/core/src/migration-completion.ts";

test("native bridge retains raw bytes, workspace association and structured conflict bytes", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const original = [239, 187, 191, 123, 125, 13, 10, 0, 255];
  const adapter = nativeMigrationStorage("workspace_bytes", async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return (command === "read_workbench_migration" ? { manifest: original, files: [{ path: "backup", bytes: original }, { path: "unavailable", error: "failure" }] } : { kind: "conflict", path: "backup", phase: "read-back", actualBytes: original }) as T;
  });
  assert.equal(calls.length, 0);
  const snapshot = await adapter.read();
  assert.deepEqual(snapshot.manifest, new Uint8Array(original));
  assert.deepEqual(snapshot.files, [{ path: "backup", bytes: new Uint8Array(original) }, { path: "unavailable", error: "failure" }]);
  const result = await adapter.stage("project_bytes", [{ path: "backup", bytes: new Uint8Array(original) }]);
  assert.equal(result.kind, "conflict");
  if (result.kind === "conflict") assert.deepEqual(result.actualBytes, new Uint8Array(original));
  assert.deepEqual(calls, [
    { command: "read_workbench_migration", args: { workspaceId: "workspace_bytes" } },
    { command: "stage_workbench_migration", args: { workspaceId: "workspace_bytes", projectId: "project_bytes", files: [{ path: "backup", bytes: original }] } },
  ]);
});
test("native byte arrays reject invalid numbers instead of wrapping or truncating", async () => {
  for (const value of [[-1], [256], [1.5], [null], ["1"], "text"]) {
    const adapter = nativeMigrationStorage("workspace", async <T>(): Promise<T> => ({ manifest: value, files: [] }) as T);
    await assert.rejects(adapter.read(), /Invalid native migration byte payload/);
  }
});
test("native completion sends the frozen plan as byte arrays, bound to its workspace and project", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const result = { kind: "executed", manifest: "written", activated: ["selections.json"] };
  const adapter = nativeMigrationCompletionStorage("workspace_bytes", "project_bytes", async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args: structuredClone(args) });
    return result as T;
  });
  assert.equal(calls.length, 0, "construction performs no IPC");
  const original = [239, 187, 191, 0, 255];
  const manifest = new Uint8Array(original);
  const plan: MigrationCompletionPlan = {
    projectId: "project_bytes",
    operationId: "migration_op",
    expected: { manifest, files: [{ path: "selections.json", bytes: new Uint8Array([255]) }, { path: "drafts/draft_x.json", error: "unreadable" }] },
    source: manifest,
    shared: new Uint8Array([123, 125, 10]),
    activations: [{ candidate: "candidates/selections.json", destination: "selections.json", bytes: new Uint8Array([13, 10]) }],
  };
  const pending = adapter.execute(plan);
  // The caller's buffers may change after the call; the payload was captured synchronously.
  manifest.fill(0);
  assert.deepEqual(await pending, result);
  assert.deepEqual(calls, [{
    command: "complete_workbench_migration",
    args: {
      workspaceId: "workspace_bytes",
      projectId: "project_bytes",
      plan: {
        projectId: "project_bytes",
        operationId: "migration_op",
        expected: { manifest: original, files: [{ path: "selections.json", bytes: [255] }, { path: "drafts/draft_x.json", error: "unreadable" }] },
        source: original,
        shared: [123, 125, 10],
        activations: [{ candidate: "candidates/selections.json", destination: "selections.json", bytes: [13, 10] }],
      },
    },
  }]);
  await adapter.read().catch(() => {});
  assert.equal(calls.at(-1)?.command, "read_workbench_migration");
});
