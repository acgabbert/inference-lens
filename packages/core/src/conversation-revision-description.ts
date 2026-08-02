import type { EvaluationSuite } from "./evaluation-suites.ts";
import { resolveProjectRevision } from "./project.ts";
import type { ProjectConversationRevision, ProjectFile } from "./project.ts";
import { templateUseVariableIndex } from "./template-use-variable-index.ts";
import type {
  ConversationId,
  ConversationRevisionId,
  EvaluationInputBindingId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";

/** The longest first-message summary a revision choice carries. */
export const REVISION_SUMMARY_LENGTH = 72;

export interface RevisionTemplateUseDescriptor {
  templateUseId: PromptTemplateUseId;
  templateId: PromptTemplateId;
  templateName: string;
  templateRevisionId: PromptTemplateRevisionId;
  /** False when the use pins an older immutable revision than the template's current one. */
  pinnedToCurrentTemplateRevision: boolean;
  messageCount: number;
}

export interface RevisionBindingMismatch {
  inputBindingId: EvaluationInputBindingId;
  inputName: string;
  templateUseId: PromptTemplateUseId;
  variableName: string;
  reason: "missing-template-use" | "missing-template-variable";
}

/**
 * Compatibility is decided by exact template-use ID and variable name. Two uses
 * of one template are different authored inputs, so a shared template ID says
 * nothing about whether a binding still resolves.
 */
export type RevisionSuiteCompatibility =
  | { kind: "unbound" }
  | { kind: "compatible" }
  | { kind: "incompatible"; mismatches: RevisionBindingMismatch[] };

export interface ConversationRevisionDescriptor {
  revisionId: ConversationRevisionId;
  conversationId: ConversationId;
  createdAt: string;
  /** True for the project's active authored revision, which the Messages editor edits. */
  isCurrentRevision: boolean;
  templateUses: RevisionTemplateUseDescriptor[];
  messageCount: number;
  /**
   * The first message with text, shortened. Unfilled variables survive as their
   * own `{{token}}`, so a choice reads as the authored prompt rather than as a
   * value that was silently dropped.
   */
  summary: string;
  summaryRole?: "system" | "user" | "assistant" | "tool";
  /** False when a pinned template revision has gone missing, so text cannot be resolved. */
  resolvable: boolean;
  compatibility: RevisionSuiteCompatibility;
}

function shorten(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > REVISION_SUMMARY_LENGTH
    ? `${collapsed.slice(0, REVISION_SUMMARY_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

function revisionCompatibility(
  revision: ProjectConversationRevision,
  project: Pick<ProjectFile, "promptTemplates">,
  suite: EvaluationSuite | undefined,
): RevisionSuiteCompatibility {
  if (!suite || suite.inputBindings.length === 0) return { kind: "unbound" };
  const uses = templateUseVariableIndex([revision], project.promptTemplates);
  const mismatches = suite.inputBindings.flatMap((binding): RevisionBindingMismatch[] => {
    const occurrence = uses.get(binding.target.templateUseId)?.[0];
    if (occurrence?.variables.has(binding.target.variableName)) return [];
    return [{
      inputBindingId: binding.id,
      inputName: binding.name,
      templateUseId: binding.target.templateUseId,
      variableName: binding.target.variableName,
      reason: occurrence ? "missing-template-variable" : "missing-template-use",
    }];
  });
  return mismatches.length === 0 ? { kind: "compatible" } : { kind: "incompatible", mismatches };
}

/**
 * A derived, presentation-free description of one conversation revision.
 *
 * Human revision descriptions are projected on demand rather than stored: a
 * mutable `revisionName` on portable data would let a label drift from the
 * immutable content an execution actually snapshotted. Locale-specific time
 * rendering and label assembly stay with the caller.
 */
export function describeConversationRevision(
  project: Pick<ProjectFile, "conversationRevisions" | "promptTemplates" | "defaults">,
  revision: ProjectConversationRevision,
  suite?: EvaluationSuite,
): ConversationRevisionDescriptor {
  const templatesById = new Map(project.promptTemplates.map((template) => [template.id, template]));
  const templateUses = revision.items.flatMap((item): RevisionTemplateUseDescriptor[] => {
    if (item.kind !== "template-use") return [];
    const template = templatesById.get(item.use.templateId);
    return [{
      templateUseId: item.use.id,
      templateId: item.use.templateId,
      // A missing template is a described condition, not an excuse to surface
      // a raw ID where every other use shows a human name.
      templateName: template?.name ?? "Missing template",
      templateRevisionId: item.use.templateRevisionId,
      pinnedToCurrentTemplateRevision: template?.currentRevisionId === item.use.templateRevisionId,
      messageCount: item.use.outputMessageIds.length,
    }];
  });

  let messages: ReturnType<typeof resolveProjectRevision>["messages"] = [];
  let resolvable = true;
  try {
    messages = resolveProjectRevision(project, revision).messages;
  } catch {
    // A use whose pinned template revision has gone missing cannot render, but
    // the revision must still be describable so an author can recognize and
    // repair it instead of meeting an empty selector.
    resolvable = false;
  }
  const first = messages.find((message) =>
    message.content.some(({ text }) => text.trim() !== ""),
  );

  return {
    revisionId: revision.id,
    conversationId: revision.conversationId,
    createdAt: revision.createdAt,
    isCurrentRevision: revision.id === project.defaults.conversationRevisionId,
    templateUses,
    messageCount: resolvable ? messages.length : revision.items.length,
    summary: first ? shorten(first.content.map(({ text }) => text).join("")) : "",
    ...(first ? { summaryRole: first.role } : {}),
    resolvable,
    compatibility: revisionCompatibility(revision, project, suite),
  };
}

/** Describes every revision in authored project order. */
export function describeConversationRevisions(
  project: Pick<ProjectFile, "conversationRevisions" | "promptTemplates" | "defaults">,
  suite?: EvaluationSuite,
): ConversationRevisionDescriptor[] {
  return project.conversationRevisions.map((revision) =>
    describeConversationRevision(project, revision, suite),
  );
}
