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
  reconnectProjectWorkspace as reconnectStoredProjectWorkspace,
  restoreProjectWorkspace,
  saveProjectWorkspace,
} from "./project-workspace.client.ts";
import type {
  ProjectCreationOptions,
  ProjectWorkspaceHandle,
  WorkspaceResumeOutcome,
} from "./project-workspace.client.ts";
import { readProfiles } from "./profile-store.client.ts";
import {
  prunedProjectProfileMap,
  readProjectProfileMap,
  resolveMappedProfile,
  withMappedProfile,
  withoutMappedProfile,
  writeProjectProfileMap,
} from "./project-profile-map.client.ts";

export type ProjectErrorKind =
  | "auto-save"
  | "tools-disabled"
  | "workspace-reconnect";

const PROJECT_AUTO_SAVE_DELAY_MS = 800;
const PROJECT_AUTO_SAVE_MAX_WAIT_MS = 5_000;
const PROJECT_AUTO_SAVE_RETRY_BASE_MS = 2_000;
const PROJECT_AUTO_SAVE_RETRY_MAX_MS = 30_000;

export interface ProjectWorkspaceHandleState {
  projectFile: ProjectFile | null;
  projectWorkspace: ProjectWorkspaceHandle | null;
  projectDirty: boolean;
  projectError?: string;
  projectErrorKind?: ProjectErrorKind;
  mappedProfileId?: string;
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
  mapProfile(profileId: string): void;
  mapActiveProfile(): void;
  unmapProfile(profileId: string): void;
  newProjectFolder(options: ProjectCreationOptions): Promise<void>;
  openProjectWorkspace(): Promise<void>;
  reconnectProjectWorkspace(): Promise<void>;
  saveProject(options?: ProjectCreationOptions): Promise<void>;
  exportProject(): void;
  importProject(event: ChangeEvent<HTMLInputElement>): Promise<void>;
}

/**
 * Owns the lifecycle of a portable project and its local workspace handle.
 * The caller supplies the currently editable request draft and applies a
 * loaded draft, keeping session-only run configuration and run state outside
 * this persistence boundary.
 */
export function useProjectWorkspace(input: {
  activeProfileId: string;
  /** Every profile this device currently has, for validating stored mappings. */
  profileIds: readonly string[];
  folderAccessAvailable: boolean;
  createProject(): ProjectFile;
  currentDraft(): UpdateProjectDraft;
  onApplyDraft(draft: ProjectDraft): void;
}): ProjectWorkspaceHandleState {
  const {
    activeProfileId,
    profileIds,
    folderAccessAvailable,
    createProject,
    currentDraft,
    onApplyDraft,
  } = input;
  const [projectFile, setProjectFile] = useState<ProjectFile | null>(null);
  const [projectWorkspace, setProjectWorkspace] =
    useState<ProjectWorkspaceHandle | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);
  const [projectError, setProjectError] = useState<string>();
  const [projectErrorKind, setProjectErrorKind] = useState<ProjectErrorKind>();
  const projectErrorKindRef = useRef<ProjectErrorKind | undefined>(undefined);
  const [mappedProfileId, setMappedProfileId] = useState<string>();
  const [projectChangeVersion, setProjectChangeVersion] = useState(0);
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
  const profileIdsRef = useRef(profileIds);

  useEffect(() => {
    profileIdsRef.current = profileIds;
  }, [profileIds]);

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

  function setCurrentWorkspace(workspace: ProjectWorkspaceHandle | null): void {
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
      .then(() => saveProjectWorkspace(workspace, project));
    workspaceSaveTailRef.current = write;
    return write;
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
    setCurrentWorkspace(null);
    setMappedProfileId(activeProfileId);
    rememberMappedProfile(project.projectId, activeProfileId);
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
  function rememberMappedProfile(projectId: string, profileId: string): void {
    writeProjectProfileMap(
      withMappedProfile(
        prunedProjectProfileMap(readProjectProfileMap(), knownProfileIds()),
        projectId,
        profileId,
      ),
    );
  }

  /**
   * Every profile id this device can be said to have: the ones rendered, plus
   * the ones still in storage. Both hooks restore from storage in a task of
   * their own, so a project can be adopted before the profile list has been
   * rendered. Validating against the rendered list alone would then read as
   * "that profile is gone" and discard a mapping the user did make.
   */
  function knownProfileIds(): string[] {
    const stored = readProfiles().profiles.map(({ id }) => id);
    return [...new Set([...profileIdsRef.current, ...stored])];
  }

  function storedMappedProfile(project: ProjectFile): string | undefined {
    return resolveMappedProfile(
      readProjectProfileMap(),
      project.projectId,
      knownProfileIds(),
    );
  }

  function mapProfile(profileId: string): void {
    if (!projectFile) return;
    setMappedProfileId(profileId);
    rememberMappedProfile(projectFile.projectId, profileId);
  }

  function mapActiveProfile(): void {
    if (!projectFile) return;
    setMappedProfileId(activeProfileId);
    rememberMappedProfile(projectFile.projectId, activeProfileId);
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
    setMappedProfileId((current) =>
      current === profileId ? undefined : current,
    );
    writeProjectProfileMap(
      withoutMappedProfile(readProjectProfileMap(), profileId),
    );
  }

  function currentProjectDocument(): ProjectFile {
    return updateProjectDraft(projectFile ?? createProject(), currentDraft());
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
  ): void {
    const draft = projectDraft(project);
    hasProjectRef.current = true;
    advanceProjectChangeVersion();
    setProjectFile(project);
    setCurrentWorkspace(workspace);
    onApplyDraft(draft);
    if (profileId) rememberMappedProfile(project.projectId, profileId);
    setMappedProfileId(profileId ?? storedMappedProfile(project));
    setProjectDirty(false);
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
    if (restoredRef.current) return;
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
  }, []);

  useEffect(() => {
    if (!projectWorkspace || !projectFile || !projectDirty) return;

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
  }, [projectChangeVersion, projectDirty, projectFile, projectWorkspace]);

  function projectFailure(error: unknown, fallback: string): void {
    updateProjectErrorKind(undefined);
    setProjectError(error instanceof Error ? error.message : fallback);
  }

  function namedProject(options: ProjectCreationOptions): ProjectFile {
    return {
      ...currentProjectDocument(),
      name: options.name.trim() || "Untitled Inference Lens project",
    };
  }

  async function newProjectFolder(options: ProjectCreationOptions): Promise<void> {
    try {
      const project = namedProject(options);
      const opened = await createProjectFolder(project, options);
      if (opened) applyProjectDocument(opened.project, opened.handle, activeProfileId);
    } catch (error) {
      projectFailure(error, "Could not create the project folder.");
    }
  }

  async function openProjectWorkspace(): Promise<void> {
    try {
      const opened = await openProjectFolder();
      if (opened) applyProjectDocument(opened.project, opened.handle);
    } catch (error) {
      projectFailure(error, "Could not open the project folder.");
    }
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
          setProjectError(undefined);
          updateProjectErrorKind(undefined);
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
            mappedProfileId ?? activeProfileId,
          );
        }
        return;
      }
      downloadProjectFile(project);
      setProjectFile(project);
      setProjectDirty(false);
      setProjectError(undefined);
    } catch (error) {
      projectFailure(error, "Could not save the project.");
    }
  }

  function exportProject(): void {
    try {
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
      applyProjectDocument(parseProjectJson(await file.text()), null);
    } catch (error) {
      projectFailure(error, "Could not import the project.");
    } finally {
      event.target.value = "";
    }
  }

  return {
    projectFile,
    projectWorkspace,
    projectDirty,
    projectError,
    projectErrorKind,
    mappedProfileId,
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
    mapActiveProfile,
    unmapProfile,
    newProjectFolder,
    openProjectWorkspace,
    reconnectProjectWorkspace,
    saveProject,
    exportProject,
    importProject,
  };
}
