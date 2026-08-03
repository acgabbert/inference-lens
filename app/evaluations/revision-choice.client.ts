import type { ConversationRevisionDescriptor } from "../../packages/core/src/conversation-revision-description";

/**
 * Locale-specific rendering lives here rather than in the descriptor, so the
 * portable projection stays free of presentation decisions.
 */
export function revisionTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface RevisionChoice {
  /** The option text: recognizable without reading a timestamp or an ID. */
  label: string;
  templateSummary?: string;
  compatible: boolean;
}

/**
 * Composes a compact, meaningful description of one revision.
 *
 * Template names lead when the revision has pinned uses, because that is what
 * an author recognizes. A literal-only revision leads with its first message
 * instead. Time is useful disambiguation and is therefore always last, never
 * the identity of the choice.
 */
export function revisionChoice(descriptor: ConversationRevisionDescriptor): RevisionChoice {
  const templateSummary = descriptor.templateUses
    .map(({ templateName }) => templateName)
    .join(" + ");
  const quoted = descriptor.summary ? `“${descriptor.summary}”` : undefined;
  const body = templateSummary
    ? [templateSummary, quoted]
    : [quoted ?? (descriptor.resolvable ? "Empty revision" : "Unresolved revision")];
  const parts = [
    descriptor.isCurrentRevision ? "Current" : undefined,
    ...body,
    revisionTime(descriptor.createdAt),
  ];
  return {
    label: parts.filter((part): part is string => Boolean(part)).join(" · "),
    ...(templateSummary ? { templateSummary } : {}),
    compatible: descriptor.compatibility.kind !== "incompatible",
  };
}

export interface GroupedRevisionChoices {
  /** True when the suite has bindings, so the compatible/other split is meaningful. */
  grouped: boolean;
  compatible: ConversationRevisionDescriptor[];
  other: ConversationRevisionDescriptor[];
}

/**
 * Splits choices for display. Incompatible revisions are never hidden or
 * disabled: selecting one is how an author understands and repairs a historical
 * incompatibility.
 */
export function groupRevisionChoices(
  descriptors: readonly ConversationRevisionDescriptor[],
): GroupedRevisionChoices {
  const grouped = descriptors.some(({ compatibility }) => compatibility.kind !== "unbound");
  if (!grouped) return { grouped: false, compatible: [...descriptors], other: [] };
  return {
    grouped: true,
    compatible: descriptors.filter(({ compatibility }) => compatibility.kind === "compatible"),
    other: descriptors.filter(({ compatibility }) => compatibility.kind !== "compatible"),
  };
}
