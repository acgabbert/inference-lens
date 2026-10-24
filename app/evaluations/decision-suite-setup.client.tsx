"use client";

import { useState } from "react";
import { resolveDecisionEvaluationVariant } from "../../packages/core/src/evaluation-suites";
import type { DecisionEvaluationSuite } from "../../packages/core/src/evaluation-suites";
import type { ProjectFile } from "../../packages/core/src/project";
import type { DecisionRequestRevisionId } from "../../packages/core/src/run-kernel/types";
import { MAX_EVALUATION_REPETITIONS } from "../../packages/runner/src/evaluation-batch-limits";
import type { SuiteSetupFacts } from "./chat-suite-setup.client";
import type { EvaluationSuiteExecutionActions } from "./evaluation-suite-editor.client";
import type { DecisionSuiteSettingsHandle } from "./use-decision-suite-settings.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";

function connectionName(project: ProjectFile, suite: DecisionEvaluationSuite): string {
  return project.connectionRequirements.find(({ id }) => id === suite.execution.target.connectionRequirementId)?.name
    ?? suite.execution.target.connectionRequirementId;
}

/** What a decision suite's band tells the editor (see `SuiteSetupFacts`). */
export function decisionSuiteSetupFacts(
  project: ProjectFile,
  suite: DecisionEvaluationSuite,
  execution: EvaluationSuiteExecutionActions | undefined,
): SuiteSetupFacts {
  const revision = project.decisionRequestRevisions.find(({ id }) => id === suite.input.decisionRequestRevisionId);
  const request = revision && project.decisionRequests.find(({ id }) => id === revision.decisionRequestId);
  return {
    issues: [
      ...(revision ? [] : ["The decision request revision this suite pins no longer exists. Choose another in Setup."]),
      // Device-local, like a chat suite's delivery issue: the suite is
      // authored correctly and this machine cannot serve it.
      ...(execution?.decisionTargetIssues ?? []),
    ],
    summary: [
      request?.name ?? "Missing request",
      connectionName(project, suite),
      suite.execution.target.model,
    ],
    // One exchange per repetition, and never a tool.
    batchShape: { exposedToolCount: 0, turnCeiling: 1 },
  };
}

/**
 * A decision suite's setup band (D51): the pinned request revision, the
 * target, repetitions, configurations' models, and case inputs. Like the chat
 * band it renders nothing while shut and keeps its own disclosure state.
 */
export function DecisionSuiteSetup({
  open,
  className,
  project,
  authoring,
  settings,
}: {
  open: boolean;
  className: string;
  project: ProjectFile;
  authoring: EvaluationSuiteAuthoringHandle;
  settings: DecisionSuiteSettingsHandle;
}) {
  const [candidateIndex, setCandidateIndex] = useState(0);
  if (!open) return null;
  const { suite } = settings;
  const { target } = suite.execution;

  return (
    <div className={className}>
      <div className="evaluation-input-summary">
        <span>Decision request</span>
        <div className="evaluation-input-actions">
          <select
            className="evaluation-input-picker"
            aria-label="Decision request revision"
            value={suite.input.decisionRequestRevisionId}
            onChange={(event) => settings.selectRevision(event.target.value as DecisionRequestRevisionId)}
          >
            {!settings.pinnedRevision && <option value={suite.input.decisionRequestRevisionId}>Missing revision</option>}
            {settings.requests.map((request) => (
              <optgroup key={request.name} label={request.name}>
                {request.revisions.map(({ revisionId, label }) => <option key={revisionId} value={revisionId}>{label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {settings.pinnedRevision && <small>
          {Object.keys(settings.pinnedRevision.decision.questions).length} questions · pinned, so later edits in Decision Compose make a new revision
        </small>}
      </div>
      {settings.error && <p className="evaluation-field-error" role="alert">{settings.error}</p>}

      <div className="evaluation-settings-grid" role="group" aria-label="Decision target">
        <label>Connection
          <select aria-label="Decision suite connection" value={target.connectionRequirementId} onChange={(event) => settings.setConnection(event.target.value as typeof target.connectionRequirementId)}>
            {project.connectionRequirements.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
          <small>Its mapped profile must declare System One.</small>
        </label>
        {/* Committed on blur: the project refuses an empty model, and a
            keystroke-by-keystroke commit would reject the field as it is
            cleared to type a new one. */}
        <label>Model
          <input key={`${suite.id}:${target.model}`} aria-label="Decision suite model" defaultValue={target.model} onBlur={(event) => {
            const model = event.target.value.trim();
            if (model && model !== target.model) settings.setModel(model);
            else event.currentTarget.value = target.model;
          }} />
        </label>
        <label className="inference-settings-count">Repetitions
          <input type="number" aria-label="Decision suite repetitions" min="1" max={MAX_EVALUATION_REPETITIONS} step="1" value={suite.execution.repetitions} onChange={(event) => settings.setRepetitions(Number(event.target.value))} />
        </label>
      </div>

      <section className="evaluation-configurations" aria-label="Configurations">
        <div className="evaluation-section-heading">
          <span className="eyebrow">Configurations</span>
          <button className="button secondary" type="button" onClick={authoring.addVariant}>+ Add configuration</button>
        </div>
        {suite.variants.map((variant, index) => {
          const effective = resolveDecisionEvaluationVariant(suite, variant);
          const inherits = variant.overrides.target?.model === undefined;
          return (
            <article className="evaluation-configuration-card" aria-label={`Configuration ${variant.name}`} key={variant.id}>
              <div className="evaluation-check-heading"><strong>Configuration {index + 1}</strong><div>
                <label title={`Include ${variant.name} in this evaluation`}><input aria-label={`Include configuration ${variant.name}`} type="checkbox" checked={authoring.selectedVariantIds.has(variant.id)} onChange={(event) => authoring.setVariantSelected(variant.id, event.target.checked)} /> Include</label>
                {suite.variants.length > 1 && <button className="remove-button" type="button" onClick={() => authoring.deleteVariant(variant.id)}>Delete</button>}
              </div></div>
              <div className="evaluation-settings-grid">
                <label>Name <input key={`${variant.id}:${variant.name}`} aria-label={`Configuration name ${index + 1}`} defaultValue={variant.name} onBlur={(event) => {
                  if (event.target.value !== variant.name) settings.updateVariant(variant.id, { name: event.target.value, ...(inherits ? {} : { model: effective.model }) });
                }} /></label>
                {/* Empty inherits the suite's model rather than meaning "no model". */}
                <label>Model <input key={`${variant.id}:${effective.model}:${inherits}`} aria-label={`Configuration model ${variant.name}`} defaultValue={inherits ? "" : effective.model} placeholder={target.model} onBlur={(event) => {
                  const model = event.target.value.trim();
                  settings.updateVariant(variant.id, { name: variant.name, ...(model ? { model } : {}) });
                }} /><small>{inherits ? "Inherits suite model" : "Overrides suite model"}</small></label>
              </div>
            </article>
          );
        })}
      </section>

      {(suite.inputBindings.length > 0 || settings.candidates.length > 0) && (
        <div className="evaluation-input-bindings">
          <span className="eyebrow">Request variables</span>
          {suite.inputBindings.map((binding) => (
            <div className="evaluation-binding-row" key={binding.id}>
              <div className="evaluation-binding-identity"><strong>{binding.name}</strong><span><code>{binding.target.variableName}</code> request variable</span></div>
              <button className="remove-button" type="button" onClick={() => authoring.deleteInput(binding.id)}>Remove</button>
            </div>
          ))}
          {settings.candidates.length > 0 && <div className="evaluation-add-row">
            <select aria-label="Request variable to vary" value={Math.min(candidateIndex, settings.candidates.length - 1)} onChange={(event) => setCandidateIndex(Number(event.target.value))}>
              {settings.candidates.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
            <button className="button secondary" type="button" onClick={() => {
              const name = settings.candidates[Math.min(candidateIndex, settings.candidates.length - 1)];
              if (name) settings.addInput(name);
              setCandidateIndex(0);
            }}>+ Add case input</button>
          </div>}
          <small>A variable without a case input keeps the revision’s value.</small>
        </div>
      )}
    </div>
  );
}
