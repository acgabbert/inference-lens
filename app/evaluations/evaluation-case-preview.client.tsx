"use client";

import type { EvaluationCase } from "../../packages/core/src/project";
import type { ConversationRevisionDescriptor } from "../../packages/core/src/conversation-revision-description";
import type {
  EvaluationCaseResolution,
  EvaluationValueSource,
} from "../../packages/core/src/evaluation-case-resolution";
import { promptTargetAdvisories } from "../../packages/core/src/prompt-target-advisory";
import type { InferenceOptions } from "../../packages/core/src/run-kernel";
import { conversationMessageText } from "../conversation-display";
import { PaneEmptyState } from "../pane-empty-state.client";
import { revisionChoice, revisionTime } from "./revision-choice.client";
import type { EvaluationSuiteExecutionActions } from "./evaluation-suite-editor.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";

const valueSourceLabels: Record<EvaluationValueSource, string> = {
  case: "Case value",
  "authored-use": "Authored use value",
  "template-default": "Prompt default",
};

/**
 * Renders only the options that are actually populated, so the settings region
 * shows what the plan will snapshot rather than a fixed grid of blanks. The
 * provider-default temperature is included explicitly because omission has
 * execution meaning; other non-finite values are dropped rather than
 * formatted, which is what keeps `NaN` out of a numeric preflight.
 */
function inferenceOptionRows(options: InferenceOptions): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  rows.push({
    label: "Temperature",
    value: options.temperature === undefined
      ? "Provider default"
      : Number.isFinite(options.temperature)
        ? options.temperature.toFixed(1)
        : "",
  });
  if (rows[0]!.value === "") rows.shift();
  if (Number.isFinite(options.maxOutputTokens)) {
    rows.push({ label: "Max output tokens", value: String(options.maxOutputTokens) });
  }
  if (Number.isFinite(options.seed)) rows.push({ label: "Seed", value: String(options.seed) });
  if (options.stop && options.stop.length > 0) {
    rows.push({ label: "Stop sequences", value: options.stop.join(" · ") });
  }
  if (options.providerOptions && Object.keys(options.providerOptions).length > 0) {
    rows.push({ label: "Provider options", value: JSON.stringify(options.providerOptions) });
  }
  return rows;
}

/** Region 1: which frozen revision this case resolves from, and what it pins. */
function RevisionProvenanceRegion({ descriptor, caseName }: {
  descriptor: ConversationRevisionDescriptor;
  caseName: string;
}) {
  return (
    <section className="evaluation-preflight-region" aria-label={`Revision provenance for ${caseName}`}>
      <h5>Revision provenance</h5>
      <p className="evaluation-provenance-label">{revisionChoice(descriptor).label}</p>
      {descriptor.templateUses.length === 0
        ? <p className="evaluation-empty-inline">No pinned prompts; this revision is authored messages only.</p>
        : <ul className="evaluation-provenance-uses">
            {descriptor.templateUses.map((use) => (
              <li key={use.templateUseId}>
                <strong>{use.templateName}</strong>
                <span>
                  {use.messageCount} {use.messageCount === 1 ? "message" : "messages"}
                  {" · "}
                  {use.pinnedToCurrentTemplateRevision
                    ? "pinned to the prompt’s current revision"
                    : "pinned to an earlier prompt revision"}
                </span>
              </li>
            ))}
          </ul>}
      {/* Still a disclosure with the pane's room to spare: revision and template
          revision IDs are a trust check an author opens deliberately, not
          something they read case to case. */}
      <details className="evaluation-provenance-details">
        <summary>Stable identity</summary>
        <dl>
          <div><dt>Revision</dt><dd><code>{descriptor.revisionId}</code></dd></div>
          <div><dt>Conversation</dt><dd><code>{descriptor.conversationId}</code></dd></div>
          {descriptor.templateUses.map((use) => (
            <div key={use.templateUseId}>
              <dt>{use.templateName} revision</dt>
              <dd><code>{use.templateRevisionId}</code></dd>
            </div>
          ))}
          <div><dt>Created</dt><dd>{revisionTime(descriptor.createdAt)}</dd></div>
        </dl>
      </details>
    </section>
  );
}

/** Region 2: every template variable, its effective value, and where it came from. */
function ResolvedValuesRegion({ resolution, caseName }: {
  resolution: EvaluationCaseResolution;
  caseName: string;
}) {
  return (
    <section className="evaluation-preflight-region" aria-label={`Resolved values for ${caseName}`}>
      <h5>Resolved values</h5>
      {resolution.variables.length === 0 && resolution.unresolvedBindings.length === 0 ? (
        <p className="evaluation-empty-inline">This revision’s prompts have no prompt variables.</p>
      ) : (
        // Wide content scrolls inside its own region rather than pushing the
        // pane past the viewport on a phone.
        <div className="evaluation-value-scroll">
        <table className="evaluation-value-table">
          <thead>
            <tr><th scope="col">Prompt</th><th scope="col">Variable</th><th scope="col">Value</th><th scope="col">Source</th></tr>
          </thead>
          <tbody>
            {resolution.variables.map((variable) => (
              <tr
                className={variable.source ? undefined : "evaluation-value-missing"}
                key={`${variable.templateUseId}-${variable.variableName}`}
              >
                <td>{variable.templateName}</td>
                <td><code>{variable.variableName}</code></td>
                {/* An empty string is a real, intentional override; saying so
                    beats rendering a blank cell that reads as "not set yet". */}
                <td>{variable.source === undefined
                  ? "No value at any level"
                  : variable.value === ""
                    ? "Empty value"
                    : variable.value}</td>
                <td>{variable.source === undefined
                  ? "Setup error"
                  : variable.source === "case"
                    ? `${valueSourceLabels.case} · ${variable.inputName ?? "case input"}`
                    : valueSourceLabels[variable.source]}</td>
              </tr>
            ))}
            {resolution.unresolvedBindings.map((binding) => (
              <tr className="evaluation-value-missing" key={binding.inputBindingId}>
                <td>Not in this revision</td>
                <td><code>{binding.variableName}</code></td>
                <td>Case input “{binding.inputName}” has nowhere to go</td>
                <td>{binding.reason === "missing-template-use"
                  ? "Setup error · revision has no such prompt use"
                  : "Setup error · prompt use has no such variable"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

/** Region 3: the exact ordered messages the plan will snapshot. */
function ResolvedConversationRegion({ resolution, caseName }: {
  resolution: EvaluationCaseResolution;
  caseName: string;
}) {
  return (
    <section className="evaluation-preflight-region" aria-label={`Resolved conversation for ${caseName}`}>
      <h5>Resolved conversation</h5>
      {resolution.ok ? (
        resolution.messages.length === 0
          ? <p className="evaluation-empty-inline">This revision resolves to no messages, so there is nothing to send.</p>
          : <div className="evaluation-provider-messages">
              {resolution.messages.map((message, index) => (
                <article className="request-preview-message" key={`${message.id}-${index}`}>
                  <span className="eyebrow">{message.role}</span>
                  <pre>{conversationMessageText(message)}</pre>
                </article>
              ))}
            </div>
      ) : (
        <div className="template-diagnostic" role="alert">
          {resolution.unresolvable
            ?? resolution.diagnostics[0]?.diagnostic.message
            ?? "This case cannot be resolved."}
        </div>
      )}
    </section>
  );
}

/** Region 4: the connection, protocol, model, delivery, options, and tools. */
function ExecutionSettingsRegion({ preview, caseName, toolNames }: {
  preview: NonNullable<EvaluationSuiteExecutionActions["preview"]>;
  caseName: string;
  /** Exactly the descriptors this suite's plan will snapshot, in project order. */
  toolNames: readonly string[];
}) {
  const options = inferenceOptionRows(preview.options);
  return (
    <section className="evaluation-preflight-region" aria-label={`Execution settings for ${caseName}`}>
      <h5>Execution settings</h5>
      <dl className="evaluation-provider-settings">
        <div><dt>Connection</dt><dd>{preview.targetName}</dd></div>
        <div><dt>Endpoint</dt><dd><code>{preview.endpoint || "Not set"}</code></dd></div>
        <div><dt>Protocol</dt><dd>{preview.protocol}</dd></div>
        <div><dt>Model</dt><dd>{preview.model || "Not set"}</dd></div>
        <div><dt>Delivery</dt><dd>{preview.responseMode === "streaming" ? "Streaming" : "Buffered"}</dd></div>
        {options.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        {/* The suite's own exposure, not the composer's: a tool switched on in
            Messages neither travels with this plan nor blocks this run. */}
        <div><dt>Tools</dt><dd>{toolNames.length === 0 ? "None" : toolNames.join(", ")}</dd></div>
      </dl>
    </section>
  );
}

/**
 * The exact provider input for the focused case, in the four regions an author
 * needs to trust it: which revision, which values and where each came from, the
 * messages themselves, and the settings around them.
 *
 * Everything here reads the one shared case projection the plan builder uses,
 * so the preview cannot drift from what an execution would snapshot.
 */
export function EvaluationCasePreview({ evaluationCase, authoring, execution }: {
  evaluationCase: EvaluationCase;
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
}) {
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const revision = project?.conversationRevisions.find(({ id }) => id === authoring.revisionId);
  const resolution = authoring.focusedCaseResolution;
  const descriptor = authoring.selectedRevision;
  if (!project || !suite || !revision || !resolution) return null;

  const advisories = execution?.preview
    ? promptTargetAdvisories(project, revision, {
        connectionRequirementId: suite.execution.target.connectionRequirementId,
        model: execution.preview.model,
      })
    : undefined;

  return (
    <section className="evaluation-provider-input" aria-label={`Provider input for ${evaluationCase.name}`}>
      {suite.inputBindings.length === 0
        ? <p className="evaluation-provider-sameness"><strong>All cases currently use this provider input.</strong> References and checks may still differ.</p>
        : <p>This case replaces the prompt values in the saved revision. Repetitions resend this same resolved input; other cases can resolve to different messages.</p>}
      {/* Advisory, never blocking, and never applied: one revision can pin
          several prompts while a provider call carries exactly one model. */}
      {advisories && advisories.distinctTargets.length > 1 && (
        <p className="evaluation-target-advisory" role="status">
          <strong>These prompts recommend different targets.</strong>{" "}
          {advisories.distinctTargets.map(({ connectionName, model }) => `${connectionName} · ${model}`).join(", ")}. No single evaluation target can match them all; the target below is unchanged.
        </p>
      )}
      {advisories && advisories.differing.length > 0 && advisories.distinctTargets.length === 1 && (
        <p className="evaluation-target-advisory" role="status">
          <strong>Advisory:</strong> {advisories.differing.map(({ templateName }) => templateName).join(", ")} {advisories.differing.length === 1 ? "was" : "were"} authored against {advisories.differing[0]!.connectionName} · {advisories.differing[0]!.model}. The evaluation target below is unchanged.
        </p>
      )}
      {descriptor && <RevisionProvenanceRegion caseName={evaluationCase.name} descriptor={descriptor} />}
      <ResolvedValuesRegion caseName={evaluationCase.name} resolution={resolution} />
      <ResolvedConversationRegion caseName={evaluationCase.name} resolution={resolution} />
      {execution?.preview && (
        <ExecutionSettingsRegion
          caseName={evaluationCase.name}
          preview={execution.preview}
          toolNames={project.tools
            .filter(({ id }) => suite.execution.toolIds.includes(id))
            .map(({ name }) => name)}
        />
      )}
    </section>
  );
}

/**
 * The response pane's occupant while an evaluation is being authored. The pane
 * split already means "edit on the left, read the consequence on the right"
 * everywhere else in the workbench; this is that relationship for evaluations,
 * and it hands the pane to the results workspace the moment a run starts.
 */
export function EvaluationPreviewWorkspace({ authoring, execution }: {
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
}) {
  const project = authoring.project;
  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const focusedCase = suite?.cases.find(({ id }) => id === authoring.focusedCaseId);
  return (
    <>
      <div className="panel-header result-header">
        <div><span className="eyebrow">Evaluation</span><h2>Provider input</h2></div>
        {focusedCase && (
          <div className="result-header-controls">
            <span className="evaluation-preview-case">{focusedCase.name}</span>
            {execution?.preview && (
              <span className="evaluation-provider-target">
                {execution.preview.targetName} · {execution.preview.model}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="evaluation-preview-scroll">
        {!project ? (
          <PaneEmptyState
            heading="Open or save a project first"
            detail="Evaluation suites are portable project content, so they need a project document."
          />
        ) : !suite ? (
          <PaneEmptyState
            heading="No evaluation suite selected"
            detail="Create or choose a suite in the Evaluations tab to see exactly what it will send."
          />
        ) : !focusedCase ? (
          <PaneEmptyState
            heading="No case focused"
            detail="Focus a case in the Evaluations tab to see the exact provider input it will send."
          />
        ) : (
          <EvaluationCasePreview
            evaluationCase={focusedCase}
            authoring={authoring}
            {...(execution ? { execution } : {})}
          />
        )}
      </div>
    </>
  );
}
