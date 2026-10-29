"use client";

import { useState } from "react";
import type { ChatEvaluationSuite } from "../../packages/core/src/project";
import { resolveEvaluationVariant } from "../../packages/core/src/evaluation-suites";
import type { EvaluationInputBinding, EvaluationVariant } from "../../packages/core/src/evaluation-suites";
import type { ConversationRevisionDescriptor } from "../../packages/core/src/conversation-revision-description";
import type { ProviderWireProtocol } from "../../packages/core/src/run-kernel";
import { PROVIDER_WIRE_PROTOCOLS } from "../../packages/core/src/run-kernel/types";
import { protocolLabel } from "../../packages/core/src/provider-protocols";
import {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "../../packages/core/src/experiment";
import { InferenceSettingsPanel } from "../inference-settings-panel.client";
import { DisclosureChevron } from "../disclosure-chevron.client";
import { experimentToolBindingLabel } from "../run/experiment-tool-bindings.client";
import { groupRevisionChoices, revisionChoice } from "./revision-choice.client";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client";
import { MAX_EVALUATION_REPETITIONS } from "../../packages/runner/src/evaluation-batch-limits";
import type { EvaluationSuiteExecutionActions, ModelFavoritesHandle } from "./evaluation-suite-editor.client";

type AuthoredProject = NonNullable<EvaluationSuiteAuthoringHandle["project"]>;

/**
 * What a suite kind's setup tells the editor that hosts it. The editor owns
 * the header, the preflight chip, and the collapsible band; each kind owns
 * what goes inside the band and the facts that band would otherwise hide.
 */
export interface SuiteSetupFacts {
  /**
   * Device-local reasons a start would be refused that authoring preflight
   * cannot see. Each counts as a setup issue, so the chip never reads "Ready
   * to run" beside a Start button that refuses.
   */
  issues: string[];
  /** Named in the collapsed band, ahead of the repetition count. */
  summary: string[];
  /** Tool exposure bounds the worst-case provider call count. */
  batchShape: { exposedToolCount: number; turnCeiling: number };
}

export function chatSuiteSetupFacts(
  project: AuthoredProject,
  suite: ChatEvaluationSuite,
  execution: EvaluationSuiteExecutionActions | undefined,
): SuiteSetupFacts {
  const exposedToolIds = suite.execution.toolIds;
  const turnCeiling = suite.execution.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
  // A tool this suite exposes that nothing here can serve stops every
  // repetition, so it is named while the suite is being authored rather than
  // only at the moment someone tries to start it.
  const unboundExposedTools = (execution?.toolBindings ?? []).filter(
    ({ tool, binding }) => exposedToolIds.includes(tool.id) && !binding,
  );
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
  // it.
  const bindingIssue = unboundExposedTools.length > 0
    ? `Nothing on this device serves ${unboundExposedTools.map(({ tool }) => tool.name).join(", ")}. Enable a mock or grant a command tool before starting.${execution?.commandToolsUnavailableReason ? ` ${execution.commandToolsUnavailableReason}` : ""}`
    : undefined;
  return {
    issues: [
      ...(deliveryIssue ? [deliveryIssue] : []),
      ...(bindingIssue ? [bindingIssue] : []),
    ],
    summary: [
      connectionName(project, suite),
      suite.execution.target.model || "No model",
      exposedToolIds.length === 0 ? "No tools" : `${exposedToolIds.length} exposed`,
    ],
    batchShape: { exposedToolCount: exposedToolIds.length, turnCeiling },
  };
}

// Named in the collapsed summary, so which connection a suite targets stays
// readable without expanding the panel that chooses it.
function connectionName(project: AuthoredProject, suite: ChatEvaluationSuite): string {
  return project.connectionRequirements.find(({ id }) => id === suite.execution.target.connectionRequirementId)?.name
    ?? suite.execution.target.connectionRequirementId;
}

/** Prompt variables of the selected revision that no binding maps yet. */
export function availableBindingCandidates(
  authoring: EvaluationSuiteAuthoringHandle,
  suite: ChatEvaluationSuite | undefined,
): EvaluationSuiteAuthoringHandle["candidates"] {
  return authoring.candidates.filter((candidate) => !suite?.inputBindings.some((binding) =>
    binding.target.templateUseId === candidate.templateUseId && binding.target.variableName === candidate.variableName
  ));
}

export function evaluationInputLabel(
  project: AuthoredProject,
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

/**
 * Every protocol, not only what some local profile has enabled: a suite is
 * portable, and whether this device can serve its choice is the start gate's
 * question, answered per configuration against the profile it maps to.
 */
function ProtocolOptions() {
  return <>{PROVIDER_WIRE_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocolLabel(protocol)}</option>)}</>;
}

function hasVariantOverride(overrides: EvaluationVariant["overrides"]): boolean {
  return (
    overrides.target?.connectionRequirementId !== undefined ||
    overrides.target?.model !== undefined ||
    overrides.target?.protocol !== undefined ||
    overrides.responseMode !== undefined ||
    Object.keys(overrides.options ?? {}).length > 0
  );
}

function configurationsSummary(variants: readonly EvaluationVariant[]): string {
  if (variants.length === 1) {
    const only = variants[0]!;
    return `1 configuration (${only.name}${hasVariantOverride(only.overrides) ? "" : ", inherits everything"})`;
  }
  return `${variants.length} configurations: ${variants.map(({ name }) => name).join(", ")}`;
}

/**
 * Collapsed unless there is more than one configuration or any of them
 * overrides the suite's shared execution — the one case where the concept
 * can stay out of the way of a first suite's setup.
 */
function ConfigurationsSection({
  suite,
  project,
  authoring,
  preview,
}: {
  suite: ChatEvaluationSuite;
  project: AuthoredProject;
  authoring: EvaluationSuiteAuthoringHandle;
  preview?: EvaluationSuiteExecutionActions["preview"];
}) {
  const [open, setOpen] = useState(
    suite.variants.length > 1 || suite.variants.some(({ overrides }) => hasVariantOverride(overrides)),
  );
  return (
    <section className="evaluation-configurations" aria-label="Configurations">
      <div className="evaluation-section-heading">
        <button
          aria-expanded={open}
          className="evaluation-section-toggle"
          type="button"
          onClick={() => setOpen(!open)}
        >
          <DisclosureChevron className="evaluation-section-chevron" />
          <span className="eyebrow">Configurations</span>
          <span className="evaluation-section-facts">{configurationsSummary(suite.variants)}</span>
        </button>
        {/* Opens the disclosure along with adding the row: a row an author
            just asked for is never left hidden behind the summary they were
            trying to get past. */}
        <button className="button secondary" type="button" onClick={() => { authoring.addVariant(); setOpen(true); }}>+ Add configuration</button>
      </div>
      {open && <>
        {suite.variants.map((variant, index) => <ConfigurationRow key={variant.id} variant={variant} suite={suite} project={project} authoring={authoring} index={index} />)}
        {preview && <ul className="evaluation-configuration-targets" aria-label="Resolved local configuration targets">
          {preview.targets.map((target) => <li key={target.variantId}>
            <strong>{target.variantName}</strong>: {target.targetName
              ? <>{target.targetName} · <code>{target.endpoint}</code> · {target.model} · {target.responseMode}</>
              : <>Map {target.requirementName} to a local profile</>}
          </li>)}
        </ul>}
      </>}
    </section>
  );
}

/**
 * Collapsed unless the suite already exposes a tool — an evaluation that
 * exists to test tool use should not have to open a disclosure to see that
 * about itself.
 */
function ToolsSection({
  project,
  authoring,
  exposedToolIds,
  turnCeiling,
  toolBindings,
}: {
  project: AuthoredProject;
  authoring: EvaluationSuiteAuthoringHandle;
  exposedToolIds: readonly string[];
  turnCeiling: number;
  toolBindings?: EvaluationSuiteExecutionActions["toolBindings"];
}) {
  const [open, setOpen] = useState(exposedToolIds.length > 0);
  return (
    <div className="evaluation-tools">
      <button
        aria-expanded={open}
        className="evaluation-section-toggle"
        type="button"
        onClick={() => setOpen(!open)}
      >
        <DisclosureChevron className="evaluation-section-chevron" />
        <strong>Tools</strong>
        <span className="evaluation-section-facts">{exposedToolIds.length === 0 ? "None exposed" : `${exposedToolIds.length} exposed`}</span>
      </button>
      {open && <>
        {project.tools.length === 0
          ? <small>This project defines no tools. Add one in the request composer’s Tools pane to expose it here.</small>
          : <ul className="evaluation-tool-list">
              {project.tools.map((tool) => {
                const exposed = exposedToolIds.includes(tool.id);
                const entry = toolBindings?.find(({ tool: candidate }) => candidate.id === tool.id);
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
      </>}
    </div>
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
  suite: ChatEvaluationSuite;
  project: AuthoredProject;
  authoring: EvaluationSuiteAuthoringHandle;
  index: number;
}) {
  const effective = resolveEvaluationVariant(suite, variant);
  const inherited = (field: "connection" | "model" | "protocol" | "delivery" | "temperature") => field === "connection"
    ? variant.overrides.target?.connectionRequirementId === undefined
    : field === "model"
      ? variant.overrides.target?.model === undefined
      : field === "protocol"
        ? variant.overrides.target?.protocol === undefined
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
      <label>Protocol <select aria-label={`Configuration protocol ${variant.name}`} value={effective.target.protocol} onChange={(event) => update({ ...variant.overrides, target: { ...variant.overrides.target, protocol: event.target.value as ProviderWireProtocol } })}><ProtocolOptions /></select><small>{inherited("protocol") ? "Inherits suite protocol" : "Overrides suite protocol"}</small></label>
      <label>Delivery <select aria-label={`Configuration delivery ${variant.name}`} value={effective.responseMode} onChange={(event) => update({ ...variant.overrides, responseMode: event.target.value as typeof effective.responseMode })}><option value="buffered">Buffered</option><option value="streaming">Streaming</option></select><small>{inherited("delivery") ? "Inherits suite delivery" : "Overrides suite delivery"}</small></label>
      <label>Temperature <input aria-label={`Configuration temperature ${variant.name}`} type="number" step="0.1" value={effective.options.temperature ?? ""} onChange={(event) => update({ ...variant.overrides, options: { ...variant.overrides.options, temperature: event.target.value === "" ? null : Number(event.target.value) } })} /><small>{inherited("temperature") ? "Inherits suite option" : variant.overrides.options?.temperature === null ? "Uses provider default" : "Overrides suite option"}</small></label>
    </div>
    {/* The per-field captions above already say what is inherited versus
        overridden; this line only earns its place once an override exists,
        because before that it restates the captions in one denser sentence. */}
    {hasVariantOverride(variant.overrides) && <p className="evaluation-portable-warning">Effective: {project.connectionRequirements.find(({ id }) => id === effective.target.connectionRequirementId)?.name ?? effective.target.connectionRequirementId} · {effective.target.model} · {protocolLabel(effective.target.protocol)} · {effective.responseMode} · temperature {effective.options.temperature ?? "provider default"} · max output {effective.options.maxOutputTokens ?? "provider default"} · seed {effective.options.seed ?? "provider default"} · stop {effective.options.stop?.join(", ") || "provider default"} · provider options {effective.options.providerOptions ? "set" : "provider default"}</p>}
  </article>;
}

/**
 * A chat suite's setup band: its conversation input, configurations,
 * execution settings, tools, and prompt-variable bindings.
 *
 * Stays mounted while the band is shut and renders nothing, so the settings
 * disclosure and the candidate picker keep their state across a collapse, as
 * they did when the editor held them.
 */
export function ChatSuiteSetup({
  open,
  className,
  suite,
  project,
  authoring,
  execution,
  modelFavorites,
}: {
  open: boolean;
  className: string;
  suite: ChatEvaluationSuite;
  project: AuthoredProject;
  authoring: EvaluationSuiteAuthoringHandle;
  execution?: EvaluationSuiteExecutionActions;
  modelFavorites?: ModelFavoritesHandle;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  if (!open) return null;

  const selectedInputRevision = project.conversationRevisions.find(({ id }) => id === authoring.revisionId);
  const stalePromptUses = selectedInputRevision?.items.flatMap((item) => {
    if (item.kind !== "template-use") return [];
    const template = project.promptTemplates.find(({ id }) => id === item.use.templateId);
    return template && template.currentRevisionId !== item.use.templateRevisionId
      ? [{ templateUseId: item.use.id, templateName: template.name }]
      : [];
  }) ?? [];
  const exposedToolIds = suite.execution.toolIds;
  const turnCeiling = suite.execution.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
  const availableCandidates = availableBindingCandidates(authoring, suite);
  const revisionGroups = groupRevisionChoices(authoring.revisionChoices);

  return (
    <div className={className}>
      <div className="evaluation-input-summary">
        <span>Evaluation input</span>
        {authoring.promptPinNotice && <div className="evaluation-resolution-action" role="status">
          <div><strong>Input pinned to {authoring.promptPinNotice.promptName} · {authoring.promptPinNotice.revisionLabel}</strong></div>
          <button className="button secondary" type="button" onClick={authoring.dismissPromptPinNotice} aria-label="Dismiss">Dismiss</button>
        </div>}
        <div className="evaluation-input-actions">
          <button className="button secondary" type="button" onClick={authoring.openSavedPromptPicker}>Start from prompt…</button>
          {/* Flat, not a disclosure: at full width the revision picker
              costs one row, and hiding it behind a summary made an
              author open something to discover the choice existed.
              The selected option is the fact; no separate label or
              bold restatement duplicates it. */}
          <select className="evaluation-input-picker" aria-label="Existing project revision" value={authoring.revisionId} onChange={(event) => authoring.selectRevision(event.target.value as NonNullable<typeof authoring.revisionId>)}>
          {revisionGroups.grouped ? (
            <>
              {/* Incompatible revisions stay selectable: choosing one is how an
                  author sees and repairs a historical incompatibility. */}
              {revisionGroups.compatible.length > 0 && <optgroup label="Compatible revisions">{revisionGroups.compatible.map(revisionOption)}</optgroup>}
              {revisionGroups.other.length > 0 && <optgroup label="Other revisions">{revisionGroups.other.map(revisionOption)}</optgroup>}
            </>
          ) : authoring.revisionChoices.map(revisionOption)}
          </select>
        </div>
        {stalePromptUses.length > 0 && <div className="evaluation-resolution-action evaluation-resolution-action-compact" role="status">
          <span>{stalePromptUses.length === 1 ? `Newer revision of “${stalePromptUses[0]!.templateName}” exists` : `${stalePromptUses.length} pinned prompts have newer revisions`}</span>
          {stalePromptUses.map((use) => <button className="text-button" key={use.templateUseId} type="button" onClick={() => authoring.useCurrentPromptRevision(use.templateUseId)}>Use current {use.templateName} revision</button>)}
        </div>}
      </div>
      <ConfigurationsSection
        key={`${suite.id}:configurations`}
        suite={suite}
        project={project}
        authoring={authoring}
        {...(execution?.preview ? { preview: execution.preview } : {})}
      />
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
          summary: connectionName(project, suite),
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
        protocol={{
          summary: protocolLabel(suite.execution.target.protocol),
          control: (
            <label>Protocol
              <select value={suite.execution.target.protocol} onChange={(event) => authoring.updateExecution({ ...suite.execution, target: { ...suite.execution.target, protocol: event.target.value as ProviderWireProtocol } })}>
                <ProtocolOptions />
              </select>
            </label>
          ),
          ...(suite.execution.target.protocol !== project.defaults.target.protocol
            ? {
                override: {
                  inheritedFrom: "project defaults",
                  onRevert: () => authoring.updateExecution({
                    ...suite.execution,
                    target: { ...suite.execution.target, protocol: project.defaults.target.protocol },
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
      <ToolsSection
        key={`${suite.id}:tools`}
        project={project}
        authoring={authoring}
        exposedToolIds={exposedToolIds}
        turnCeiling={turnCeiling}
        {...(execution?.toolBindings ? { toolBindings: execution.toolBindings } : {})}
      />
      {/* Suite-level, not per-case: binding a template variable changes
          what every case can vary, so it belongs with the rest of the
          suite's setup rather than above the dataset it applies to.
          "Prompt variables" so this stays distinct from the case
          editor's "Case inputs", which supplies the values these
          bindings only name. One compact row per binding, no
          surrounding card. */}
      {(suite.inputBindings.length > 0 || availableCandidates.length > 0) && (
        <div className="evaluation-input-bindings">
          <span className="eyebrow">Prompt variables</span>
          {suite.inputBindings.map((binding) => {
            const input = evaluationInputLabel(project, authoring.revisionId, binding);
            return <div className="evaluation-binding-row" key={binding.id}><div className="evaluation-binding-identity"><strong>{input.templateName}</strong><span><code>{input.variableName}</code> prompt variable</span></div><button className="remove-button" type="button" onClick={() => authoring.deleteInput(binding.id)}>Remove</button></div>;
          })}
          {availableCandidates.length > 0 && <div className="evaluation-add-row"><select aria-label="Prompt variable to map" value={candidateIndex} onChange={(event) => setCandidateIndex(Number(event.target.value))}>{availableCandidates.map((candidate, index) => <option key={`${candidate.templateUseId}-${candidate.variableName}`} value={index}>{candidate.templateName} · {candidate.variableName}</option>)}</select><button className="button secondary" type="button" onClick={() => { const candidate = availableCandidates[candidateIndex]; if (candidate) authoring.addInput(candidate); setCandidateIndex(0); }}>+ Add case input</button></div>}
        </div>
      )}
    </div>
  );
}
