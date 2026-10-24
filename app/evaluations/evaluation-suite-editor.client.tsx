"use client";

import { useState } from "react";
import { StructuredCheckEditor } from "./structured-check-editor.client";
import { CHECK_KINDS, isDecisionCheckKind } from "../../packages/core/src/checks";
import type { CheckDefinition, CheckKind, ToolCallCountComparator } from "../../packages/core/src/checks";
import type { JsonObject } from "../../packages/core/src/run-kernel";
import type { EvaluationCase } from "../../packages/core/src/project";
import type { EvaluationCaseSource } from "../../packages/core/src/evaluation-case-sources";
import type { InferenceOptions, ProviderProtocol } from "../../packages/core/src/run-kernel";
import { DEFAULT_EXPERIMENT_TURN_CEILING } from "../../packages/core/src/experiment";
import { DisclosureChevron } from "../disclosure-chevron.client";
import { EditableTitle } from "../editable-title.client";
import type { ExperimentToolBinding } from "../../packages/core/src/tool-binding-resolution";
import { PaneEmptyState } from "../pane-empty-state.client";
import { SavedPromptDialog } from "./saved-prompt-dialog.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";
import type { EvaluationCheckAuthoringField } from "./use-evaluation-suite-authoring.client";
import { evaluationBatchGuardrail } from "./evaluation-batch.client";
import { availableBindingCandidates, ChatSuiteSetup, chatSuiteSetupFacts, evaluationInputLabel } from "./chat-suite-setup.client";
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
  "json-schema": "JSON Schema",
  "max-output-characters": "Maximum characters",
  "max-duration-ms": "Maximum duration",
  "max-total-tokens": "Maximum tokens",
  "called-tool": "Called tool",
  "did-not-call-tool": "Did not call tool",
  "tool-call-count": "Tool call count",
  "tool-call-arguments": "Tool call arguments",
  "decision-choice": "Choice is",
  "decision-option-probability": "Option probability",
  "decision-score-range": "Score range",
  "decision-noul": "Noul probability",
  "decision-confidence": "Confidence",
};

const checkKinds = CHECK_KINDS.map((kind) => ({ kind, label: checkKindLabels[kind] }));
// A chat suite is offered every kind that reads a chat run; decision kinds
// arrive with decision suites.
const offeredCheckKinds = checkKinds.filter(({ kind }) => !isDecisionCheckKind(kind));

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
      {(check.kind === "valid-json" || check.kind === "json-schema") && <StructuredCheckEditor check={check} onCommit={(next) => onCommit(next, "structured-check")} />}
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
      <div className="evaluation-section-heading"><div><span className="eyebrow">Focused case</span><EditableTitle label="Case name" value={evaluationCase.name} onCommit={(name) => authoring.renameCase(evaluationCase.id, name)} /></div><button className="remove-button" type="button" onClick={() => authoring.deleteCase(evaluationCase.id)}>Delete case</button></div>
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
        <select aria-label="New check kind" value={newKind} onChange={(event) => setNewKind(event.target.value as CheckKind)}>{offeredCheckKinds.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}</select>
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
  const setupFacts = project && suite ? chatSuiteSetupFacts(project, suite, execution) : undefined;
  const exposedToolCount = setupFacts?.batchShape.exposedToolCount ?? 0;
  const batch = evaluationBatchGuardrail(selectedCount, selectedVariantCount, authoring.repetitions, {
    exposedToolCount,
    turnCeiling: setupFacts?.batchShape.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING,
  });
  const availableCandidates = availableBindingCandidates(authoring, suite);
  const resolvableMissingInput = authoring.diagnostics.find(
    (diagnostic) => diagnostic.code === "unresolved-template-variable" &&
      availableCandidates.some((candidate) => candidate.templateUseId === diagnostic.templateUseId && candidate.variableName === diagnostic.variableName),
  );
  const suggestedCandidate = resolvableMissingInput?.code === "unresolved-template-variable"
    ? availableCandidates.find((candidate) => candidate.templateUseId === resolvableMissingInput.templateUseId && candidate.variableName === resolvableMissingInput.variableName)
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
    ...(setupFacts?.issues ?? []),
  ];
  const blockers = authoredBlockers.length > 0
    ? authoredBlockers
    : execution?.disabledReason
      ? [execution.disabledReason]
      : [];
  // What the band is hiding while it is shut. Every fact here changes what a
  // start would do, so none of them may need an expansion to be read.
  const setupSummary = setupFacts
    ? [
        ...setupFacts.summary,
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
              {/* Keyed by the suite: the rail switches which suite this header
                  describes without remounting, and a draft must not follow. */}
              <EditableTitle key={suite.id} heading="h2" label="Suite name" value={suite.name} onCommit={authoring.renameSuite} />
              <span className={styles.identitySpacer} />
              <button className="remove-button" type="button" onClick={authoring.deleteSuite}>Delete suite</button>
            </div>
            {authoring.error?.target.kind === "suite-name" && <p className="evaluation-field-error evaluation-suite-name-error" role="alert">{authoring.error.message}</p>}
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
                <output><span>{selectedCount} {selectedCount === 1 ? "case" : "cases"}</span> × <span>{selectedVariantCount} {selectedVariantCount === 1 ? "configuration" : "configurations"}</span> × <span>{authoring.repetitions} {authoring.repetitions === 1 ? "rep" : "reps"}</span> → <strong>{Number.isFinite(batch.plannedCalls) ? batch.plannedCalls.toLocaleString() : "Invalid"} runs</strong>{exposedToolCount > 0 && Number.isFinite(batch.worstCaseCalls) && <span>, up to {batch.worstCaseCalls.toLocaleString()} provider calls</span>}</output>
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
            <ChatSuiteSetup
              open={setupOpen}
              className={`evaluation-setup ${styles.setupBody}`}
              suite={suite}
              project={project}
              authoring={authoring}
              {...(execution ? { execution } : {})}
              {...(modelFavorites ? { modelFavorites } : {})}
            />
          </div>

          <section className={`evaluation-cases ${styles.cases}`}>
            <div className="evaluation-section-heading"><div><span className="eyebrow">Dataset</span><h3>Cases</h3></div>{suite.cases.length > 0 && <button className="button secondary" type="button" onClick={authoring.addCase}>+ Add case</button>}</div>
            <p className="evaluation-portable-warning">Case values are saved in portable project data. Do not enter credentials or secrets.</p>
            {suite.cases.length === 0 ? (
              // The primary next step for a fresh suite, not a peer of the
              // setup band above it: nothing here can run until a case
              // exists, so this is where the empty-suite author's attention
              // belongs.
              <PaneEmptyState
                heading="No cases yet"
                detail="A case supplies input values and the checks that score them. Empty suites can be saved but cannot run."
                action={{ label: "+ Add case", onClick: authoring.addCase }}
              />
            ) : (
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

          {/* A sibling of Cases, not part of Setup: evidence about past runs
              is not a decision about the next one, and the setup band should
              not carry its weight while collapsed. */}
          {history && <EvaluationSuiteHistory history={history} />}
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
