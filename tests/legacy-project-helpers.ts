import {
  parseLegacyProjectFile,
  projectFieldOrder,
} from "../packages/core/src/project.ts";
import type {
  ChatPromptTemplateDraft,
  DecisionPromptTemplateDraft,
  ProjectFile,
  ProjectFileV18,
} from "../packages/core/src/project.ts";
import type { PromptTemplateId } from "../packages/core/src/run-kernel/types.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { stableJsonValue } from "../packages/core/src/stable-json.ts";

/**
 * Test-only writers for a pre-v19 project, for the cases about older folders:
 * the upgrade, migration recovery and the CLI's legacy read. The app never
 * writes one; seed every other folder with `serializeProjectFile`, which
 * writes v19 (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "In-memory v19 label",
 * L3).
 */
export type LegacyProject = ProjectFileV18;

/** The same content as a v18 document. */
export function asLegacyProject(project: ProjectFile | LegacyProject): LegacyProject {
  return parseLegacyProjectFile({ ...project, schemaVersion: 18 });
}

/** A v18 `project.json`, with any template drafts it carries. */
export function serializeLegacyProjectFile(project: ProjectFile | LegacyProject): string {
  return `${JSON.stringify(stableJsonValue(asLegacyProject(project), { preferredKeyOrder: projectFieldOrder }), null, 2)}\n`;
}

/** Puts a draft on a template, as a v10–v18 build saved one. */
export function withLegacyPromptDraft(
  project: ProjectFile | LegacyProject,
  templateId: PromptTemplateId,
  draft: ChatPromptTemplateDraft | DecisionPromptTemplateDraft,
): LegacyProject {
  const legacy = asLegacyProject(project);
  if (!legacy.promptTemplates.some(({ id }) => id === templateId)) throw new Error(`No template ${templateId}.`);
  return parseLegacyProjectFile({
    ...legacy,
    promptTemplates: legacy.promptTemplates.map((template) =>
      template.id === templateId ? { ...template, draft: structuredClone(draft) } : template),
  });
}

/**
 * Opens a v10–v18 document the only way the app and the CLI do: through the
 * migration plan, whose shared document is the v19 `ProjectFile`.
 */
export function openLegacyProject(value: unknown): ProjectFile {
  return planSharedProjectMigration(new TextEncoder().encode(JSON.stringify(value))).shared;
}
