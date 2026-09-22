"use client";

import type { ChangeEvent } from "react";
import type { StoredInferenceProfile } from "./profile-store.client";
import type { ProjectStorageState } from "./use-project-workspace.client";
import { ModeStrip } from "./modes/mode-strip.client";
import type { AppMode, ModeIndicator } from "./modes/app-mode";

interface TopbarProps {
  profiles: StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  /** Portable requirement this chooser remaps while a project is open. */
  projectConnectionName?: string;
  hasCredential: boolean;
  projectName?: string;
  projectDirty: boolean;
  projectStorageState?: ProjectStorageState;
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
  /** Per-mode running and unread-results state, shown on the strip. */
  modeIndicators?: Partial<Record<AppMode, ModeIndicator>>;
  awaitingToolResults: boolean;
  retryableFailure: boolean;
  runDisabled: boolean;
  /**
   * Id of the element that states, in visible text, why the run is refused.
   * The reason itself is never carried by a `title` here: a native tooltip is
   * invisible on touch and unreachable from the keyboard.
   */
  runDisabledReasonId?: string;
  evaluationStartDisabled: boolean;
  /** Same contract as `runDisabledReasonId`, for the Evaluations primary. */
  evaluationStartDisabledReasonId?: string;
  onChooseProfile(profileId: string): void;
  onOpenConnections(): void;
  onNewProject(): void;
  onOpenProject(): void;
  onSaveProject(): void;
  onImportProject(event: ChangeEvent<HTMLInputElement>): void;
  onExportProject(): void;
  n8nImportDisabledReason?: string;
  onOpenN8nImport(): void;
  onDownloadDiagnostics(): void;
  onDownloadRunTrace(): void;
  onImportRunTrace(event: ChangeEvent<HTMLInputElement>): void;
  onOpenRunHistory(): void;
  onStop(): void;
  onStopExperiment(): void;
  onRun(): void;
  onStartEvaluation(): void;
}

function closeContainingMenu(element: HTMLElement): void {
  element.closest("details")?.removeAttribute("open");
}

/** Application menus and the current run controls. */
export function Topbar({
  profiles, activeProfile, projectConnectionName, hasCredential, projectName, projectDirty,
  projectStorageState,
  folderAccessAvailable, hasDiagnosticCapture, isRequestActive, isExperimentActive, awaitingToolResults,
  mode, onModeChange, modeIndicators,
  hasRunTrace,
  hasProjectWorkspace,
  runHistoryBlocked,
  retryableFailure,
  runDisabled, onChooseProfile, onOpenConnections, onNewProject, onOpenProject,
  runDisabledReasonId,
  evaluationStartDisabled, evaluationStartDisabledReasonId,
  onSaveProject, onImportProject, onExportProject,
  n8nImportDisabledReason, onOpenN8nImport,
  onDownloadDiagnostics, onStop, onStopExperiment, onRun, onStartEvaluation,
  onDownloadRunTrace,
  onImportRunTrace,
  onOpenRunHistory,
}: TopbarProps) {
  const profileName = activeProfile.name || "Untitled profile";
  // The dot's meaning is credential state, which no one can read off a colour.
  // It travels in the accessible name so the control is not visual-only.
  const credentialState = hasCredential ? "credential set" : "no credential";
  const targetCaption = projectConnectionName ? "Project connection" : "Connection";
  const targetAccessibleName = projectConnectionName
    ? `${targetCaption}: ${profileName}`
    : `Run target: ${profileName}, ${credentialState}`;
  const projectStorageLabel = !projectStorageState
    ? undefined
    : projectStorageState.kind === "session"
      ? folderAccessAvailable
        ? "Session only — save to a folder to keep changes"
        : "Session only — export a JSON copy to keep changes"
      : projectStorageState.kind === "saving"
        ? `Saving to ${projectStorageState.displayPath}…`
        : projectStorageState.kind === "error"
          ? "Save failed — retry from Project"
          : `Saved to ${projectStorageState.displayPath}`;
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">IL</span><div><h1>Inference Lens</h1><p>Inspect every model run · {projectName ? <><strong>{projectName}</strong>{projectDirty ? " · Unsaved" : ""}{projectStorageLabel ? ` · ${projectStorageLabel}` : ""}</> : "No project open"}</p></div></div>
      <ModeStrip value={mode} onChange={onModeChange} {...(modeIndicators ? { indicators: modeIndicators } : {})} />
      <div className="header-actions">
        {/*
          The connection profile is the only run setting global enough for the
          topbar: compose sends through it, and a project's connection
          requirements are mapped onto it. Model is deliberately absent. It is
          per-request in Compose and per-configuration in Evaluations, so a
          topbar copy would have contradicted the run the primary action starts.
          Each surface states its own model on its settings summary instead.

          The static `Connection` caption is what makes the profile name read as
          a chosen value rather than a heading.
        */}
        <details className="header-menu target-menu"><summary aria-label={targetAccessibleName} className="target-control" title={profileName}><span className={projectConnectionName || hasCredential ? "connection-indicator ready" : "connection-indicator"} aria-hidden="true" /><span className="target-copy"><small className="target-caption" aria-hidden="true">{targetCaption}</small><strong>{profileName}</strong></span><span className="menu-chevron" aria-hidden="true">⌄</span></summary>
          <div className="menu-popover target-popover"><div className="menu-heading"><span>{targetCaption}</span><small>{projectConnectionName ?? profileName}</small></div>{projectConnectionName && <p className="menu-context">Choose the local profile used by {projectConnectionName} in this project, including evaluations that share it.</p>}<div className="profile-menu-list">{profiles.map((profile) => <button aria-label={projectConnectionName ? `Use ${profile.name || "Untitled profile"} for ${projectConnectionName}` : undefined} className={profile.id === activeProfile.id ? "menu-option selected" : "menu-option"} key={profile.id} type="button" onClick={(event) => { onChooseProfile(profile.id); closeContainingMenu(event.currentTarget); }}><span><strong>{profile.name || "Untitled profile"}</strong><small>{profile.endpoint}</small></span>{profile.id === activeProfile.id && <span aria-hidden="true">✓</span>}</button>)}</div><button className="menu-action" type="button" onClick={(event) => { onOpenConnections(); closeContainingMenu(event.currentTarget); }}>Manage connections<span aria-hidden="true">→</span></button></div>
        </details>
        <details className="header-menu project-menu"><summary aria-label="Project menu" className="button secondary"><span className="project-menu-label">Project</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover">
          <div className="menu-group-heading">Project</div>
          {folderAccessAvailable && <><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onNewProject(); }}>New project folder…</button><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onOpenProject(); }}>Open project folder…</button><span className="menu-separator" /></>}
          <button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onSaveProject(); }}>{hasProjectWorkspace ? "Save now" : folderAccessAvailable ? "Save project to folder…" : "Download project JSON…"} <kbd>⌘S</kbd></button><label className="menu-file-button">Import project JSON…<input type="file" accept="application/json,.json" onChange={onImportProject} /></label><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onExportProject(); }}>Export JSON copy…</button><span className="menu-separator" /><button disabled={Boolean(n8nImportDisabledReason)} title={n8nImportDisabledReason} type="button" onClick={(event) => { onOpenN8nImport(); closeContainingMenu(event.currentTarget); }}>Import prompt from n8n…</button>
        </div></details>
        <details className="header-menu run-data-menu"><summary aria-label="Run data menu" className="button secondary"><span className="run-data-menu-label">Run data</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover run-data-popover">
          <div className="menu-group-heading">Run data</div>
          <button disabled={!hasProjectWorkspace || runHistoryBlocked} title={runHistoryBlocked ? "Finish or stop the current run before opening history." : undefined} type="button" onClick={(event) => { onOpenRunHistory(); closeContainingMenu(event.currentTarget); }}>Run history…</button><label className="menu-file-button">Import run trace…<input type="file" accept="application/json,.json" onChange={onImportRunTrace} /></label><button disabled={!hasRunTrace} type="button" onClick={onDownloadRunTrace}>Export run trace…</button><span className="menu-separator" /><button disabled={!hasDiagnosticCapture} type="button" onClick={onDownloadDiagnostics}>Download diagnostics</button>
        </div></details>
        {/*
          The topbar holds one primary action and `Stop`; nothing else. Which
          primary it is comes from the mode, so the slot no longer changes
          identity underneath a user mid-task. Run-lifecycle actions render at
          the thing they act on instead: `Continue` at the tool-call pause,
          `Retry` and `Discard failed run` on the failure card, `Repeat…` in
          the request composer's header. `Stop` stays here because a running
          batch or request is global state and has to be stoppable from any
          mode.
        */}
        {isExperimentActive ? (
          <button className="button stop" onClick={onStopExperiment}>Stop remaining</button>
        ) : isRequestActive ? (
          <button className="button stop" onClick={onStop}>Stop</button>
        ) : mode === "compose" ? (
          // A paused run owns its own way out. Offering a fresh request beside
          // it would be a third exit from a state that already has two, and
          // starting one would silently abandon the pause.
          awaitingToolResults ? (
            <button className="button stop" onClick={onStop}>Stop</button>
          ) : retryableFailure ? null : (
            <button
              aria-describedby={runDisabled ? runDisabledReasonId : undefined}
              className="button primary"
              disabled={runDisabled}
              onClick={onRun}
            >
              Run current conversation <span className="shortcut">⌘↵</span>
            </button>
          )
        ) : mode === "evaluations" ? (
          <button
            aria-describedby={evaluationStartDisabled ? evaluationStartDisabledReasonId : undefined}
            className="button primary"
            disabled={evaluationStartDisabled}
            onClick={onStartEvaluation}
          >
            Start evaluation… <span className="shortcut">⌘↵</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
