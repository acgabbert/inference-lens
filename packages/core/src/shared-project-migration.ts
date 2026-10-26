import { parseProjectJson, ProjectValidationError } from "./project.ts";
import { parseSharedProjectFile } from "./shared-project.ts";
import type { SharedProjectFileV16 } from "./shared-project.ts";
import { parseWorkbenchRecord } from "./personal-workbench.ts";
import type { WorkbenchPromptDraftV1, WorkbenchSelectionsV1 } from "./personal-workbench.ts";

export interface SharedProjectMigrationPlan {
  sourceVersion: 10 | 11 | 12 | 13 | 14 | 15;
  /** Untouched bytes, copied before decoding or legacy normalization. */
  sourceBytes: Uint8Array;
  shared: SharedProjectFileV16;
  drafts: WorkbenchPromptDraftV1[];
  /** A candidate seed, never an instruction to overwrite existing selections. */
  selections: WorkbenchSelectionsV1;
  preview: {
    promptDraftCount: number;
    messages: string[];
  };
}

/**
 * Pure planning only: no file access, publication, source backup, journal or
 * replacement of an existing workbench. The caller must preserve the source
 * and verify recovery writes before committing the shared candidate.
 */
export function planSharedProjectMigration(sourceBytes: Uint8Array): SharedProjectMigrationPlan {
  const preservedBytes = new Uint8Array(sourceBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(preservedBytes);
  } catch {
    throw new ProjectValidationError([{ code: "custom", path: [], message: "Migration source is not valid UTF-8." }]);
  }
  // The existing strict v10→v15 chain validates before any fields are removed.
  const project = parseProjectJson(text);
  const sourceVersion = (JSON.parse(text) as { schemaVersion: SharedProjectMigrationPlan["sourceVersion"] }).schemaVersion;
  const drafts: WorkbenchPromptDraftV1[] = [];
  const templates = project.promptTemplates.map(template => {
    if (template.draft) {
      const { sourceRevisionId, ...edited } = template.draft;
      const snapshot = template.revisions.find(revision => revision.id === sourceRevisionId);
      // Encode every UTF-16 code unit: stable, injective even for legacy IDs
      // containing path separators or unpaired surrogates. No filesystem path
      // is derived here and no migration-operation identity is being assigned.
      const suffix = template.id.split("").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
      const record = parseWorkbenchRecord({
        schemaVersion: 1,
        kind: "draft",
        projectId: project.projectId,
        draftId: `draft_migrated-${suffix}`,
        asset: { kind: template.kind === "chat" ? "chat-prompt" : "decision-prompt", id: template.id },
        base: { revisionId: sourceRevisionId, snapshot },
        edited,
      }, project.projectId);
      if (record.kind !== "draft") throw new Error("Expected a migration draft record.");
      drafts.push(record);
    }
    const sharedTemplate = { ...template };
    delete sharedTemplate.draft;
    return sharedTemplate;
  });
  const shared = parseSharedProjectFile({ ...project, schemaVersion: 16, promptTemplates: templates });
  const { defaults } = project;
  const selections = parseWorkbenchRecord({
    schemaVersion: 1,
    kind: "selections",
    projectId: project.projectId,
    chat: {
      selectedInput: { kind: "saved-conversation-revision", revisionId: defaults.conversationRevisionId },
      execution: { target: defaults.target, options: defaults.options, enabledToolIds: defaults.enabledToolIds },
    },
    ...(defaults.decisionRequestRevisionId === undefined ? {} : {
      decision: { selectedInput: { kind: "saved-decision-request-revision", revisionId: defaults.decisionRequestRevisionId } },
    }),
  }, project.projectId);
  if (selections.kind !== "selections") throw new Error("Expected migration selections.");
  return {
    sourceVersion,
    sourceBytes: preservedBytes,
    shared,
    drafts,
    selections,
    preview: {
      promptDraftCount: drafts.length,
      messages: [
        ...(drafts.length === 0 ? [] : [
          `Move ${drafts.length} prompt ${drafts.length === 1 ? "draft" : "drafts"} into this folder's personal workbench.`,
        ]),
        "Keep all saved requests, branches, values, fixtures, imports and suites shared.",
        "Keep existing launch defaults shared and copy them into your personal selections. This migration does not make previously saved content private.",
        "This is an in-memory plan. Before changing project.json, preserve the original bytes and verify all personal records under the protected .workbench directory. Existing personal records require reconciliation, not replacement.",
        "Suite, tool and mock editing, incomplete editor buffers and personal backups are not separated by this core slice.",
      ],
    },
  };
}
