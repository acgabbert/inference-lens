import {
  completeSharedProjectMigration,
  inspectSharedProjectMigrationCompletion,
} from "../../packages/core/src/migration-completion.ts";
import type {
  CandidateAssessment,
  MigrationCompletionOutcome,
  MigrationCompletionStorage,
} from "../../packages/core/src/migration-completion.ts";
import {
  inspectSharedProjectMigration,
  prepareSharedProjectMigration,
  stageSharedProjectMigration,
} from "../../packages/core/src/migration-journal.ts";
import type { MigrationStorage } from "../../packages/core/src/migration-journal.ts";
import type { WorkbenchPromptDraftV1 } from "../../packages/core/src/personal-workbench.ts";
import type { ProjectId } from "../../packages/core/src/run-kernel/types.ts";
import { planSharedProjectMigration } from "../../packages/core/src/shared-project-migration.ts";

/**
 * The migration owner's protocol (I2), apart from React. It is the only caller
 * of migration completion while the gate is on, and runs only in a `personal`
 * session (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6 decisions").
 *
 * Nothing here reopens the project or touches personal records: the owner
 * reports what happened and the workspace reopens the folder.
 */
export interface ProjectMigrationStorage {
  migration: MigrationStorage;
  migrationCompletion: MigrationCompletionStorage;
}

export interface ProjectMigrationPreview {
  projectId: ProjectId;
  /** Names the source bytes; an Upgrade against other bytes is stale. */
  operationId: string;
  sourceVersion: number;
  /** Prompt drafts the file holds, which move to personal records. */
  drafts: { kind: "chat-prompt" | "decision-prompt"; id: string; name: string }[];
  /** An earlier attempt already staged these bytes; Upgrade continues it. */
  staged: boolean;
}

export type ProjectMigrationPreviewOutcome =
  | { kind: "preview"; preview: ProjectMigrationPreview }
  | { kind: "blocked"; message: string };

/** The candidates the upgrade could not restore, for the result notice and 6b. */
export interface UpgradeRecovery {
  pending: CandidateAssessment[];
  stopped?: { destination: string; message: string };
}

export type ProjectUpgradeOutcome =
  /**
   * The manifest is confirmed v19. `activated` names the active records that
   * completion created; `lifted` are the drafts the file held, so the reopened
   * session can tell an unedited carried draft from an edited one (V2).
   */
  | { kind: "upgraded"; activated: string[]; lifted: WorkbenchPromptDraftV1[]; recovery: UpgradeRecovery }
  /** D5, V3: the shared write could not be confirmed, or another writer changed the manifest. */
  | { kind: "inspection"; shared: "diverged" | "uncertain"; message: string; lifted: WorkbenchPromptDraftV1[] }
  /** The file changed since the preview, or since this attempt read it: preview again. */
  | { kind: "stale"; message: string }
  /** Refused or failed before `project.json` changed. */
  | { kind: "failed"; message: string };

const STALE_MESSAGE = "project.json changed since this preview. Review the upgrade again before continuing.";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function previewProjectMigration(storage: ProjectMigrationStorage): Promise<ProjectMigrationPreviewOutcome> {
  try {
    const snapshot = await storage.migration.read();
    if (!snapshot.manifest) return { kind: "blocked", message: "This folder has no project.json to upgrade." };
    const plan = planSharedProjectMigration(snapshot.manifest);
    const prepared = await prepareSharedProjectMigration(snapshot.manifest);
    const inspection = await inspectSharedProjectMigration(snapshot, prepared.projectId, prepared.operationId);
    if (inspection.kind === "foreign-project") {
      return { kind: "blocked", message: "This folder's personal workbench belongs to a different project. Move .workbench/ aside before upgrading." };
    }
    if (inspection.kind === "needs-review" || inspection.kind === "manifest-diverged" || inspection.kind === "shared-written") {
      return { kind: "blocked", message: `An earlier upgrade of this folder needs review before another can start${inspection.message ? `: ${inspection.message}` : "."}` };
    }
    const names = new Map(plan.shared.promptTemplates.map((template) => [template.id, template.name]));
    return {
      kind: "preview",
      preview: {
        projectId: prepared.projectId,
        operationId: prepared.operationId,
        sourceVersion: plan.sourceVersion,
        drafts: plan.drafts.map((draft) => ({ kind: draft.asset.kind, id: draft.asset.id, name: names.get(draft.asset.id) ?? draft.asset.id })),
        staged: inspection.kind === "ready",
      },
    };
  } catch (error) {
    return { kind: "blocked", message: message(error, "Could not read this project for an upgrade.") };
  }
}

function recoveryOf(outcome: Extract<MigrationCompletionOutcome, { kind: "completed" }>): UpgradeRecovery {
  const pending = outcome.personal.candidates.filter((candidate) => candidate.disposition === "pending-draft" || candidate.disposition === "unavailable");
  return {
    pending,
    ...(outcome.personal.stopped ? { stopped: { destination: outcome.personal.stopped.destination, message: outcome.personal.stopped.message } } : {}),
  };
}

function completionOutcome(outcome: MigrationCompletionOutcome, lifted: WorkbenchPromptDraftV1[]): ProjectUpgradeOutcome {
  switch (outcome.kind) {
    case "stale-plan": return { kind: "stale", message: STALE_MESSAGE };
    case "blocked": return { kind: "failed", message: outcome.message };
    case "completed":
      switch (outcome.shared) {
        case "confirmed-shared":
          return { kind: "upgraded", activated: outcome.personal.activated, lifted, recovery: recoveryOf(outcome) };
        case "unchanged-source":
          return { kind: "failed", message: `project.json was not changed${outcome.personal.stopped ? `: ${outcome.personal.stopped.message}` : "."}` };
        case "diverged":
          return { kind: "inspection", shared: "diverged", lifted, message: "project.json changed while it was being upgraded, so the upgrade stopped. Your drafts and the original file are kept in .workbench/migrations/." };
        case "uncertain":
          return { kind: "inspection", shared: "uncertain", lifted, message: "The upgraded project.json could not be confirmed. Your drafts and the original file are kept in .workbench/migrations/." };
      }
  }
}

/**
 * One confirmation stages and completes. Staging is skipped when an earlier
 * attempt already staged these exact bytes.
 */
export async function upgradeProject(storage: ProjectMigrationStorage, preview: Pick<ProjectMigrationPreview, "projectId" | "operationId">): Promise<ProjectUpgradeOutcome> {
  let lifted: WorkbenchPromptDraftV1[];
  try {
    const snapshot = await storage.migration.read();
    if (!snapshot.manifest) return { kind: "stale", message: STALE_MESSAGE };
    const prepared = await prepareSharedProjectMigration(snapshot.manifest);
    if (prepared.projectId !== preview.projectId || prepared.operationId !== preview.operationId) return { kind: "stale", message: STALE_MESSAGE };
    lifted = planSharedProjectMigration(snapshot.manifest).drafts;
    const inspection = await inspectSharedProjectMigration(snapshot, prepared.projectId, prepared.operationId);
    if (inspection.kind !== "ready") {
      const staged = await stageSharedProjectMigration(storage.migration, prepared);
      if (staged.kind === "blocked" && staged.reason === "manifest-diverged") return { kind: "stale", message: STALE_MESSAGE };
      if (staged.kind === "blocked") return { kind: "failed", message: staged.message };
      if (staged.kind === "conflict") return { kind: "failed", message: `${staged.path} changed while the upgrade was being prepared. Nothing in project.json was changed.` };
      if (staged.kind === "failed") return { kind: "failed", message: `Could not prepare the upgrade (${staged.path}): ${staged.message}` };
    }
  } catch (error) {
    return { kind: "failed", message: message(error, "Could not prepare the upgrade.") };
  }
  return completionOutcome(await completeSharedProjectMigration(storage.migrationCompletion, preview.projectId, preview.operationId), lifted);
}

export interface UnfinishedUpgrade {
  operationId: string;
  /** Staged records an interrupted completion has not activated yet. */
  remaining: number;
}

const OPERATION = /^migrations\/(migration_[0-9a-f]{64})\/journal\.json$/;

/**
 * A v19 folder whose manifest is exactly an operation's shared output, with
 * staged records still to activate: an upgrade interrupted after the shared
 * write. Any later shared save diverges the manifest, and the candidates then
 * wait for reconciliation (6b) instead.
 */
export async function findUnfinishedUpgrade(storage: ProjectMigrationStorage, projectId: ProjectId): Promise<UnfinishedUpgrade | undefined> {
  const snapshot = await storage.migrationCompletion.read();
  for (const file of snapshot.files) {
    const operationId = OPERATION.exec(file.path)?.[1];
    if (!operationId) continue;
    const inspection = await inspectSharedProjectMigrationCompletion(snapshot, projectId, operationId);
    if (inspection.kind !== "shared-written") continue;
    const remaining = inspection.candidates.filter((candidate) => candidate.disposition === "activate").length;
    if (remaining) return { operationId, remaining };
  }
  return undefined;
}

/** Activates what an interrupted upgrade left staged; never rewrites the manifest. */
export async function finishUpgrade(storage: ProjectMigrationStorage, projectId: ProjectId, operationId: string): Promise<ProjectUpgradeOutcome> {
  return completionOutcome(await completeSharedProjectMigration(storage.migrationCompletion, projectId, operationId), []);
}
