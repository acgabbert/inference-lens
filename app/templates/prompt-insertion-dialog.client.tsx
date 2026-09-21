"use client";

import { useEffect, useMemo, useState } from "react";

import type { PromptTemplate } from "../../packages/core/src/project";
import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
} from "../../packages/core/src/run-kernel";
import { discoverTemplateVariables } from "../../packages/core/src/template-engine";
import { promptRevisionLabel } from "./prompt-revision-label";

export function PromptInsertionDialog({
  templates,
  itemCount,
  onCancel,
  onInsert,
  onOpenPrompts,
}: {
  templates: readonly PromptTemplate[];
  itemCount: number;
  onCancel(): void;
  onInsert(
    templateId: PromptTemplateId,
    revisionId: PromptTemplateRevisionId,
    itemIndex: number,
  ): void;
  onOpenPrompts(): void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<PromptTemplateId | undefined>(
    templates[0]?.id,
  );
  const selectedTemplate = templates.find(({ id }) => id === selectedId);
  const [revisionId, setRevisionId] = useState<PromptTemplateRevisionId | undefined>(
    selectedTemplate?.currentRevisionId,
  );
  const [itemIndex, setItemIndex] = useState(itemCount);
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

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onCancel]);

  function chooseTemplate(template: PromptTemplate): void {
    setSelectedId(template.id);
    setRevisionId(template.currentRevisionId);
  }

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        aria-labelledby="prompt-insertion-title"
        aria-modal="true"
        className="confirmation-dialog prompt-insertion-dialog"
        role="dialog"
      >
        <span className="eyebrow">Current conversation</span>
        <h2 id="prompt-insertion-title">Insert saved prompt</h2>
        {templates.length === 0 ? (
          <>
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
            <p>Choose the exact immutable revision and where it belongs in this conversation.</p>
            <label className="prompt-insertion-search">
              Search prompts
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="prompt-insertion-workspace">
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
              {visibleSelection && revision && (
                <section className="prompt-insertion-selection" aria-label="Prompt selection">
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
                            {candidate.name ? ` — ${candidate.name}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Position
                      <select value={Math.min(itemIndex, itemCount)} onChange={(event) => setItemIndex(Number(event.target.value))}>
                        {Array.from({ length: itemCount + 1 }, (_, index) => (
                          <option key={index} value={index}>
                            {index === 0 ? "At start" : index === itemCount ? "At end" : `After item ${index}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="prompt-insertion-preview">
                    <span className="eyebrow">Preview</span>
                    {revision.messages.map((message, index) => (
                      <article key={`${message.role}-${index}`}>
                        <strong>{message.role}</strong>
                        <pre>{message.content}</pre>
                      </article>
                    ))}
                  </div>
                  <p className="prompt-insertion-variable-summary">
                    {(() => {
                      const variables = discoverTemplateVariables(revision.messages).variables;
                      return variables.length === 0
                        ? "No values required."
                        : `${variables.length} ${variables.length === 1 ? "value" : "values"} to review after insertion.`;
                    })()}
                  </p>
                </section>
              )}
            </div>
            <div className="confirmation-actions">
              <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
              <button
                className="button primary"
                disabled={!visibleSelection || !revision}
                type="button"
                onClick={() => visibleSelection && revision && onInsert(
                  visibleSelection.id,
                  revision.id,
                  Math.min(itemIndex, itemCount),
                )}
              >
                Insert prompt
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
