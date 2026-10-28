"use client";

import { useState, type ReactNode } from "react";

/**
 * The header's Revision field, with an inline rename for the saved revision
 * being viewed. Only the label changes; a blank name falls back to the
 * revision's position, shown as the placeholder.
 */
export function RevisionField({
  children,
  rename,
}: {
  /** The revision select. */
  children: ReactNode;
  /** Omitted when the viewed entry is not a saved revision that can be relabeled. */
  rename?: {
    name: string;
    fallbackLabel: string;
    onRename(name: string): void;
  };
}) {
  const [draft, setDraft] = useState<string | undefined>();
  const editing = Boolean(rename) && draft !== undefined;

  function commit(): void {
    if (draft === undefined) return;
    rename?.onRename(draft);
    setDraft(undefined);
  }

  const heading = (actions: ReactNode) => (
    <div className="template-revision-field-heading">
      <span>Revision</span>
      {actions}
    </div>
  );

  if (!editing) {
    return (
      <div className="template-revision-field">
        {heading(rename && (
          <button
            aria-label="Rename revision"
            className="text-button"
            type="button"
            onClick={() => setDraft(rename.name)}
          >
            Rename
          </button>
        ))}
        {children}
      </div>
    );
  }

  // The actions take the Rename link's place so the input keeps the select's width.
  return (
    <form
      className="template-revision-field"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      {heading(
        <span className="template-revision-rename-actions">
          <button className="text-button" type="submit">Save name</button>
          <button className="text-button" type="button" onClick={() => setDraft(undefined)}>
            Cancel
          </button>
        </span>,
      )}
      <input
        aria-label="New revision name"
        autoFocus
        className="template-revision-rename"
        placeholder={rename!.fallbackLabel}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Escape here cancels the rename, not the surrounding focus mode.
          event.preventDefault();
          event.stopPropagation();
          setDraft(undefined);
        }}
      />
    </form>
  );
}
