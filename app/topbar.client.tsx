"use client";

import { type ChangeEvent, useEffect, useRef } from "react";
import type { StoredInferenceProfile } from "./profile-store.client";
import type { ProjectStorageState } from "./use-project-workspace.client";
import { ModeStrip } from "./modes/mode-strip.client";
import type { AppMode, ModeIndicator } from "./modes/app-mode";
import type { ComposePrimary } from "./compose/use-compose.client";

interface TopbarProps {
  profiles: StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  /** Decision Compose owns its connection independently of chat mappings. */
  decisionConnection?: {
    profiles: StoredInferenceProfile[];
    profile?: StoredInferenceProfile;
    selectProfile(profileId: string): void;
    disabled: boolean;
  };
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
  /** Either Compose kind has an attempt in flight; its Stop shows in every mode. */
  composeExecuting: boolean;
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
  /**
   * Compose's primary action for the request kind on screen (D29-A). A refused
   * run names, by id, the element that states why in visible text; the reason
   * is never carried by a `title` here, since a native tooltip is invisible on
   * touch and unreachable from the keyboard.
   */
  composePrimary: ComposePrimary;
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
  onStopExperiment(): void;
  onStartEvaluation(): void;
}

function closeContainingMenu(element: HTMLElement): void {
  element.closest("details")?.removeAttribute("open");
}

/** Application menus and the current run controls. */
export function Topbar({
  profiles, activeProfile, decisionConnection, projectConnectionName, hasCredential, projectName, projectDirty,
  projectStorageState,
  folderAccessAvailable, hasDiagnosticCapture, composeExecuting, isExperimentActive, composePrimary,
  mode, onModeChange, modeIndicators,
  hasRunTrace,
  hasProjectWorkspace,
  onChooseProfile, onOpenConnections, onNewProject, onOpenProject,
  evaluationStartDisabled, evaluationStartDisabledReasonId,
  onSaveProject, onImportProject, onExportProject,
  n8nImportDisabledReason, onOpenN8nImport,
  onDownloadDiagnostics, onStopExperiment, onStartEvaluation,
  onDownloadRunTrace,
  onImportRunTrace,
  onOpenRunHistory,
}: TopbarProps) {
  const topbarRef = useRef<HTMLElement>(null);
  const targetProfile = decisionConnection ? decisionConnection.profile : activeProfile;
  const targetProfiles = decisionConnection ? decisionConnection.profiles : profiles;
  const targetRequirement = decisionConnection ? undefined : projectConnectionName;
  const profileName = targetProfile ? targetProfile.name || "Untitled profile" : "No decision connection";
  // The dot's meaning is credential state, which no one can read off a colour.
  // It travels in the accessible name so the control is not visual-only.
  const credentialState = hasCredential ? "credential set" : "no credential";
  const targetCaption = decisionConnection ? "Decision connection" : targetRequirement ? "Project connection" : "Connection";
  const targetAccessibleName = decisionConnection || targetRequirement
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
        : projectStorageState.kind === "unsaved"
          ? "Unfinished edits have not been saved"
          : projectStorageState.kind === "error"
            ? "Save failed — retry from Project"
            : projectStorageState.kind === "secondary"
              ? "Not saved — another tab is editing this project"
              : `Saved to ${projectStorageState.displayPath}`;

  useEffect(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    const menus = Array.from(
      topbar.querySelectorAll<HTMLDetailsElement>("details.header-menu"),
    );

    const closeMenus = (except?: HTMLDetailsElement) => {
      for (const menu of menus) {
        if (menu !== except) menu.open = false;
      }
    };
    const handleToggle = (event: Event) => {
      const menu = event.currentTarget as HTMLDetailsElement;
      if (menu.open) closeMenus(menu);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menus.some((menu) => menu.contains(target))) {
        closeMenus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openMenu = menus.find((menu) => menu.open);
      if (!openMenu) return;
      event.preventDefault();
      openMenu.open = false;
      openMenu.querySelector<HTMLElement>("summary")?.focus();
    };

    for (const menu of menus) menu.addEventListener("toggle", handleToggle);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      for (const menu of menus) menu.removeEventListener("toggle", handleToggle);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <header className="topbar" ref={topbarRef}>
      <div className="brand"><span className="brand-mark" aria-hidden="true">IL</span><div><h1>Inference Lens</h1><p>Inspect every model run · {projectName ? <><strong>{projectName}</strong>{projectDirty ? " · Unsaved" : ""}{projectStorageLabel ? ` · ${projectStorageLabel}` : ""}</> : "No project open"}</p></div></div>
      <ModeStrip value={mode} onChange={onModeChange} {...(modeIndicators ? { indicators: modeIndicators } : {})} />
      <div className="header-actions">
        {/* The active Compose kind supplies its own connection chooser. A
            decision choice never remaps the project's chat requirement. */}
        <details className="header-menu target-menu">
          <summary aria-label={targetAccessibleName} className="target-control" title={profileName}>
            {!decisionConnection && <span className={targetRequirement || hasCredential ? "connection-indicator ready" : "connection-indicator"} aria-hidden="true" />}
            {decisionConnection && <span className="decision-connection-glyph" aria-hidden="true">◇</span>}
            <span className="target-copy"><small className="target-caption" aria-hidden="true">{targetCaption}</small><strong>{profileName}</strong></span>
            <span className="menu-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="menu-popover target-popover">
            <div className="menu-heading"><span>{targetCaption}</span><small>{targetRequirement ?? profileName}</small></div>
            {targetRequirement && <p className="menu-context">Choose the local profile used by {targetRequirement} in this project, including evaluations that share it.</p>}
            {decisionConnection && <p className="menu-context">This connection sends the decision request. Only connections that declare System One are offered.</p>}
            <div className="profile-menu-list">
              {targetProfiles.map((profile) => (
                <button
                  aria-label={targetRequirement ? `Use ${profile.name || "Untitled profile"} for ${targetRequirement}` : undefined}
                  className={profile.id === targetProfile?.id ? "menu-option selected" : "menu-option"}
                  disabled={decisionConnection?.disabled}
                  key={profile.id}
                  type="button"
                  onClick={(event) => {
                    if (decisionConnection) decisionConnection.selectProfile(profile.id);
                    else onChooseProfile(profile.id);
                    closeContainingMenu(event.currentTarget);
                  }}
                >
                  <span><strong>{profile.name || "Untitled profile"}</strong><small>{profile.endpoint}</small></span>
                  {profile.id === targetProfile?.id && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            <button className="menu-action" type="button" onClick={(event) => { onOpenConnections(); closeContainingMenu(event.currentTarget); }}>Manage connections<span aria-hidden="true">→</span></button>
          </div>
        </details>
        <details className="header-menu project-menu"><summary aria-label="Project menu" className="button secondary"><span className="project-menu-label">Project</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover">
          <div className="menu-group-heading">Project</div>
          {folderAccessAvailable && <><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onNewProject(); }}>New project folder…</button><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onOpenProject(); }}>Open project folder…</button><span className="menu-separator" /></>}
          <button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onSaveProject(); }}>{hasProjectWorkspace ? "Save now" : folderAccessAvailable ? "Save project to folder…" : "Download project JSON…"} <kbd>⌘S</kbd></button><label className="menu-file-button">Import project JSON…<input type="file" accept="application/json,.json" onChange={onImportProject} /></label><button type="button" onClick={(event) => { closeContainingMenu(event.currentTarget); onExportProject(); }}>Export JSON copy…</button><span className="menu-separator" /><button disabled={Boolean(n8nImportDisabledReason)} title={n8nImportDisabledReason} type="button" onClick={(event) => { onOpenN8nImport(); closeContainingMenu(event.currentTarget); }}>Import prompt from n8n…</button>
        </div></details>
        <details className="header-menu run-data-menu"><summary aria-label="Run data menu" className="button secondary"><span className="run-data-menu-label">Run data</span> <span className="menu-chevron">⌄</span></summary><div className="menu-popover project-popover run-data-popover">
          <div className="menu-group-heading">Run data</div>
          <button type="button" onClick={(event) => { onOpenRunHistory(); closeContainingMenu(event.currentTarget); }}>Run history</button><label className="menu-file-button">Import run trace…<input type="file" accept="application/json,.json" onChange={onImportRunTrace} /></label><button disabled={!hasRunTrace} type="button" onClick={onDownloadRunTrace}>Export run trace…</button><span className="menu-separator" /><button disabled={!hasDiagnosticCapture} type="button" onClick={onDownloadDiagnostics}>Download diagnostics</button>
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
        ) : composeExecuting && composePrimary.kind === "stop" ? (
          <button className="button stop" onClick={composePrimary.stop}>Stop</button>
        ) : mode === "compose" ? (
          // A paused run owns its own way out (`none`). Offering a fresh request
          // beside it would be a third exit from a state that already has two,
          // and starting one would silently abandon the pause.
          composePrimary.kind === "stop" ? (
            <button className="button stop" onClick={composePrimary.stop}>Stop</button>
          ) : composePrimary.kind === "none" ? null : (
            <button
              aria-describedby={composePrimary.disabled ? composePrimary.disabledReasonId : undefined}
              className="button primary"
              disabled={composePrimary.disabled}
              onClick={composePrimary.run}
            >
              {composePrimary.label} <span className="shortcut">⌘↵</span>
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
