"use client";

import type { MigrationCompletionHostResult, MigrationCompletionPlan, MigrationCompletionStorage } from "../packages/core/src/migration-completion.ts";
import type { ProjectId } from "../packages/core/src/run-kernel/types.ts";
import type { MigrationFile, MigrationPayload, MigrationSnapshot, MigrationStageOutcome, MigrationStorage } from "../packages/core/src/migration-journal.ts";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type WireFile = { path: string; bytes: number[] } | { path: string; error: string };
function bytes(value: unknown): Uint8Array {
  if (!Array.isArray(value) || !value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("Invalid native migration byte payload.");
  return new Uint8Array(value);
}
/** Preserve bytes across JSON IPC; no lossy text decoding or implicit native open. */
export function nativeMigrationStorage(workspaceId: string, invoke: Invoke): MigrationStorage {
  return {
    async read(): Promise<MigrationSnapshot> {
      const snapshot = await invoke<{ manifest: number[] | null; files: WireFile[] }>("read_workbench_migration", { workspaceId });
      const files: MigrationFile[] = snapshot.files.map(file => "bytes" in file ? { path: file.path, bytes: bytes(file.bytes) } : file);
      return { manifest: snapshot.manifest === null ? null : bytes(snapshot.manifest), files };
    },
    async stage(projectId, files: MigrationPayload[]): Promise<MigrationStageOutcome> {
      const outcome = await invoke<Exclude<MigrationStageOutcome, { kind: "conflict" }> | { kind: "conflict"; path: string; phase: "before-write" | "read-back"; actualBytes: number[] | null }>("stage_workbench_migration", {
        workspaceId, projectId, files: files.map(file => ({ path: file.path, bytes: Array.from(file.bytes) })),
      });
      return outcome.kind === "conflict" ? { ...outcome, actualBytes: outcome.actualBytes === null ? null : bytes(outcome.actualBytes) } : outcome;
    },
  };
}

const wireBytes = (value: Uint8Array) => Array.from(value);
/**
 * Native completion for one workspace handle. The plan is converted before the
 * first await, so later changes to caller buffers cannot reach the host. The
 * command holds the workspace mutex and invalidates this workspace's saves.
 */
export function nativeMigrationCompletionStorage(workspaceId: string, projectId: ProjectId, invoke: Invoke): MigrationCompletionStorage {
  return {
    read: () => nativeMigrationStorage(workspaceId, invoke).read(),
    execute(plan: MigrationCompletionPlan): Promise<MigrationCompletionHostResult> {
      const wire = {
        projectId: plan.projectId,
        operationId: plan.operationId,
        expected: {
          manifest: plan.expected.manifest === null ? null : wireBytes(plan.expected.manifest),
          files: plan.expected.files.map((file): WireFile => "bytes" in file ? { path: file.path, bytes: wireBytes(file.bytes) } : { path: file.path, error: file.error }),
        },
        source: wireBytes(plan.source),
        shared: wireBytes(plan.shared),
        activations: plan.activations.map(item => ({ candidate: item.candidate, destination: item.destination, bytes: wireBytes(item.bytes) })),
      };
      return invoke<MigrationCompletionHostResult>("complete_workbench_migration", { workspaceId, projectId, plan: wire });
    },
  };
}
