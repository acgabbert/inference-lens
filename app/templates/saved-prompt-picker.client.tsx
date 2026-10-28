"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  isChatPromptTemplate,
  type ChatPromptTemplate,
  type PromptTemplate,
} from "../../packages/core/src/project";
import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
} from "../../packages/core/src/run-kernel";
import { discoverTemplateVariables } from "../../packages/core/src/template-engine";
import { filterPromptLibrary } from "./prompt-library";
import { promptRevisionLabel } from "./prompt-revision-label";

/** Keeps a click on an option from blurring the search before it registers. */
const preventBlur = (event: { preventDefault: () => void }): void =>
  event.preventDefault();

/**
 * Names are not identities, so the row's second line carries what tells two
 * prompts of one name apart without opening either: the revision a quick
 * insert pins and how many values it will ask for.
 */
function describeRow(template: ChatPromptTemplate): string {
  const revision = template.revisions.find(({ id }) => id === template.currentRevisionId);
  const label = promptRevisionLabel(template, template.currentRevisionId).replace(/ \(current\)$/, "");
  const count = revision ? discoverTemplateVariables(revision.messages).variables.length : 0;
  return `${label} · ${count === 0 ? "no values" : `${count} ${count === 1 ? "value" : "values"}`}`;
}

/**
 * The fast path to a saved prompt: pick one by name and it is inserted at once
 * on its current revision. The composer decides where it lands, as it does for
 * the dialog. Anything more — another revision, another position, a preview —
 * belongs to the dialog, which `onMoreOptions` opens on the same search.
 */
export function SavedPromptPicker({
  templates: allTemplates,
  onInsert,
  onMoreOptions,
  onOpenPrompts,
}: {
  /** Chat prompts the composer may insert, in project order. */
  templates: readonly PromptTemplate[];
  onInsert(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId): void;
  onMoreOptions(query: string, templateId: PromptTemplateId | undefined): void;
  onOpenPrompts(): void;
}) {
  const templates = useMemo(() => allTemplates.filter(isChatPromptTemplate), [allTemplates]);
  const idPrefix = useId();
  const popoverId = `${idPrefix}-popover`;
  const listboxId = `${idPrefix}-options`;
  const optionId = (index: number): string => `${idPrefix}-option-${index}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rows = filterPromptLibrary(templates, { status: "active", kind: "all", search: query.trim() });
  const highlighted = rows[Math.min(highlightedIndex, rows.length - 1)];

  // Focus leaving the picker for anywhere else closes it; a pointer press
  // outside does too, because a press on a non-focusable surface moves no
  // focus and would otherwise leave the popover floating over the composer.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  function openPicker(): void {
    setQuery("");
    setHighlightedIndex(0);
    setOpen(true);
  }

  function close({ restoreFocus }: { restoreFocus: boolean }): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function insert(template: ChatPromptTemplate): void {
    // Focus is the composer's to place on the inserted item, so it is not
    // returned to the trigger here.
    setOpen(false);
    onInsert(template.id, template.currentRevisionId);
  }

  function moreOptions(): void {
    // The trigger becomes the dialog's opener, so closing the dialog returns there.
    close({ restoreFocus: true });
    onMoreOptions(query.trim(), highlighted?.id);
  }

  return (
    <div
      className="saved-prompt-picker"
      ref={rootRef}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="button secondary"
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close({ restoreFocus: false }) : openPicker())}
      >
        Insert saved prompt…
      </button>
      {open && (
        <div
          aria-label="Insert saved prompt"
          className="saved-prompt-popover"
          id={popoverId}
          role="dialog"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // The composer's focus mode also listens for Escape; this one
            // belongs to the picker alone.
            event.stopPropagation();
            close({ restoreFocus: true });
          }}
        >
          {templates.length === 0 ? (
            <div className="saved-prompt-popover-empty">
              <p>This project has no active saved prompts.</p>
              <button autoFocus className="button secondary" type="button" onClick={() => {
                setOpen(false);
                onOpenPrompts();
              }}>
                Open Prompts
              </button>
            </div>
          ) : (
            <>
              <input
                aria-activedescendant={highlighted ? optionId(rows.indexOf(highlighted)) : undefined}
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded
                aria-label="Search saved prompts"
                autoComplete="off"
                autoFocus
                placeholder="Search by name"
                role="combobox"
                spellCheck={false}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    if (rows.length === 0) return;
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    const current = highlighted ? rows.indexOf(highlighted) : 0;
                    setHighlightedIndex((current + direction + rows.length) % rows.length);
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.shiftKey) moreOptions();
                    else if (highlighted) insert(highlighted);
                  }
                }}
              />
              <div aria-label="Saved prompts" className="saved-prompt-options" id={listboxId} role="listbox">
                {rows.length === 0 ? (
                  <p className="saved-prompt-options-status">No prompts match “{query.trim()}”.</p>
                ) : rows.map((template, index) => (
                  <div
                    aria-selected={template === highlighted}
                    className={template === highlighted ? "saved-prompt-option-row highlighted" : "saved-prompt-option-row"}
                    id={optionId(index)}
                    key={template.id}
                    role="option"
                    onMouseDown={preventBlur}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => insert(template)}
                  >
                    <strong>{template.name}</strong>
                    <span>{describeRow(template)}</span>
                  </div>
                ))}
              </div>
              <div className="saved-prompt-popover-footer">
                <button className="text-button" type="button" onMouseDown={preventBlur} onClick={moreOptions}>
                  More options…
                </button>
                <span aria-hidden="true">Shift+Enter</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
