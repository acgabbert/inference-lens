"use client";

import { useState } from "react";
import { StatusChip } from "../notifications/status-chip.client";

/** What the composer shows about a personal session's local request. */
export interface LocalRequestState {
  kind: "draft" | "scratch";
  /** A scratch started from a run. */
  branched: boolean;
  /** Save creates a request, so it asks for a name. */
  needsName: boolean;
  saving: boolean;
  onSave(name?: string): Promise<boolean>;
  onDiscard(): void;
}

/**
 * Says that the composer holds local work and offers Save and Discard (2b
 * step 3). Lives among the pane's notices, inside its scroll area.
 */
export function LocalRequestNotice({ state }: { state: LocalRequestState }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const detail = state.kind === "draft"
    ? "Your edits to the saved request stay on this device until you save them."
    : state.branched
      ? "This branch stays on this device until you save it."
      : "This request stays on this device until you save it.";
  function save(): void {
    if (state.needsName) {
      setNaming(true);
      return;
    }
    void state.onSave();
  }
  async function saveNamed(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (await state.onSave(trimmed)) {
      setNaming(false);
      setName("");
    }
  }
  return (
    <>
      <StatusChip
        tone="advisory"
        label={state.kind === "draft" ? "Unsaved changes" : "Local request"}
        detail={detail}
        actions={state.saving
          ? [{ key: "saving", label: "Saving…", onSelect() {} }]
          : [
              { key: "save", label: state.needsName ? "Save as request…" : "Save request", onSelect: save },
              { key: "discard", label: state.kind === "draft" ? "Discard changes" : "Discard", onSelect: state.onDiscard },
            ]}
      />
      {naming && !state.saving ? (
        <form
          className="local-request-name"
          onSubmit={(event) => {
            event.preventDefault();
            void saveNamed();
          }}
        >
          <label>
            Request name
            <input
              // Opened by the user's own Save, so taking focus is expected.
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button className="button primary" type="submit" disabled={!name.trim()}>Save</button>
          <button className="button secondary" type="button" onClick={() => setNaming(false)}>Cancel</button>
        </form>
      ) : null}
    </>
  );
}
