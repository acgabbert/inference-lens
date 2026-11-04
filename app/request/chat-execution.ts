import type { ExecutionTarget, ProjectFile } from "../../packages/core/src/project.ts";
import type { WorkbenchSelectionsV1 } from "../../packages/core/src/personal-workbench.ts";
import type {
  ConversationRevisionId,
  EnvironmentId,
  InferenceOptions,
  ProviderWireProtocol,
  ToolId,
} from "../../packages/core/src/run-kernel/types.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";

/**
 * A personal session's execution choices over the project's launch defaults
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 5 decisions"). Overrides are
 * sparse (T2): a field set back to its launch-default value is cleared, so
 * fields the user never moved away from follow a teammate's later change.
 * None of these helpers writes a project or a record.
 */

export type ChatExecutionOverrides = NonNullable<NonNullable<WorkbenchSelectionsV1["chat"]>["execution"]>;
type OptionOverrides = NonNullable<ChatExecutionOverrides["options"]>;
const OPTION_FIELDS = ["temperature", "maxOutputTokens", "seed", "stop", "providerOptions"] as const;

/** What the next chat run is sent with, once the overrides are applied. */
export interface EffectiveChatExecution {
  target: ExecutionTarget;
  options: InferenceOptions;
  enabledToolIds: ToolId[];
  /** Undefined runs with no environment. */
  environmentId: EnvironmentId | undefined;
}

/** One field the composer edits. `undefined` clears an optional field. */
export type ChatExecutionPatch =
  | { field: "model"; value: string }
  | { field: "protocol"; value: ProviderWireProtocol }
  | { field: "temperature"; value: number | undefined }
  | { field: "enabledToolIds"; value: readonly ToolId[] }
  | { field: "environmentId"; value: EnvironmentId | undefined };

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left ?? null)) === JSON.stringify(stableJsonValue(right ?? null));
}

function sameToolSet(left: readonly ToolId[], right: readonly ToolId[]): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((id) => set.has(id));
}

/**
 * The launch defaults with the overrides applied. An override that names
 * something the project no longer holds (a removed tool or environment) is
 * ignored rather than refused: a teammate's shared edit cannot break a
 * personal session.
 */
export function effectiveChatExecution(
  project: ProjectFile,
  overrides: ChatExecutionOverrides | undefined,
): EffectiveChatExecution {
  const { defaults } = project;
  const options: InferenceOptions = structuredClone(defaults.options);
  for (const field of OPTION_FIELDS) {
    if (!overrides?.options || !(field in overrides.options)) continue;
    const value = overrides.options[field];
    if (value === null || value === undefined) delete options[field];
    else (options as Record<string, unknown>)[field] = structuredClone(value);
  }
  const toolIds = new Set(project.tools.map(({ id }) => id));
  const enabledToolIds = (overrides?.enabledToolIds ?? defaults.enabledToolIds).filter((id) => toolIds.has(id));
  const environments = new Set(project.environments.map(({ id }) => id));
  const launchEnvironment = defaults.environmentId && environments.has(defaults.environmentId)
    ? defaults.environmentId
    : undefined;
  const chosen = overrides?.environmentId;
  const environmentId = chosen === null
    ? undefined
    : chosen && environments.has(chosen) ? chosen : launchEnvironment;
  return {
    target: { ...defaults.target, ...(overrides?.target ?? {}) },
    options,
    enabledToolIds,
    environmentId,
  };
}

/**
 * Applies one composer edit and keeps the overrides sparse (T2). Undefined
 * when nothing is left to override.
 */
export function patchChatExecution(
  project: ProjectFile,
  overrides: ChatExecutionOverrides | undefined,
  patch: ChatExecutionPatch,
): ChatExecutionOverrides | undefined {
  const { defaults } = project;
  const next: ChatExecutionOverrides = structuredClone(overrides ?? {});
  switch (patch.field) {
    case "model":
    case "protocol": {
      const target = { ...(next.target ?? {}) };
      if (defaults.target[patch.field] === patch.value) delete target[patch.field];
      else (target as Record<string, unknown>)[patch.field] = patch.value;
      if (Object.keys(target).length) next.target = target;
      else delete next.target;
      break;
    }
    case "temperature": {
      const options: OptionOverrides = { ...(next.options ?? {}) };
      if (defaults.options.temperature === patch.value) delete options.temperature;
      else options.temperature = patch.value ?? null;
      if (Object.keys(options).length) next.options = options;
      else delete next.options;
      break;
    }
    case "enabledToolIds":
      if (sameToolSet(defaults.enabledToolIds, patch.value)) delete next.enabledToolIds;
      else next.enabledToolIds = [...patch.value];
      break;
    case "environmentId":
      if (defaults.environmentId === patch.value) delete next.environmentId;
      else next.environmentId = patch.value ?? null;
      break;
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Settle a launch-default write without dropping edits made since its preview.
 * Compare sparse fields before rebasing: removing an override during the write
 * means choosing the OLD default, which may need an override against the new one.
 * Environment has its own publication action and is preserved as recorded.
 */
export function chatExecutionAfterLaunchSave(
  before: ProjectFile,
  published: ProjectFile,
  captured: ChatExecutionOverrides | undefined,
  current: ChatExecutionOverrides | undefined,
): ChatExecutionOverrides | undefined {
  const next: ChatExecutionOverrides = {};
  for (const group of ["target", "options"] as const) {
    const fields = group === "target"
      ? ["connectionRequirementId", "model", "protocol"] as const
      : OPTION_FIELDS;
    const rebased: Record<string, unknown> = {};
    for (const field of fields) {
      const previous = (captured?.[group] as Record<string, unknown> | undefined)?.[field];
      const latest = (current?.[group] as Record<string, unknown> | undefined)?.[field];
      // Null clears an option; absence inherits it. They are distinct edits.
      if (latest === previous || (latest !== undefined && previous !== undefined && same(latest, previous))) continue;
      const value = latest === undefined
        ? (before.defaults[group] as unknown as Record<string, unknown>)[field]
        : latest;
      if (!same(value, (published.defaults[group] as unknown as Record<string, unknown>)[field])) {
        rebased[field] = structuredClone(value ?? null);
      }
    }
    if (Object.keys(rebased).length) Object.assign(next, { [group]: rebased });
  }
  if (!same(current?.enabledToolIds, captured?.enabledToolIds)) {
    const ids = current?.enabledToolIds ?? before.defaults.enabledToolIds;
    if (!sameToolSet(ids, published.defaults.enabledToolIds)) next.enabledToolIds = [...ids];
  }
  if (current?.environmentId !== undefined) next.environmentId = current.environmentId;
  return Object.keys(next).length ? next : undefined;
}

export type LaunchDefaultField = "request" | "connection" | "model" | "protocol" | "temperature" | "options" | "tools";

export interface LaunchDefaultDifference {
  field: LaunchDefaultField;
  label: string;
  /** What `defaults` holds now, and what the action would write, as display text. */
  from: string;
  to: string;
}

/** The selected chat request as the status compares it. */
export type ChatSelectionForLaunch =
  | { kind: "saved"; revisionId: ConversationRevisionId }
  /** A request draft or scratch: never a valid launch pin (T3). */
  | { kind: "local"; baseRevisionId?: ConversationRevisionId };

function revisionLabel(project: ProjectFile, revisionId: ConversationRevisionId | undefined): string {
  if (!revisionId) return "a local request";
  const revision = project.conversationRevisions.find(({ id }) => id === revisionId);
  if (!revision) return "a missing request";
  const name = project.conversations.find(({ id }) => id === revision.conversationId)?.name ?? "Request";
  const siblings = orderedRevisions(project, revision.conversationId);
  return `${name}, revision ${siblings.findIndex(({ id }) => id === revisionId) + 1}`;
}

/** A request's revisions, oldest first: by creation time, then file order. */
export function orderedRevisions(project: ProjectFile, conversationId: string) {
  return project.conversationRevisions
    .map((revision, index) => ({ revision, index }))
    .filter(({ revision }) => revision.conversationId === conversationId)
    .sort((left, right) => left.revision.createdAt.localeCompare(right.revision.createdAt) || left.index - right.index)
    .map(({ revision }) => revision);
}

function toolNames(project: ProjectFile, ids: readonly ToolId[]): string {
  if (!ids.length) return "none";
  return ids.map((id) => project.tools.find((tool) => tool.id === id)?.name ?? id).join(", ");
}

/**
 * Where the personal selection differs from the launch default (T4): what a
 * teammate or the CLI would get instead. Values are compared, not override
 * presence, so a stale override equal to a changed default is no difference.
 * Environment is left to its own selector (D13).
 */
export function chatLaunchDifferences(
  project: ProjectFile,
  selection: ChatSelectionForLaunch,
  execution: EffectiveChatExecution,
): LaunchDefaultDifference[] {
  const { defaults } = project;
  const differences: LaunchDefaultDifference[] = [];
  const selectedRevision = selection.kind === "saved" ? selection.revisionId : selection.baseRevisionId;
  if (selection.kind === "local" || selectedRevision !== defaults.conversationRevisionId) {
    differences.push({
      field: "request",
      label: "Request",
      from: revisionLabel(project, defaults.conversationRevisionId),
      to: selection.kind === "local"
        ? `unsaved changes${selection.baseRevisionId ? ` to ${revisionLabel(project, selection.baseRevisionId)}` : ""}`
        : revisionLabel(project, selection.revisionId),
    });
  }
  const connectionName = (id: string) => project.connectionRequirements.find((entry) => entry.id === id)?.name ?? id;
  if (execution.target.connectionRequirementId !== defaults.target.connectionRequirementId) {
    differences.push({
      field: "connection", label: "Connection",
      from: connectionName(defaults.target.connectionRequirementId),
      to: connectionName(execution.target.connectionRequirementId),
    });
  }
  if (execution.target.model !== defaults.target.model) {
    differences.push({ field: "model", label: "Model", from: defaults.target.model, to: execution.target.model });
  }
  if (execution.target.protocol !== defaults.target.protocol) {
    differences.push({ field: "protocol", label: "Protocol", from: defaults.target.protocol, to: execution.target.protocol });
  }
  if (execution.options.temperature !== defaults.options.temperature) {
    differences.push({
      field: "temperature", label: "Temperature",
      from: defaults.options.temperature === undefined ? "provider default" : String(defaults.options.temperature),
      to: execution.options.temperature === undefined ? "provider default" : String(execution.options.temperature),
    });
  }
  const withoutTemperature = (options: InferenceOptions) => ({ ...options, temperature: undefined });
  if (!same(withoutTemperature(defaults.options), withoutTemperature(execution.options))) {
    differences.push({ field: "options", label: "Other options", from: "launch default", to: "personal settings" });
  }
  if (!sameToolSet(defaults.enabledToolIds, execution.enabledToolIds)) {
    differences.push({
      field: "tools", label: "Tools",
      from: toolNames(project, defaults.enabledToolIds),
      to: toolNames(project, execution.enabledToolIds),
    });
  }
  return differences;
}
