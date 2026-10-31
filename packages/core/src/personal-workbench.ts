import { z } from "zod";
import { isSensitiveTemplateVariableName, projectContentSchemas, projectFieldOrder, sensitiveFieldPaths } from "./project.ts";
import type { ProjectConversationItem } from "./project.ts";
import type { DecisionInput } from "./decision.ts";
import { discoverDecisionVariables } from "./decision-variables.ts";
import type { ProjectId } from "./run-kernel/types.ts";
import { stableJsonValue } from "./stable-json.ts";

export const WORKBENCH_SCHEMA_VERSION = 1;
export const WORKBENCH_GITIGNORE_CONTENTS = "*\n";

const { entityId, chatPromptRevision, chatPromptDraft, decisionPromptRevision,
  decisionPromptDraft, inferenceOptions, executionTarget, conversationRevision,
  conversationItem, decisionRequestRevision, decisionInput, variableName } = projectContentSchemas;
const envelope = {
  schemaVersion: z.literal(WORKBENCH_SCHEMA_VERSION),
  projectId: entityId("project"),
};
const draftIdSchema = z.string().regex(/^draft_[A-Za-z0-9_-]+$/);
const scratchIdSchema = z.string().regex(/^scratch_[A-Za-z0-9_-]+$/);
const draftEnvelope = {
  ...envelope,
  kind: z.literal("draft"),
  draftId: draftIdSchema,
};

const chatPromptContent = chatPromptDraft.omit({ sourceRevisionId: true });
const decisionPromptContent = decisionPromptDraft.omit({ sourceRevisionId: true });
const chatRequestContent = z.object({ items: z.array(conversationItem) }).strict();
/** A decision request revision's editable arms, without its identity. */
const decisionRequestContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), decision: decisionInput, values: z.record(z.string(), z.string()) }).strict(),
  z.object({
    kind: z.literal("template-use"), templateId: entityId("template"), templateRevisionId: entityId("template-revision"),
    overrides: z.record(z.string().regex(variableName), z.string()),
  }).strict(),
]);

/**
 * Written, and read back, before the shared write it describes. A draft
 * publishes as a child of its base, so the recorded parent is the base.
 */
const draftPublicationIntent = <C extends z.ZodType>(revision: "template-revision" | "revision" | "decision-revision", content: C) =>
  z.object({ revisionId: entityId(revision), parentRevisionId: entityId(revision), content }).strict();

type Issues = z.core.$RefinementCtx;
type Path = Array<string | number>;

/** Saved and local assignments obey the project file's rules, minus live references. */
function checkChatItems(items: ProjectConversationItem[], path: Path, context: Issues): void {
  const messageIds = new Set<string>();
  const useIds = new Set<string>();
  function checkId(seen: Set<string>, id: string, idPath: Path): void {
    if (seen.has(id)) {
      context.addIssue({ code: "custom", path: idPath, message: `Duplicate identifier "${id}".` });
    }
    seen.add(id);
  }
  items.forEach((item, index) => {
    if (item.kind === "message") {
      checkId(messageIds, item.message.id, [...path, index, "message", "id"]);
      return;
    }
    checkId(useIds, item.use.id, [...path, index, "use", "id"]);
    item.use.outputMessageIds.forEach((id, outputIndex) => {
      checkId(messageIds, id, [...path, index, "use", "outputMessageIds", outputIndex]);
    });
    for (const name of Object.keys(item.use.values)) {
      if (isSensitiveTemplateVariableName(name)) {
        context.addIssue({ code: "custom", path: [...path, index, "use", "values", name], message: "Secret values cannot be recoverable template assignments." });
      }
    }
  });
}

function checkDecisionContent(content: z.infer<typeof decisionRequestContent>, path: Path, context: Issues): void {
  const field = content.kind === "inline" ? "values" : "overrides";
  const assignments = content.kind === "inline" ? content.values : content.overrides;
  // A template-use pin is resolved against a live project; inline content is self-contained.
  const used = content.kind === "inline" ? new Set(discoverDecisionVariables(content.decision as DecisionInput).variables) : undefined;
  for (const name of Object.keys(assignments)) {
    if (used && !used.has(name)) {
      context.addIssue({ code: "custom", path: [...path, field, name], message: "Decision value names a variable the request does not use." });
    } else if (isSensitiveTemplateVariableName(name)) {
      context.addIssue({ code: "custom", path: [...path, field, name], message: "Secret values cannot be recoverable decision assignments." });
    }
  }
}

function checkPromptContent(content: { variableDefaults: Record<string, string>; decision?: unknown }, path: Path, context: Issues): void {
  const variables = "decision" in content ? new Set(discoverDecisionVariables(content.decision as DecisionInput).variables) : undefined;
  for (const name of Object.keys(content.variableDefaults)) {
    if (isSensitiveTemplateVariableName(name)) {
      context.addIssue({ code: "custom", path: [...path, "variableDefaults", name], message: "Secret values cannot have recoverable template defaults." });
    }
    if (variables && !variables.has(name)) {
      context.addIssue({ code: "custom", path: [...path, "variableDefaults", name], message: "Decision default names a variable the request does not use." });
    }
  }
}

function checkBase(draft: { base: { revisionId: string; snapshot: { id: string } } }, context: Issues): void {
  if (draft.base.revisionId !== draft.base.snapshot.id) {
    context.addIssue({ code: "custom", path: ["base", "revisionId"], message: "Base revision must match its source snapshot." });
  }
}

function checkPublishingParent(draft: { base: { revisionId: string }; publishing?: { revisionId: string; parentRevisionId: string } }, context: Issues): void {
  if (!draft.publishing) return;
  if (draft.publishing.parentRevisionId !== draft.base.revisionId) {
    context.addIssue({ code: "custom", path: ["publishing", "parentRevisionId"], message: "A draft publishes as a child of its base revision." });
  }
  if (draft.publishing.revisionId === draft.base.revisionId) {
    context.addIssue({ code: "custom", path: ["publishing", "revisionId"], message: "A publication allocates a new revision." });
  }
}

const chatPromptDraftSchema = z.object({
  ...draftEnvelope,
  asset: z.object({ kind: z.literal("chat-prompt"), id: entityId("template") }).strict(),
  base: z.object({ revisionId: entityId("template-revision"), snapshot: chatPromptRevision }).strict(),
  edited: chatPromptContent,
  publishing: draftPublicationIntent("template-revision", chatPromptContent).optional(),
}).strict();
const decisionPromptDraftSchema = z.object({
  ...draftEnvelope,
  asset: z.object({ kind: z.literal("decision-prompt"), id: entityId("template") }).strict(),
  base: z.object({ revisionId: entityId("template-revision"), snapshot: decisionPromptRevision }).strict(),
  edited: decisionPromptContent,
  publishing: draftPublicationIntent("template-revision", decisionPromptContent).optional(),
}).strict();
const chatRequestDraftSchema = z.object({
  ...draftEnvelope,
  asset: z.object({ kind: z.literal("chat-request"), id: entityId("conversation") }).strict(),
  base: z.object({ revisionId: entityId("revision"), snapshot: conversationRevision }).strict(),
  edited: chatRequestContent,
  publishing: draftPublicationIntent("revision", chatRequestContent).optional(),
}).strict();
const decisionRequestDraftSchema = z.object({
  ...draftEnvelope,
  asset: z.object({ kind: z.literal("decision-request"), id: entityId("decision-request") }).strict(),
  base: z.object({ revisionId: entityId("decision-revision"), snapshot: decisionRequestRevision }).strict(),
  edited: decisionRequestContent,
  publishing: draftPublicationIntent("decision-revision", decisionRequestContent).optional(),
}).strict();

const draftSchema = z.union([chatPromptDraftSchema, decisionPromptDraftSchema, chatRequestDraftSchema, decisionRequestDraftSchema])
  .superRefine((draft, context) => {
    checkBase(draft, context);
    checkPublishingParent(draft, context);
    switch (draft.asset.kind) {
      case "chat-prompt":
      case "decision-prompt": {
        const prompt = draft as z.infer<typeof chatPromptDraftSchema> | z.infer<typeof decisionPromptDraftSchema>;
        checkPromptContent(prompt.base.snapshot, ["base", "snapshot"], context);
        checkPromptContent(prompt.edited, ["edited"], context);
        if (prompt.publishing) checkPromptContent(prompt.publishing.content, ["publishing", "content"], context);
        return;
      }
      case "chat-request": {
        const request = draft as z.infer<typeof chatRequestDraftSchema>;
        if (request.base.snapshot.conversationId !== request.asset.id) {
          context.addIssue({ code: "custom", path: ["base", "snapshot", "conversationId"], message: "Base revision belongs to a different request." });
        }
        checkChatItems(request.base.snapshot.items, ["base", "snapshot", "items"], context);
        checkChatItems(request.edited.items, ["edited", "items"], context);
        if (request.publishing) checkChatItems(request.publishing.content.items, ["publishing", "content", "items"], context);
        return;
      }
      case "decision-request": {
        const request = draft as z.infer<typeof decisionRequestDraftSchema>;
        if (request.base.snapshot.decisionRequestId !== request.asset.id) {
          context.addIssue({ code: "custom", path: ["base", "snapshot", "decisionRequestId"], message: "Base revision belongs to a different request." });
        }
        checkDecisionContent(request.base.snapshot, ["base", "snapshot"], context);
        checkDecisionContent(request.edited, ["edited"], context);
        if (request.publishing) checkDecisionContent(request.publishing.content, ["publishing", "content"], context);
      }
    }
  });

const scratchRef = z.object({ kind: z.literal("scratch"), scratchId: scratchIdSchema }).strict();
const savedConversationRevision = z.object({ kind: z.literal("saved-conversation-revision"), revisionId: entityId("revision") }).strict();
const savedDecisionRequestRevision = z.object({ kind: z.literal("saved-decision-request-revision"), revisionId: entityId("decision-revision") }).strict();
const nonEmptyName = z.string().trim().min(1);

/**
 * With a saved ancestor, a scratch publishes as a child inside that
 * ancestor's request, since project.json keeps a parent in its child's
 * request. Without one it creates a request, which needs a name.
 */
const scratchPublication = <I extends "conversation" | "decision-request", R extends "revision" | "decision-revision", C extends z.ZodType>(
  identity: I, revision: R, content: C,
) => z.object({
  [identity === "conversation" ? "conversationId" : "decisionRequestId"]: entityId(identity),
  name: nonEmptyName.optional(),
  revisionId: entityId(revision),
  parentRevisionId: entityId(revision).optional(),
  content,
}).strict().refine(
  (intent) => (intent.name === undefined) !== (intent.parentRevisionId === undefined),
  "Publish a scratch either as a child of its saved ancestor or as a new named request.",
);

const scratchSchema = z.object({
  ...envelope,
  kind: z.literal("scratch"),
  scratchId: scratchIdSchema,
  createdAt: z.iso.datetime({ offset: true }),
  /** Groups this scratch's runs; never written to project.json. */
  localConversationId: entityId("conversation"),
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("chat"), items: z.array(conversationItem), parent: z.discriminatedUnion("kind", [savedConversationRevision, scratchRef]).optional() }).strict(),
    z.object({ kind: z.literal("decision"), content: decisionRequestContent, parent: z.discriminatedUnion("kind", [savedDecisionRequestRevision, scratchRef]).optional() }).strict(),
  ]),
  branchedFrom: z.object({ runId: z.string().regex(/^run_.+/), messageId: entityId("message") }).strict().optional(),
  publishing: z.union([
    scratchPublication("conversation", "revision", chatRequestContent),
    scratchPublication("decision-request", "decision-revision", decisionRequestContent),
  ]).optional(),
}).strict().superRefine((scratch, context) => {
  const { request, publishing } = scratch;
  if (request.parent?.kind === "scratch" && request.parent.scratchId === scratch.scratchId) {
    context.addIssue({ code: "custom", path: ["request", "parent", "scratchId"], message: "A scratch cannot be its own parent." });
  }
  if (request.kind === "chat") {
    checkChatItems(request.items, ["request", "items"], context);
  } else {
    checkDecisionContent(request.content, ["request", "content"], context);
  }
  if (!publishing) return;
  if (publishing.revisionId === publishing.parentRevisionId) {
    context.addIssue({ code: "custom", path: ["publishing", "revisionId"], message: "A publication allocates a new revision." });
  }
  if (("conversationId" in publishing) !== (request.kind === "chat")) {
    context.addIssue({ code: "custom", path: ["publishing"], message: "Publication must match the scratch request's kind." });
  } else if ("conversationId" in publishing) {
    checkChatItems((publishing.content as z.infer<typeof chatRequestContent>).items, ["publishing", "content", "items"], context);
  } else {
    checkDecisionContent(publishing.content as z.infer<typeof decisionRequestContent>, ["publishing", "content"], context);
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

/** One active draft per asset, so a selection names the draft record. */
const draftRef = z.object({ kind: z.literal("draft"), draftId: draftIdSchema }).strict();

const selectionsSchema = z.object({
  ...envelope,
  kind: z.literal("selections"),
  chat: z.object({
    selectedInput: z.discriminatedUnion("kind", [savedConversationRevision, draftRef, scratchRef]).optional(),
    execution: z.object({
      target: executionTarget.partial().optional(),
      /** Absent inherits the launch default; null chooses no environment. */
      environmentId: entityId("environment").nullable().optional(),
      options: optionOverridesSchema.optional(),
      enabledToolIds: z.array(entityId("tool")).refine(ids => new Set(ids).size === ids.length, "Duplicate tool selection.").optional(),
    }).strict().optional(),
  }).strict().optional(),
  decision: z.object({
    selectedInput: z.discriminatedUnion("kind", [savedDecisionRequestRevision, draftRef, scratchRef]),
  }).strict().optional(),
}).strict().superRefine((record, context) => {
  for (const path of sensitiveFieldPaths(record.chat?.execution?.options?.providerOptions, ["chat", "execution", "options", "providerOptions"])) {
    context.addIssue({ code: "custom", path, message: "Secret-bearing fields are not recoverable execution settings." });
  }
});

const recordSchemas = { draft: draftSchema, selections: selectionsSchema, scratch: scratchSchema };

// Envelope fields lead, matching the authored examples; nested saved content
// keeps the project file's order. The order applies at every depth, so a field
// that saved content also uses (such as `createdAt`) is left out of it.
const envelopeFieldOrder = [
  "schemaVersion", "kind", "projectId", "draftId", "scratchId", "localConversationId",
  "asset", "base", "edited", "request", "branchedFrom", "publishing", "chat", "decision",
];
const workbenchFieldOrder = new Map([
  ...envelopeFieldOrder,
  ...[...projectFieldOrder.keys()].filter(field => !envelopeFieldOrder.includes(field)),
].map((field, index) => [field, index]));

export type WorkbenchPromptDraftV1 = z.infer<typeof chatPromptDraftSchema> | z.infer<typeof decisionPromptDraftSchema>;
export type WorkbenchChatRequestDraftV1 = z.infer<typeof chatRequestDraftSchema>;
export type WorkbenchDecisionRequestDraftV1 = z.infer<typeof decisionRequestDraftSchema>;
export type WorkbenchDraftV1 = WorkbenchPromptDraftV1 | WorkbenchChatRequestDraftV1 | WorkbenchDecisionRequestDraftV1;
export type WorkbenchScratchV1 = z.infer<typeof scratchSchema>;
export type WorkbenchSelectionsV1 = z.infer<typeof selectionsSchema>;
export type WorkbenchRecordV1 = WorkbenchDraftV1 | WorkbenchSelectionsV1 | WorkbenchScratchV1;
export type WorkbenchDecisionRequestContent = z.infer<typeof decisionRequestContent>;

/** Draft arms are distinguished by `asset.kind`, which TypeScript does not narrow on. */
export function isPromptDraft(record: WorkbenchRecordV1): record is WorkbenchPromptDraftV1 {
  return record.kind === "draft" && (record.asset.kind === "chat-prompt" || record.asset.kind === "decision-prompt");
}

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
  const kind = value !== null && typeof value === "object" && "kind" in value ? value.kind : undefined;
  const schema = typeof kind === "string" && Object.hasOwn(recordSchemas, kind) ? recordSchemas[kind as keyof typeof recordSchemas] : undefined;
  if (!schema) {
    throw new WorkbenchValidationError([{ code: "custom", path: ["kind"], message: "Unsupported workbench record kind." }]);
  }
  const parsed = schema.safeParse(value);
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
  return `${JSON.stringify(stableJsonValue(parseWorkbenchRecord(record), { preferredKeyOrder: workbenchFieldOrder }), null, 2)}\n`;
}
