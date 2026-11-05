import {
  PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
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
 * The manifest boundary (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "In-memory
 * shared document").
 *
 * Owners keep operating on `ProjectFile` (I1). The in-memory document carries
 * no template `draft` and is labeled with the active in-memory version; only
 * this module converts to and from v19. A legacy document is planned in
 * memory, never migrated: its prompt drafts come back as session-only personal
 * seeds (S1, S2).
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
 * The app writes v19 only. The v19 serializer rejects a template draft, so a
 * draft that missed the personal owner is a loud save error rather than
 * personal work leaking into the shared file.
 */
export function serializeProjectManifest(project: ProjectFile): string {
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectValidationError([{ code: "custom", path: ["schemaVersion"], message: "Expected the active in-memory project version." }]);
  }
  return serializeSharedProjectFile({ ...project, schemaVersion: SHARED_PROJECT_SCHEMA_VERSION } as unknown as SharedProjectFileV19);
}
