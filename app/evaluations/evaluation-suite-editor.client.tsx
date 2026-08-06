"use client";

import { useState } from "react";
import { CHECK_KINDS } from "../../packages/core/src/checks";
import type { CheckDefinition, CheckKind, ToolCallCountComparator } from "../../packages/core/src/checks";
import type { JsonObject } from "../../packages/core/src/run-kernel";
import type { EvaluationCase } from "../../packages/core/src/project";
import type { EvaluationCaseSource } from "../../packages/core/src/evaluation-case-sources";
import { resolveEvaluationVariant } from "../../packages/core/src/evaluation-suites";
import type { EvaluationInputBinding, EvaluationVariant } from "../../packages/core/src/evaluation-suites";
import type { ConversationRevisionDescriptor } from "../../packages/core/src/conversation-revision-description";
import type { InferenceOptions, ProviderProtocol } from "../../packages/core/src/run-kernel";
import {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "../../packages/core/src/experiment";
import { InferenceSettingsPanel } from "../inference-settings-panel.client";
import { DisclosureChevron } from "../disclosure-chevron.client";
import { experimentToolBindingLabel } from "../run/experiment-tool-bindings.client";
import type { ExperimentToolBinding } from "../run/experiment-tool-bindings.client";
import { PaneEmptyState } from "../pane-empty-state.client";
import { groupRevisionChoices, revisionChoice } from "./revision-choice.client";
import { SavedPromptDialog } from "./saved-prompt-dialog.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";
import type { EvaluationCheckAuthoringField } from "./use-evaluation-suite-authoring.client";
import {
  evaluationBatchGuardrail,
  MAX_EVALUATION_REPETITIONS,
} from "./evaluation-batch.client";
import {
  EvaluationSuiteHistory,
  type EvaluationSuiteHistoryHandle,
} from "./evaluation-suite-history.client";
import { BlockerChip } from "../blocker-chip.client";
import styles from "./evaluation-surface.module.css";

/**
 * The id of the preflight chip's summary line. The Start button is in the
 * topbar, so it points at this text rather than restating the reason in a
 * tooltip no keyboard or touch author would ever see.
 */
export const EVALUATION_PREFLIGHT_SUMMARY_ID = "evaluation-preflight-summary";

const checkKindLabels: Record<CheckKind, string> = {
  "exact-match": "Exact output",
  contains: "Contains text",
  regex: "Regex",
  "valid-json": "Valid JSON",
  "max-output-characters": "Maximum characters",
  "max-duration-ms": "Maximum duration",
  "max-total-tokens": "Maximum tokens",
  "called-tool": "Called tool",
  "did-not-call-tool": "Did not call tool",
  "tool-call-count": "Tool call count",
  "tool-call-arguments": "Tool call arguments",
};

// Ordered by the vocabulary itself, so a new kind cannot be offered without a
// label or silently left out of the picker.
const checkKinds = CHECK_KINDS.map((kind) => ({ kind, label: checkKindLabels[kind] }));

function evaluationInputLabel(
  project: NonNullable<EvaluationSuiteAuthoringHandle["project"]>,
  revisionId: EvaluationSuiteAuthoringHandle["revisionId"],
  binding: EvaluationInputBinding,
): { templateName: string; variableName: string; label: string } {
  const revision = project.conversationRevisions.find(({ id }) => id === revisionId);
  const templateUse = revision?.items.find((item) =>
    item.kind === "template-use" && item.use.id === binding.target.templateUseId
  );
  const templateName = templateUse?.kind === "template-use"
    ? project.promptTemplates.find(({ id }) => id === templateUse.use.templateId)?.name ?? "Prompt"
    : "Prompt";
  return {
    templateName,
    variableName: binding.target.variableName,
    label: `${templateName} · ${binding.target.variableName}`,
  };
}

function revisionOption(descriptor: ConversationRevisionDescriptor) {
  const choice = revisionChoice(descriptor);
  return (
    <option
      key={descriptor.revisionId}
      title={`${descriptor.revisionId} · ${descriptor.messageCount} ${descriptor.messageCount === 1 ? "message" : "messages"}`}
      value={descriptor.revisionId}
    >
      {choice.label}
    </option>
  );
}

function ConfigurationRow({
  variant,
  suite,
  project,
  authoring,
  index,
}: {
  variant: EvaluationVariant;
  suite: NonNullable<EvaluationSuiteAuthoringHandle["project"]>["evaluationSuites"][number];
  project: NonNullable<EvaluationSuiteAuthoringHandle["project"]>;
  authoring: EvaluationSuiteAuthoringHandle;
  index: number;
}) {
  const effective = resolveEvaluationVariant(suite, variant);
  const inherited = (field: "connection" | "model" | "delivery" | "temperature") => field === "connection"
    ? variant.overrides.target?.connectionRequirementId === undefined
    : field === "model"
      ? variant.overrides.target?.model === undefined
      : field === "delivery"
        ? variant.overrides.responseMode === undefined
        : variant.overrides.options?.temperature === undefined;
  const update = (patch: EvaluationVariant["overrides"]) => authoring.updateVariant(variant.id, { name: variant.name, overrides: patch });
  return <article className="evaluation-configuration-card" aria-label={`Configuration ${variant.name}`}>
    <div className="evaluation-check-heading"><strong>Configuration {index + 1}</strong><div>
      <label title={`Include ${variant.name} in this evaluation`}><input aria-label={`Include configuration ${variant.name}`} type="checkbox" checked={authoring.selectedVariantIds.has(variant.id)} onChange={(event) => authoring.setVariantSelected(variant.id, event.target.checked)} /> Include</label>
      {index > 0 && <button className="text-button" type="button" onClick={() => authoring.moveVariant(variant.id, index - 1)}>Move up</button>}
      {index < suite.variants.length - 1 && <button className="text-button" type="button" onClick={() => authoring.moveVariant(variant.id, index + 1)}>Move down</button>}
      <button className="remove-button" type="button" onClick={() => authoring.deleteVariant(variant.id)}>Delete</button>
    </div></div>
    <label>Name <input aria-label={`Configuration name ${index + 1}`} value={variant.name} onChange={(event) => authoring.updateVariant(variant.id, { name: event.target.value, overrides: variant.overrides })} /></label>
    <div className="evaluation-settings-grid">
      <label>Connection <select aria-label={`Configuration connection ${variant.name}`} value={effective.target.connectionRequirementId} onChange={(event) => update({ ...variant.overrides, target: { ...variant.overrides.target, connectionRequirementId: event.target.value as typeof effective.target.connectionRequirementId } })}>{project.connectionRequirements.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select><small>{inherited("connection") ? "Inherits suite connection" : "Overrides suite connection"}</small></label>
      <label>Model <input aria-label={`Configuration model ${variant.name}`} value={effective.target.model} onChange={(event) => update({ ...variant.overrides, target: { ...variant.overrides.target, model: event.target.value } })} /><small>{inherited("model") ? "Inherits suite model" : "Overrides suite model"}</small></label>
      <label>Delivery <select aria-label={`Configuration delivery ${variant.name}`} value={effective.responseMode} onChange={(event) => update({ ...variant.overrides, responseMode: event.target.value as typeof effective.responseMode })}><option value="buffered">Buffered</option><option value="streaming">Streaming</option></select><small>{inherited("delivery") ? "Inherits suite delivery" : "Overrides suite delivery"}</small></label>
      <label>Temperature <input aria-label={`Configuration temperature ${variant.name}`} type="number" step="0.1" value={effective.options.temperature ?? ""} onChange={(event) => update({ ...variant.overrides, options: { ...variant.overrides.options, temperature: event.target.value === "" ? null : Number(event.target.value) } })} /><small>{inherited("temperature") ? "Inherits suite option" : variant.overrides.options?.temperature === null ? "Uses provider default" : "Overrides suite option"}</small></label>
    </div>
    <p className="evaluation-portable-warning">Effective: {project.connectionRequirements.find(({ id }) => id === effective.target.connectionRequirementId)?.name ?? effective.target.connectionRequirementId} · {effective.target.model} · {effective.responseMode} · temperature {effective.options.temperature ?? "provider default"} · max output {effective.options.maxOutputTokens ?? "provider default"} · seed {effective.options.seed ?? "provider default"} · stop {effective.options.stop?.join(", ") || "provider default"} · provider options {effective.options.providerOptions ? "set" : "provider default"}</p>
  </article>;
}

function CheckEditor({ check, error, onCommit, onRemove }: {
  check: CheckDefinition;
  error?: { field: EvaluationCheckAuthoringField; message: string };
  onCommit(check: CheckDefinition, field: EvaluationCheckAuthoringField): boolean;
  onRemove(): void;
}) {
  const value = check.kind === "exact-match" || check.kind === "contains"
    ? check.value
    : check.kind === "regex"
      ? check.pattern
      : undefined;
  return (
    <article className="evaluation-check-card">
      <div className="evaluation-check-heading">
        <div className="evaluation-check-title">
          <strong>{checkKinds.find(({ kind }) => kind === check.kind)?.label}</strong>
          {check.kind === "regex" && (
            <details className="evaluation-regex-dialect">
              <summary aria-label="About RE2 syntax">
                RE2 syntax <span aria-hidden="true"><span className="info-mark-glyph">i</span></span>
              </summary>
              <p>Lookarounds and backreferences aren’t supported.</p>
            </details>
          )}
        </div>
        <button className="remove-button" type="button" onClick={onRemove}>Remove</button>
      </div>
      <label>Label <input defaultValue={check.label ?? ""} onBlur={(event) => {
        if (!onCommit({ ...check, ...(event.target.value ? { label: event.target.value } : { label: undefined }) }, "label")) event.currentTarget.value = check.label ?? "";
      }} /></label>
      {error?.field === "label" && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {value !== undefined && (
        <label>{check.kind === "regex" ? "Pattern" : "Expected text"}
          <textarea defaultValue={value} rows={3} onBlur={(event) => {
            const field = check.kind === "regex" ? "pattern" : "expected-text";
            const next = (check.kind === "regex" ? { ...check, pattern: event.target.value } : { ...check, value: event.target.value }) as CheckDefinition;
            if (!onCommit(next, field)) event.currentTarget.value = value;
          }} />
        </label>
      )}
      {(error?.field === "pattern" || error?.field === "expected-text") && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {(check.kind === "exact-match" || check.kind === "contains") && (
        <div className="evaluation-check-options">
          <label><input type="checkbox" defaultChecked={check.caseSensitive !== false} onChange={(event) => { if (!onCommit({ ...check, caseSensitive: event.target.checked }, "case-sensitive")) event.currentTarget.checked = check.caseSensitive !== false; }} /> Case sensitive</label>
          <label><input type="checkbox" defaultChecked={check.trimWhitespace ?? false} onChange={(event) => { if (!onCommit({ ...check, trimWhitespace: event.target.checked }, "trim-whitespace")) event.currentTarget.checked = check.trimWhitespace ?? false; }} /> Trim whitespace</label>
          <label><input type="checkbox" defaultChecked={check.negate ?? false} onChange={(event) => { if (!onCommit({ ...check, negate: event.target.checked }, "negate")) event.currentTarget.checked = check.negate ?? false; }} /> Negate</label>
        </div>
      )}
      {(check.kind === "exact-match" || check.kind === "contains") && (error?.field === "case-sensitive" || error?.field === "trim-whitespace" || error?.field === "negate") && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {check.kind === "regex" && (
        <div className="evaluation-check-options">
          <label>Flags <input className="evaluation-flags" defaultValue={check.flags ?? ""} placeholder="ims" onBlur={(event) => { if (!onCommit({ ...check, flags: event.target.value || undefined }, "flags")) event.currentTarget.value = check.flags ?? ""; }} /></label>
          <label><input type="checkbox" defaultChecked={check.negate ?? false} onChange={(event) => { if (!onCommit({ ...check, negate: event.target.checked }, "negate")) event.currentTarget.checked = check.negate ?? false; }} /> Negate</label>
        </div>
      )}
      {(error?.field === "flags" || (check.kind === "regex" && error?.field === "negate")) && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {check.kind === "valid-json" && (
        <div className="evaluation-check-options">
          <label>Top level <select defaultValue={check.topLevel ?? "any"} onChange={(event) => { if (!onCommit({ ...check, topLevel: event.target.value as "any" | "object" | "array" }, "top-level")) event.currentTarget.value = check.topLevel ?? "any"; }}><option value="any">Any JSON</option><option value="object">Object</option><option value="array">Array</option></select></label>
          <label><input type="checkbox" defaultChecked={check.negate ?? false} onChange={(event) => { if (!onCommit({ ...check, negate: event.target.checked }, "negate")) event.currentTarget.checked = check.negate ?? false; }} /> Negate</label>
        </div>
      )}
      {(error?.field === "top-level" || (check.kind === "valid-json" && error?.field === "negate")) && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {(check.kind === "max-output-characters" || check.kind === "max-duration-ms" || check.kind === "max-total-tokens") && (
        <label>Limit <input type="number" min="0" step="1" defaultValue={check.limit} onBlur={(event) => { if (!onCommit({ ...check, limit: Math.max(0, Math.floor(Number(event.target.value) || 0)) }, "limit")) event.currentTarget.value = String(check.limit); }} /></label>
      )}
      {error?.field === "limit" && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {(check.kind === "called-tool" || check.kind === "did-not-call-tool" || check.kind === "tool-call-arguments") && (
        <label>Tool name <input defaultValue={check.toolName} placeholder="get_weather" onBlur={(event) => { if (!onCommit({ ...check, toolName: event.target.value }, "tool-name")) event.currentTarget.value = check.toolName; }} /></label>
      )}
      {error?.field === "tool-name" && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {check.kind === "tool-call-count" && (
        <div className="evaluation-check-options">
          <label>Tool name <input defaultValue={check.toolName ?? ""} placeholder="Any tool" onBlur={(event) => { if (!onCommit({ ...check, toolName: event.target.value || undefined }, "tool-name")) event.currentTarget.value = check.toolName ?? ""; }} /></label>
          <label>Comparator <select defaultValue={check.comparator} onChange={(event) => { if (!onCommit({ ...check, comparator: event.target.value as ToolCallCountComparator }, "comparator")) event.currentTarget.value = check.comparator; }}><option value="exact">Exactly</option><option value="at-least">At least</option><option value="at-most">At most</option></select></label>
          <label>Count <input type="number" min="0" step="1" defaultValue={check.count} onBlur={(event) => { if (!onCommit({ ...check, count: Math.max(0, Math.floor(Number(event.target.value) || 0)) }, "count")) event.currentTarget.value = String(check.count); }} /></label>
        </div>
      )}
      {(error?.field === "comparator" || error?.field === "count") && <p className="evaluation-field-error" role="alert">{error.message}</p>}
      {check.kind === "tool-call-arguments" && (
        <label>Expected arguments (JSON subset)
          <textarea
            defaultValue={JSON.stringify(check.argumentsSubset, null, 2)}
            rows={4}
            onBlur={(event) => {
              let parsed: JsonObject;
              try {
                const value = JSON.parse(event.target.value || "{}");
                if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
                parsed = value as JsonObject;
              } catch {
                event.currentTarget.value = JSON.stringify(check.argumentsSubset, null, 2);
                return;
              }
              if (!onCommit({ ...check, argumentsSubset: parsed }, "arguments-subset")) {
                event.currentTarget.value = JSON.stringify(check.argumentsSubset, null, 2);
              }
            }}
          />
        </label>
      )}
      {error?.field === "arguments-subset" && <p className="evaluation-field-error" role="alert">{error.message}</p>}
    </article>
  );
}

function CaseEditor({ evaluationCase, authoring, source, onOpenSourceTrace }: {
  evaluationCase: EvaluationCase;
  authoring: EvaluationSuiteAuthoringHandle;
  source?: EvaluationCaseSource;
  onOpenSourceTrace?(source: EvaluationCaseSource): void;
}) {
  const [newKind, setNewKind] = useState<CheckKind>("contains");
  // Seeded from the case rather than driven by it: a controlled `open` would
  // snap the disclosure shut under the author whenever an unrelated edit
  // re-rendered. The editor is keyed by case id, so focusing another case
  // remounts and re-seeds this.
  const [referenceOpen, setReferenceOpen] = useState(Boolean(evaluationCase.referenceAnswer));
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const checkError = authoring.error?.target.kind === "check" && authoring.error.target.caseId === evaluationCase.id
    ? authoring.error
    : undefined;
  const addError = authoring.error?.target.kind === "add-check" && authoring.error.target.caseId === evaluationCase.id
    ? authoring.error.message
    : undefined;
  return (
    <section className="evaluation-case-detail" aria-label={`Edit ${evaluationCase.name}`}>
      <div className="evaluation-section-heading"><div><span className="eyebrow">Focused case</span><h3>{evaluationCase.name}</h3></div><button className="remove-button" type="button" onClick={() => authoring.deleteCase(evaluationCase.id)}>Delete case</button></div>
      <label>Case name <input aria-label={`Case name ${evaluationCase.name}`} defaultValue={evaluationCase.name} onBlur={(event) => {
        if (!authoring.renameCase(evaluationCase.id, event.target.value)) event.currentTarget.value = evaluationCase.name;
      }} /></label>
      {authoring.error?.target.kind === "case-name" && authoring.error.target.caseId === evaluationCase.id && <p className="evaluation-field-error" role="alert">{authoring.error.message}</p>}
      {source && onOpenSourceTrace && <button className="text-button" type="button" onClick={() => onOpenSourceTrace(source)}>Open source trace</button>}
      {suite && suite.inputBindings.length > 0 && (
        <div className="evaluation-case-values">
          <div><span className="eyebrow">Case inputs</span><p>Values inserted into this case’s prompt variables.</p></div>
          {suite.inputBindings.map((binding) => {
            const input = evaluationInputLabel(project!, authoring.revisionId, binding);
            return <label key={binding.id}>{input.label}
              <textarea aria-label={`${evaluationCase.name} ${input.variableName}`} rows={3} value={evaluationCase.values[binding.id] ?? ""} onChange={(event) => authoring.updateCase(evaluationCase.id, { values: { ...evaluationCase.values, [binding.id]: event.target.value } })} />
            </label>;
          })}
        </div>
      )}
      {/* Above the reference answer, not below it. Checks are what the case
          asserts and what an evaluation scores; the reference is an optional
          human note that nothing reads automatically, so it does not get the
          space directly under the inputs. */}
      <div className="evaluation-check-list">
        {evaluationCase.checks.length === 0 && <p className="evaluation-empty-inline">No deterministic checks yet.</p>}
        {evaluationCase.checks.map((check) => <CheckEditor key={check.checkId} check={check} error={checkError?.target.kind === "check" && checkError.target.checkId === check.checkId ? { field: checkError.target.field, message: checkError.message } : undefined} onCommit={(next, field) => authoring.updateCheck(evaluationCase.id, next, field)} onRemove={() => authoring.deleteCheck(evaluationCase.id, check.checkId)} />)}
      </div>
      <div className="evaluation-add-row">
        <select aria-label="New check kind" value={newKind} onChange={(event) => setNewKind(event.target.value as CheckKind)}>{checkKinds.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}</select>
        <button className="button secondary" type="button" onClick={() => {
          authoring.addCheck(evaluationCase.id, { kind: newKind });
        }}>+ Add check</button>
      </div>
      {addError && <p className="evaluation-field-error" role="alert">{addError}</p>}
      {/* Open when the case has one, so an existing reference is never hidden
          from the author who wrote it; shut otherwise, because an empty
          optional field should not outrank the checks. */}
      <details className="evaluation-reference-answer" open={referenceOpen} onToggle={(event) => setReferenceOpen(event.currentTarget.open)}>
        <summary>
          <DisclosureChevron className="evaluation-reference-chevron" />
          Reference answer
          <span>{evaluationCase.referenceAnswer ? "Written" : "Optional · not scored"}</span>
        </summary>
        <textarea aria-label={`Reference answer ${evaluationCase.name}`} rows={4} defaultValue={evaluationCase.referenceAnswer ?? ""} placeholder="Optional human reference; not scored automatically." onBlur={(event) => authoring.updateCase(evaluationCase.id, { referenceAnswer: event.target.value || undefined })} />
      </details>
    </section>
  );
}

export interface EvaluationSuiteExecutionActions {
  storage: "durable" | "unsaved";
  /**
   * The exact target and settings an execution would snapshot. Supplied by the
   * route because the connection, model, and inference options are session
   * execution state rather than portable evaluation content.
   */
  preview?: {
    targets: readonly {
      variantId: string;
      variantName: string;
      requirementName: string;
      targetName?: string;
      endpoint?: string;
      protocol: ProviderProtocol;
      model: string;
      responseMode: "streaming" | "buffered";
      options: InferenceOptions;
      streamingAvailable: boolean;
    }[];
  };
  disabledReason?: string;
  running: boolean;
  onStart(): void;
  /**
   * What serves each of the project's tools on this device, supplied by the
   * route. Which tools a suite exposes is portable content the suite owns;
   * what answers them is device-local, so the editor renders the join without
   * ever storing it.
   */
  toolBindings?: readonly ExperimentToolBinding[];
  /** Why command tools cannot run in this shell, when that is the case. */
  commandToolsUnavailableReason?: string;
}

/**
 * Model ids this device has pinned. They are session profile state rather than
 * portable evaluation content, so the route supplies them and the suite stores
 * nothing about them. Discovery is deliberately absent: a suite targets its own
 * connection requirement, which need not be the profile that is active, and
 * offering that profile's catalogue here would name models this target may not
 * serve.
 */
export interface ModelFavoritesHandle {
  models: string[];
  onToggle(model: string): void;
}

/**
 * Whether the suite's setup band is expanded. Owned by the route for the same
 * reason the history disclosure is: the Evaluations mode unmounts when another
 * mode is on screen, so state kept here would collapse on the way back.
 */
export interface EvaluationSetupDisclosure {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function EvaluationSuiteEditor({
  authoring,
  execution,
  history,
  modelFavorites,
  setup,
  onOpenTemplates,
  caseSource,
  onOpenSourceTrace,
}: {
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
  /** Saved executions of the selected suite, listed by the route. */
  history?: EvaluationSuiteHistoryHandle;
  modelFavorites?: ModelFavoritesHandle;
  setup?: EvaluationSetupDisclosure;
  /** Request-composer navigation stays with its owner. */
  onOpenTemplates?(): void;
  caseSource?: EvaluationCaseSource;
  onOpenSourceTrace?(source: EvaluationCaseSource): void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [renamingSuite, setRenamingSuite] = useState(false);
  const [suiteNameDraft, setSuiteNameDraft] = useState("");
  // Falls back to local state so the editor stays renderable on its own; the
  // mode supplies the durable one.
  const [localSetupOpen, setLocalSetupOpen] = useState(true);
  const setupOpen = setup ? setup.open : localSetupOpen;
  const setSetupOpen = setup ? setup.onOpenChange : setLocalSetupOpen;
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const focusedCase = suite?.cases.find(({ id }) => id === authoring.focusedCaseId);
  const selectedCount = authoring.selectedCaseIds.size;
  const selectedVariantCount = authoring.selectedVariantIds.size;
  const exposedToolIds = suite?.execution.toolIds ?? [];
  const turnCeiling = suite?.execution.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
  const batch = evaluationBatchGuardrail(selectedCount, selectedVariantCount, authoring.repetitions, {
    exposedToolCount: exposedToolIds.length,
    turnCeiling,
  });
  // A tool this suite exposes that nothing here can serve stops every
  // repetition, so it is named while the suite is being authored rather than
  // only at the moment someone tries to start it.
  const unboundExposedTools = (execution?.toolBindings ?? []).filter(
    ({ tool, binding }) => exposedToolIds.includes(tool.id) && !binding,
  );
  const availableCandidates = authoring.candidates.filter((candidate) => !suite?.inputBindings.some((binding) => binding.target.templateUseId === candidate.templateUseId && binding.target.variableName === candidate.variableName));
  const revisionGroups = groupRevisionChoices(authoring.revisionChoices);
  const resolvableMissingInput = authoring.diagnostics.find(
    (diagnostic) => diagnostic.code === "unresolved-template-variable" &&
      availableCandidates.some((candidate) => candidate.templateUseId === diagnostic.templateUseId && candidate.variableName === diagnostic.variableName),
  );
  const suggestedCandidate = resolvableMissingInput?.code === "unresolved-template-variable"
    ? availableCandidates.find((candidate) => candidate.templateUseId === resolvableMissingInput.templateUseId && candidate.variableName === resolvableMissingInput.variableName)
    : undefined;
  // The suite owns its delivery mode, but whether that mode can be served is a
  // property of the connection this device resolves. Preflight is where the two
  // meet, so it must not report "Ready to run" for a mode that cannot execute.
  const unavailableStreamingTarget = execution?.preview?.targets.find(
    ({ responseMode, streamingAvailable }) => responseMode === "streaming" && !streamingAvailable,
  );
  const deliveryIssue = unavailableStreamingTarget
    ? `Configuration “${unavailableStreamingTarget.variantName}” is set to Streaming, but ${unavailableStreamingTarget.targetName ?? "its mapped profile"} cannot stream. Choose Buffered delivery.`
    : undefined;
  // Device-local, like the delivery issue above and unlike a preflight
  // diagnostic: the suite is authored correctly, and this machine cannot run
  // it. Counted as a setup issue so the preflight badge cannot read "Ready to
  // run" beside a Start button that refuses.
  const bindingIssue = unboundExposedTools.length > 0
    ? `Nothing on this device serves ${unboundExposedTools.map(({ tool }) => tool.name).join(", ")}. Enable a mock or grant a command tool before starting.${execution?.commandToolsUnavailableReason ? ` ${execution.commandToolsUnavailableReason}` : ""}`
    : undefined;
  // Named in the collapsed summary, so which connection a suite targets stays
  // readable without expanding the panel that chooses it.
  const connectionName = suite
    ? project?.connectionRequirements.find(({ id }) => id === suite.execution.target.connectionRequirementId)?.name
      ?? suite.execution.target.connectionRequirementId
    : undefined;

  // Everything that blocks a start, in one list. It renders in the suite
  // header rather than in the setup band, because the band collapses and a
  // blocked primary action must state its reason in visible text either way.
  //
  // `execution.disabledReason` is the same policy read one step later, by the
  // route that owns the connection and the session. It contributes only when
  // the authoring-side list is empty, so a condition both of them see — an
  // unbound tool, a batch over the maximum — is stated once rather than twice.
  const authoredBlockers = [
    ...authoring.diagnostics.map(({ message }) => message),
    ...(batch.error ? [batch.error] : []),
    ...(deliveryIssue ? [deliveryIssue] : []),
    ...(bindingIssue ? [bindingIssue] : []),
  ];
  const blockers = authoredBlockers.length > 0
    ? authoredBlockers
    : execution?.disabledReason
      ? [execution.disabledReason]
      : [];
  // What the band is hiding while it is shut. Every fact here changes what a
  // start would do, so none of them may need an expansion to be read.
  const setupSummary = suite
    ? [
        connectionName,
        suite.execution.target.model || "No model",
        exposedToolIds.length === 0 ? "No tools" : `${exposedToolIds.length} exposed`,
        `${authoring.repetitions} ${authoring.repetitions === 1 ? "rep" : "reps"}`,
      ].filter(Boolean).join(" · ")
    : "";

  if (!project) return <PaneEmptyState eyebrow="Evaluations" heading="Open or save a project first" detail="Evaluation suites are portable project content, so they need a project document." />;

  return (
    <section aria-label="Evaluation suites" className={`evaluation-editor ${suite ? styles.workspace : styles.workspaceEmpty}`}>
      {!suite ? (
        <PaneEmptyState
          heading="No evaluation suites yet"
          detail="Create one to map prompt variables, author cases, and add deterministic checks."
          action={{ label: "Create evaluation suite", onClick: authoring.createSuite }}
        />
      ) : (
        <>
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className="eyebrow">Evaluation suite</span>
              <h2>{suite.name}</h2>
              <span className={styles.identitySpacer} />
              <button className="button secondary" type="button" onClick={() => { setSuiteNameDraft(suite.name); setRenamingSuite(true); }}>Rename</button>
              <button className="remove-button" type="button" onClick={authoring.deleteSuite}>Delete suite</button>
            </div>
            {renamingSuite && <form className="evaluation-suite-rename" onSubmit={(event) => {
              event.preventDefault();
              if (authoring.renameSuite(suiteNameDraft)) setRenamingSuite(false);
              else setSuiteNameDraft(suite.name);
            }}>
              <label>Suite name <input autoFocus value={suiteNameDraft} onChange={(event) => setSuiteNameDraft(event.target.value)} /></label>
              <button className="button primary" type="submit">Save name</button>
              <button className="text-button" type="button" onClick={() => setRenamingSuite(false)}>Cancel</button>
            </form>}
            {authoring.error?.target.kind === "suite-name" && <p className="evaluation-field-error" role="alert">{authoring.error.message}</p>}
            {authoring.error?.target.kind === "editor" && <div className="template-diagnostic" role="alert">{authoring.error.message}</div>}
            {authoring.savedPromptError && !authoring.savedPromptPickerOpen && <p className="evaluation-field-error" role="alert">{authoring.savedPromptError}</p>}
            {/* Preflight is the shared blocker chip, so the state of the
                Start button in the topbar and the reason it is in that state
                are one component with one policy behind it. The plan line
                rides inside the chip because how many provider calls a start
                would make is the other half of the same decision. */}
            <section className="evaluation-preflight" aria-label="Evaluation preflight">
              <BlockerChip
                label="Evaluation preflight"
                tone={blockers.length > 0 ? "blocked" : batch.warning ? "advisory" : "ready"}
                {...(blockers.length > 0 ? { noun: { one: "setup issue", many: "setup issues" } } : {})}
                summary={blockers[0] ?? batch.warning ?? "Ready to run"}
                summaryId={EVALUATION_PREFLIGHT_SUMMARY_ID}
                issues={blockers}
                {...(batch.warning && blockers.length > 0
                  ? { detail: `${batch.warning} Review the exact call count in confirmation before starting.` }
                  : batch.warning
                    ? { detail: "Review the exact call count in confirmation before starting." }
                    : {})}
              >
                {/* Outside the setup band deliberately: how many provider calls
                    the suite is about to make is the consequence of settings
                    the band hides, and it must stay readable while it is shut. */}
                <output><span>{selectedCount} {selectedCount === 1 ? "case" : "cases"}</span> × <span>{selectedVariantCount} {selectedVariantCount === 1 ? "configuration" : "configurations"}</span> × <span>{authoring.repetitions} {authoring.repetitions === 1 ? "rep" : "reps"}</span> → <strong>{Number.isFinite(batch.plannedCalls) ? batch.plannedCalls.toLocaleString() : "Invalid"} runs</strong>{exposedToolIds.length > 0 && Number.isFinite(batch.worstCaseCalls) && <span>, up to {batch.worstCaseCalls.toLocaleString()} provider calls</span>}</output>
              </BlockerChip>
              {execution && <small className="evaluation-storage-note">{execution.storage === "durable" ? "The plan, traces, and result will be saved in this project folder." : "Session evaluation: results will be lost when this session closes."}</small>}
            </section>
            {suggestedCandidate && <div className="evaluation-resolution-action" role="status"><div><strong>Add a case input for <code>{suggestedCandidate.variableName}</code></strong><span>Each case can then supply the missing value and clear this setup issue.</span></div><button className="button secondary" type="button" onClick={() => authoring.addInput(suggestedCandidate)}>+ Add case input</button></div>}
          </header>

          <div className={styles.setup}>
            {/* Expanded by default, so without a marked affordance the band
                reads as a heading and nobody discovers it can be shut — which
                is the move that gives the cases the rest of the height. */}
            <button aria-expanded={setupOpen} className={styles.setupToggle} type="button" onClick={() => setSetupOpen(!setupOpen)}>
              <DisclosureChevron className={styles.setupChevron} />
              <strong>Setup</strong>
              <span className={styles.setupFacts}>{setupSummary}</span>
              <span className={styles.setupHint}>{setupOpen ? "Hide" : "Show input, settings, and tools"}</span>
            </button>
            {setupOpen && <div className={`evaluation-setup ${styles.setupBody}`}>
              <div className="evaluation-input-summary">
                <span>Evaluation input</span>
                <strong>{authoring.selectedRevision ? revisionChoice(authoring.selectedRevision).label : "Input unavailable"}</strong>
                <small>This suite keeps its own immutable input; changing Messages does not change it.</small>
                <div className="evaluation-input-actions">
                  <button className="button secondary" type="button" onClick={authoring.openSavedPromptPicker}>Start from prompt…</button>
                  {/* Flat, not a disclosure: at full width the revision picker
                      costs one row, and hiding it behind a summary made an
                      author open something to discover the choice existed. */}
                  <label className="evaluation-input-picker">Existing project revision
                    <select value={authoring.revisionId} onChange={(event) => authoring.selectRevision(event.target.value as NonNullable<typeof authoring.revisionId>)}>
                    {revisionGroups.grouped ? (
                      <>
                        {/* Incompatible revisions stay selectable: choosing one is how an
                            author sees and repairs a historical incompatibility. */}
                        {revisionGroups.compatible.length > 0 && <optgroup label="Compatible revisions">{revisionGroups.compatible.map(revisionOption)}</optgroup>}
                        {revisionGroups.other.length > 0 && <optgroup label="Other revisions">{revisionGroups.other.map(revisionOption)}</optgroup>}
                      </>
                    ) : authoring.revisionChoices.map(revisionOption)}
                    </select>
                  </label>
                </div>
              </div>
              <section className="evaluation-configurations" aria-label="Configurations">
                <div className="evaluation-section-heading"><div><span className="eyebrow">Configurations</span><h3>Compare named configurations</h3></div><button className="button secondary" type="button" onClick={authoring.addVariant}>+ Add configuration</button></div>
                <p className="evaluation-portable-warning">Each configuration stores only its overrides. Repetitions, turn ceiling, and exposed tools are shared across every configuration.</p>
                {suite.variants.map((variant, index) => <ConfigurationRow key={variant.id} variant={variant} suite={suite} project={project} authoring={authoring} index={index} />)}
                {execution?.preview && <ul className="evaluation-configuration-targets" aria-label="Resolved local configuration targets">
                  {execution.preview.targets.map((target) => <li key={target.variantId}>
                    <strong>{target.variantName}</strong>: {target.targetName
                      ? <>{target.targetName} · <code>{target.endpoint}</code> · {target.model} · {target.responseMode}</>
                      : <>Map {target.requirementName} to a local profile</>}
                  </li>)}
                </ul>}
              </section>
              {/* Each edit commits, which the project's debounced auto-save
                  absorbs into one write. */}
              <InferenceSettingsPanel
                idPrefix="evaluation"
                label="Evaluation execution settings"
                heading="Execution settings"
                scopeLabel="Saved with this suite"
                inherited={{
                  label: "project defaults",
                  value: {
                    model: project.defaults.target.model,
                    // Isolated render fixtures may provide only the defaults
                    // fields this editor used before inheritance markers. A
                    // missing parent option means "provider default", exactly
                    // the portable schema's meaning for absent temperature.
                    temperature: project.defaults.options?.temperature,
                    responseMode: "buffered",
                  },
                }}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                value={{
                  model: suite.execution.target.model,
                  temperature: suite.execution.options.temperature,
                  responseMode: suite.execution.responseMode,
                }}
                onChange={(next) => authoring.updateExecution({
                  ...suite.execution,
                  target: { ...suite.execution.target, model: next.model },
                  responseMode: next.responseMode,
                  options: { ...suite.execution.options, temperature: next.temperature },
                })}
                // Discovery is deliberately absent here; see ModelFavoritesHandle.
                streamingAvailable={execution
                  ? execution.preview?.targets.every(({ streamingAvailable }) => streamingAvailable) ?? true
                  : true}
                favoriteModels={modelFavorites?.models ?? []}
                onToggleFavoriteModel={(model) => modelFavorites?.onToggle(model)}
                connection={{
                  summary: connectionName,
                  control: (
                    <label>Connection
                      <select value={suite.execution.target.connectionRequirementId} onChange={(event) => authoring.updateExecution({ ...suite.execution, target: { ...suite.execution.target, connectionRequirementId: event.target.value as typeof suite.execution.target.connectionRequirementId } })}>
                        {project.connectionRequirements.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </label>
                  ),
                  ...(suite.execution.target.connectionRequirementId !== project.defaults.target.connectionRequirementId
                    ? {
                        override: {
                          inheritedFrom: "project defaults",
                          onRevert: () => authoring.updateExecution({
                            ...suite.execution,
                            target: {
                              ...suite.execution.target,
                              connectionRequirementId: project.defaults.target.connectionRequirementId,
                            },
                          }),
                        },
                      }
                    : {}),
                }}
                repetitions={{
                  summary: `${authoring.repetitions} ${authoring.repetitions === 1 ? "rep" : "reps"}`,
                  control: <label className="inference-settings-count">Repetitions <input type="number" min="1" max={MAX_EVALUATION_REPETITIONS} step="1" value={authoring.repetitions} onChange={(event) => authoring.setRepetitions(Number(event.target.value))} /></label>,
                  ...(authoring.repetitions !== 1
                    ? {
                        override: {
                          inheritedFrom: "suite default",
                          onRevert: () => authoring.setRepetitions(1),
                        },
                      }
                    : {}),
                }}
              />
              {/* Exposure is portable suite content and what serves it is not,
                  so the two are rendered together and stored apart. Outside the
                  settings disclosure because a suite that runs tools is a
                  different kind of evaluation, not a tweak to this one. */}
              <div className="evaluation-tools">
                <div className="evaluation-tools-heading">
                  <strong>Tools</strong>
                  <span>{exposedToolIds.length === 0 ? "None exposed" : `${exposedToolIds.length} exposed`}</span>
                </div>
                {project.tools.length === 0
                  ? <small>This project defines no tools. Add one in the request composer’s Tools pane to expose it here.</small>
                  : <ul className="evaluation-tool-list">
                      {project.tools.map((tool) => {
                        const exposed = exposedToolIds.includes(tool.id);
                        const entry = execution?.toolBindings?.find(({ tool: candidate }) => candidate.id === tool.id);
                        return (
                          <li key={tool.id} className={exposed && entry && !entry.binding ? "evaluation-tool-unbound" : undefined}>
                            <label>
                              <input
                                type="checkbox"
                                checked={exposed}
                                onChange={(event) => authoring.setToolExposed(tool.id, event.target.checked)}
                              />
                              <code>{tool.name}</code>
                            </label>
                            {exposed && entry && <span> → {experimentToolBindingLabel(entry)}</span>}
                          </li>
                        );
                      })}
                    </ul>}
                {exposedToolIds.length > 0 && (
                  <label className="inference-settings-count">Turn ceiling
                    <input
                      type="number"
                      min={MIN_EXPERIMENT_TURN_CEILING}
                      max={MAX_EXPERIMENT_TURN_CEILING}
                      step="1"
                      value={turnCeiling}
                      onChange={(event) => authoring.setTurnCeiling(Number(event.target.value))}
                    />
                  </label>
                )}
                {exposedToolIds.length > 0 && <small>Each repetition answers its own tool calls and is failed if it reaches {turnCeiling} provider turns with calls outstanding.</small>}
              </div>
              {/* Suite-level, not per-case: binding a template variable changes
                  what every case can vary, so it belongs with the rest of the
                  suite's setup rather than above the dataset it applies to. */}
              {(suite.inputBindings.length > 0 || availableCandidates.length > 0) && (
                <div className="evaluation-input-manager">
                  <div className="evaluation-input-manager-heading"><div><strong>Case inputs</strong><span>Map prompt variables so cases can send different conversations.</span></div>{suite.inputBindings.length > 0 && <span>{suite.inputBindings.length} {suite.inputBindings.length === 1 ? "input" : "inputs"}</span>}</div>
                  {suite.inputBindings.map((binding) => {
                    const input = evaluationInputLabel(project, authoring.revisionId, binding);
                    return <div className="evaluation-binding-row" key={binding.id}><div className="evaluation-binding-identity"><strong>{input.templateName}</strong><span><code>{input.variableName}</code> prompt variable</span></div><button className="remove-button" type="button" onClick={() => authoring.deleteInput(binding.id)}>Remove</button></div>;
                  })}
                  {availableCandidates.length > 0 && <div className="evaluation-add-row"><select aria-label="Prompt variable to map" value={candidateIndex} onChange={(event) => setCandidateIndex(Number(event.target.value))}>{availableCandidates.map((candidate, index) => <option key={`${candidate.templateUseId}-${candidate.variableName}`} value={index}>{candidate.templateName} · {candidate.variableName}</option>)}</select><button className="button secondary" type="button" onClick={() => { const candidate = availableCandidates[candidateIndex]; if (candidate) authoring.addInput(candidate); setCandidateIndex(0); }}>+ Add case input</button></div>}
                </div>
              )}
              {history && <EvaluationSuiteHistory history={history} />}
            </div>}
          </div>

          <section className={`evaluation-cases ${styles.cases}`}>
            <div className="evaluation-section-heading"><div><span className="eyebrow">Dataset</span><h3>Cases</h3></div><button className="button secondary" type="button" onClick={authoring.addCase}>+ Add case</button></div>
            <p className="evaluation-portable-warning">Case values are saved in portable project data. Do not enter credentials or secrets.</p>
            {suite.cases.length === 0 ? <div className="evaluation-empty-inline">No cases yet. Empty suites can be saved but cannot run.</div> : (
              <div className={`evaluation-cases-workspace ${styles.casesWorkspace}`}>
                <aside className="evaluation-case-rail" aria-label="Evaluation cases">
                  {suite.cases.map((evaluationCase) => {
                    const summaries = suite.inputBindings.map((binding) => evaluationCase.values[binding.id]?.trim()).filter(Boolean);
                    return <div className={focusedCase?.id === evaluationCase.id ? "evaluation-case-list-item selected" : "evaluation-case-list-item"} key={evaluationCase.id}>
                      <label title={`Include ${evaluationCase.name} in this evaluation`}><input aria-label={`Select ${evaluationCase.name}`} type="checkbox" checked={authoring.selectedCaseIds.has(evaluationCase.id)} onChange={(event) => authoring.setCaseSelected(evaluationCase.id, event.target.checked)} /></label>
                      <button aria-current={focusedCase?.id === evaluationCase.id ? "true" : undefined} type="button" onClick={() => authoring.focusCase(evaluationCase.id)}><strong>{evaluationCase.name}</strong><span>{summaries.length > 0 ? summaries.join(" · ") : `${evaluationCase.checks.length} ${evaluationCase.checks.length === 1 ? "check" : "checks"}`}</span></button>
                      {summaries.length > 0 && <span className="evaluation-case-check-count">{evaluationCase.checks.length}</span>}
                    </div>;
                  })}
                </aside>
                {/* Keyed: without it, focusing another case reuses this
                    instance, and the uncontrolled fields — the case name and
                    the reference answer — keep the previous case's edited
                    text while the heading says otherwise. */}
                {focusedCase && <CaseEditor key={focusedCase.id} evaluationCase={focusedCase} authoring={authoring} {...(caseSource?.caseId === focusedCase.id ? { source: caseSource, onOpenSourceTrace } : {})} />}
              </div>
            )}
          </section>
        </>
      )}
      {authoring.savedPromptPickerOpen && (
        <SavedPromptDialog
          candidates={authoring.savedPromptCandidates}
          hasExistingBindings={(suite?.inputBindings.length ?? 0) > 0}
          {...(authoring.savedPromptError ? { error: authoring.savedPromptError } : {})}
          onCancel={authoring.closeSavedPromptPicker}
          onConfirm={authoring.startFromSavedPrompt}
          {...(onOpenTemplates ? { onOpenTemplates } : {})}
        />
      )}
    </section>
  );
}
