"use client";

import { useEffect, useRef, useState } from "react";
import type { PromptTemplate } from "../packages/core/src/project";
import type { DecisionInput } from "../packages/core/src/decision";
import type { PromptTemplateId, PromptTemplateRevisionId } from "../packages/core/src/run-kernel";
import { discoverDecisionVariables } from "../packages/core/src/decision-variables";
import { ChatPromptTemplateEditor, type ChatPromptTemplateEditorProps } from "./templates/chat-prompt-template-editor.client";
import { DecisionPromptTemplateEditor, type DecisionTemplateEditorMemory } from "./templates/decision-prompt-template-editor.client";
export { TemplateUseCard } from "./templates/chat-prompt-template-editor.client";
export type { CompatibleEvaluationSuite } from "./templates/chat-prompt-template-editor.client";

export interface ProjectTemplatesPaneProps extends ChatPromptTemplateEditorProps {
  decisionEditorMemory?: Map<PromptTemplateId, DecisionTemplateEditorMemory>;
  onCreateDecision?(name: string, decision: DecisionInput, defaults?: Record<string, string>): PromptTemplateId;
  onDecisionDraftChange?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, decision: DecisionInput, defaults: Record<string, string>, revisionName?: string): void;
  onSaveDecision?(templateId: PromptTemplateId, name: string, decision: DecisionInput, defaults: Record<string, string>, revisionName?: string): PromptTemplateRevisionId | undefined;
  onUseDecision?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId): void;
}

function description(template: PromptTemplate): string {
  if (template.kind === "chat") {
    const revision = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
    return `Chat · ${revision.messages.length} ${revision.messages.length === 1 ? "message" : "messages"}`;
  }
  const revision = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
  return `Decision · ${Object.keys(revision.decision.questions).length} questions · ${discoverDecisionVariables(revision.decision).variables.length} variables`;
}

/** Shared library navigation; each kind owns its authoring state and content. */
export function ProjectTemplatesPane(props: ProjectTemplatesPaneProps) {
  const { templates, navigationTarget, onSelectionChange, sessionTemplateIds = new Set() } = props;
  const target = templates.find(({ id }) => id === navigationTarget?.templateId);
  const [status, setStatus] = useState<"active" | "archived">(target?.archivedAt ? "archived" : "active");
  const [kind, setKind] = useState<"all" | "chat" | "decision">("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(target?.id ?? templates.find(({ archivedAt }) => !archivedAt)?.id);
  const [localMemory] = useState(() => new Map<PromptTemplateId, DecisionTemplateEditorMemory>());
  const workspace = useRef<HTMLDivElement>(null);
  const { focusRequested, onFocusHandled } = props;
  useEffect(() => {
    if (focusRequested) { workspace.current?.focus(); onFocusHandled?.(); }
  }, [focusRequested, onFocusHandled]);
  const active = templates.filter(({ archivedAt }) => !archivedAt);
  const archived = templates.filter(({ archivedAt }) => archivedAt);
  const visible = (status === "active" ? active : archived).filter((entry) =>
    (kind === "all" || entry.kind === kind) && entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selected = visible.find(({ id }) => id === selectedId);
  function select(template: PromptTemplate) { setSelectedId(template.id); onSelectionChange?.(template.id); }
  function create(decision: boolean) {
    const id = decision
      ? props.onCreateDecision?.("Untitled decision prompt", { state: "{{state}}", questions: { answer: { type: "noul", instructions: "Is this relevant?" } } })
      : props.onCreate("Untitled prompt", [{ role: "user", content: "Write about {{topic}}." }]);
    if (!id) return;
    setStatus("active"); setKind("all"); setSearch(""); setSelectedId(id); onSelectionChange?.(id);
  }
  const shared = {
    ...props,
    focusRequested: false,
    onRestore(id: PromptTemplateId) { props.onRestore(id); setStatus("active"); },
    onArchive(id: PromptTemplateId) { props.onArchive(id, () => {
      const fallback = active.find((entry) => entry.id !== id && (kind === "all" || entry.kind === kind));
      setSelectedId(fallback?.id); if (fallback) onSelectionChange?.(fallback.id);
    }); },
  };
  return <div className="templates-workspace" data-readiness-target="prompt-library" ref={workspace} tabIndex={-1}>
    <aside className="template-sidebar">
      {props.onReturn && <button className="text-button template-return-action" type="button" onClick={props.onReturn}>← {props.returnLabel ?? "Back"}</button>}
      <div className="template-create-actions">
        <button className="button secondary" type="button" onClick={() => create(false)}>New prompt</button>
        {props.onCreateDecision && <button className="button secondary" type="button" onClick={() => create(true)}>New decision prompt</button>}
        <button className="button secondary template-import-action" disabled={Boolean(props.n8nImportDisabledReason)} title={props.n8nImportDisabledReason} type="button" onClick={props.onOpenN8nImport}>Import prompt from n8n…</button>
      </div>
      <input aria-label="Search prompts" placeholder="Search prompts" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="template-library-filter" aria-label="Prompt kind">
        {(["all", "chat", "decision"] as const).map((value) => <button className={kind === value ? "template-kind-filter-button selected" : "template-kind-filter-button"} aria-pressed={kind === value} key={value} type="button" onClick={() => setKind(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </div>
      <div className="template-library-filter" aria-label="Prompt status">
        <button className={status === "active" ? "template-library-tab selected" : "template-library-tab"} aria-pressed={status === "active"} type="button" onClick={() => { setStatus("active"); if (active[0]) select(active[0]); }}>Active <span>{active.length}</span></button>
        <button className={status === "archived" ? "template-library-archive-link selected" : "template-library-archive-link"} aria-pressed={status === "archived"} type="button" onClick={() => { setStatus("archived"); if (archived[0]) select(archived[0]); }}>Archived <span>{archived.length}</span></button>
      </div>
      <div className="template-list">
        {visible.length === 0 && <p className="template-empty">{status === "archived" ? "Archived prompts will appear here." : "No matching prompts. Create a project-owned prompt."}</p>}
        {visible.map((template) => <button aria-current={template.id === selected?.id} className={template.id === selected?.id ? "template-list-item selected" : "template-list-item"} key={template.id} type="button" onClick={() => select(template)}>
          <strong>{template.name}</strong><span>{description(template)} · {props.usageCounts.get(template.id) ?? 0} uses</span>
        </button>)}
      </div>
    </aside>
    {selected?.kind === "chat" ? <ChatPromptTemplateEditor {...shared} key={selected.id} templates={[selected]} navigationTarget={navigationTarget?.templateId === selected.id ? navigationTarget : { key: 0, templateId: selected.id }} />
      : selected?.kind === "decision" ? <DecisionPromptTemplateEditor key={selected.id} template={selected} memory={props.decisionEditorMemory ?? localMemory}
          initialRevisionId={navigationTarget?.templateId === selected.id ? navigationTarget.revisionId : undefined}
          connectionRequirements={props.connectionRequirements} onRecommendedTargetChange={props.onRecommendedTargetChange}
          sessionOwned={sessionTemplateIds.has(selected.id)} persistenceStatus={props.persistenceStatus ?? "saved"}
          onRename={props.onRename} onDraftChange={props.onDecisionDraftChange} onSave={props.onSaveDecision}
          onUse={props.onUseDecision} onSelectionChange={onSelectionChange} onArchive={shared.onArchive} onRestore={shared.onRestore} />
      : <section className="template-editor"><div className="template-empty-state"><h3>{status === "active" ? "No active project prompts" : "No archived prompts"}</h3><p>Create or select a prompt to begin.</p></div></section>}
  </div>;
}
