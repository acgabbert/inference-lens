"use client";

import { useState } from "react";
import type { LinkedPromptSourcesHandle, LinkedPromptState } from "./use-linked-prompt-sources.client";

export interface LinkedPromptSourceView {
  rootName: string;
  path: string;
  state: LinkedPromptState;
}

/** The drift lines for a linked prompt; shared by the library entry and the editor. */
export function linkedPromptStatusLines(state: LinkedPromptState): string[] {
  switch (state.kind) {
    case "checking":
      return ["Checking the source file…"];
    case "unavailable":
    case "unreadable":
      return [state.message];
    case "read":
      return [
        state.drift.fileChanged ? "File changed since last pull" : "File matches the last pull",
        ...(state.drift.localRevisions ? ["Local revisions not from the file"] : []),
      ];
  }
}

/**
 * The editor's linked-source row for a file-tracked prompt: where it is
 * linked, its drift, and Pull, Refresh, Change link and Unlink. Reading the
 * file again on Pull means the preview never shows a stale read.
 */
export function LinkedPromptSource({ link, sources, canEdit, onPull, onOpenLink, onUnlink }: {
  link?: LinkedPromptSourceView;
  sources: LinkedPromptSourcesHandle;
  canEdit: boolean;
  onPull(source: { label: string; path: string; text: string }): void;
  onOpenLink(): void;
  onUnlink(): void;
}) {
  const [pullError, setPullError] = useState<string>();
  const [pulling, setPulling] = useState(false);
  if (!link) {
    return canEdit ? <div className="file-prompt-actions linked-prompt-source">
      <span>Not linked to a source folder.</span>
      <button className="button secondary" type="button" onClick={onOpenLink}>Link to source file…</button>
    </div> : null;
  }
  const folder = sources.folderFor(link.rootName);
  const label = `${link.rootName}/${link.path}`;
  const undeclared = !folder && sources.availability.kind === "ready";
  return <section aria-label="Linked source file" className="linked-prompt-source">
    <div className="file-prompt-actions">
      <span>Linked to <code>{label}</code></span>
      {canEdit && <button className="button secondary" disabled={link.state.kind !== "read" || pulling} type="button" onClick={async () => {
        if (!folder) return;
        setPulling(true);
        setPullError(undefined);
        try {
          const result = await sources.readFile(folder, link.path);
          if (result.ok) onPull({ label, path: link.path, text: result.text });
          else setPullError(result.message);
        } catch (cause) {
          setPullError(cause instanceof Error ? cause.message : "Could not read the source file.");
        } finally {
          setPulling(false);
        }
      }}>Pull from file…</button>}
      <button className="button secondary" type="button" onClick={sources.refresh}>Refresh</button>
      {canEdit && <button className="button secondary" type="button" onClick={onOpenLink}>Change link…</button>}
      {canEdit && <button className="button secondary" type="button" onClick={onUnlink}>Unlink</button>}
    </div>
    <ul aria-label="Source file status" className="linked-prompt-source-status">
      {linkedPromptStatusLines(link.state).map((line) => <li key={line}>{line}</li>)}
    </ul>
    {undeclared && sources.folders.length > 0 && <label className="linked-prompt-source-mapping">
      Read “{link.rootName}” from this server folder for this session
      <select value="" onChange={(event) => { if (event.target.value) sources.mapFolder(link.rootName, event.target.value); }}>
        <option value="">Choose a folder</option>
        {sources.folders.map(({ name, label: folderLabel }) => <option key={name} value={name}>{folderLabel ? `${folderLabel} (${name})` : name}</option>)}
      </select>
    </label>}
    {pullError && <p role="alert">{pullError}</p>}
  </section>;
}
