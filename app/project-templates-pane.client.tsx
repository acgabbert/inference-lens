"use client";

import { useEffect, useRef, useState } from "react";
import type { DecisionInput } from "../packages/core/src/decision";
import type { DecisionTemplateEvaluationRetargetPreview } from "../packages/core/src/decision-template-evaluation";
import { discoverDecisionVariables } from "../packages/core/src/decision-variables";
import type { PromptTemplate, PromptTemplateMessages } from "../packages/core/src/project";
import type { EvaluationSuiteId, PromptTemplateId, PromptTemplateRevisionId } from "../packages/core/src/run-kernel";
import {
  ChatPromptTemplateEditor,
  type ChatPromptTemplateEditorProps,
} from "./templates/chat-prompt-template-editor.client";
import { DecisionPromptTemplateEditor } from "./templates/decision-prompt-template-editor.client";
import {
  useDecisionTemplateEditorMemory,
  type DecisionTemplateEditorMemoryStore,
} from "./templates/decision-template-editor-memory.client";
import {
  describeEmptyPromptLibrary,
  filterPromptLibrary,
  selectPromptLibraryEntry,
  type PromptLibraryFilters,
  type PromptLibraryKind,
} from "./templates/prompt-library";
export { TemplateUseCard } from "./templates/chat-prompt-template-editor.client";
export type { CompatibleEvaluationSuite } from "./templates/chat-prompt-template-editor.client";

type SaveDecisionTemplate = (
  templateId: PromptTemplateId,
  name: string,
  decision: DecisionInput,
  defaults: Record<string, string>,
  revisionName?: string,
) => PromptTemplateRevisionId | undefined;

export interface ProjectTemplatesPaneProps
  extends Omit<ChatPromptTemplateEditorProps, "template" | "templates"> {
  templates: PromptTemplate[];
  usageCounts: ReadonlyMap<PromptTemplateId, number>;
  n8nImportDisabledReason?: string;
  onOpenN8nImport(): void;
  onCreate(name: string, messages: PromptTemplateMessages): PromptTemplateId;
  returnLabel?: string;
  onReturn?(): void;
  decisionEditorMemory?: DecisionTemplateEditorMemoryStore;
  onCreateDecision?(name: string, decision: DecisionInput, defaults?: Record<string, string>): PromptTemplateId;
  onDecisionDraftChange?(
    templateId: PromptTemplateId,
    revisionId: PromptTemplateRevisionId,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): void;
  onSaveDecision?: SaveDecisionTemplate;
  onSaveAndUseDecision?: SaveDecisionTemplate;
  onUseDecision?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId): void;
  onPreviewDecisionEvaluation?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, suiteId: EvaluationSuiteId): DecisionTemplateEvaluationRetargetPreview;
}

const KIND_FILTERS: { value: PromptLibraryKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "chat", label: "Chat" },
  { value: "decision", label: "Decision" },
];

function describeEntry(template: PromptTemplate): string {
  if (template.kind === "chat") {
    const revision = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
    const count = revision.messages.length;
    return `Chat · ${count} ${count === 1 ? "message" : "messages"}`;
  }
  const revision = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
  const questions = Object.keys(revision.decision.questions).length;
  const variables = discoverDecisionVariables(revision.decision).variables.length;
  return `Decision · ${questions} questions · ${variables} variables`;
}

/** Shared library navigation; each kind owns its authoring state and content. */
export function ProjectTemplatesPane(props: ProjectTemplatesPaneProps) {
  const { templates, navigationTarget, onSelectionChange, sessionTemplateIds = new Set() } = props;
  const target = templates.find(({ id }) => id === navigationTarget?.templateId);
  const [filters, setFilters] = useState<PromptLibraryFilters>({
    status: target?.archivedAt ? "archived" : "active",
    kind: "all",
    search: "",
  });
  const [selectedId, setSelectedId] = useState(
    target?.id ?? templates.find(({ archivedAt }) => !archivedAt)?.id,
  );
  const localMemory = useDecisionTemplateEditorMemory();
  const memory = props.decisionEditorMemory ?? localMemory;
  const workspace = useRef<HTMLDivElement>(null);
  const { focusRequested, onFocusHandled } = props;
  useEffect(() => {
    if (!focusRequested) return;
    workspace.current?.focus();
    onFocusHandled?.();
  }, [focusRequested, onFocusHandled]);

  const counts = {
    active: templates.filter(({ archivedAt }) => !archivedAt).length,
    archived: templates.filter(({ archivedAt }) => archivedAt).length,
  };
  const visible = filterPromptLibrary(templates, filters);
  const selected = selectPromptLibraryEntry(visible, selectedId);
  const empty = describeEmptyPromptLibrary(templates, filters);

  function select(template: PromptTemplate): void {
    setSelectedId(template.id);
    onSelectionChange?.(template.id);
  }

  /**
   * Changes filters and follows the entry the editor will show, so navigation
   * agrees with it. With nothing visible the choice is kept for later.
   */
  function changeFilters(next: Partial<PromptLibraryFilters>): void {
    const merged = { ...filters, ...next };
    setFilters(merged);
    const shown = selectPromptLibraryEntry(filterPromptLibrary(templates, merged), selectedId);
    if (shown && shown.id !== selectedId) select(shown);
  }

  function create(decision: boolean): void {
    const id = decision
      ? props.onCreateDecision?.("Untitled decision prompt", {
          state: "{{state}}",
          questions: { answer: { type: "noul", instructions: "Is this relevant?" } },
        })
      : props.onCreate("Untitled prompt", [{ role: "user", content: "Write about {{topic}}." }]);
    if (!id) return;
    setFilters({ status: "active", kind: "all", search: "" });
    setSelectedId(id);
    onSelectionChange?.(id);
  }

  function archive(id: PromptTemplateId): void {
    props.onArchive(id, () => {
      const remaining = templates.filter((entry) => entry.id !== id);
      const fallback = selectPromptLibraryEntry(filterPromptLibrary(remaining, filters), undefined);
      setSelectedId(fallback?.id);
      if (fallback) onSelectionChange?.(fallback.id);
    });
  }

  function restore(id: PromptTemplateId): void {
    props.onRestore(id);
    // Kind and search already matched it in Archived, so it stays visible.
    setFilters((current) => ({ ...current, status: "active" }));
  }

  return (
    <div className="templates-workspace" data-readiness-target="prompt-library" ref={workspace} tabIndex={-1}>
      <aside className="template-sidebar">
        {props.onReturn && (
          <button className="text-button template-return-action" type="button" onClick={props.onReturn}>
            ← {props.returnLabel ?? "Back"}
          </button>
        )}
        <div className="template-create-actions">
          <button className="button secondary" type="button" onClick={() => create(false)}>
            New prompt
          </button>
          {props.onCreateDecision && (
            <button className="button secondary" type="button" onClick={() => create(true)}>
              New decision prompt
            </button>
          )}
          <button
            className="button secondary template-import-action"
            disabled={Boolean(props.n8nImportDisabledReason)}
            title={props.n8nImportDisabledReason}
            type="button"
            onClick={props.onOpenN8nImport}
          >
            Import prompt from n8n…
          </button>
        </div>
        <input
          aria-label="Search prompts"
          placeholder="Search prompts"
          value={filters.search}
          onChange={(event) => changeFilters({ search: event.target.value })}
        />
        <div className="template-library-filter" aria-label="Prompt kind">
          {KIND_FILTERS.map(({ value, label }) => (
            <button
              aria-pressed={filters.kind === value}
              className={
                filters.kind === value ? "template-kind-filter-button selected" : "template-kind-filter-button"
              }
              key={value}
              type="button"
              onClick={() => changeFilters({ kind: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="template-library-filter" aria-label="Prompt status">
          <button
            aria-pressed={filters.status === "active"}
            className={filters.status === "active" ? "template-library-tab selected" : "template-library-tab"}
            type="button"
            onClick={() => changeFilters({ status: "active" })}
          >
            Active <span>{counts.active}</span>
          </button>
          {/* Quiet by design: archiving should not read as a peer destination
              to Active, only as a reachable place to look for it later. */}
          <button
            aria-pressed={filters.status === "archived"}
            className={
              filters.status === "archived"
                ? "template-library-archive-link selected"
                : "template-library-archive-link"
            }
            type="button"
            onClick={() => changeFilters({ status: "archived" })}
          >
            Archived <span>{counts.archived}</span>
          </button>
        </div>
        <div className="template-list">
          {visible.length === 0 && <p className="template-empty">{empty.list}</p>}
          {visible.map((template) => (
            <button
              aria-current={template.id === selected?.id}
              className={template.id === selected?.id ? "template-list-item selected" : "template-list-item"}
              key={template.id}
              type="button"
              onClick={() => select(template)}
            >
              <strong>{template.name}</strong>
              <span>
                {describeEntry(template)} · {props.usageCounts.get(template.id) ?? 0} uses
              </span>
            </button>
          ))}
        </div>
      </aside>
      {selected?.kind === "chat" ? (
        <ChatPromptTemplateEditor
          {...props}
          key={selected.id}
          template={selected}
          templates={templates}
          focusRequested={false}
          onArchive={archive}
          onRestore={restore}
        />
      ) : selected?.kind === "decision" ? (
        <DecisionPromptTemplateEditor
          key={selected.id}
          template={selected}
          templates={templates}
          memory={memory}
          initialRevisionId={navigationTarget?.templateId === selected.id ? navigationTarget.revisionId : undefined}
          connectionRequirements={props.connectionRequirements}
          onRecommendedTargetChange={props.onRecommendedTargetChange}
          sessionOwned={sessionTemplateIds.has(selected.id)}
          persistenceStatus={props.persistenceStatus ?? "saved"}
          onRename={props.onRename}
          onDraftChange={props.onDecisionDraftChange}
          onSave={props.onSaveDecision}
          onSaveAndUse={props.onSaveAndUseDecision}
          onUse={props.onUseDecision}
          evaluationSuites={props.compatibleEvaluationSuitesByTemplate?.get(selected.id)}
          onPreviewEvaluation={props.onPreviewDecisionEvaluation}
          onEvaluateRevision={props.onEvaluateRevision}
          onOpenEvaluationSuite={props.onOpenEvaluationSuite}
          evaluateRevisionError={props.evaluateRevisionError}
          onDismissEvaluateRevisionError={props.onDismissEvaluateRevisionError}
          onSelectionChange={onSelectionChange}
          onArchive={archive}
          onRestore={restore}
        />
      ) : (
        <section className="template-editor">
          <div className="template-empty-state">
            <h3>{empty.heading}</h3>
            <p>Create or select a prompt to begin.</p>
          </div>
        </section>
      )}
    </div>
  );
}
