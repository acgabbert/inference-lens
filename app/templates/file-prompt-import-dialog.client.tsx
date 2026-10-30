"use client";

import { useEffect, useState } from "react";
import { createFilePromptCandidate, decodePromptFile, type FilePromptInput } from "../../packages/core/src/file-prompt-import";
import { projectExternalPromptTemplate } from "../../packages/core/src/external-prompt-project";
import type { ExternalPromptCandidate } from "../../packages/core/src/external-prompt-import";
import { ModalDialog } from "../modal-dialog.client";
import { WorkbenchPanel } from "../workbench-panel.client";

interface FileDraft {
  file: File;
  role: FilePromptInput["role"];
  plainText: boolean;
}
type Preview = { candidate: ExternalPromptCandidate } | { error: string };

/** Owns the entire transient pick/drop/read/review lifecycle. No writes until Apply. */
export function FilePromptImportDialog({ initialFiles = [], priorImports = () => [], onImport, onClose }: {
  initialFiles?: File[];
  /** Saved prompts already imported from a filename; a match warns but never blocks. */
  priorImports?(filename: string): string[];
  onImport(candidates: ExternalPromptCandidate[]): Promise<void>;
  onClose(): void;
}) {
  const [drafts, setDrafts] = useState<FileDraft[]>(() => initialFiles.map((file) => ({ file, role: "user", plainText: false })));
  const [previews, setPreviews] = useState<Preview[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all(drafts.map(async ({ file, role, plainText }): Promise<Preview> => {
      try {
        if (!/\.(md|txt)$/i.test(file.name)) throw new Error("Choose a .md or .txt file.");
        const text = decodePromptFile(await file.arrayBuffer());
        return { candidate: await createFilePromptCandidate({ filename: file.name, text, role, plainText }) };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not read this file." };
      }
    })).then((next) => { if (!cancelled) setPreviews(next); });
    return () => { cancelled = true; };
  }, [drafts]);

  function choose(files: File[]): void {
    if (busy) return;
    setPreviews(undefined);
    setError(undefined);
    setDrafts(files.map((file) => ({ file, role: "user", plainText: false })));
  }
  function update(index: number, patch: Partial<FileDraft>): void {
    setPreviews(undefined);
    setError(undefined);
    setDrafts(drafts.map((draft, position) => position === index ? { ...draft, ...patch } : draft));
  }
  const ready = drafts.length > 0 && previews?.length === drafts.length && previews.every((preview) => "candidate" in preview);
  return <ModalDialog
    backdropClassName="file-prompt-backdrop"
    className="file-prompt-dialog"
    labelledBy="file-prompt-title"
    onClose={() => { if (!busy) onClose(); }}
  >
    <WorkbenchPanel header={<h2 id="file-prompt-title">Import prompts from files</h2>}>
      <div className="file-prompt-body" onDragOver={(event) => { event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); choose(Array.from(event.dataTransfer.files)); }}>
        <p>Choose or drop .md or .txt files. Each file becomes one reusable prompt. Review the text and variables before importing.</p>
        <p>n8n expressions become variables you supply; expressions are never run.</p>
        <label>Prompt files<input type="file" accept=".md,.txt,text/plain,text/markdown" multiple disabled={busy} onChange={(event) => choose(Array.from(event.target.files ?? []))} /></label>
        {drafts.map((draft, index) => {
          const preview = previews?.[index];
          const candidate = preview && "candidate" in preview ? preview.candidate : undefined;
          const projection = candidate ? projectExternalPromptTemplate(candidate) : undefined;
          const prior = priorImports(draft.file.name);
          const sameNameInBatch = drafts.some((other, position) => position !== index && other.file.name === draft.file.name);
          return <fieldset key={index} disabled={busy}>
            <legend>{draft.file.name}</legend>
            <label>Message role<select value={draft.role} onChange={(event) => update(index, { role: event.target.value as FileDraft["role"] })}>
              <option value="user">User</option><option value="system">System</option><option value="assistant">Assistant</option>
            </select></label>
            <label className="file-prompt-checkbox"><input type="checkbox" checked={draft.plainText} onChange={(event) => update(index, { plainText: event.target.checked })} />Treat as plain text</label>
            {prior.length > 0 && <p className="file-prompt-warning">
              Already imported as {prior.map((name) => `“${name}”`).join(", ")}. Importing again creates a separate saved prompt.
            </p>}
            {sameNameInBatch && <p className="file-prompt-warning">
              Another file in this batch is also named {draft.file.name}. Each becomes a separate saved prompt.
            </p>}
            {preview && "error" in preview && <p role="alert">{preview.error}</p>}
            {candidate && projection ? <>
              <details><summary>Source text</summary><pre>{candidate.authored[0].text}</pre></details>
              <label>Template preview<textarea readOnly rows={4} value={projection.messages[0].content} /></label>
              {projection.variables.length > 0 ? <ul>{projection.variables.map((variable) => <li key={variable.bindingIndex}><code>{variable.expression} → {`{{${variable.variableName}}}`}</code></li>)}</ul> : <p>No input variables.</p>}
            </> : !preview && <p role="status">Reading file…</p>}
          </fieldset>;
        })}
        {error && <p role="alert">{error}</p>}
        <div className="file-prompt-actions">
          <button className="button secondary" disabled={busy} type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || !ready} type="button" onClick={async () => {
            if (!ready || !previews) return;
            setBusy(true);
            try {
              await onImport(previews.flatMap((preview) => "candidate" in preview ? [preview.candidate] : []));
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not import these files.");
              setBusy(false);
            }
          }}>{busy ? "Importing…" : `Import ${drafts.length} prompt${drafts.length === 1 ? "" : "s"}`}</button>
        </div>
      </div>
    </WorkbenchPanel>
  </ModalDialog>;
}
