"use client";

import { useRef, useState } from "react";
import type { DecisionInput } from "../../packages/core/src/decision";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import { diffDecisionPromptTemplateRevisions } from "../../packages/core/src/decision-template-revision-diff";
import { DecisionRevisionDiff } from "./decision-revision-diff.client";
import { isSensitiveTemplateVariableName } from "../../packages/core/src/project";
import type { ConnectionRequirement, PromptTemplateRecommendedTarget, DecisionPromptTemplate, DecisionPromptTemplateRevision } from "../../packages/core/src/project";
import type { PromptTemplateId, PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import { DecisionInputEditor } from "../decisions/decision-composer.client";
import { decisionDraftFromInput, validateDecisionDraft } from "../decisions/decision-draft";
import { useDecisionDraft, type DecisionDraftSnapshot } from "../decisions/use-decision-draft.client";
import { PaneTabs } from "../workbench-shell.client";
import { promptRevisionLabel } from "./prompt-revision-label";

export interface DecisionTemplateEditorMemory {
  sourceRevisionId: PromptTemplateRevisionId;
  snapshot: DecisionDraftSnapshot;
  revisionName: string;
}
interface Props {
  template: DecisionPromptTemplate;
  memory: Map<PromptTemplateId, DecisionTemplateEditorMemory>;
  initialRevisionId?: PromptTemplateRevisionId;
  sessionOwned: boolean;
  connectionRequirements: ConnectionRequirement[];
  onRecommendedTargetChange(id: PromptTemplateId, target?: PromptTemplateRecommendedTarget): void;
  persistenceStatus: "saving" | "saved" | "session" | "error";
  onRename(id: PromptTemplateId, name: string): boolean;
  onDraftChange?(id: PromptTemplateId, source: PromptTemplateRevisionId, decision: DecisionInput, defaults: Record<string, string>, revisionName?: string): void;
  onSave?(id: PromptTemplateId, name: string, decision: DecisionInput, defaults: Record<string, string>, revisionName?: string): PromptTemplateRevisionId | undefined;
  onUse?(id: PromptTemplateId, revisionId: PromptTemplateRevisionId): void;
  onSelectionChange?(id: PromptTemplateId, revisionId?: PromptTemplateRevisionId): void;
  onArchive(id: PromptTemplateId): void;
  onRestore(id: PromptTemplateId): void;
}

export function DecisionPromptTemplateEditor(props: Props) {
  const { template, memory } = props;
  const [view, setView] = useState<string>(props.initialRevisionId ?? (template.archivedAt ? template.currentRevisionId : memory.has(template.id) || template.draft ? "draft" : template.currentRevisionId));
  const [editing, setEditing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const source = view === "draft" ? memory.get(template.id)?.sourceRevisionId ?? template.draft?.sourceRevisionId ?? template.currentRevisionId : view;
  const revision = template.revisions.find(({ id }) => id === source) ?? template.revisions.find(({ id }) => id === template.currentRevisionId)!;
  const readOnly = Boolean(template.archivedAt || (!editing && view !== "draft" && revision.id !== template.currentRevisionId));
  function select(value: string) {
    setView(value); setEditing(false); setEpoch((value) => value + 1);
    props.onSelectionChange?.(template.id, value === "draft" ? undefined : value as PromptTemplateRevisionId);
  }
  return <DecisionTemplateContent key={`${revision.id}:${epoch}`} {...props} revision={revision} useMemory={view === "draft"} readOnly={readOnly}
    onSaved={(id) => select(id)} onEdited={() => { if (view !== "draft") { setView("draft"); props.onSelectionChange?.(template.id); } }}
    controls={<label className="template-revision-field">Revision<select aria-label="Revision" disabled={props.sessionOwned} value={view} onChange={(event) => select(event.target.value)}>
      {(template.draft || memory.has(template.id) || view === "draft") && <option value="draft">Draft · {props.sessionOwned ? "session only" : "last valid edits saved"}</option>}
      {[...template.revisions].reverse().map((entry) => <option value={entry.id} key={entry.id}>{promptRevisionLabel(template, entry.id)}{entry.name ? ` — ${entry.name}` : ""}</option>)}
    </select></label>}
    onEditHistorical={() => { setEditing(true); memory.set(template.id, { sourceRevisionId: revision.id, revisionName: "", snapshot: { draft: decisionDraftFromInput(revision.decision), values: { ...revision.variableDefaults }, touched: true } }); setView("draft"); setEpoch((value) => value + 1); props.onSelectionChange?.(template.id); }} />;
}

function DecisionTemplateContent(props: Props & {
  revision: DecisionPromptTemplateRevision; useMemory: boolean; readOnly: boolean;
  controls: React.ReactNode; onSaved(id: PromptTemplateRevisionId): void; onEdited(): void; onEditHistorical(): void;
}) {
  const { template, revision, memory, readOnly } = props;
  const cached = props.useMemory ? memory.get(template.id) : undefined;
  const persisted = props.useMemory ? template.draft : undefined;
  const [revisionName, setRevisionName] = useState(cached?.revisionName ?? persisted?.revisionName ?? "");
  const [name, setName] = useState(template.name);
  const [recommendedConnectionId, setRecommendedConnectionId] = useState(template.recommendedTarget?.connectionRequirementId ?? props.connectionRequirements[0]?.id ?? "");
  const lastSnapshot = useRef("");
  const draft = useDecisionDraft({ initial: cached?.snapshot ?? {
    draft: decisionDraftFromInput(persisted?.decision ?? revision.decision), values: { ...(persisted?.variableDefaults ?? revision.variableDefaults) }, touched: false,
  }, onSnapshot(snapshot) {
    const signature = JSON.stringify([snapshot, revisionName]);
    if (!snapshot.touched || readOnly || signature === lastSnapshot.current) return;
    lastSnapshot.current = signature;
    memory.set(template.id, { sourceRevisionId: revision.id, snapshot, revisionName });
    props.onEdited();
    const validated = validateDecisionDraft(snapshot.draft);
    if (!("input" in validated)) return;
    const discovery = discoverDecisionVariables(validated.input);
    if (discovery.diagnostics.length || discovery.variables.some(isSensitiveTemplateVariableName)) return;
    const defaults = Object.fromEntries(Object.entries(snapshot.values).filter(([key]) => discovery.variables.includes(key)));
    const current = template.draft ?? revision;
    if (JSON.stringify([validated.input, defaults, revisionName]) !== JSON.stringify([current.decision, current.variableDefaults, template.draft?.revisionName ?? ""])) {
      props.onDraftChange?.(template.id, revision.id, validated.input, defaults, revisionName);
    }
  } });
  const validated = draft.validated();
  const discovery = "input" in validated ? discoverDecisionVariables(validated.input) : undefined;
  const defaults = Object.fromEntries(Object.entries(draft.values).filter(([key]) => discovery?.variables.includes(key)));
  const sensitiveVariables = discovery?.variables.filter(isSensitiveTemplateVariableName) ?? [];
  const invalid = !("input" in validated) || Boolean(discovery?.diagnostics.length) || sensitiveVariables.length > 0;
  const changed = "input" in validated && JSON.stringify([validated.input, defaults]) !== JSON.stringify([revision.decision, revision.variableDefaults]);
  const canSave = !readOnly && !invalid && Boolean(name.trim()) && (changed || props.sessionOwned);
  function save(): PromptTemplateRevisionId | undefined {
    if (!canSave || !("input" in validated)) return undefined;
    const id = props.onSave?.(template.id, name.trim(), validated.input, defaults, revisionName);
    if (id) { memory.delete(template.id); props.onSaved(id); }
    return id;
  }
  const [compareId, setCompareId] = useState(template.revisions[template.revisions.indexOf(revision) - 1]?.id ?? template.revisions.find(({ id }) => id !== revision.id)?.id);
  const compare = template.revisions.find(({ id }) => id === compareId);
  return <section className="template-editor decision-template-editor" onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && (changed || invalid || props.sessionOwned)) { event.preventDefault(); event.stopPropagation(); save(); }
  }}>
    <header className="template-editor-header">
      <label className="template-name-field">Prompt name<input disabled={readOnly} value={name} onChange={(event) => { setName(event.target.value); if (event.target.value.trim()) props.onRename(template.id, event.target.value); }} /></label>
      {props.controls}
      <div className="template-editor-actions">
        {template.archivedAt ? <><span className="provider-pill">Archived</span><button className="button primary" type="button" onClick={() => props.onRestore(template.id)}>Restore</button></>
          : readOnly ? <button className="button secondary" type="button" onClick={props.onEditHistorical}>Edit as new revision</button>
            : <><label>Revision name <span className="field-optional">Optional</span><input aria-label="Revision name" value={revisionName} onChange={(event) => { setRevisionName(event.target.value); draft.touch(); lastSnapshot.current = ""; }} /></label>
              <button className="button primary" type="button" disabled={!canSave} onClick={save}>{props.sessionOwned ? "Save to project" : "Create revision"}</button></>}
        {!template.archivedAt && !props.sessionOwned && <button className="button secondary" type="button" onClick={() => props.onArchive(template.id)}>Archive</button>}
      </div>
    </header>
    <p className="template-draft-status" role="status">{invalid ? "Incomplete edits kept in this session only. The project keeps its last valid draft." : readOnly ? "Saved revision · read only." : props.sessionOwned ? "Session draft — not saved after closing." : props.persistenceStatus === "error" ? "Draft save failed — your changes remain in this session." : props.persistenceStatus === "session" ? "Draft kept in this session. Save the project to keep it after closing." : props.persistenceStatus === "saving" ? "Saving valid draft…" : "Valid draft saved to the project."}</p>
    <div className="template-editor-body">
      <div className="decision-content">
        <PaneTabs label="Decision editor" value={draft.draft.view} onChange={(value) => value === "json" ? draft.showJson() : draft.showForm()} tabs={[{ id: "form", label: "Form" }, { id: "json", label: "JSON" }]} />
        {draft.viewProblems.map((problem, index) => <p className="template-diagnostic" role="alert" key={index}>{problem.location}: {problem.message}</p>)}
        <DecisionInputEditor handle={draft} disabled={readOnly} />
        {"problems" in validated && validated.problems.map((problem, index) => <p className="template-diagnostic" role="alert" key={index}>{problem.location}: {problem.message}</p>)}
        {sensitiveVariables.map((variable) => <p className="template-diagnostic" role="alert" key={variable}>Secret-like variable <code>{`{{${variable}}}`}</code> can never receive a portable default or request value. Rename it; credentials belong in Connections.</p>)}
        {discovery?.diagnostics.map((problem, index) => <p className="template-diagnostic" role="alert" key={index}>{problem.field.kind}: {problem.diagnostic.message}</p>)}
      </div>
      <aside className="template-variable-rail"><h3>Variable defaults</h3><p>Optional reusable values. Missing values must be filled before running.</p>
        {draft.variables.map((variable) => <label key={variable}><code>{`{{${variable}}}`}</code><input aria-label={`Default for ${variable}`} disabled={readOnly || isSensitiveTemplateVariableName(variable)} placeholder="No default" value={draft.values[variable] ?? ""} onChange={(event) => draft.setValue(variable, event.target.value)} />
          {Object.hasOwn(draft.values, variable) && <button className="text-button" disabled={readOnly} type="button" onClick={() => draft.clearValue(variable)}>Remove default for {variable}</button>}</label>)}
        <h3>Recommended target</h3><p>Optional advice. Opening or using a prompt keeps your selected connection and model.</p>
        <label>Recommended connection<select aria-label="Recommended connection" disabled={readOnly || props.connectionRequirements.length === 0} value={recommendedConnectionId} onChange={(event) => {
          const requirement = event.target.value as ConnectionRequirement["id"];
          setRecommendedConnectionId(requirement);
          if (template.recommendedTarget) props.onRecommendedTargetChange(template.id, requirement ? { ...template.recommendedTarget, connectionRequirementId: requirement } : undefined);
        }}><option value="">No recommendation</option>{props.connectionRequirements.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <label>Recommended model<input aria-label="Recommended model" disabled={readOnly || !recommendedConnectionId} value={template.recommendedTarget?.model ?? ""} onChange={(event) => {
          const model = event.target.value;
          const connectionRequirementId = recommendedConnectionId as ConnectionRequirement["id"];
          props.onRecommendedTargetChange(template.id, model.trim() && connectionRequirementId ? { model, connectionRequirementId } : undefined);
        }} /></label>
      </aside>
    </div>
    {template.revisions.length > 1 && <details className="template-revision-diff"><summary>Revision changes</summary><label>Compare this revision with<select value={compareId} onChange={(event) => setCompareId(event.target.value as PromptTemplateRevisionId)}>{template.revisions.filter(({ id }) => id !== revision.id).map((entry) => <option key={entry.id} value={entry.id}>{promptRevisionLabel(template, entry.id)}</option>)}</select></label>{compare && <DecisionRevisionDiff diff={diffDecisionPromptTemplateRevisions(compare, revision)} />}</details>}
    {!template.archivedAt && <footer className="template-insert-bar"><span>Pin a saved revision into Decision Compose</span><button className="button primary" type="button" disabled={invalid || (changed || props.sessionOwned ? !canSave : false)} onClick={() => { const id = changed || props.sessionOwned ? save() : revision.id; if (id) props.onUse?.(template.id, id); }}>{changed || props.sessionOwned ? "Save and use revision" : `Use ${promptRevisionLabel(template, revision.id)}`}</button></footer>}
  </section>;
}
