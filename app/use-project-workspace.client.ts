"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  parseProjectJson,
  projectDraft,
  updateProjectDraft,
} from "../packages/core/src/project.ts";
import type {
  ProjectDraft,
  ProjectFile,
  UpdateProjectDraft,
} from "../packages/core/src/project.ts";
import {
  createProjectFolder,
  downloadProjectFile,
  openProjectFolder,
  ProjectManifestConflictError,
  reconnectProjectWorkspace as reconnectStoredProjectWorkspace,
  reopenProjectWorkspace,
  restoreProjectWorkspace,
  saveProjectWorkspace,
} from "./project-workspace.client.ts";
import type {
  ProjectCreationOptions,
  ProjectWorkspaceHandle,
  WorkspaceResumeOutcome,
} from "./project-workspace.client.ts";
import {
  prunedProjectProfileMap,
  readLegacyProjectProfileMap,
  readProjectProfileMap,
  resolveMappedProfiles,
  withMappedProfile,
  withoutMappedProfile,
  writeProjectProfileMap,
} from "./project-profile-map.client.ts";
import type { ProfileIdentity } from "./project-profile-map.client.ts";
import {
  browserProjectTabHost,
  coordinateProjectTab,
} from "./project-tab-coordination.client.ts";
import type {
  LockAcquisition,
  ProjectTabCoordinator,
} from "./project-tab-coordination.client.ts";

export type ProjectErrorKind =
  | "auto-save"
  | "tools-disabled"
  | "workspace-reconnect";

/**
 * User-facing persistence state for the open project. A JSON import has no
 * writable destination even when its in-memory document is clean, so it stays
 * `session` until a folder workspace is explicitly attached.
 */
export type ProjectStorageState =
  | { kind: "session" }
  | { kind: "unsaved"; displayPath: string; reason: string }
  | { kind: "saving"; displayPath: string }
  | { kind: "saved"; displayPath: string }
  | { kind: "error"; displayPath: string }
  /** Another tab of this app is the project's editor; this one does not save. */
  | { kind: "secondary"; displayPath: string };

/**
 * Which tab may write `project.json`. Only the `editor` tab autosaves. Every
 * tab composes, runs and records traces. `uncoordinated` covers the desktop
 * app, browsers without Web Locks and projects without a folder, which behave
 * as they did before tabs were coordinated.
 */
export type ProjectTabRole = "editor" | "secondary" | "uncoordinated";

export interface ProjectTabState {
  role: ProjectTabRole;
  /** The editor tab saved after this tab loaded the project. */
  behind: boolean;
  /** Another tab took over editing before this tab's changes were saved. */
  lostEdits: boolean;
  /**
   * Becoming editor reloads from disk, so a tab with edits is asked first:
   * because the user asked, or because the editing tab closed.
   */
  confirmTakeover?: "requested" | "editor-closed";
  switching: boolean;
}

const SECONDARY_SAVE_MESSAGE =
  "Another tab is editing this project, so this tab does not save it. Choose Edit here to save from this tab.";
const PEER_CONFLICT_MESSAGE =
  "Another Inference Lens tab saved this project after this tab loaded it. Reopen the project before saving here.";

const PROJECT_AUTO_SAVE_DELAY_MS = 800;
const PROJECT_AUTO_SAVE_MAX_WAIT_MS = 5_000;
const PROJECT_AUTO_SAVE_RETRY_BASE_MS = 2_000;
const PROJECT_AUTO_SAVE_RETRY_MAX_MS = 30_000;

export interface ProjectWorkspaceHandleState {
  projectFile: ProjectFile | null;
  projectWorkspace: ProjectWorkspaceHandle | null;
  projectDirty: boolean;
  projectStorageState?: ProjectStorageState;
  projectError?: string;
  projectErrorKind?: ProjectErrorKind;
  /** Device-local profile ids keyed by portable connection requirement id. */
  mappedProfileIds: Readonly<Record<string, string>>;
  pendingProjectReplacement?: PendingProjectReplacement;
  /**
   * Advances each time a document is adopted from outside the editors, even
   * the same project reloaded from disk. Owners that keep local editing state
   * key on it so a reload cannot leave a discarded draft on screen.
   */
  projectAdoption: number;
  /** Absent without a project folder, and while the role is being settled. */
  projectTab?: ProjectTabState;
  /** Edit here: reloads from disk at once, or asks first when this tab has edits. */
  becomeProjectEditor(): void;
  confirmProjectEditorTakeover(): void;
  cancelProjectEditorTakeover(): void;
  markDirty(): void;
  setError(message: string | undefined, options?: { clearKind?: boolean }): void;
  clearErrorKind(): void;
  setToolsDisabledError(message: string): void;
  dismissError(): void;
  clearToolsDisabledError(): void;
  adoptBranchRevision(project: ProjectFile): void;
  currentProjectDocument(): ProjectFile;
  materializeProject(): ProjectFile;
  adoptProjectMutation(project: ProjectFile): void;
  /**
   * `inProject` is a document just handed to `adoptProjectMutation`, for a
   * requirement that mutation added and this render does not hold yet.
   */
  mapProfile(requirementId: string, profile: ProfileIdentity, inProject?: ProjectFile): void;
  unmapProfile(profileId: string): void;
  newProjectFolder(options: ProjectCreationOptions): Promise<void>;
  openProjectWorkspace(): Promise<void>;
  reconnectProjectWorkspace(): Promise<void>;
  saveProject(options?: ProjectCreationOptions): Promise<void>;
  exportProject(): void;
  importProject(event: ChangeEvent<HTMLInputElement>): Promise<void>;
  cancelProjectReplacement(): void;
  discardAndContinueProjectReplacement(): Promise<void>;
  saveAndContinueProjectReplacement(
    options?: ProjectCreationOptions,
  ): Promise<void>;
}

export interface PendingProjectReplacement {
  currentProjectName: string;
  nextProjectName: string;
  saveNeedsLocation: boolean;
  saving: boolean;
  error?: string;
}

interface QueuedProjectReplacement {
  perform(): Promise<void>;
  fallbackError: string;
}

/** A same-project refresh replaces persisted drafts, but preserves run sessions. */
export type ProjectDocumentAdoption = "replace" | "refresh";

/**
 * Owns the lifecycle of a portable project and its local workspace handle.
 * The caller supplies the currently editable request draft and applies a
 * loaded draft, keeping session-only run configuration and run state outside
 * this persistence boundary.
 */
export function useProjectWorkspace(input: {
  activeProfile: ProfileIdentity;
  /** Every restored profile this device currently has. */
  profiles: readonly ProfileIdentity[];
  /** Automatic workspace adoption waits for authoritative profile identities. */
  profilesLoaded: boolean;
  /** Selects a resolved local mapping as part of project adoption. */
  onActivateProfile(profileId: string): void;
  folderAccessAvailable: boolean;
  /** Creates a new, independent project when another project is already open. */
  createFreshProject(): ProjectFile;
  createProject(): ProjectFile;
  currentDraft(): UpdateProjectDraft;
  onApplyDraft(draft: ProjectDraft, projectId: ProjectFile["projectId"], adoption: ProjectDocumentAdoption): void;
  /**
   * Writes the decision editor's draft into a document being saved (D42). The
   * decision feature owns its draft, as the chat request owns `currentDraft`.
   */
  withDecisionDraft(project: ProjectFile): ProjectFile;
  /** Read from commands and saves, after the feature owners have rendered. */
  getUnsavedDraftReason(): string | undefined;
  /** Hands a newly applied document's active decision request to its owner. */
  onApplyDecisionRequest(project: ProjectFile, adoption: ProjectDocumentAdoption): void;
  /**
   * A save the user asked for landed. Deliberately not called by the auto-save
   * loop below: auto-save is continuous and unremarkable, and confirming it
   * every eight hundred milliseconds would train the user to ignore the only
   * channel that also carries "your work did not reach the disk".
   */
  onSaved?(outcome: { name: string; destination: "folder" | "download" }): void;
}): ProjectWorkspaceHandleState {
  const {
    activeProfile,
    profiles,
    profilesLoaded,
    onActivateProfile,
    folderAccessAvailable,
    createFreshProject,
    createProject,
    currentDraft,
    onApplyDraft,
    withDecisionDraft,
    getUnsavedDraftReason,
    onApplyDecisionRequest,
    onSaved,
  } = input;
  const [projectFile, setProjectFile] = useState<ProjectFile | null>(null);
  const [projectWorkspace, setProjectWorkspace] =
    useState<ProjectWorkspaceHandle | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);
  // A write of the last valid document does not persist an incomplete editor
  // draft. Track that independently so autosave settles without looping and
  // replacement/unload protection stays active.
  const [unsavedDraftReason, setUnsavedDraftReason] = useState<string>();
  const hasUnsavedChanges = projectDirty || Boolean(unsavedDraftReason);
  const [projectError, setProjectError] = useState<string>();
  const [projectErrorKind, setProjectErrorKind] = useState<ProjectErrorKind>();
  const projectErrorKindRef = useRef<ProjectErrorKind | undefined>(undefined);
  const [mappedProfileIds, setMappedProfileIds] = useState<Record<string, string>>({});
  const [projectChangeVersion, setProjectChangeVersion] = useState(0);
  const [projectAdoption, setProjectAdoption] = useState(0);
  const [pendingProjectReplacement, setPendingProjectReplacement] =
    useState<PendingProjectReplacement>();
  const projectChangeVersionRef = useRef(0);
  const projectWorkspaceRef = useRef<ProjectWorkspaceHandle | null>(null);
  const workspaceSaveTailRef = useRef<Promise<void>>(Promise.resolve());
  const autoSaveWindowStartedAtRef = useRef<number | null>(null);
  const autoSaveFailureCountRef = useRef(0);
  const autoSaveRetryNotBeforeRef = useRef(0);
  const hasProjectRef = useRef(false);
  const restoredRef = useRef(false);
  // Read inside asynchronous adoption paths, which must see the profiles the
  // device has now rather than the ones it had when the operation started.
  const profilesRef = useRef(profiles);
  const queuedProjectReplacementRef =
    useRef<QueuedProjectReplacement | null>(null);
  const [tabRole, setTabRole] = useState<ProjectTabRole | "acquiring">("uncoordinated");
  const tabRoleRef = useRef<ProjectTabRole | "acquiring">("uncoordinated");
  const [tabBehind, setTabBehind] = useState(false);
  const peerSavedRef = useRef(false);
  const [tabLostEdits, setTabLostEdits] = useState(false);
  const [confirmTakeover, setConfirmTakeover] =
    useState<ProjectTabState["confirmTakeover"]>();
  const [tabSwitching, setTabSwitching] = useState(false);
  const tabCoordinatorRef = useRef<ProjectTabCoordinator | null>(null);
  // A role loss or replacement invalidates every pending read from that hold.
  const tabAcquisitionRef = useRef(0);
  // Consent covers only the edits present when Edit here/Discard was clicked.
  const requestedTakeoverVersionRef = useRef<number | undefined>(undefined);
  // A reload to become editor replaces the handle but keeps the coordinator.
  const workspaceCoordinatorsRef =
    useRef(new WeakMap<ProjectWorkspaceHandle, ProjectTabCoordinator>());
  const flushFailedRef = useRef(false);
  // Coordinator events arrive outside React; they act through the latest
  // render's functions and state rather than the ones they were created with.
  const latestRef = useRef<{
    hasUnsavedChanges(): boolean;
    onTabAcquired(cause: LockAcquisition): void;
    flushBeforeRelease(): Promise<void>;
  }>({
    hasUnsavedChanges: () => false,
    onTabAcquired: () => undefined,
    flushBeforeRelease: () => Promise.resolve(),
  });

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

  function advanceProjectChangeVersion(): number {
    autoSaveWindowStartedAtRef.current ??= Date.now();
    projectChangeVersionRef.current += 1;
    setProjectChangeVersion(projectChangeVersionRef.current);
    return projectChangeVersionRef.current;
  }

  function updateProjectErrorKind(kind: ProjectErrorKind | undefined): void {
    projectErrorKindRef.current = kind;
    setProjectErrorKind(kind);
  }

  function updateTabRole(role: ProjectTabRole | "acquiring"): void {
    tabRoleRef.current = role;
    setTabRole(role);
  }

  /**
   * Releases the previous project's role and starts settling this one's. A
   * reload to become editor keeps the role: the tab already holds the lock.
   */
  function coordinateTabs(
    workspace: ProjectWorkspaceHandle | null,
    projectId: ProjectFile["projectId"] | undefined,
  ): void {
    tabAcquisitionRef.current += 1;
    requestedTakeoverVersionRef.current = undefined;
    tabCoordinatorRef.current?.close();
    tabCoordinatorRef.current = null;
    peerSavedRef.current = false;
    flushFailedRef.current = false;
    setTabBehind(false);
    setTabLostEdits(false);
    setConfirmTakeover(undefined);
    setTabSwitching(false);
    const host = browserProjectTabHost();
    // A JSON import has no folder and does no folder saves, so it takes no lock.
    if (!workspace || !projectId || workspace.kind !== "browser-directory" || !host) {
      updateTabRole("uncoordinated");
      return;
    }
    updateTabRole("acquiring");
    const coordinator = coordinateProjectTab(projectId, {
      acquired: (cause) => {
        if (tabCoordinatorRef.current === coordinator) latestRef.current.onTabAcquired(cause);
      },
      secondary: (cause) => {
        if (tabCoordinatorRef.current !== coordinator) return;
        tabAcquisitionRef.current += 1;
        requestedTakeoverVersionRef.current = undefined;
        setTabSwitching(false);
        updateTabRole("secondary");
        // The lock this tab held after the editor closed has moved on.
        setConfirmTakeover((current) => current === "editor-closed" ? undefined : current);
        if (
          (cause === "stolen" && latestRef.current.hasUnsavedChanges()) ||
          (cause === "handed-over" && flushFailedRef.current)
        ) {
          setTabLostEdits(true);
        }
      },
      peerSaved: () => {
        if (tabCoordinatorRef.current !== coordinator) return;
        peerSavedRef.current = true;
        setTabBehind(true);
      },
      flushBeforeRelease: () => latestRef.current.flushBeforeRelease(),
    }, host);
    tabCoordinatorRef.current = coordinator;
  }

  useEffect(() => () => {
    tabAcquisitionRef.current += 1;
    tabCoordinatorRef.current?.close();
  }, []);

  function setCurrentWorkspace(
    workspace: ProjectWorkspaceHandle | null,
    projectId?: ProjectFile["projectId"],
    options?: { keepTabRole: true },
  ): void {
    if (!options?.keepTabRole) coordinateTabs(workspace, projectId);
    if (workspace && tabCoordinatorRef.current) {
      workspaceCoordinatorsRef.current.set(workspace, tabCoordinatorRef.current);
    }
    if (projectWorkspaceRef.current !== workspace) {
      autoSaveWindowStartedAtRef.current = null;
      autoSaveFailureCountRef.current = 0;
      autoSaveRetryNotBeforeRef.current = 0;
    }
    projectWorkspaceRef.current = workspace;
    setProjectWorkspace(workspace);
  }

  /**
   * All writes share one queue. Browser file handles and native workspaces both
   * permit asynchronous writes, so allowing a manual save and an auto-save to
   * overlap could let the older document finish last.
   */
  function writeProjectWorkspace(
    workspace: ProjectWorkspaceHandle,
    project: ProjectFile,
  ): Promise<void> {
    const write = workspaceSaveTailRef.current
      .catch(() => undefined)
      .then(async () => {
        // Checked when the write runs, not when it was queued: the role can
        // pass to another tab while a save waits its turn.
        const coordinator = workspaceCoordinatorsRef.current.get(workspace);
        if (
          coordinator &&
          projectWorkspaceRef.current === workspace &&
          tabRoleRef.current !== "editor"
        ) {
          throw new Error(SECONDARY_SAVE_MESSAGE);
        }
        const fence = coordinator
          ? async () => {
              if (!(await coordinator.holdsEditorLock())) throw new Error(SECONDARY_SAVE_MESSAGE);
            }
          : undefined;
        try {
          await saveProjectWorkspace(workspace, project, fence);
        } catch (error) {
          throw error instanceof ProjectManifestConflictError && peerSavedRef.current
            ? new Error(PEER_CONFLICT_MESSAGE)
            : error;
        }
        if (projectWorkspaceRef.current === workspace) tabCoordinatorRef.current?.announceSaved();
      });
    workspaceSaveTailRef.current = write;
    return write;
  }

  /**
   * Becoming editor never adopts this tab's in-memory document as the base for
   * writing: the editor saved continuously, so it reloads from disk through the
   * adoption path, preserving sessions and checking that the acquisition and
   * consent still cover the document when the asynchronous read completes.
   */
  async function adoptEditorRoleFromDisk(
    acquisition: number,
    version: number,
    confirmation: NonNullable<ProjectTabState["confirmTakeover"]>,
  ): Promise<void> {
    const workspace = projectWorkspaceRef.current;
    const coordinator = tabCoordinatorRef.current;
    const projectId = projectFile?.projectId;
    if (!workspace || !projectId || !coordinator) return;
    const isCurrent = () =>
      tabAcquisitionRef.current === acquisition &&
      tabCoordinatorRef.current === coordinator &&
      projectWorkspaceRef.current === workspace;
    setConfirmTakeover(undefined);
    setTabSwitching(true);
    try {
      const opened = await reopenProjectWorkspace(workspace, projectId);
      if (!isCurrent()) return;
      const holdsLock = await coordinator.holdsEditorLock();
      if (!isCurrent() || !holdsLock) return;
      if (projectChangeVersionRef.current !== version) {
        setConfirmTakeover(confirmation);
        return;
      }
      applyProjectDocument(opened.project, opened.handle, undefined, { keepTabRole: true });
      updateTabRole("editor");
      peerSavedRef.current = false;
      setTabBehind(false);
      setTabLostEdits(false);
    } catch (error) {
      if (isCurrent()) projectFailure(error, "Could not reload the project to edit it in this tab.");
    } finally {
      // Adoption replaces the handle, so only the acquisition guards cleanup.
      if (tabAcquisitionRef.current === acquisition) setTabSwitching(false);
    }
  }

  function onTabAcquired(cause: LockAcquisition): void {
    const acquisition = ++tabAcquisitionRef.current;
    const version = cause === "requested"
      ? requestedTakeoverVersionRef.current
      : projectChangeVersion;
    requestedTakeoverVersionRef.current = undefined;
    const confirmation = cause === "vacated" ? "editor-closed" : "requested";
    if (cause === "initial") {
      updateTabRole("editor");
    } else if (
      (cause === "vacated" && hasUnsavedChanges) ||
      version === undefined || version !== projectChangeVersionRef.current
    ) {
      setTabSwitching(false);
      setConfirmTakeover(confirmation);
    } else {
      void adoptEditorRoleFromDisk(acquisition, version, confirmation);
    }
  }

  /** Writes the pending change now rather than after the debounce, for a handover. */
  async function flushBeforeRelease(): Promise<void> {
    flushFailedRef.current = false;
    // A tab holding the lock without having adopted it has nothing to flush.
    if (tabRoleRef.current !== "editor") return;
    const workspace = projectWorkspaceRef.current;
    if (!workspace || !projectDirty) return;
    const version = projectChangeVersionRef.current;
    const project = currentProjectDocument();
    const unsavedReason = getUnsavedDraftReason();
    try {
      await writeProjectWorkspace(workspace, project);
    } catch (error) {
      flushFailedRef.current = true;
      throw error;
    }
    if (
      projectWorkspaceRef.current === workspace &&
      projectChangeVersionRef.current === version
    ) {
      setProjectFile(project);
      setProjectDirty(false);
      setUnsavedDraftReason(unsavedReason);
    }
  }

  useEffect(() => {
    latestRef.current = {
      hasUnsavedChanges: () => hasUnsavedChanges,
      onTabAcquired,
      flushBeforeRelease,
    };
  });

  function becomeProjectEditor(): void {
    if (tabRoleRef.current !== "secondary" || tabSwitching) return;
    if (hasUnsavedChanges) {
      setConfirmTakeover("requested");
      return;
    }
    confirmProjectEditorTakeover();
  }

  function confirmProjectEditorTakeover(): void {
    const coordinator = tabCoordinatorRef.current;
    if (!coordinator) return;
    requestedTakeoverVersionRef.current = projectChangeVersionRef.current;
    setConfirmTakeover(undefined);
    setTabSwitching(true);
    // The role arrives as an `acquired` event, which reloads from disk.
    void coordinator.requestEditor();
  }

  function cancelProjectEditorTakeover(): void {
    setConfirmTakeover(undefined);
  }

  function markDirty(): void {
    if (projectFile) {
      advanceProjectChangeVersion();
      setProjectDirty(true);
    }
  }

  function setError(
    message: string | undefined,
    options?: { clearKind?: boolean },
  ): void {
    if (options?.clearKind) updateProjectErrorKind(undefined);
    setProjectError(message);
  }

  function dismissError(): void {
    setProjectError(undefined);
    updateProjectErrorKind(undefined);
  }

  function clearErrorKind(): void {
    updateProjectErrorKind(undefined);
  }

  function setToolsDisabledError(message: string): void {
    updateProjectErrorKind("tools-disabled");
    setProjectError(message);
  }

  function setReconnectError(message: string): void {
    updateProjectErrorKind("workspace-reconnect");
    setProjectError(message);
  }

  function clearToolsDisabledError(): void {
    if (projectErrorKind === "tools-disabled") dismissError();
  }

  function adoptBranchRevision(project: ProjectFile): void {
    advanceProjectChangeVersion();
    setProjectFile(project);
    setProjectDirty(true);
    dismissError();
  }

  function materializeProject(): ProjectFile {
    const project = currentProjectDocument();
    advanceProjectChangeVersion();
    setProjectFile(project);
    setCurrentWorkspace(null, project.projectId);
    const requirementId = project.defaults.target.connectionRequirementId;
    setMappedProfileIds({ [requirementId]: activeProfile.id });
    rememberMappedProfile(project.projectId, requirementId, activeProfile);
    setProjectDirty(true);
    dismissError();
    return project;
  }

  function adoptProjectMutation(project: ProjectFile): void {
    advanceProjectChangeVersion();
    setProjectFile(project);
    setProjectDirty(true);
    dismissError();
  }

  /**
   * Records the choice for this device, so reopening the project stops asking
   * for a connection the user already picked. Nothing about the profile enters
   * the portable project file.
   */
  function rememberMappedProfile(
    projectId: string,
    requirementId: string,
    profile: ProfileIdentity,
  ): void {
    writeProjectProfileMap(
      withMappedProfile(
        prunedProjectProfileMap(readProjectProfileMap(), profilesRef.current),
        projectId,
        requirementId,
        profile,
      ),
    );
  }

  function profileIdentity(profileId: string): ProfileIdentity | undefined {
    return profilesRef.current.find(({ id }) => id === profileId);
  }

  function storedMappedProfiles(project: ProjectFile): Record<string, string> {
    let map = readProjectProfileMap();
    const baseRequirementId = project.defaults.target.connectionRequirementId;
    // V2 had one project-wide mapping. Its only sound destination is the base
    // requirement that all pre-variant execution used. Other requirements stay
    // explicitly unmapped.
    if (!map[project.projectId]?.[baseRequirementId]) {
      const legacy = readLegacyProjectProfileMap()[project.projectId];
      if (legacy) {
        map = withMappedProfile(map, project.projectId, baseRequirementId, {
          id: legacy.profileId,
          instanceId: legacy.profileInstanceId,
        });
        writeProjectProfileMap(map);
      }
    }
    return resolveMappedProfiles(
      map,
      project.projectId,
      profilesRef.current,
    );
  }

  function mapProfile(requirementId: string, profile: ProfileIdentity, inProject?: ProjectFile): void {
    const target = inProject ?? projectFile;
    if (!target) return;
    if (!target.connectionRequirements.some(({ id }) => id === requirementId)) return;
    setMappedProfileIds((current) => ({ ...current, [requirementId]: profile.id }));
    rememberMappedProfile(target.projectId, requirementId, profile);
    setProjectError(undefined);
  }

  /**
   * Releases the mapping when the profile it names goes away. The project is
   * left unmapped rather than pointed at a replacement: which connection runs a
   * project is the user's choice, and asking again is better than guessing.
   * Projects that are not open lose it too, since the profile is gone for all
   * of them and a stored id is never reissued.
   */
  function unmapProfile(profileId: string): void {
    setMappedProfileIds((current) => Object.fromEntries(
      Object.entries(current).filter(([, mappedId]) => mappedId !== profileId),
    ));
    writeProjectProfileMap(
      withoutMappedProfile(readProjectProfileMap(), profileId),
    );
  }

  function currentProjectDocument(): ProjectFile {
    return withDecisionDraft(updateProjectDraft(projectFile ?? createProject(), currentDraft()));
  }

  function requireSavableDraft(): void {
    const reason = getUnsavedDraftReason();
    if (reason) throw new Error(reason);
  }

  /**
   * `profileId` is the mapping this adoption establishes — creating or saving a
   * project maps it to the connection it was created with. Every other way a
   * project arrives, including an import or a resumed folder, takes the mapping
   * this device already recorded for it, and is left unmapped when there is
   * none to take.
   */
  function applyProjectDocument(
    project: ProjectFile,
    workspace: ProjectWorkspaceHandle | null,
    profileId?: string,
    options?: { keepTabRole: true },
  ): void {
    const draft = projectDraft(project);
    const baseRequirementId = project.defaults.target.connectionRequirementId;
    const resolvedMappings = profileId
      ? { ...storedMappedProfiles(project), [baseRequirementId]: profileId }
      : storedMappedProfiles(project);
    const resolvedProfile = resolvedMappings[baseRequirementId]
      ? profileIdentity(resolvedMappings[baseRequirementId]!)
      : undefined;
    // Profile selection is part of adopting the project, not a later effect.
    // React batches the two state owners into the same committed render.
    if (resolvedProfile) onActivateProfile(resolvedProfile.id);
    hasProjectRef.current = true;
    advanceProjectChangeVersion();
    setProjectAdoption((current) => current + 1);
    setProjectFile(project);
    setCurrentWorkspace(workspace, project.projectId, options);
    const adoption = options?.keepTabRole ? "refresh" : "replace";
    onApplyDraft(draft, project.projectId, adoption);
    onApplyDecisionRequest(project, adoption);
    if (profileId && resolvedProfile) {
      rememberMappedProfile(project.projectId, baseRequirementId, resolvedProfile);
    }
    setMappedProfileIds(resolvedMappings);
    setProjectDirty(false);
    setUnsavedDraftReason(undefined);
    dismissError();
  }

  function applyResumeOutcome(outcome: WorkspaceResumeOutcome): void {
    if (hasProjectRef.current) return;
    switch (outcome.kind) {
      case "none":
        return;
      case "resumed":
        if (hasProjectRef.current) return;
        applyProjectDocument(outcome.project, outcome.handle);
        return;
      case "reconnect-required":
        setReconnectError(outcome.message);
        return;
      case "forgotten":
        projectFailure(
          new Error(outcome.message),
          "Could not restore the remembered project.",
        );
    }
  }

  useEffect(() => {
    if (!profilesLoaded || restoredRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (restoredRef.current) return;
      restoredRef.current = true;
      void restoreProjectWorkspace()
        .then((outcome) => {
          if (!cancelled) applyResumeOutcome(outcome);
        })
        .catch((error: unknown) => {
          if (!cancelled && !hasProjectRef.current) {
            projectFailure(error, "Could not restore the remembered project.");
          }
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Restoration runs once after hydration. Its state adoption uses the same
    // mutation funnel as an explicit open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesLoaded]);

  useEffect(() => {
    if (!projectWorkspace || !projectFile || !projectDirty) return;
    // Only the editor tab schedules writes; a secondary tab's would all fail.
    if (tabRole !== "editor" && tabRole !== "uncoordinated") return;

    const workspace = projectWorkspace;
    const version = projectChangeVersion;
    const now = Date.now();
    autoSaveWindowStartedAtRef.current ??= now;
    const maxWaitAt =
      autoSaveWindowStartedAtRef.current + PROJECT_AUTO_SAVE_MAX_WAIT_MS;
    const debounceDelay = Math.min(
      PROJECT_AUTO_SAVE_DELAY_MS,
      Math.max(0, maxWaitAt - now),
    );
    const retryDelay = Math.max(0, autoSaveRetryNotBeforeRef.current - now);
    const saveDelay = Math.max(debounceDelay, retryDelay);
    const timer = window.setTimeout(() => {
      // Start a fresh max-wait window when this snapshot is queued. Otherwise,
      // edits arriving after the first deadline would each queue another save.
      autoSaveWindowStartedAtRef.current = Date.now();
      const project = currentProjectDocument();
      const unsavedReason = getUnsavedDraftReason();

      void writeProjectWorkspace(workspace, project)
        .then(() => {
          autoSaveFailureCountRef.current = 0;
          autoSaveRetryNotBeforeRef.current = 0;
          autoSaveWindowStartedAtRef.current =
            projectChangeVersionRef.current === version ? null : Date.now();
          if (
            projectWorkspaceRef.current !== workspace ||
            projectChangeVersionRef.current !== version
          ) {
            return;
          }
          setProjectFile(project);
          setProjectDirty(false);
          setUnsavedDraftReason(unsavedReason);
          if (projectErrorKindRef.current === "auto-save") {
            setProjectError(undefined);
            updateProjectErrorKind(undefined);
          }
        })
        .catch((error: unknown) => {
          if (projectWorkspaceRef.current !== workspace) return;
          autoSaveFailureCountRef.current += 1;
          const retryDelay = Math.min(
            PROJECT_AUTO_SAVE_RETRY_BASE_MS *
              2 ** (autoSaveFailureCountRef.current - 1),
            PROJECT_AUTO_SAVE_RETRY_MAX_MS,
          );
          autoSaveRetryNotBeforeRef.current = Date.now() + retryDelay;
          updateProjectErrorKind("auto-save");
          setProjectError(
            error instanceof Error
              ? error.message
              : "Could not auto-save the project.",
          );
        });
    }, saveDelay);

    return () => window.clearTimeout(timer);
    // Each dirtying mutation advances the version. Depending on the render-local
    // function would restart the debounce for unrelated parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectChangeVersion, projectDirty, projectFile, projectWorkspace, tabRole]);

  function projectFailure(error: unknown, fallback: string): void {
    updateProjectErrorKind(undefined);
    setProjectError(error instanceof Error ? error.message : fallback);
  }

  async function performProjectReplacement(
    replacement: QueuedProjectReplacement,
  ): Promise<void> {
    try {
      await replacement.perform();
    } catch (error) {
      projectFailure(error, replacement.fallbackError);
    }
  }

  function requestProjectReplacement(
    nextProjectName: string,
    replacement: QueuedProjectReplacement,
  ): void {
    if (!projectFile || (!projectDirty && !getUnsavedDraftReason())) {
      void performProjectReplacement(replacement);
      return;
    }
    queuedProjectReplacementRef.current = replacement;
    setPendingProjectReplacement({
      currentProjectName: projectFile.name,
      nextProjectName,
      saveNeedsLocation: folderAccessAvailable && !projectWorkspace && !getUnsavedDraftReason(),
      saving: false,
    });
  }

  function cancelProjectReplacement(): void {
    queuedProjectReplacementRef.current = null;
    setPendingProjectReplacement(undefined);
  }

  async function continueProjectReplacement(): Promise<void> {
    const replacement = queuedProjectReplacementRef.current;
    if (!replacement) return;
    queuedProjectReplacementRef.current = null;
    setPendingProjectReplacement(undefined);
    await performProjectReplacement(replacement);
  }

  async function discardAndContinueProjectReplacement(): Promise<void> {
    await continueProjectReplacement();
  }

  async function saveAndContinueProjectReplacement(
    options?: ProjectCreationOptions,
  ): Promise<void> {
    const replacement = queuedProjectReplacementRef.current;
    if (!replacement || !projectFile) return;
    if (folderAccessAvailable && !projectWorkspace && !options && !getUnsavedDraftReason()) return;

    setPendingProjectReplacement((current) =>
      current ? { ...current, saving: true, error: undefined } : current,
    );
    try {
      requireSavableDraft();
      const project = currentProjectDocument();
      if (projectWorkspace) {
        const workspace = projectWorkspace;
        const version = projectChangeVersionRef.current;
        await writeProjectWorkspace(workspace, project);
        if (
          projectWorkspaceRef.current !== workspace ||
          projectChangeVersionRef.current !== version
        ) {
          throw new Error(
            "The project changed while it was being saved. Review the latest changes and try again.",
          );
        }
        autoSaveWindowStartedAtRef.current = null;
        autoSaveFailureCountRef.current = 0;
        autoSaveRetryNotBeforeRef.current = 0;
        setProjectFile(project);
        setProjectDirty(false);
        setUnsavedDraftReason(undefined);
        setProjectError(undefined);
        updateProjectErrorKind(undefined);
        onSaved?.({ name: project.name, destination: "folder" });
      } else if (folderAccessAvailable) {
        const named = namedProject(project, options!);
        const opened = await createProjectFolder(named, options!);
        if (!opened) {
          setPendingProjectReplacement((current) =>
            current ? { ...current, saving: false } : current,
          );
          return;
        }
        applyProjectDocument(
          opened.project,
          opened.handle,
          mappedProfileIds[project.defaults.target.connectionRequirementId] ??
            activeProfile.id,
        );
        onSaved?.({ name: opened.project.name, destination: "folder" });
      } else {
        downloadProjectFile(project);
        setProjectFile(project);
        setProjectDirty(false);
        setUnsavedDraftReason(undefined);
        setProjectError(undefined);
        updateProjectErrorKind(undefined);
        onSaved?.({ name: project.name, destination: "download" });
      }
      await continueProjectReplacement();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save the project.";
      projectFailure(error, "Could not save the project.");
      setPendingProjectReplacement((current) =>
        current ? { ...current, saving: false, error: message } : current,
      );
    }
  }

  function namedProject(
    project: ProjectFile,
    options: ProjectCreationOptions,
  ): ProjectFile {
    return {
      ...project,
      name: options.name.trim() || "Untitled Inference Lens project",
    };
  }

  async function newProjectFolder(options: ProjectCreationOptions): Promise<void> {
    if (!projectFile) {
      try { requireSavableDraft(); }
      catch (error) { projectFailure(error, "Could not create the project folder."); return; }
    }
    const project = namedProject(
      projectFile ? createFreshProject() : currentProjectDocument(),
      options,
    );
    requestProjectReplacement(project.name, {
      fallbackError: "Could not create the project folder.",
      async perform() {
        const opened = await createProjectFolder(project, options);
        if (opened) {
          applyProjectDocument(opened.project, opened.handle, activeProfile.id);
        }
      },
    });
  }

  async function openProjectWorkspace(): Promise<void> {
    requestProjectReplacement("the selected project folder", {
      fallbackError: "Could not open the project folder.",
      async perform() {
        const opened = await openProjectFolder();
        if (opened) applyProjectDocument(opened.project, opened.handle);
      },
    });
  }

  async function reconnectProjectWorkspace(): Promise<void> {
    if (hasProjectRef.current) return;
    try {
      const outcome = await reconnectStoredProjectWorkspace();
      if (hasProjectRef.current) return;
      applyResumeOutcome(outcome);
    } catch (error) {
      if (!hasProjectRef.current) {
        projectFailure(error, "Could not reconnect the remembered project.");
      }
    }
  }

  async function saveProject(options?: ProjectCreationOptions): Promise<void> {
    try {
      requireSavableDraft();
      const project = currentProjectDocument();
      if (projectWorkspace) {
        const workspace = projectWorkspace;
        const version = projectChangeVersionRef.current;
        await writeProjectWorkspace(workspace, project);
        if (
          projectWorkspaceRef.current === workspace &&
          projectChangeVersionRef.current === version
        ) {
          autoSaveWindowStartedAtRef.current = null;
          autoSaveFailureCountRef.current = 0;
          autoSaveRetryNotBeforeRef.current = 0;
          setProjectFile(project);
          setProjectDirty(false);
          setUnsavedDraftReason(undefined);
          setProjectError(undefined);
          updateProjectErrorKind(undefined);
          onSaved?.({ name: project.name, destination: "folder" });
        }
        return;
      }
      if (folderAccessAvailable) {
        if (!options) {
          throw new Error("Choose a project name and location before saving.");
        }
        const named = { ...project, name: options.name.trim() || project.name };
        const opened = await createProjectFolder(named, options);
        if (opened) {
          applyProjectDocument(
            opened.project,
            opened.handle,
            mappedProfileIds[project.defaults.target.connectionRequirementId] ?? activeProfile.id,
          );
          onSaved?.({ name: opened.project.name, destination: "folder" });
        }
        return;
      }
      downloadProjectFile(project);
      setProjectFile(project);
      setProjectDirty(false);
      setUnsavedDraftReason(undefined);
      setProjectError(undefined);
      onSaved?.({ name: project.name, destination: "download" });
    } catch (error) {
      projectFailure(error, "Could not save the project.");
    }
  }

  function exportProject(): void {
    try {
      requireSavableDraft();
      downloadProjectFile(currentProjectDocument());
      setProjectError(undefined);
    } catch (error) {
      projectFailure(error, "Could not export the project.");
    }
  }

  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = parseProjectJson(await file.text());
      requestProjectReplacement(imported.name, {
        fallbackError: "Could not import the project.",
        async perform() {
          applyProjectDocument(imported, null);
        },
      });
    } catch (error) {
      projectFailure(error, "Could not import the project.");
    } finally {
      event.target.value = "";
    }
  }

  return {
    projectFile,
    projectWorkspace,
    projectDirty: hasUnsavedChanges,
    projectStorageState: projectFile
      ? !projectWorkspace
        ? { kind: "session" }
        : tabRole === "secondary"
          ? { kind: "secondary", displayPath: projectWorkspace.displayPath }
          : projectErrorKind === "auto-save"
            ? { kind: "error", displayPath: projectWorkspace.displayPath }
            : projectDirty
              ? { kind: "saving", displayPath: projectWorkspace.displayPath }
              : unsavedDraftReason
                ? { kind: "unsaved", displayPath: projectWorkspace.displayPath, reason: unsavedDraftReason }
                : { kind: "saved", displayPath: projectWorkspace.displayPath }
      : undefined,
    projectError,
    projectErrorKind,
    mappedProfileIds,
    pendingProjectReplacement,
    projectAdoption,
    ...(projectWorkspace && tabRole !== "acquiring"
      ? {
          projectTab: {
            role: tabRole,
            behind: tabBehind,
            lostEdits: tabLostEdits,
            ...(confirmTakeover ? { confirmTakeover } : {}),
            switching: tabSwitching,
          },
        }
      : {}),
    becomeProjectEditor,
    confirmProjectEditorTakeover,
    cancelProjectEditorTakeover,
    markDirty,
    setError,
    clearErrorKind,
    setToolsDisabledError,
    dismissError,
    clearToolsDisabledError,
    adoptBranchRevision,
    currentProjectDocument,
    materializeProject,
    adoptProjectMutation,
    mapProfile,
    unmapProfile,
    newProjectFolder,
    openProjectWorkspace,
    reconnectProjectWorkspace,
    saveProject,
    exportProject,
    importProject,
    cancelProjectReplacement,
    discardAndContinueProjectReplacement,
    saveAndContinueProjectReplacement,
  };
}
