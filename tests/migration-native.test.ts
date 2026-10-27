import assert from "node:assert/strict";
import test from "node:test";
import { nativeMigrationStorage } from "../app/migration-native.client.ts";

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
