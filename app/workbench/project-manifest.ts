import {
  declaredProjectSchemaVersion,
  parseProjectJson,
  PROJECT_SCHEMA_VERSION,
  serializeProjectFile,
} from "../../packages/core/src/project.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../../packages/core/src/shared-project-migration.ts";
import type { SharedProjectMigrationPlan } from "../../packages/core/src/shared-project-migration.ts";
import type { WorkbenchPromptDraftV1 } from "../../packages/core/src/personal-workbench.ts";

/**
 * The manifest boundary (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "In-memory
 * shared document" and "In-memory v19 label").
 *
 * Owners hold the shared document, `ProjectFile`, which is v19 in memory as
 * on disk and has no template `draft`. A legacy document is planned in memory,
 * never migrated: its prompt drafts come back as session-only personal seeds
 * (S1, S2).
 */
export type ProjectManifestFormat =
  | { kind: "legacy"; sourceVersion: SharedProjectMigrationPlan["sourceVersion"] }
  | { kind: "shared" };

export interface ProjectManifestRead {
  project: ProjectFile;
  format: ProjectManifestFormat;
  /** Template drafts lifted out of a legacy document; always empty otherwise. */
  personalSeeds: WorkbenchPromptDraftV1[];
}

export const LEGACY_FOLDER_SAVE_BLOCKED_MESSAGE =
  "This project folder uses an older project format. Viewing, running and run history still work, but saving shared changes needs the project upgraded first: choose Upgrade project… in the notice above.";

export function readProjectManifest(contents: string): ProjectManifestRead {
  if (declaredProjectSchemaVersion(contents) === PROJECT_SCHEMA_VERSION) {
    return { project: parseProjectJson(contents), format: { kind: "shared" }, personalSeeds: [] };
  }
  const plan = planSharedProjectMigration(new TextEncoder().encode(contents));
  return {
    project: plan.shared,
    format: { kind: "legacy", sourceVersion: plan.sourceVersion },
    personalSeeds: plan.drafts,
  };
}

/** The app writes v19 only, the same document it holds. */
export function serializeProjectManifest(project: ProjectFile): string {
  return serializeProjectFile(project);
}
