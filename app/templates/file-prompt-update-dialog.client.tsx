"use client";

import { useEffect, useState } from "react";
import { createFilePromptCandidate, decodePromptFile, type FilePromptInput } from "../../packages/core/src/file-prompt-import";
import type { FilePromptUpdatePlan } from "../../packages/core/src/file-prompt-update";
import type { ExternalPromptCandidate } from "../../packages/core/src/external-prompt-import";
import type { ChatPromptTemplate, ChatPromptTemplateRevision, ExternalImportReceipt } from "../../packages/core/src/project";
import { diffPromptTemplateRevisions } from "../../packages/core/src/prompt-template-revision-diff";
import { ChatRevisionDiff } from "./chat-revision-diff.client";
import { promptRevisionLabel } from "./prompt-revision-label";
import { ModalDialog } from "../modal-dialog.client";
import { WorkbenchPanel } from "../workbench-panel.client";

type Reading = { candidate: ExternalPromptCandidate } | { error: string };
type Preview = { plan: FilePromptUpdatePlan } | { error: string };

function readingLabel(version: string | undefined): string {
  return version === "plain-text-v1" ? "plain text" : "n8n expressions";
}

function DiffSection({ title, before, after }: { title: string; before: ChatPromptTemplateRevision; after: ChatPromptTemplateRevision }) {
  const diff = diffPromptTemplateRevisions(before, after);
  return <section aria-label={title}>
    <h3>{title}</h3>
    {diff.identical ? <p>No changes.</p> : <ChatRevisionDiff diff={diff} />}
  </section>;
}

/**
 * Owns reading one file and previewing a pull into a file-tracked prompt.
 * Nothing is written until Apply; the source file is never written.
 */
export function FilePromptUpdateDialog({ template, lastReceipt, plan, onApply, onClose }: {
  template: ChatPromptTemplate;
  /** The last pull; its role and reading are the defaults. */
  lastReceipt: ExternalImportReceipt;
  plan(candidate: ExternalPromptCandidate): FilePromptUpdatePlan;
  onApply(candidate: ExternalPromptCandidate): Promise<void>;
  onClose(): void;
}) {
  const [file, setFile] = useState<File>();
  const [role, setRole] = useState<FilePromptInput["role"]>(lastReceipt.authored[0]?.role ?? "user");
  const [plainText, setPlainText] = useState(lastReceipt.invocation.version === "plain-text-v1");
  const [reading, setReading] = useState<Reading>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async (): Promise<Reading> => {
      try {
        if (!/\.(md|txt)$/i.test(file.name)) throw new Error("Choose a .md or .txt file.");
        const text = decodePromptFile(await file.arrayBuffer());
        return { candidate: await createFilePromptCandidate({ filename: file.name, text, role, plainText }) };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not read this file." };
      }
    })().then((next) => { if (!cancelled) setReading(next); });
    return () => { cancelled = true; };
  }, [file, role, plainText]);
  // Planned on every render, so the preview follows the latest project.
  let preview: Preview | undefined;
  if (reading && "error" in reading) {
    preview = reading;
  } else if (reading) {
    try {
      preview = { plan: plan(reading.candidate) };
    } catch (cause) {
      preview = { error: cause instanceof Error ? cause.message : "Could not preview this update." };
    }
  }

  function choose(files: File[]): void {
    if (busy || files.length === 0) return;
    setReading(undefined);
    setError(undefined);
    if (files.length > 1) {
      setFile(undefined);
      setError("Choose one file to update this prompt from.");
      return;
    }
    setFile(files[0]);
  }
  const current = preview && "plan" in preview ? preview.plan : undefined;
  const pulled: ChatPromptTemplateRevision | undefined = current && {
    ...current.current,
    messages: current.messages,
    variableDefaults: current.variableDefaults,
    externalImportId: current.lastPulled.receipt.id,
  };
  const lastFilename = lastReceipt.source.resource.name ?? lastReceipt.source.resource.id;
  const replacesLocal = Boolean(current && current.current.id !== current.lastPulled.revision.id);
  const ready = Boolean(current && !current.blocked && current.wouldChange);
  return <ModalDialog
    backdropClassName="file-prompt-backdrop"
    className="file-prompt-dialog"
    labelledBy="file-update-title"
    onClose={() => { if (!busy) onClose(); }}
  >
    <WorkbenchPanel header={<h2 id="file-update-title">Update “{template.name}” from file</h2>}>
      <div className="file-prompt-body" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => {
        event.preventDefault();
        // The library also accepts file drops; this drop belongs only to the update.
        event.stopPropagation();
        choose(Array.from(event.dataTransfer.files));
      }}>
        <p>Choose or drop the .md or .txt file this prompt tracks, last pulled from {lastFilename}. The file is only read, never written.</p>
        <label>Prompt file<input type="file" accept=".md,.txt,text/plain,text/markdown" disabled={busy} onChange={(event) => choose(Array.from(event.target.files ?? []))} /></label>
        <fieldset disabled={busy}>
          <legend>Read as</legend>
          <label>Message role<select value={role} onChange={(event) => { setReading(undefined); setRole(event.target.value as FilePromptInput["role"]); }}>
            <option value="user">User</option><option value="system">System</option><option value="assistant">Assistant</option>
          </select></label>
          <label className="file-prompt-checkbox"><input type="checkbox" checked={plainText} onChange={(event) => { setReading(undefined); setPlainText(event.target.checked); }} />Treat as plain text</label>
        </fieldset>
        {file && !preview && <p role="status">Reading file…</p>}
        {preview && "error" in preview && <p role="alert">{preview.error}</p>}
        {current && pulled && <>
          <ul aria-label="Changes from file" className="file-prompt-update-status">
            <li>Compared with {promptRevisionLabel(template, current.lastPulled.revision.id)}, the last pull.</li>
            <li>{current.textChanged ? "File text changed since the last pull." : "File text is unchanged since the last pull."}</li>
            {current.roleChanged && <li>Message role changes from {current.lastPulled.receipt.authored[0]?.role} to {role}.</li>}
            {current.interpretationChanged && <li>Reading changes from {readingLabel(current.lastPulled.receipt.invocation.version)} to {readingLabel(current.candidate.invocation.version)}.</li>}
          </ul>
          {current.filenameChanged && <p className="file-prompt-warning">
            This prompt was last pulled from {lastFilename}; this file is {file?.name}. Check it is the right file.
          </p>}
          {replacesLocal && <p className="file-prompt-warning">
            Replaces {promptRevisionLabel(template, current.current.id)} as current.
            {current.localRevisionIds.length > 0 && <> Saved since the last pull: {current.localRevisionIds.map((id) => promptRevisionLabel(template, id)).join(", ")}. They stay in history and can be made current again.</>}
          </p>}
          {current.blocked && <p role="alert">{current.blocked}</p>}
          {!current.wouldChange && <p role="status">The current revision already matches this file.</p>}
          {current.variables.length > 0 ? <ul aria-label="Variables">{current.variables.map((variable) => <li key={variable.bindingIndex}>
            <code>{variable.expression} → {`{{${variable.variableName}}}`}</code> · {variable.reused ? "kept" : "new"}
          </li>)}</ul> : <p>No input variables.</p>}
          {Object.keys(current.variableDefaults).length > 0 && <p>
            Keeps defaults for {Object.keys(current.variableDefaults).map((name) => `{{${name}}}`).join(", ")}.
          </p>}
          <DiffSection title="File changes since last pull" before={current.lastPulled.revision} after={pulled} />
          {replacesLocal && <DiffSection title="Replaces current" before={current.current} after={pulled} />}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="file-prompt-actions">
          <button className="button secondary" disabled={busy} type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || !ready} type="button" onClick={async () => {
            if (!ready || !current) return;
            setBusy(true);
            try {
              await onApply(current.candidate);
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not update this prompt.");
              setBusy(false);
            }
          }}>{busy ? "Updating…" : replacesLocal ? "Replace current with file" : "Update from file"}</button>
        </div>
      </div>
    </WorkbenchPanel>
  </ModalDialog>;
}
