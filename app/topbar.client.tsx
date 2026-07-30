"use client";

import type { ChangeEvent } from "react";
import type { StoredInferenceProfile } from "./profile-store.client";

interface TopbarProps {
  profiles: StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  activeModel: string;
  hasCredential: boolean;
  projectName?: string;
  projectDirty: boolean;
  folderAccessAvailable: boolean;
  hasDiagnosticCapture: boolean;
  hasRunTrace: boolean;
  hasProjectWorkspace: boolean;
  runHistoryBlocked: boolean;
  n8nImportDisabledReason?: string;
  isRequestActive: boolean;
  awaitingToolResults: boolean;
  retryableFailure: boolean;
  runDisabled: boolean;
  runDisabledReason?: string;
  onChooseProfile(profileId: string): void;
  onOpenConnections(): void;
  onNewProject(): void;
  onOpenProject(): void;
  onSaveProject(): void;
  onImportProject(event: ChangeEvent<HTMLInputElement>): void;
  onOpenN8nImport(): void;
  onExportProject(): void;
  onOpenToolLibrary(): void;
  onDownloadDiagnostics(): void;
  onDownloadRunTrace(): void;
  onImportRunTrace(event: ChangeEvent<HTMLInputElement>): void;
  onOpenRunHistory(): void;
  onStop(): void;
  onRun(): void;
  onContinue(): void;
  onRetry(): void;
}

function closeContainingMenu(element: HTMLElement): void {
  element.closest("details")?.removeAttribute("open");
}

/** Application menus and the current run controls. */
export function Topbar({
  profiles, activeProfile, activeModel, hasCredential, projectName, projectDirty,
  folderAccessAvailable, hasDiagnosticCapture, isRequestActive, awaitingToolResults,
  hasRunTrace,
  hasProjectWorkspace,
  runHistoryBlocked,
  n8nImportDisabledReason,
  retryableFailure,
  runDisabled, onChooseProfile, onOpenConnections, onNewProject, onOpenProject,
  runDisabledReason,
  onSaveProject, onImportProject, onOpenN8nImport, onExportProject, onOpenToolLibrary,
  onDownloadDiagnostics, onStop, onRun, onContinue, onRetry,
  onDownloadRunTrace,
  onImportRunTrace,
  onOpenRunHistory,
}: TopbarProps) {
  const profileName = activeProfile.name || "Untitled profile";
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">IL</span><div><h1>Inference Lens</h1><p>Inspect every model run · {projectName ? `${projectName}${projectDirty ? " • Unsaved" : ""}` : "No project open"}</p></div></div>
      <div className="header-actions">
        <details className="header-menu target-menu"><summary aria-label={`Run target: ${profileName}, ${activeModel}`} className="target-control" title={`${profileName} · ${activeModel}`}><span className={hasCredential ? "connection-indicator ready" : "connection-indicator"} aria-hidden="true" /><span className="target-copy"><strong>{profileName}</strong><small>{activeModel}</small></span><span className="menu-chevron" aria-hidden="true">⌄</span></summary>
          <div className="menu-popover target-popover"><div className="menu-heading"><span>Run target</span><small>Local profiles</small></div><div className="profile-menu-list">{profiles.map((profile) => <button className={profile.id === activeProfile.id ? "menu-option selected" : "menu-option"} key={profile.id} type="button" onClick={(event) => { onChooseProfile(profile.id); closeContainingMenu(event.currentTarget); }}><span><strong>{profile.name || "Untitled profile"}</strong><small>{profile.endpoint}</small></span>{profile.id === activeProfile.id && <span aria-hidden="true">✓</span>}</button>)}</div><button className="menu-action" type="button" onClick={(event) => { onOpenConnections(); closeContainingMenu(event.currentTarget); }}>Manage connections<span aria-hidden="true">→</span></button></div>
        </details>
        <details className="header-menu project-menu"><summary aria-label="Project menu" className="button secondary"><span className="project-menu-label">Project</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover">
          {folderAccessAvailable && <><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onNewProject(); }}>New project</button><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onOpenProject(); }}>Open project…</button><span className="menu-separator" /></>}
          <button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onSaveProject(); }}>Save <kbd>⌘S</kbd></button><label className="menu-file-button">Import project…<input type="file" accept="application/json,.json" onChange={onImportProject} /></label><button disabled={Boolean(n8nImportDisabledReason)} title={n8nImportDisabledReason} type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onOpenN8nImport(); }}>Import prompt from n8n…</button><button type="button" onClick={onExportProject}>Export project…</button><span className="menu-separator" /><button disabled={!hasProjectWorkspace || runHistoryBlocked} title={runHistoryBlocked ? "Finish or stop the current run before opening history." : undefined} type="button" onClick={(event) => { onOpenRunHistory(); closeContainingMenu(event.currentTarget); }}>Run history…</button><label className="menu-file-button">Import run trace…<input type="file" accept="application/json,.json" onChange={onImportRunTrace} /></label><button disabled={!hasRunTrace} type="button" onClick={onDownloadRunTrace}>Export run trace…</button><span className="menu-separator" /><button type="button" onClick={(event) => { onOpenToolLibrary(); closeContainingMenu(event.currentTarget); }}>Local tool library</button><button disabled={!hasDiagnosticCapture} type="button" onClick={onDownloadDiagnostics}>Download diagnostics</button>
        </div></details>
        {isRequestActive ? <button className="button stop" onClick={onStop}>Stop</button> : awaitingToolResults ? <><button className="button stop" onClick={onStop}>Stop</button><button className="button primary" onClick={onContinue}>Continue run</button></> : retryableFailure ? <><button className="button stop" onClick={onStop}>Discard failed run</button><button className="button secondary" disabled={runDisabled} onClick={onRun} title={runDisabled ? runDisabledReason : undefined}>Run new request</button><button className="button primary" onClick={onRetry}>Retry <span className="shortcut">⌘↵</span></button></> : <button className="button primary" disabled={runDisabled} onClick={onRun} title={runDisabled ? runDisabledReason : undefined}>Run request <span className="shortcut">⌘↵</span></button>}
      </div>
    </header>
  );
}
