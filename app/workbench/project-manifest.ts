import {
  parseProjectJson,
  PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
  serializeProjectFile,
} from "../../packages/core/src/project.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import {
  declaredProjectSchemaVersion,
  parseSharedProjectJson,
  SHARED_PROJECT_SCHEMA_VERSION,
  serializeSharedProjectFile,
  sharedProjectAsActive,
} from "../../packages/core/src/shared-project.ts";
import type { SharedProjectFileV19 } from "../../packages/core/src/shared-project.ts";
import { planSharedProjectMigration } from "../../packages/core/src/shared-project-migration.ts";
import type { SharedProjectMigrationPlan } from "../../packages/core/src/shared-project-migration.ts";
import type { WorkbenchPromptDraftV1 } from "../../packages/core/src/personal-workbench.ts";

/**
 * The manifest boundary for both session modes
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "In-memory shared document").
 *
 * Owners keep operating on `ProjectFile` (I1). In a `personal` session the
 * in-memory document carries no template `draft` and is labeled with the active
 * version; only this module converts to and from v19. A legacy document opened
 * in a `personal` session is planned in memory, never migrated: its prompt
 * drafts come back as session-only personal seeds (S1, S2).
 */
export type ProjectSessionMode = "legacy" | "personal";

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

export function readProjectManifest(contents: string, mode: ProjectSessionMode): ProjectManifestRead {
  if (mode === "legacy") {
    const project = parseProjectJson(contents);
    // parseProjectJson accepted it, so the declared version is one it opens.
    const sourceVersion = declaredProjectSchemaVersion(contents) as SharedProjectMigrationPlan["sourceVersion"];
    return { project, format: { kind: "legacy", sourceVersion }, personalSeeds: [] };
  }
  if (declaredProjectSchemaVersion(contents) === SHARED_PROJECT_SCHEMA_VERSION) {
    return { project: sharedProjectAsActive(parseSharedProjectJson(contents)), format: { kind: "shared" }, personalSeeds: [] };
  }
  const plan = planSharedProjectMigration(new TextEncoder().encode(contents));
  return {
    project: sharedProjectAsActive(plan.shared),
    format: { kind: "legacy", sourceVersion: plan.sourceVersion },
    personalSeeds: plan.drafts,
  };
}

/**
 * A `personal` session writes v19 only. The v19 serializer rejects a template
 * draft, so a draft that missed the personal owner is a loud save error rather
 * than personal work leaking into the shared file.
 */
export function serializeProjectManifest(project: ProjectFile, mode: ProjectSessionMode): string {
  if (mode === "legacy") return serializeProjectFile(project);
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectValidationError([{ code: "custom", path: ["schemaVersion"], message: "Expected the active in-memory project version." }]);
  }
  return serializeSharedProjectFile({ ...project, schemaVersion: SHARED_PROJECT_SCHEMA_VERSION } as unknown as SharedProjectFileV19);
}
