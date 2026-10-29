"use client";

import { useMemo, useState } from "react";

import { isChatPromptTemplate, type PromptTemplate } from "../../packages/core/src/project";
import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
} from "../../packages/core/src/run-kernel";
import { discoverTemplateVariables } from "../../packages/core/src/template-engine";
import { PromptMessagesPreview } from "./prompt-messages-preview.client";
import { promptRevisionLabel } from "./prompt-revision-label";
import { ModalDialog } from "../modal-dialog.client";

export function PromptInsertionDialog({
  templates: allTemplates,
  initialQuery = "",
  initialTemplateId,
  itemCount,
  replaceEmptyDraft,
  onCancel,
  onInsert,
  onOpenPrompts,
}: {
  templates: readonly PromptTemplate[];
  /** The search and selection the quick picker hands over on "More options…". */
  initialQuery?: string;
  initialTemplateId?: PromptTemplateId;
  itemCount: number;
  onCancel(): void;
  onInsert(
    templateId: PromptTemplateId,
    revisionId: PromptTemplateRevisionId,
    itemIndex: number,
    replaceEmptyDraft: boolean,
  ): void;
  replaceEmptyDraft: boolean;
  onOpenPrompts(): void;
}) {
  const templates = useMemo(() => allTemplates.filter(isChatPromptTemplate), [allTemplates]);
  const [query, setQuery] = useState(initialQuery);
  const [selectedId, setSelectedId] = useState<PromptTemplateId | undefined>(
    templates.some(({ id }) => id === initialTemplateId) ? initialTemplateId : templates[0]?.id,
  );
  const selectedTemplate = templates.find(({ id }) => id === selectedId);
  const [revisionId, setRevisionId] = useState<PromptTemplateRevisionId | undefined>(
    selectedTemplate?.currentRevisionId,
  );
  const [itemIndex, setItemIndex] = useState(replaceEmptyDraft ? 0 : itemCount);
  const visibleTemplates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? templates.filter(({ name }) => name.toLocaleLowerCase().includes(normalized))
      : [...templates];
  }, [query, templates]);
  const visibleSelection = visibleTemplates.find(({ id }) => id === selectedId)
    ?? visibleTemplates[0];
  const revision = visibleSelection?.revisions.find(({ id }) => id === revisionId)
    ?? visibleSelection?.revisions.find(({ id }) => id === visibleSelection.currentRevisionId);

  function chooseTemplate(template: PromptTemplate): void {
    setSelectedId(template.id);
    setRevisionId(template.currentRevisionId);
  }

  const variables = revision ? discoverTemplateVariables(revision.messages).variables : [];

  return (
    <ModalDialog
      className={`confirmation-dialog prompt-insertion-dialog${templates.length > 0 ? " wide-dialog" : ""}`}
      labelledBy="prompt-insertion-title"
      onClose={onCancel}
    >
      {templates.length === 0 ? (
        <>
          <span className="eyebrow">Current conversation</span>
          <h2 id="prompt-insertion-title">Insert saved prompt</h2>
          <p>This project has no active saved prompts. Create or save one in Prompts first.</p>
          <div className="confirmation-actions">
            <button autoFocus className="button secondary" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="button primary" type="button" onClick={onOpenPrompts}>
              Open Prompts
            </button>
          </div>
        </>
      ) : (
        <>
          <header className="wide-dialog-header">
            <span className="eyebrow">Current conversation</span>
            <h2 id="prompt-insertion-title">Insert saved prompt</h2>
            <p>{replaceEmptyDraft
              ? "The empty draft will be replaced."
              : "Choose the exact immutable revision and where it belongs in this conversation."}</p>
          </header>
          <div className="wide-dialog-columns">
            <div className="wide-dialog-pane prompt-insertion-list">
              <label className="prompt-insertion-search">
                Search prompts
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <fieldset className="saved-prompt-list">
                <legend>Active saved prompts</legend>
                {visibleTemplates.length === 0 ? (
                  <p className="template-empty">No prompts match “{query.trim()}”.</p>
                ) : visibleTemplates.map((template) => (
                  <label
                    className={template.id === visibleSelection?.id
                      ? "saved-prompt-option selected"
                      : "saved-prompt-option"}
                    key={template.id}
                  >
                    <input
                      checked={template.id === visibleSelection?.id}
                      name="conversation-prompt"
                      type="radio"
                      value={template.id}
                      onChange={() => chooseTemplate(template)}
                    />
                    <strong>{template.name}</strong>
                  </label>
                ))}
              </fieldset>
            </div>
            <section className="wide-dialog-pane" aria-label="Prompt preview">
              {visibleSelection && revision && <>
                <div className="prompt-insertion-controls">
                  <label>
                    Revision
                    <select
                      value={revision.id}
                      onChange={(event) => setRevisionId(event.target.value as PromptTemplateRevisionId)}
                    >
                      {[...visibleSelection.revisions].reverse().map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {promptRevisionLabel(visibleSelection, candidate.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!replaceEmptyDraft && <label>
                      Position
                      <select value={Math.min(itemIndex, itemCount)} onChange={(event) => setItemIndex(Number(event.target.value))}>
                        {Array.from({ length: itemCount + 1 }, (_, index) => (
                          <option key={index} value={index}>
                            {index === 0 ? "At start" : index === itemCount ? "At end" : `After item ${index}`}
                          </option>
                        ))}
                      </select>
                    </label>}
                </div>
                {visibleSelection.recommendedTarget && <p className="prompt-model-summary">Recommended model: {visibleSelection.recommendedTarget.model}</p>}
                <PromptMessagesPreview messages={revision.messages} />
              </>}
            </section>
            <section className="wide-dialog-pane" aria-label="Variables">
              <span className="eyebrow">Variables</span>
              {revision && <>
                <p className="prompt-insertion-variable-summary">
                  {variables.length === 0
                    ? "No values required."
                    : `${variables.length} ${variables.length === 1 ? "value" : "values"} to review after insertion.`}
                </p>
                {variables.length > 0 && <ul className="prompt-variable-list">
                  {variables.map(({ name }) => (
                    <li key={name}>
                      <code>{name}</code>
                      <small>{Object.prototype.hasOwnProperty.call(revision.variableDefaults, name)
                        ? `Default: ${revision.variableDefaults[name]}`
                        : "No default"}</small>
                    </li>
                  ))}
                </ul>}
              </>}
            </section>
          </div>
          <div className="confirmation-actions wide-dialog-footer">
            <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
            <button
              className="button primary"
              disabled={!visibleSelection || !revision}
              type="button"
              onClick={() => visibleSelection && revision && onInsert(
                visibleSelection.id,
                revision.id,
                replaceEmptyDraft ? 0 : Math.min(itemIndex, itemCount),
                replaceEmptyDraft,
              )}
            >
              Insert prompt
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}
