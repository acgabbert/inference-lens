"use client";

import { useRef, useState } from "react";
import { CHECK_KINDS } from "../../packages/core/src/checks";
import type { CheckDefinition, CheckKind } from "../../packages/core/src/checks";
import type { EvaluationCase } from "../../packages/core/src/project";
import { prepareProjectRevisionRun } from "../../packages/core/src/project";
import type { TemplateRunOverrides } from "../../packages/core/src/project";
import type { EvaluationInputBinding } from "../../packages/core/src/evaluation-suites";
import { conversationMessageText } from "../conversation-display";
import { FocusModeToggle, useFocusMode } from "../focus-mode.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";
import type { EvaluationCheckAuthoringField } from "./use-evaluation-suite-authoring.client";
import {
  evaluationBatchGuardrail,
  MAX_EVALUATION_REPETITIONS,
} from "./evaluation-batch.client";

const checkKindLabels: Record<CheckKind, string> = {
  "exact-match": "Exact output",
  contains: "Contains text",
  regex: "Safe regex",
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
        <strong>{checkKinds.find(({ kind }) => kind === check.kind)?.label}</strong>
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

function CaseEditor({ evaluationCase, authoring, execution }: {
  evaluationCase: EvaluationCase;
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
}) {
  const [newKind, setNewKind] = useState<CheckKind>("contains");
  const [regexPattern, setRegexPattern] = useState("");
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
      <CaseProviderInput evaluationCase={evaluationCase} authoring={authoring} execution={execution} />
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
        {newKind === "regex" && <label className="evaluation-new-regex">Pattern <input aria-label="New Safe regex pattern" value={regexPattern} onChange={(event) => setRegexPattern(event.target.value)} /></label>}
        <button className="button secondary" type="button" onClick={() => {
          const added = authoring.addCheck(evaluationCase.id, newKind === "regex" ? { kind: newKind, pattern: regexPattern } : { kind: newKind });
          if (added) setRegexPattern("");
        }}>+ Add check</button>
      </div>
      {addError && <p className="evaluation-field-error" role="alert">{addError}</p>}
    </section>
  );
}

function CaseProviderInput({ evaluationCase, authoring, execution }: {
  evaluationCase: EvaluationCase;
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
}) {
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const revision = project?.conversationRevisions.find(({ id }) => id === authoring.revisionId);
  if (!project || !suite || !revision) return null;

  const overrides: Record<string, Record<string, string>> = {};
  suite.inputBindings.forEach((binding) => {
    const values = overrides[binding.target.templateUseId] ?? {};
    values[binding.target.variableName] = evaluationCase.values[binding.id] ?? "";
    overrides[binding.target.templateUseId] = values;
  });
  const prepared = prepareProjectRevisionRun(project, revision, overrides as TemplateRunOverrides);

  return (
    <section className="evaluation-provider-input" aria-label={`Provider input for ${evaluationCase.name}`}>
      <div className="evaluation-section-heading">
        <div><span className="eyebrow">Provider input</span><h4>Resolved conversation</h4></div>
        {execution?.preview && <span className="evaluation-provider-target">{execution.preview.targetName} · {execution.preview.model}</span>}
      </div>
      {suite.inputBindings.length === 0
        ? <p className="evaluation-provider-sameness"><strong>All cases currently use this provider input.</strong> References and checks may still differ.</p>
        : <p>This case replaces the bound template values in the saved revision. Repetitions resend this same resolved input; other cases can resolve to different messages.</p>}
      {execution?.preview && <dl className="evaluation-provider-settings"><div><dt>Temperature</dt><dd>{execution.preview.temperature.toFixed(1)}</dd></div><div><dt>Delivery</dt><dd>{execution.preview.responseMode === "streaming" ? "Streaming" : "Buffered"}</dd></div><div><dt>Tools</dt><dd>None</dd></div></dl>}
      {prepared.ok ? (
        <div className="evaluation-provider-messages">
          {prepared.messages.map((message, index) => <article className="request-preview-message" key={`${message.id}-${index}`}><span className="eyebrow">{message.role}</span><pre>{conversationMessageText(message)}</pre></article>)}
        </div>
      ) : <div className="template-diagnostic" role="alert">{prepared.diagnostics[0]?.diagnostic.message ?? "This case cannot be resolved."}</div>}
    </section>
  );
}

export interface EvaluationSuiteExecutionActions {
  storage: "durable" | "unsaved";
  preview?: {
    targetName: string;
    model: string;
    temperature: number;
    responseMode: "streaming" | "buffered";
  };
  disabledReason?: string;
  running: boolean;
  onStart(): void;
}

export function EvaluationSuiteEditor({
  authoring,
  execution,
}: {
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
}) {
  const [focusMode, setFocusMode] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const containerRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const { close } = useFocusMode({ open: focusMode, setOpen: setFocusMode, containerRef, triggerRef: focusToggleRef, initialFocusSelector: "select" });
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const focusedCase = suite?.cases.find(({ id }) => id === authoring.focusedCaseId);
  const selectedCount = authoring.selectedCaseIds.size;
  const batch = evaluationBatchGuardrail(selectedCount, authoring.repetitions);
  const availableCandidates = authoring.candidates.filter((candidate) => !suite?.inputBindings.some((binding) => binding.target.templateUseId === candidate.templateUseId && binding.target.variableName === candidate.variableName));

  if (!project) return <div className="pane-empty-state"><span className="eyebrow">Evaluations</span><h3>Open or save a project first</h3><p>Evaluation suites are portable project content, so they need a project document.</p></div>;

  return (
    <section ref={containerRef} role={focusMode ? "dialog" : undefined} aria-modal={focusMode ? "true" : undefined} aria-label={focusMode ? "Evaluation editor focus mode" : "Evaluation suites"} className={focusMode ? "evaluation-editor focus-mode-surface evaluation-focus-mode" : "evaluation-editor"}>
      <div className="evaluation-toolbar">
        <label>Suite <select aria-label="Evaluation suite" value={authoring.suiteId ?? ""} onChange={(event) => authoring.selectSuite(event.target.value as NonNullable<typeof authoring.suiteId>)}>{project.evaluationSuites.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
        <button className="button secondary" type="button" onClick={authoring.createSuite}>+ New suite</button>
        <FocusModeToggle className="evaluation-focus-toggle" open={focusMode} subject="evaluation editor" toggleRef={focusToggleRef} onToggle={() => focusMode ? close() : setFocusMode(true)} />
      </div>
      {!suite ? (
        <div className="pane-empty-state"><h3>No evaluation suites yet</h3><p>Create one to bind template variables, author cases, and add deterministic checks.</p><button className="button primary" type="button" onClick={authoring.createSuite}>Create evaluation suite</button></div>
      ) : (
        <>
          <div className="evaluation-suite-header">
            <label>Suite name <input defaultValue={suite.name} key={suite.id} onBlur={(event) => {
              if (!authoring.renameSuite(event.target.value)) event.currentTarget.value = suite.name;
            }} /></label>
            <button className="remove-button" type="button" onClick={authoring.deleteSuite}>Delete suite</button>
          </div>
          {authoring.error?.target.kind === "suite-name" && <p className="evaluation-field-error" role="alert">{authoring.error.message}</p>}
          {authoring.error?.target.kind === "editor" && <div className="template-diagnostic" role="alert">{authoring.error.message}</div>}
          <section className="evaluation-preflight" aria-label="Evaluation preflight">
            <div className="evaluation-preflight-status"><span className="eyebrow">Preflight</span><strong>{authoring.diagnostics.length === 0 && !batch.error ? "Ready to run" : `${authoring.diagnostics.length + (batch.error ? 1 : 0)} setup ${authoring.diagnostics.length + (batch.error ? 1 : 0) === 1 ? "issue" : "issues"}`}</strong></div>
            <div className="evaluation-preflight-controls">
              <label>Base conversation revision <select value={authoring.revisionId} onChange={(event) => authoring.selectRevision(event.target.value as NonNullable<typeof authoring.revisionId>)}>{project.conversationRevisions.map((revision) => <option key={revision.id} value={revision.id}>{revision.id === project.defaults.conversationRevisionId ? "Current · " : ""}{new Date(revision.createdAt).toLocaleString()}</option>)}</select><small>Cases start from this saved project revision; session-only composer values and run overrides are excluded.</small></label>
              <div className="evaluation-batch-controls">
                <label>Repetitions <input type="number" min="1" max={MAX_EVALUATION_REPETITIONS} step="1" value={authoring.repetitions} onChange={(event) => authoring.setRepetitions(Number(event.target.value))} /></label>
                <output><span>{selectedCount} selected</span> × <span>{authoring.repetitions} {authoring.repetitions === 1 ? "rep" : "reps"}</span> → <strong>{Number.isFinite(batch.plannedCalls) ? batch.plannedCalls.toLocaleString() : "Invalid"} runs</strong></output>
              </div>
            </div>
            {execution && <div className="evaluation-start-area"><button className="button primary" type="button" disabled={execution.running || Boolean(execution.disabledReason) || authoring.diagnostics.length > 0 || Boolean(batch.error)} title={execution.disabledReason ?? batch.error} onClick={execution.onStart}>{execution.running ? "Evaluation running" : "Start evaluation…"}</button><small>{execution.storage === "durable" ? "The plan, traces, and result will be saved in this project folder." : "Session evaluation: results will be lost when this session closes."}</small></div>}
          </section>
          {batch.warning && <p className="evaluation-batch-warning" role="status"><strong>{batch.warning}</strong> Review the exact call count in confirmation before starting.</p>}
          {batch.error && <p className="evaluation-batch-warning error" role="alert">{batch.error}</p>}
          {authoring.diagnostics.length > 0 && <ul className="evaluation-diagnostics">{authoring.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>)}</ul>}

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
                {focusedCase && <CaseEditor evaluationCase={focusedCase} authoring={authoring} execution={execution} />}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
