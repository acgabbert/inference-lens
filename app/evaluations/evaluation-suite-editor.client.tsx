"use client";

import { useRef, useState } from "react";
import { CHECK_KINDS } from "../../packages/core/src/checks";
import type { CheckDefinition, CheckKind } from "../../packages/core/src/checks";
import type { EvaluationCase } from "../../packages/core/src/project";
import type { EvaluationInputBinding } from "../../packages/core/src/evaluation-suites";
import type { ConversationRevisionDescriptor } from "../../packages/core/src/conversation-revision-description";
import type { InferenceOptions, ProviderProtocol } from "../../packages/core/src/run-kernel";
import { FocusModeToggle, useFocusMode } from "../focus-mode.client";
import { InferenceSettingsPanel } from "../inference-settings-panel.client";
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

const checkKindLabels: Record<CheckKind, string> = {
  "exact-match": "Exact output",
  contains: "Contains text",
  regex: "Regex",
  "valid-json": "Valid JSON",
  "max-output-characters": "Maximum characters",
  "max-duration-ms": "Maximum duration",
  "max-total-tokens": "Maximum tokens",
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
    ? project.promptTemplates.find(({ id }) => id === templateUse.use.templateId)?.name ?? "Template"
    : "Template";
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
    </article>
  );
}

function CaseEditor({ evaluationCase, authoring }: {
  evaluationCase: EvaluationCase;
  authoring: EvaluationSuiteAuthoringHandle;
}) {
  const [newKind, setNewKind] = useState<CheckKind>("contains");
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
      {suite && suite.inputBindings.length > 0 && (
        <div className="evaluation-case-values">
          <div><span className="eyebrow">Case inputs</span><p>Values inserted into this case’s bound template variables.</p></div>
          {suite.inputBindings.map((binding) => {
            const input = evaluationInputLabel(project!, authoring.revisionId, binding);
            return <label key={binding.id}>{input.label}
              <textarea aria-label={`${evaluationCase.name} ${input.variableName}`} rows={3} value={evaluationCase.values[binding.id] ?? ""} onChange={(event) => authoring.updateCase(evaluationCase.id, { values: { ...evaluationCase.values, [binding.id]: event.target.value } })} />
            </label>;
          })}
        </div>
      )}
      <label>Reference answer <textarea rows={4} defaultValue={evaluationCase.referenceAnswer ?? ""} placeholder="Optional human reference; not scored automatically." onBlur={(event) => authoring.updateCase(evaluationCase.id, { referenceAnswer: event.target.value || undefined })} /></label>
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
    targetName: string;
    endpoint: string;
    protocol: ProviderProtocol;
    model: string;
    responseMode: "streaming" | "buffered";
    options: InferenceOptions;
    streamingAvailable: boolean;
  };
  disabledReason?: string;
  running: boolean;
  onStart(): void;
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

export function EvaluationSuiteEditor({
  authoring,
  execution,
  history,
  modelFavorites,
  onOpenTemplates,
}: {
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
  /** Saved executions of the selected suite, listed by the route. */
  history?: EvaluationSuiteHistoryHandle;
  modelFavorites?: ModelFavoritesHandle;
  /** Request-composer navigation stays with its owner. */
  onOpenTemplates?(): void;
}) {
  const [focusMode, setFocusMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [renamingSuite, setRenamingSuite] = useState(false);
  const [suiteNameDraft, setSuiteNameDraft] = useState("");
  const containerRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const { close } = useFocusMode({ open: focusMode, setOpen: setFocusMode, containerRef, triggerRef: focusToggleRef, initialFocusSelector: "select" });
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const focusedCase = suite?.cases.find(({ id }) => id === authoring.focusedCaseId);
  const selectedCount = authoring.selectedCaseIds.size;
  const batch = evaluationBatchGuardrail(selectedCount, authoring.repetitions);
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
  const deliveryIssue = suite && execution?.preview && suite.execution.responseMode === "streaming" && !execution.preview.streamingAvailable
    ? `This evaluation is set to Streaming, but ${execution.preview.targetName} cannot stream. Choose Buffered delivery.`
    : undefined;
  const issueCount = authoring.diagnostics.length + (batch.error ? 1 : 0) + (deliveryIssue ? 1 : 0);
  // Named in the collapsed summary, so which connection a suite targets stays
  // readable without expanding the panel that chooses it.
  const connectionName = suite
    ? project?.connectionRequirements.find(({ id }) => id === suite.execution.target.connectionRequirementId)?.name
      ?? suite.execution.target.connectionRequirementId
    : undefined;

  if (!project) return <PaneEmptyState eyebrow="Evaluations" heading="Open or save a project first" detail="Evaluation suites are portable project content, so they need a project document." />;

  return (
    <section ref={containerRef} role={focusMode ? "dialog" : undefined} aria-modal={focusMode ? "true" : undefined} aria-label={focusMode ? "Evaluation editor focus mode" : "Evaluation suites"} className={focusMode ? "evaluation-editor focus-mode-surface evaluation-focus-mode" : "evaluation-editor"}>
      <div className="evaluation-toolbar">
        <label>Suite <select aria-label="Evaluation suite" value={authoring.suiteId ?? ""} onChange={(event) => authoring.selectSuite(event.target.value as NonNullable<typeof authoring.suiteId>)}>{project.evaluationSuites.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
        <button className="button secondary" type="button" onClick={authoring.createSuite}>+ New suite</button>
        {suite && <button className="button secondary" type="button" onClick={() => { setSuiteNameDraft(suite.name); setRenamingSuite(true); }}>Rename</button>}
        {suite && <button className="remove-button" type="button" onClick={authoring.deleteSuite}>Delete suite</button>}
        <FocusModeToggle className="evaluation-focus-toggle" open={focusMode} subject="evaluation editor" toggleRef={focusToggleRef} onToggle={() => focusMode ? close() : setFocusMode(true)} />
      </div>
      {!suite ? (
        <PaneEmptyState
          heading="No evaluation suites yet"
          detail="Create one to bind template variables, author cases, and add deterministic checks."
          action={{ label: "Create evaluation suite", onClick: authoring.createSuite }}
        />
      ) : (
        <>
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
          {authoring.notice && <p className="evaluation-authoring-notice" role="status">
            <strong>Evaluation input now uses “{authoring.notice.templateName}”.</strong> It pins {authoring.notice.messageCount} {authoring.notice.messageCount === 1 ? "message" : "messages"} and {authoring.notice.variableCount === 0 ? "no variables" : `${authoring.notice.variableCount} ${authoring.notice.variableCount === 1 ? "variable" : "variables"}`}. Messages was not changed.
            <button className="text-button" type="button" onClick={authoring.dismissNotice}>Dismiss</button>
          </p>}
          {authoring.savedPromptError && !authoring.savedPromptPickerOpen && <p className="evaluation-field-error" role="alert">{authoring.savedPromptError}</p>}
          <section className="evaluation-preflight" aria-label="Evaluation preflight">
            <div className="evaluation-preflight-status"><span className="eyebrow">Preflight</span><strong>{issueCount === 0 ? "Ready to run" : `${issueCount} setup ${issueCount === 1 ? "issue" : "issues"}`}</strong></div>
            <div className="evaluation-preflight-controls">
              <div className="evaluation-input-summary">
                <span>Evaluation input</span>
                <strong>{authoring.selectedRevision ? revisionChoice(authoring.selectedRevision).label : "Input unavailable"}</strong>
                <small>This suite keeps its own immutable input; changing Messages does not change it.</small>
                <button className="button secondary" type="button" onClick={authoring.openSavedPromptPicker}>Start from saved prompt…</button>
                <details className="evaluation-input-picker">
                  <summary>Use a project revision…</summary>
                  <label>Existing project revision
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
                </details>
              </div>
              {/* Each edit commits, which the project's debounced auto-save
                  absorbs into one write. */}
              <InferenceSettingsPanel
                idPrefix="evaluation"
                label="Evaluation execution settings"
                heading="Execution settings"
                scopeNote="Saved with this suite"
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
                streamingAvailable={execution ? Boolean(execution.preview?.streamingAvailable) : true}
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
                }}
                repetitions={{
                  summary: `${authoring.repetitions} ${authoring.repetitions === 1 ? "rep" : "reps"}`,
                  control: <label className="inference-settings-count">Repetitions <input type="number" min="1" max={MAX_EVALUATION_REPETITIONS} step="1" value={authoring.repetitions} onChange={(event) => authoring.setRepetitions(Number(event.target.value))} /></label>,
                }}
              />
              {/* Outside the panel deliberately: how many provider calls the
                  suite is about to make is the consequence of these settings,
                  and it must stay readable while the panel is collapsed. */}
              <output><span>{selectedCount} selected</span> × <span>{authoring.repetitions} {authoring.repetitions === 1 ? "rep" : "reps"}</span> → <strong>{Number.isFinite(batch.plannedCalls) ? batch.plannedCalls.toLocaleString() : "Invalid"} runs</strong></output>
            </div>
            {execution && <div className="evaluation-start-area"><button className="button primary" type="button" disabled={execution.running || Boolean(execution.disabledReason) || issueCount > 0} title={execution.disabledReason ?? batch.error} onClick={execution.onStart}>{execution.running ? "Evaluation running" : "Start evaluation…"}</button>
              {/* A disabled primary action must say why in text, not only in a
                  tooltip a keyboard or touch author never sees. */}
              {!execution.running && execution.disabledReason && authoring.diagnostics.length === 0 && <small className="evaluation-start-blocked">{execution.disabledReason}</small>}
              <small>{execution.storage === "durable" ? "The plan, traces, and result will be saved in this project folder." : "Session evaluation: results will be lost when this session closes."}</small></div>}
          </section>
          {batch.warning && <p className="evaluation-batch-warning" role="status"><strong>{batch.warning}</strong> Review the exact call count in confirmation before starting.</p>}
          {batch.error && <p className="evaluation-batch-warning error" role="alert">{batch.error}</p>}
          {(authoring.diagnostics.length > 0 || deliveryIssue) && <ul className="evaluation-diagnostics">
            {authoring.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>)}
            {deliveryIssue && <li key="delivery">{deliveryIssue}</li>}
          </ul>}
          {history && <EvaluationSuiteHistory history={history} />}
          {suggestedCandidate && <div className="evaluation-resolution-action" role="status"><div><strong>Add a case input for <code>{suggestedCandidate.variableName}</code></strong><span>Each case can then supply the missing value and clear this setup issue.</span></div><button className="button secondary" type="button" onClick={() => authoring.addInput(suggestedCandidate)}>+ Add case input</button></div>}

          <section className="evaluation-cases">
            <div className="evaluation-section-heading"><div><span className="eyebrow">Dataset</span><h3>Cases</h3></div><button className="button secondary" type="button" onClick={authoring.addCase}>+ Add case</button></div>
            <p className="evaluation-portable-warning">Case values are saved in portable project data. Do not enter credentials or secrets.</p>
            {(suite.inputBindings.length > 0 || availableCandidates.length > 0) && (
              <div className="evaluation-input-manager">
                <div className="evaluation-input-manager-heading"><div><strong>Case inputs</strong><span>Bind template variables so cases can send different conversations.</span></div>{suite.inputBindings.length > 0 && <span>{suite.inputBindings.length} {suite.inputBindings.length === 1 ? "input" : "inputs"}</span>}</div>
                {suite.inputBindings.map((binding) => {
                  const input = evaluationInputLabel(project, authoring.revisionId, binding);
                  return <div className="evaluation-binding-row" key={binding.id}><div className="evaluation-binding-identity"><strong>{input.templateName}</strong><span><code>{input.variableName}</code> template variable</span></div><button className="remove-button" type="button" onClick={() => authoring.deleteInput(binding.id)}>Remove</button></div>;
                })}
                {availableCandidates.length > 0 && <div className="evaluation-add-row"><select aria-label="Template variable to bind" value={candidateIndex} onChange={(event) => setCandidateIndex(Number(event.target.value))}>{availableCandidates.map((candidate, index) => <option key={`${candidate.templateUseId}-${candidate.variableName}`} value={index}>{candidate.templateName} · {candidate.variableName}</option>)}</select><button className="button secondary" type="button" onClick={() => { const candidate = availableCandidates[candidateIndex]; if (candidate) authoring.addInput(candidate); setCandidateIndex(0); }}>+ Add case input</button></div>}
              </div>
            )}
            {suite.cases.length === 0 ? <div className="evaluation-empty-inline">No cases yet. Empty suites can be saved but cannot run.</div> : (
              <div className="evaluation-cases-workspace">
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
                {focusedCase && <CaseEditor evaluationCase={focusedCase} authoring={authoring} />}
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
