"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DecisionInput } from "../../packages/core/src/decision";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import { diffDecisionPromptTemplateRevisions } from "../../packages/core/src/decision-template-revision-diff";
import { isSensitiveTemplateVariableName } from "../../packages/core/src/project";
import type {
  ConnectionRequirement,
  DecisionPromptTemplate,
  DecisionPromptTemplateRevision,
  PromptTemplate,
  PromptTemplateRecommendedTarget,
} from "../../packages/core/src/project";
import type { PromptTemplateId, PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import { DecisionInputEditor } from "../decisions/decision-composer.client";
import { decisionDraftFromInput, validateDecisionDraft } from "../decisions/decision-draft";
import { useDecisionDraft, type DecisionDraftSnapshot } from "../decisions/use-decision-draft.client";
import { PaneTabs } from "../workbench-shell.client";
import type { DecisionTemplateEditorMemoryStore } from "./decision-template-editor-memory.client";
import { DecisionRevisionDiff } from "./decision-revision-diff.client";
import { hasDuplicatePromptName } from "./prompt-library";
import { defaultComparedRevisionId, promptRevisionLabel, promptRevisionPositionLabel } from "./prompt-revision-label";
import { RevisionField } from "./revision-rename.client";
import { DecisionPromptEvaluationDialog, type DecisionPromptEvaluationActions } from "./decision-prompt-evaluation-dialog.client";

import { RecommendedModelEditor, type PromptModelCatalog } from "./recommended-model-editor.client";

type SaveDecisionTemplate = (
  id: PromptTemplateId,
  name: string,
  decision: DecisionInput,
  defaults: Record<string, string>,
  revisionName?: string,
) => PromptTemplateRevisionId | undefined;

interface Props extends DecisionPromptEvaluationActions {
  template: DecisionPromptTemplate;
  /** The whole library, for duplicate-name warnings. */
  templates: readonly PromptTemplate[];
  memory: DecisionTemplateEditorMemoryStore;
  initialRevisionId?: PromptTemplateRevisionId;
  sessionOwned: boolean;
  connectionRequirements: ConnectionRequirement[];
  modelCatalog?: PromptModelCatalog;
  onRecommendedTargetChange(id: PromptTemplateId, target?: PromptTemplateRecommendedTarget): void;
  persistenceStatus: "saving" | "saved" | "session" | "error" | "secondary";
  onRename(id: PromptTemplateId, name: string): boolean;
  /** Relabels a saved revision; a blank name clears the label. */
  onRenameRevision?(id: PromptTemplateId, revisionId: PromptTemplateRevisionId, name: string): void;
  onDraftChange?(
    id: PromptTemplateId,
    source: PromptTemplateRevisionId,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): void;
  onSave?: SaveDecisionTemplate;
  /** Checkpoints the edits and pins the new revision into Compose. */
  onSaveAndUse?: SaveDecisionTemplate;
  onUse?(id: PromptTemplateId, revisionId: PromptTemplateRevisionId): void;
  onSelectionChange?(id: PromptTemplateId, revisionId?: PromptTemplateRevisionId): void;
  onArchive(id: PromptTemplateId): void;
  onRestore(id: PromptTemplateId): void;
}

/** Revision choice for a decision prompt; the content below owns editing. */
export function DecisionPromptTemplateEditor(props: Props) {
  const { template, memory } = props;
  const hasDraft = Boolean(template.draft) || memory.has(template.id);
  const [view, setView] = useState<string>(
    props.initialRevisionId ??
      (template.archivedAt || !hasDraft ? template.currentRevisionId : "draft"),
  );
  const [editing, setEditing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const source =
    view === "draft"
      ? memory.get(template.id)?.sourceRevisionId ??
        template.draft?.sourceRevisionId ??
        template.currentRevisionId
      : view;
  const revision =
    template.revisions.find(({ id }) => id === source) ??
    template.revisions.find(({ id }) => id === template.currentRevisionId)!;
  const readOnly = Boolean(
    template.archivedAt ||
      (!editing && view !== "draft" && revision.id !== template.currentRevisionId),
  );

  function select(value: string): void {
    setView(value);
    setEditing(false);
    setEpoch((current) => current + 1);
    props.onSelectionChange?.(
      template.id,
      value === "draft" ? undefined : (value as PromptTemplateRevisionId),
    );
  }

  function editHistorical(): void {
    setEditing(true);
    memory.set(template.id, {
      sourceRevisionId: revision.id,
      revisionName: "",
      snapshot: {
        draft: decisionDraftFromInput(revision.decision),
        values: { ...revision.variableDefaults },
        touched: true,
      },
    });
    setView("draft");
    setEpoch((current) => current + 1);
    props.onSelectionChange?.(template.id);
  }

  return (
    <DecisionTemplateContent
      key={`${revision.id}:${epoch}`}
      {...props}
      revision={revision}
      useMemory={view === "draft"}
      readOnly={readOnly}
      onSaved={select}
      onEdited={() => {
        if (view === "draft") return;
        setView("draft");
        props.onSelectionChange?.(template.id);
      }}
      onEditHistorical={editHistorical}
      controls={
        <RevisionField
          {...(props.onRenameRevision && !props.sessionOwned && !template.archivedAt && view !== "draft"
            ? {
                rename: {
                  name: revision.name ?? "",
                  fallbackLabel: promptRevisionPositionLabel(template, revision.id),
                  onRename: (next: string) => props.onRenameRevision!(template.id, revision.id, next),
                },
              }
            : {})}
        >
          <select
            aria-label="Revision"
            disabled={props.sessionOwned}
            value={view}
            onChange={(event) => select(event.target.value)}
          >
            {(hasDraft || view === "draft") && (
              <option value="draft">
                Draft · {props.sessionOwned ? "session only" : "last valid edits saved"}
              </option>
            )}
            {[...template.revisions].reverse().map((entry) => (
              <option value={entry.id} key={entry.id}>
                {promptRevisionLabel(template, entry.id)}
              </option>
            ))}
          </select>
        </RevisionField>
      }
    />
  );
}

function draftStatus(input: {
  invalid: boolean;
  readOnly: boolean;
  sessionOwned: boolean;
  persistenceStatus: Props["persistenceStatus"];
}): string {
  if (input.invalid) return "Incomplete edits kept in this session only. The project keeps its last valid draft.";
  if (input.readOnly) return "Saved revision · read only.";
  if (input.sessionOwned) return "Session draft — not saved after closing.";
  switch (input.persistenceStatus) {
    case "error":
      return "Draft save failed — your changes remain in this session.";
    case "session":
      return "Draft kept in this session. Save the project to keep it after closing.";
    case "secondary":
      return "Draft kept in this tab only — another tab is editing this project.";
    case "saving":
      return "Saving valid draft…";
    case "saved":
      return "Valid draft saved to the project.";
  }
}

function DecisionTemplateContent(
  props: Props & {
    revision: DecisionPromptTemplateRevision;
    useMemory: boolean;
    readOnly: boolean;
    controls: ReactNode;
    onSaved(id: PromptTemplateRevisionId): void;
    onEdited(): void;
    onEditHistorical(): void;
  },
) {
  const { template, revision, memory, readOnly } = props;
  const cached = props.useMemory ? memory.get(template.id) : undefined;
  const persisted = props.useMemory ? template.draft : undefined;
  const [revisionName, setRevisionName] = useState(
    cached?.revisionName ?? persisted?.revisionName ?? "",
  );
  const [name, setName] = useState(template.name);
  const [recommendedConnectionId, setRecommendedConnectionId] = useState(
    template.recommendedTarget?.connectionRequirementId ?? props.connectionRequirements[0]?.id ?? "",
  );
  const lastRecorded = useRef("");
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const evaluateAction = useRef<HTMLButtonElement>(null);
  function closeEvaluation() {
    setEvaluationOpen(false);
    props.onDismissEvaluateRevisionError?.();
    evaluateAction.current?.focus();
  }

  /**
   * Remembers every edit for this session and persists it as the template's
   * draft when it is valid, portable and differs from what the project holds.
   */
  function record(snapshot: DecisionDraftSnapshot, nextRevisionName: string): void {
    const signature = JSON.stringify([snapshot, nextRevisionName]);
    if (!snapshot.touched || readOnly || signature === lastRecorded.current) return;
    lastRecorded.current = signature;
    memory.set(template.id, { sourceRevisionId: revision.id, snapshot, revisionName: nextRevisionName });
    props.onEdited();
    const validated = validateDecisionDraft(snapshot.draft);
    if (!("input" in validated)) return;
    const discovery = discoverDecisionVariables(validated.input);
    if (discovery.diagnostics.length || discovery.variables.some(isSensitiveTemplateVariableName)) return;
    const defaults = Object.fromEntries(
      Object.entries(snapshot.values).filter(([key]) => discovery.variables.includes(key)),
    );
    const current = template.draft ?? revision;
    const unchanged =
      JSON.stringify([validated.input, defaults, nextRevisionName]) ===
      JSON.stringify([current.decision, current.variableDefaults, template.draft?.revisionName ?? ""]);
    if (!unchanged) {
      props.onDraftChange?.(template.id, revision.id, validated.input, defaults, nextRevisionName);
    }
  }

  const draft = useDecisionDraft({
    initial: cached?.snapshot ?? {
      draft: decisionDraftFromInput(persisted?.decision ?? revision.decision),
      values: { ...(persisted?.variableDefaults ?? revision.variableDefaults) },
      touched: false,
    },
    onSnapshot: (snapshot) => record(snapshot, revisionName),
  });

  const validated = draft.validated();
  const discovery = "input" in validated ? discoverDecisionVariables(validated.input) : undefined;
  const defaults = Object.fromEntries(
    Object.entries(draft.values).filter(([key]) => discovery?.variables.includes(key)),
  );
  const sensitiveVariables = discovery?.variables.filter(isSensitiveTemplateVariableName) ?? [];
  const invalid =
    !("input" in validated) || Boolean(discovery?.diagnostics.length) || sensitiveVariables.length > 0;
  const changed =
    "input" in validated &&
    JSON.stringify([validated.input, defaults]) !== JSON.stringify([revision.decision, revision.variableDefaults]);
  const needsSave = changed || props.sessionOwned;
  const canSave = !readOnly && !invalid && Boolean(name.trim()) && needsSave;
  const duplicateName = hasDuplicatePromptName(props.templates, template.id, name);

  function commit(save: SaveDecisionTemplate | undefined): PromptTemplateRevisionId | undefined {
    if (!canSave || !("input" in validated)) return undefined;
    const id = save?.(template.id, name.trim(), validated.input, defaults, revisionName);
    if (id) {
      memory.delete(template.id);
      props.onSaved(id);
    }
    return id;
  }

  function use(): void {
    if (needsSave) commit(props.onSaveAndUse);
    else props.onUse?.(template.id, revision.id);
  }

  const [compareId, setCompareId] = useState(() => defaultComparedRevisionId(template, revision.id));
  const compare = template.revisions.find(({ id }) => id === compareId);

  return (
    <section
      className="template-editor decision-template-editor"
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
        if (!(changed || invalid || props.sessionOwned)) return;
        event.preventDefault();
        event.stopPropagation();
        commit(props.onSave);
      }}
    >
      <header className="template-editor-header">
        <label className="template-name-field">
          Prompt name
          <input
            disabled={readOnly}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (event.target.value.trim()) props.onRename(template.id, event.target.value);
            }}
          />
        </label>
        {props.controls}
        <div className="template-editor-actions">
          {template.archivedAt ? (
            <>
              <span className="provider-pill">Archived</span>
              <button className="button primary" type="button" onClick={() => props.onRestore(template.id)}>
                Restore
              </button>
            </>
          ) : readOnly ? (
            <button className="button secondary" type="button" onClick={props.onEditHistorical}>
              Edit as new revision
            </button>
          ) : (
            <>
              <label>
                Revision name <span className="field-optional">Optional</span>
                <input
                  aria-label="Revision name"
                  value={revisionName}
                  onChange={(event) => {
                    const next = event.target.value;
                    setRevisionName(next);
                    record({ draft: draft.draft, values: draft.values, touched: true }, next);
                  }}
                />
              </label>
              <button className="button primary" type="button" disabled={!canSave} onClick={() => commit(props.onSave)}>
                {props.sessionOwned ? "Save to project" : "Create revision"}
              </button>
            </>
          )}
          {!template.archivedAt && !props.sessionOwned && (
            <button className="button secondary" type="button" onClick={() => props.onArchive(template.id)}>
              Archive
            </button>
          )}
        </div>
      </header>
      <p className="template-draft-status" role="status">
        {draftStatus({
          invalid,
          readOnly,
          sessionOwned: props.sessionOwned,
          persistenceStatus: props.persistenceStatus,
        })}
      </p>
      {duplicateName && (
        <div className="template-warning" role="status">
          Another prompt has this name. IDs keep the two definitions distinct.
        </div>
      )}
      <div className="template-editor-body">
        <div className="decision-content">
          <PaneTabs
            label="Decision editor"
            value={draft.draft.view}
            onChange={(value) => (value === "json" ? draft.showJson() : draft.showForm())}
            tabs={[
              { id: "form", label: "Form" },
              { id: "json", label: "JSON" },
            ]}
          />
          {draft.viewProblems.map((problem, index) => (
            <p className="template-diagnostic" role="alert" key={index}>
              {problem.location}: {problem.message}
            </p>
          ))}
          <DecisionInputEditor handle={draft} disabled={readOnly} />
          {"problems" in validated &&
            validated.problems.map((problem, index) => (
              <p className="template-diagnostic" role="alert" key={index}>
                {problem.location}: {problem.message}
              </p>
            ))}
          {sensitiveVariables.map((variable) => (
            <p className="template-diagnostic" role="alert" key={variable}>
              Secret-like variable <code>{`{{${variable}}}`}</code> can never receive a portable default or
              request value. Rename it; credentials belong in Connections.
            </p>
          ))}
          {discovery?.diagnostics.map((problem, index) => (
            <p className="template-diagnostic" role="alert" key={index}>
              {problem.field.kind}: {problem.diagnostic.message}
            </p>
          ))}
        </div>
        <aside className="template-variable-rail">
          <h3>Variable defaults</h3>
          <p>Optional reusable values. Missing values must be filled before running.</p>
          {draft.variables.map((variable) => (
            <label key={variable}>
              <code>{`{{${variable}}}`}</code>
              <input
                aria-label={`Default for ${variable}`}
                disabled={readOnly || isSensitiveTemplateVariableName(variable)}
                placeholder="No default"
                value={draft.values[variable] ?? ""}
                onChange={(event) => draft.setValue(variable, event.target.value)}
              />
              {Object.hasOwn(draft.values, variable) && (
                <button
                  className="text-button"
                  disabled={readOnly}
                  type="button"
                  onClick={() => draft.clearValue(variable)}
                >
                  Remove default for {variable}
                </button>
              )}
            </label>
          ))}
          <RecommendedModelEditor
            kind="decision"
            connections={props.connectionRequirements}
            connectionId={recommendedConnectionId as ConnectionRequirement["id"]}
            model={template.recommendedTarget?.model ?? ""}
            disabled={readOnly}
            catalog={props.modelCatalog}
            onConnectionChange={(requirement) => {
              setRecommendedConnectionId(requirement);
              if (template.recommendedTarget) props.onRecommendedTargetChange(template.id, { ...template.recommendedTarget, connectionRequirementId: requirement });
            }}
            onModelChange={(model) => props.onRecommendedTargetChange(template.id,
              model.trim() && recommendedConnectionId
                ? { model: model.trim(), connectionRequirementId: recommendedConnectionId as ConnectionRequirement["id"] }
                : undefined)}
          />
        </aside>
      </div>
      {template.revisions.length > 1 && (
        <details className="template-revision-diff">
          <summary>Revision changes</summary>
          <label>
            Compare this revision with
            <select
              value={compareId}
              onChange={(event) => setCompareId(event.target.value as PromptTemplateRevisionId)}
            >
              {template.revisions
                .filter(({ id }) => id !== revision.id)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {promptRevisionLabel(template, entry.id)}
                  </option>
                ))}
            </select>
          </label>
          {compare && <DecisionRevisionDiff diff={diffDecisionPromptTemplateRevisions(compare, revision)} />}
        </details>
      )}
      {!template.archivedAt && (
        <footer className="template-insert-bar">
          <span>Pin a saved revision into Decision Compose</span>
          {!props.sessionOwned && props.onEvaluateRevision && <button
            className="button secondary"
            type="button"
            ref={evaluateAction}
            disabled={invalid || needsSave}
            title={needsSave ? "Create a revision before evaluating these edits." : undefined}
            onClick={() => { props.onDismissEvaluateRevisionError?.(); setEvaluationOpen(true); }}
          >Evaluate in a suite…</button>}
          <button
            className="button primary"
            type="button"
            disabled={invalid || (needsSave && !canSave)}
            onClick={use}
          >
            {needsSave ? "Save and use revision" : `Use ${promptRevisionLabel(template, revision.id)}`}
          </button>
        </footer>
      )}
      {evaluationOpen && <DecisionPromptEvaluationDialog {...props} revisionId={revision.id} onClose={closeEvaluation} />}
    </section>
  );
}
