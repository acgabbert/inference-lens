import { z } from "zod";
import { isSensitiveTemplateVariableName, projectContentSchemas } from "./project.ts";
import { discoverDecisionVariables } from "./decision-variables.ts";
import type { ProjectId } from "./run-kernel/types.ts";
import { stableJsonValue } from "./stable-json.ts";

export const WORKBENCH_SCHEMA_VERSION = 1;
export const WORKBENCH_GITIGNORE_CONTENTS = "*\n";

const { entityId, chatPromptRevision, chatPromptDraft, decisionPromptRevision,
  decisionPromptDraft, inferenceOptions, executionTarget } = projectContentSchemas;
const envelope = {
  schemaVersion: z.literal(WORKBENCH_SCHEMA_VERSION),
  projectId: entityId("project"),
};
const draftEnvelope = {
  ...envelope,
  draftId: z.string().regex(/^draft_[A-Za-z0-9_-]+$/),
};
const promptDraftSchema = z.union([
  z.object({
    ...draftEnvelope,
    asset: z.object({ kind: z.literal("chat-prompt"), id: entityId("template") }).strict(),
    base: z.object({ revisionId: entityId("template-revision"), snapshot: chatPromptRevision }).strict(),
    edited: chatPromptDraft.omit({ sourceRevisionId: true }),
  }).strict(),
  z.object({
    ...draftEnvelope,
    asset: z.object({ kind: z.literal("decision-prompt"), id: entityId("template") }).strict(),
    base: z.object({ revisionId: entityId("template-revision"), snapshot: decisionPromptRevision }).strict(),
    edited: decisionPromptDraft.omit({ sourceRevisionId: true }),
  }).strict(),
]).superRefine((draft, context) => {
  if (draft.base.revisionId !== draft.base.snapshot.id) {
    context.addIssue({ code: "custom", path: ["base", "revisionId"], message: "Base revision must match its source snapshot." });
  }
  for (const [path, content] of [[ ["base", "snapshot"], draft.base.snapshot ], [["edited"], draft.edited]] as const) {
    const variables = "decision" in content ? new Set(discoverDecisionVariables(content.decision).variables) : undefined;
    for (const name of Object.keys(content.variableDefaults)) {
      if (isSensitiveTemplateVariableName(name)) {
        context.addIssue({ code: "custom", path: [...path, "variableDefaults", name], message: "Secret values cannot have recoverable template defaults." });
      }
      if (variables && !variables.has(name)) {
        context.addIssue({ code: "custom", path: [...path, "variableDefaults", name], message: "Decision default names a variable the request does not use." });
      }
    }
  }
});

// Absent inherits; null clears an optional option. A provider-options object
// replaces the inherited object. Empty strings/arrays remain explicit values.
const optionOverridesSchema = z.object({
  temperature: inferenceOptions.shape.temperature.unwrap().nullable().optional(),
  maxOutputTokens: inferenceOptions.shape.maxOutputTokens.unwrap().nullable().optional(),
  seed: inferenceOptions.shape.seed.unwrap().nullable().optional(),
  stop: inferenceOptions.shape.stop.unwrap().nullable().optional(),
  providerOptions: inferenceOptions.shape.providerOptions.unwrap().nullable().optional(),
}).strict();

const selectionsSchema = z.object({
  ...envelope,
  chat: z.object({
    selectedInput: z.object({ kind: z.literal("saved-conversation-revision"), revisionId: entityId("revision") }).strict().optional(),
    execution: z.object({
      target: executionTarget.partial().optional(),
      options: optionOverridesSchema.optional(),
      enabledToolIds: z.array(entityId("tool")).refine(ids => new Set(ids).size === ids.length, "Duplicate tool selection.").optional(),
    }).strict().optional(),
  }).strict().optional(),
  decision: z.object({
    selectedInput: z.object({ kind: z.literal("saved-decision-request-revision"), revisionId: entityId("decision-revision") }).strict(),
  }).strict().optional(),
}).strict().superRefine((record, context) => {
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (isSensitiveTemplateVariableName(key)) {
          context.addIssue({ code: "custom", path: [...path, key], message: "Secret-bearing fields are not recoverable execution settings." });
        } else visit(item, [...path, key]);
      }
    }
  };
  visit(record.chat?.execution?.options?.providerOptions, ["chat", "execution", "options", "providerOptions"]);
});

/** Only migration-produced arms are supported in this first core slice. */
export type WorkbenchPromptDraftV1 = z.infer<typeof promptDraftSchema>;
export type WorkbenchSelectionsV1 = z.infer<typeof selectionsSchema>;
export type WorkbenchRecordV1 = WorkbenchPromptDraftV1 | WorkbenchSelectionsV1;

export class WorkbenchValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    super(`Invalid personal workbench record. ${issues.slice(0, 3).map(issue => `${issue.path.join(".") || "record"}: ${issue.message}`).join("; ")}`);
    this.name = "WorkbenchValidationError";
    this.issues = issues;
  }
}

/** Structural validation permits orphaned bases; association is checked separately. */
export function parseWorkbenchRecord(value: unknown, expectedProjectId?: ProjectId): WorkbenchRecordV1 {
  const isDraft = value !== null && typeof value === "object" && ("draftId" in value || "asset" in value);
  const parsed = (isDraft ? promptDraftSchema : selectionsSchema).safeParse(value);
  if (!parsed.success) throw new WorkbenchValidationError(parsed.error.issues);
  if (expectedProjectId !== undefined && parsed.data.projectId !== expectedProjectId) {
    throw new WorkbenchValidationError([{ code: "custom", path: ["projectId"], message: "Workbench record belongs to a different project." }]);
  }
  // Decision validation uses a custom schema; never retain a caller-owned subtree.
  return structuredClone(parsed.data);
}

export function parseWorkbenchRecordJson(text: string, expectedProjectId?: ProjectId): WorkbenchRecordV1 {
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new WorkbenchValidationError([{ code: "custom", path: [], message: "File is not valid JSON." }]);
  }
  return parseWorkbenchRecord(value, expectedProjectId);
}

export function serializeWorkbenchRecord(record: WorkbenchRecordV1): string {
  return `${JSON.stringify(stableJsonValue(parseWorkbenchRecord(record)), null, 2)}\n`;
}
