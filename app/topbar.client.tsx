"use client";

import type { ChangeEvent } from "react";
import type { StoredInferenceProfile } from "./profile-store.client";
import { ModeStrip } from "./modes/mode-strip.client";
import type { AppMode } from "./modes/app-mode";

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
  isRequestActive: boolean;
  isExperimentActive: boolean;
  /**
   * Which mode is on screen. The run controls belong to Compose; the other
   * modes supply their own primary action next to what it acts on. This
   * replaces the old `actionContext`, which read the same boundary off a tab.
   */
  mode: AppMode;
  onModeChange(mode: AppMode): void;
  /** Modes with a batch still running, so the strip can say so. */
  busyModes?: readonly AppMode[];
  awaitingToolResults: boolean;
  retryableFailure: boolean;
  runDisabled: boolean;
  runDisabledReason?: string;
  repeatDisabled: boolean;
  repeatDisabledReason?: string;
  onChooseProfile(profileId: string): void;
  onOpenConnections(): void;
  onNewProject(): void;
  onOpenProject(): void;
  onSaveProject(): void;
  onImportProject(event: ChangeEvent<HTMLInputElement>): void;
  onExportProject(): void;
  onDownloadDiagnostics(): void;
  onDownloadRunTrace(): void;
  onImportRunTrace(event: ChangeEvent<HTMLInputElement>): void;
  onOpenRunHistory(): void;
  onStop(): void;
  onStopExperiment(): void;
  onRun(): void;
  onRepeat(): void;
  onContinue(): void;
  onRetry(): void;
}

function closeContainingMenu(element: HTMLElement): void {
  element.closest("details")?.removeAttribute("open");
}

/** Application menus and the current run controls. */
export function Topbar({
  profiles, activeProfile, activeModel, hasCredential, projectName, projectDirty,
  folderAccessAvailable, hasDiagnosticCapture, isRequestActive, isExperimentActive, awaitingToolResults,
  mode, onModeChange, busyModes,
  hasRunTrace,
  hasProjectWorkspace,
  runHistoryBlocked,
  retryableFailure,
  runDisabled, repeatDisabled, onChooseProfile, onOpenConnections, onNewProject, onOpenProject,
  runDisabledReason, repeatDisabledReason,
  onSaveProject, onImportProject, onExportProject,
  onDownloadDiagnostics, onStop, onStopExperiment, onRun, onRepeat, onContinue, onRetry,
  onDownloadRunTrace,
  onImportRunTrace,
  onOpenRunHistory,
}: TopbarProps) {
  const profileName = activeProfile.name || "Untitled profile";
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">IL</span><div><h1>Inference Lens</h1><p>Inspect every model run · {projectName ? `${projectName}${projectDirty ? " • Unsaved" : ""}` : "No project open"}</p></div></div>
      <ModeStrip value={mode} onChange={onModeChange} {...(busyModes ? { busyModes } : {})} />
      <div className="header-actions">
        <details className="header-menu target-menu"><summary aria-label={`Run target: ${profileName}, ${activeModel}`} className="target-control" title={`${profileName} · ${activeModel}`}><span className={hasCredential ? "connection-indicator ready" : "connection-indicator"} aria-hidden="true" /><span className="target-copy"><strong>{profileName}</strong><small>{activeModel}</small></span><span className="menu-chevron" aria-hidden="true">⌄</span></summary>
          <div className="menu-popover target-popover"><div className="menu-heading"><span>Run target</span><small>Local profiles</small></div><div className="profile-menu-list">{profiles.map((profile) => <button className={profile.id === activeProfile.id ? "menu-option selected" : "menu-option"} key={profile.id} type="button" onClick={(event) => { onChooseProfile(profile.id); closeContainingMenu(event.currentTarget); }}><span><strong>{profile.name || "Untitled profile"}</strong><small>{profile.endpoint}</small></span>{profile.id === activeProfile.id && <span aria-hidden="true">✓</span>}</button>)}</div><button className="menu-action" type="button" onClick={(event) => { onOpenConnections(); closeContainingMenu(event.currentTarget); }}>Manage connections<span aria-hidden="true">→</span></button></div>
        </details>
        <details className="header-menu project-menu"><summary aria-label="Project menu" className="button secondary"><span className="project-menu-label">Project</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover">
          <div className="menu-group-heading">Project</div>
          {folderAccessAvailable && <><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onNewProject(); }}>New project</button><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onOpenProject(); }}>Open project…</button><span className="menu-separator" /></>}
          <button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onSaveProject(); }}>Save <kbd>⌘S</kbd></button><label className="menu-file-button">Import project…<input type="file" accept="application/json,.json" onChange={onImportProject} /></label><button type="button" onClick={onExportProject}>Export project…</button>
        </div></details>
        <details className="header-menu run-data-menu"><summary aria-label="Run data menu" className="button secondary"><span className="run-data-menu-label">Run data</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover run-data-popover">
          <div className="menu-group-heading">Run data</div>
          <button disabled={!hasProjectWorkspace || runHistoryBlocked} title={runHistoryBlocked ? "Finish or stop the current run before opening history." : undefined} type="button" onClick={(event) => { onOpenRunHistory(); closeContainingMenu(event.currentTarget); }}>Run history…</button><label className="menu-file-button">Import run trace…<input type="file" accept="application/json,.json" onChange={onImportRunTrace} /></label><button disabled={!hasRunTrace} type="button" onClick={onDownloadRunTrace}>Export run trace…</button><span className="menu-separator" /><button disabled={!hasDiagnosticCapture} type="button" onClick={onDownloadDiagnostics}>Download diagnostics</button>
        </div></details>
        {isExperimentActive ? <button className="button stop" onClick={onStopExperiment}>Stop remaining</button> : isRequestActive ? <button className="button stop" onClick={onStop}>Stop</button> : mode !== "compose" ? null : awaitingToolResults ? <><button className="button stop" onClick={onStop}>Stop</button><button className="button primary" onClick={onContinue}>Continue run</button></> : retryableFailure ? <><button className="button stop" onClick={onStop}>Discard failed run</button><button className="button secondary" disabled={runDisabled} onClick={onRun} title={runDisabled ? runDisabledReason : undefined}>Run new request</button><button className="button secondary" disabled={repeatDisabled} onClick={onRepeat} title={repeatDisabled ? repeatDisabledReason : undefined}>Repeat…</button><button className="button primary" onClick={onRetry}>Retry <span className="shortcut">⌘↵</span></button></> : <><button className="button secondary" disabled={repeatDisabled} onClick={onRepeat} title={repeatDisabled ? repeatDisabledReason : undefined}>Repeat…</button><button className="button primary" disabled={runDisabled} onClick={onRun} title={runDisabled ? runDisabledReason : undefined}>Run request <span className="shortcut">⌘↵</span></button></>}
      </div>
    </header>
  );
}
