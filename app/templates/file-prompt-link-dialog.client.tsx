"use client";

import { useEffect, useId, useState } from "react";
import type { SourceFileReadResult, SourceRootFileListResponse } from "../../packages/contracts/src/index.ts";
import type { ChatPromptTemplate, ExternalImportReceipt } from "../../packages/core/src/project";
import { comparableText } from "../../packages/core/src/file-prompt-update";
import { sourceFileBasename } from "../../packages/core/src/source-root-rules";
import { ModalDialog } from "../modal-dialog.client";
import { WorkbenchPanel } from "../workbench-panel.client";
import { sourceRootAvailabilityMessage, type LinkedPromptSourcesHandle } from "./use-linked-prompt-sources.client";

const SHOWN_FILES = 200;

// Keyed by what they were read for, so a stale answer is never shown.
type Listing = { folder: string } & ({ files: SourceRootFileListResponse } | { error: string });
type Preview = { key: string } & ({ result: SourceFileReadResult } | { error: string });

/**
 * Owns choosing a server folder and one of its files for a file-tracked
 * prompt. Linking changes only the link; the preview says whether the file
 * matches the last pull, and nothing is pulled.
 */
export function FilePromptLinkDialog({ template, lastReceipt, sources, current, onLink, onClose }: {
  template: ChatPromptTemplate;
  lastReceipt: ExternalImportReceipt;
  sources: LinkedPromptSourcesHandle;
  /** The existing link, when changing it. */
  current?: { folder?: string; path: string };
  onLink(rootName: string, path: string): void;
  onClose(): void;
}) {
  const filterId = useId();
  const unavailable = sourceRootAvailabilityMessage(sources.availability);
  const [chosenFolder, setFolder] = useState(current?.folder ?? "");
  // Folders may finish loading after the dialog opens.
  const folder = chosenFolder || sources.folders[0]?.name || "";
  const { listFiles, readFile } = sources;
  const [listed, setListing] = useState<Listing>();
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState(current?.folder ? current.path : "");
  const [previewed, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const lastFilename = lastReceipt.source.resource.name ?? lastReceipt.source.resource.id;

  useEffect(() => {
    if (!folder || unavailable) return;
    let cancelled = false;
    listFiles(folder).then(
      (files) => {
        if (cancelled) return;
        setListing({ folder, files });
        // A file with the imported name is the likely one, when it is unique.
        const named = files.files.filter((file) => sourceFileBasename(file) === sourceFileBasename(lastFilename));
        setPath((chosen) => (chosen && files.files.includes(chosen) ? chosen : named.length === 1 ? named[0]! : ""));
      },
      (cause: unknown) => { if (!cancelled) setListing({ folder, error: cause instanceof Error ? cause.message : "Could not list this folder." }); },
    );
    return () => { cancelled = true; };
  }, [folder, unavailable, listFiles, lastFilename]);

  const previewKey = JSON.stringify([folder, path]);
  useEffect(() => {
    if (!folder || !path) return;
    let cancelled = false;
    const key = JSON.stringify([folder, path]);
    readFile(folder, path).then(
      (result) => { if (!cancelled) setPreview({ key, result }); },
      (cause: unknown) => { if (!cancelled) setPreview({ key, error: cause instanceof Error ? cause.message : "Could not read this file." }); },
    );
    return () => { cancelled = true; };
  }, [folder, path, readFile]);

  const listing = listed?.folder === folder ? listed : undefined;
  const preview = path && previewed?.key === previewKey ? previewed : undefined;
  const files = listing && "files" in listing ? listing.files : undefined;
  const matching = files?.files.filter((file) => file.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  const read = preview && "result" in preview && preview.result.ok ? preview.result.text : undefined;
  const ready = Boolean(folder && path && read !== undefined);
  return <ModalDialog
    backdropClassName="file-prompt-backdrop"
    className="file-prompt-dialog"
    labelledBy="file-link-title"
    onClose={onClose}
  >
    <WorkbenchPanel header={<h2 id="file-link-title">Link “{template.name}” to a source file</h2>}>
      <div className="file-prompt-body">
        <p>Choose the file in a server folder that this prompt tracks, last pulled from {lastFilename}. Linking does not change the prompt; the library then shows when the file changes, and Pull from file reads it from the folder. The file is only read, never written.</p>
        {unavailable ? <p role="alert">{unavailable}</p> : sources.availability.kind === "loading" ? <p role="status">Checking source folders…</p> : <>
          <label>Source folder<select value={folder} onChange={(event) => { setFolder(event.target.value); setPath(""); setFilter(""); }}>
            {sources.folders.map(({ name, label }) => <option key={name} value={name}>{label ? `${label} (${name})` : name}</option>)}
          </select></label>
          {!listing && folder && <p role="status">Listing files…</p>}
          {listing && "error" in listing && <p role="alert">{listing.error}</p>}
          {files && (files.files.length === 0 ? <p>This folder has no .md or .txt files.</p> : <fieldset>
            <legend>File</legend>
            <label htmlFor={filterId}>Find a file</label>
            <input id={filterId} type="search" value={filter} placeholder="Filter by path" onChange={(event) => setFilter(event.target.value)} />
            <ul aria-label="Files" className="file-prompt-link-files">
              {matching.slice(0, SHOWN_FILES).map((file) => <li key={file}>
                <label className="file-prompt-checkbox"><input type="radio" name="source-file" checked={path === file} onChange={() => setPath(file)} /><code>{file}</code></label>
              </li>)}
            </ul>
            {matching.length === 0 && <p>No file matches “{filter}”.</p>}
            {matching.length > SHOWN_FILES && <p>{matching.length - SHOWN_FILES} more files match; narrow the filter.</p>}
            {files.truncated && <p>This folder holds more files than can be listed; filter or choose a smaller folder.</p>}
          </fieldset>)}
          {path && !preview && <p role="status">Reading {path}…</p>}
          {preview && "error" in preview && <p role="alert">{preview.error}</p>}
          {preview && "result" in preview && !preview.result.ok && <p role="alert">{preview.result.message}</p>}
          {read !== undefined && (comparableText(read) === comparableText(lastReceipt.authored[0]!.text)
            ? <p role="status">This file matches the last pull.</p>
            : <p className="file-prompt-warning">This file differs from the last pull. The library will show “File changed since last pull” until you pull it.</p>)}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="file-prompt-actions">
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!ready} type="button" onClick={() => {
            try {
              onLink(sources.rootNameFor(folder), path);
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not link this prompt.");
            }
          }}>Link</button>
        </div>
      </div>
    </WorkbenchPanel>
  </ModalDialog>;
}
