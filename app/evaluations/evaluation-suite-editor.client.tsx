"use client";

import { useRef, useState } from "react";
import { CHECK_KINDS } from "../../packages/core/src/checks";
import type { CheckDefinition, CheckKind } from "../../packages/core/src/checks";
import type { EvaluationCase } from "../../packages/core/src/project";
import { FocusModeToggle, useFocusMode } from "../focus-mode.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";

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

function CheckEditor({ check, onCommit, onRemove }: {
  check: CheckDefinition;
  onCommit(check: CheckDefinition): void;
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
      <label>Label <input defaultValue={check.label ?? ""} onBlur={(event) => onCommit({ ...check, ...(event.target.value ? { label: event.target.value } : { label: undefined }) })} /></label>
      {value !== undefined && (
        <label>{check.kind === "regex" ? "Pattern" : "Expected text"}
          <textarea defaultValue={value} rows={3} onBlur={(event) => onCommit((check.kind === "regex" ? { ...check, pattern: event.target.value } : { ...check, value: event.target.value }) as CheckDefinition)} />
        </label>
      )}
      {(check.kind === "exact-match" || check.kind === "contains") && (
        <div className="evaluation-check-options">
          <label><input type="checkbox" defaultChecked={check.caseSensitive !== false} onChange={(event) => onCommit({ ...check, caseSensitive: event.target.checked })} /> Case sensitive</label>
          <label><input type="checkbox" defaultChecked={check.trimWhitespace ?? false} onChange={(event) => onCommit({ ...check, trimWhitespace: event.target.checked })} /> Trim whitespace</label>
          <label><input type="checkbox" defaultChecked={check.negate ?? false} onChange={(event) => onCommit({ ...check, negate: event.target.checked })} /> Negate</label>
        </div>
      )}
      {check.kind === "regex" && (
        <div className="evaluation-check-options">
          <label>Flags <input className="evaluation-flags" defaultValue={check.flags ?? ""} placeholder="ims" onBlur={(event) => onCommit({ ...check, flags: event.target.value || undefined })} /></label>
          <label><input type="checkbox" defaultChecked={check.negate ?? false} onChange={(event) => onCommit({ ...check, negate: event.target.checked })} /> Negate</label>
        </div>
      )}
      {check.kind === "valid-json" && (
        <div className="evaluation-check-options">
          <label>Top level <select defaultValue={check.topLevel ?? "any"} onChange={(event) => onCommit({ ...check, topLevel: event.target.value as "any" | "object" | "array" })}><option value="any">Any JSON</option><option value="object">Object</option><option value="array">Array</option></select></label>
          <label><input type="checkbox" defaultChecked={check.negate ?? false} onChange={(event) => onCommit({ ...check, negate: event.target.checked })} /> Negate</label>
        </div>
      )}
      {(check.kind === "max-output-characters" || check.kind === "max-duration-ms" || check.kind === "max-total-tokens") && (
        <label>Limit <input type="number" min="0" step="1" defaultValue={check.limit} onBlur={(event) => onCommit({ ...check, limit: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} /></label>
      )}
    </article>
  );
}

function CaseChecks({ evaluationCase, authoring }: { evaluationCase: EvaluationCase; authoring: EvaluationSuiteAuthoringHandle }) {
  const [newKind, setNewKind] = useState<CheckKind>("contains");
  return (
    <section className="evaluation-case-detail" aria-label={`Checks for ${evaluationCase.name}`}>
      <div className="evaluation-section-heading"><div><span className="eyebrow">Focused case</span><h3>{evaluationCase.name}</h3></div><button className="remove-button" type="button" onClick={() => authoring.deleteCase(evaluationCase.id)}>Delete case</button></div>
      <label>Reference answer <textarea rows={4} defaultValue={evaluationCase.referenceAnswer ?? ""} placeholder="Optional human reference; not scored automatically." onBlur={(event) => authoring.updateCase(evaluationCase.id, { referenceAnswer: event.target.value || undefined })} /></label>
      <div className="evaluation-check-list">
        {evaluationCase.checks.length === 0 && <p className="evaluation-empty-inline">No deterministic checks yet.</p>}
        {evaluationCase.checks.map((check) => <CheckEditor key={check.checkId} check={check} onCommit={(next) => authoring.updateCheck(evaluationCase.id, next)} onRemove={() => authoring.deleteCheck(evaluationCase.id, check.checkId)} />)}
      </div>
      <div className="evaluation-add-row"><select aria-label="New check kind" value={newKind} onChange={(event) => setNewKind(event.target.value as CheckKind)}>{checkKinds.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}</select><button className="button secondary" type="button" onClick={() => authoring.addCheck(evaluationCase.id, newKind)}>+ Add check</button></div>
    </section>
  );
}

export function EvaluationSuiteEditor({ authoring }: { authoring: EvaluationSuiteAuthoringHandle }) {
  const [focusMode, setFocusMode] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const containerRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const { close } = useFocusMode({ open: focusMode, setOpen: setFocusMode, containerRef, triggerRef: focusToggleRef, initialFocusSelector: "select" });
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const focusedCase = suite?.cases.find(({ id }) => id === authoring.focusedCaseId);
  const selectedCount = authoring.selectedCaseIds.size;
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
            <label>Suite name <input defaultValue={suite.name} key={suite.id} onBlur={(event) => authoring.renameSuite(event.target.value || suite.name)} /></label>
            <button className="remove-button" type="button" onClick={authoring.deleteSuite}>Delete suite</button>
          </div>
          {authoring.error && <div className="template-diagnostic" role="alert">{authoring.error}</div>}
          <section className="evaluation-preflight" aria-label="Evaluation preflight">
            <div><span className="eyebrow">Preflight</span><strong>{authoring.diagnostics.length === 0 ? "Ready to author" : `${authoring.diagnostics.length} setup ${authoring.diagnostics.length === 1 ? "issue" : "issues"}`}</strong></div>
            <label>Conversation revision <select value={authoring.revisionId} onChange={(event) => authoring.selectRevision(event.target.value as NonNullable<typeof authoring.revisionId>)}>{project.conversationRevisions.map((revision) => <option key={revision.id} value={revision.id}>{revision.id === project.defaults.conversationRevisionId ? "Current · " : ""}{new Date(revision.createdAt).toLocaleString()}</option>)}</select></label>
            <label>Repetitions <input type="number" min="1" max="100" value={authoring.repetitions} onChange={(event) => authoring.setRepetitions(Number(event.target.value))} /></label>
            <output>{selectedCount} cases × {authoring.repetitions} = <strong>{selectedCount * authoring.repetitions} planned runs</strong></output>
          </section>
          {authoring.diagnostics.length > 0 && <ul className="evaluation-diagnostics">{authoring.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>)}</ul>}

          <section className="evaluation-inputs">
            <div className="evaluation-section-heading"><div><span className="eyebrow">Dataset columns</span><h3>Template-variable inputs</h3></div></div>
            {suite.inputBindings.map((binding) => <div className="evaluation-binding-row" key={binding.id}><input aria-label={`Input name ${binding.name}`} defaultValue={binding.name} onBlur={(event) => authoring.renameInput(binding.id, event.target.value || binding.name)} /><code>{binding.target.variableName}</code><span title={binding.target.templateUseId}>{binding.target.templateUseId}</span><button className="remove-button" type="button" onClick={() => authoring.deleteInput(binding.id)}>Remove</button></div>)}
            <div className="evaluation-add-row"><select aria-label="Template variable to bind" value={candidateIndex} disabled={availableCandidates.length === 0} onChange={(event) => setCandidateIndex(Number(event.target.value))}>{availableCandidates.map((candidate, index) => <option key={`${candidate.templateUseId}-${candidate.variableName}`} value={index}>{candidate.templateName} · {candidate.variableName}</option>)}</select><button className="button secondary" type="button" disabled={availableCandidates.length === 0} onClick={() => { const candidate = availableCandidates[candidateIndex]; if (candidate) authoring.addInput(candidate); setCandidateIndex(0); }}>+ Bind input</button></div>
          </section>

          <section className="evaluation-cases">
            <div className="evaluation-section-heading"><div><span className="eyebrow">Dataset</span><h3>Cases</h3></div><button className="button secondary" type="button" onClick={authoring.addCase}>+ Add case</button></div>
            <p className="evaluation-portable-warning">Case values are saved in portable project data. Do not enter credentials or secrets.</p>
            {suite.cases.length === 0 ? <div className="evaluation-empty-inline">No cases yet. Empty suites can be saved but cannot run.</div> : (
              <div className="evaluation-grid-scroll"><table className="evaluation-case-grid"><thead><tr><th scope="col">Run</th><th scope="col">Case</th>{suite.inputBindings.map((binding) => <th scope="col" key={binding.id}>{binding.name}</th>)}<th scope="col">Checks</th></tr></thead><tbody>{suite.cases.map((evaluationCase) => <tr key={evaluationCase.id}><td><input aria-label={`Select ${evaluationCase.name}`} type="checkbox" checked={authoring.selectedCaseIds.has(evaluationCase.id)} onChange={(event) => authoring.setCaseSelected(evaluationCase.id, event.target.checked)} /></td><td><input aria-label={`Case name ${evaluationCase.name}`} defaultValue={evaluationCase.name} onBlur={(event) => authoring.updateCase(evaluationCase.id, { name: event.target.value || evaluationCase.name })} /></td>{suite.inputBindings.map((binding) => <td key={binding.id}><textarea aria-label={`${evaluationCase.name} ${binding.name}`} rows={2} value={evaluationCase.values[binding.id] ?? ""} onChange={(event) => authoring.updateCase(evaluationCase.id, { values: { ...evaluationCase.values, [binding.id]: event.target.value } })} /></td>)}<td><button className={focusedCase?.id === evaluationCase.id ? "button secondary selected" : "button secondary"} type="button" onClick={() => authoring.focusCase(evaluationCase.id)}>{evaluationCase.checks.length} · Edit</button></td></tr>)}</tbody></table></div>
            )}
          </section>
          {focusedCase && <CaseChecks evaluationCase={focusedCase} authoring={authoring} />}
        </>
      )}
    </section>
  );
}
