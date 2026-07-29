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
  saveProjectWorkspace,
} from "./project-workspace.client.ts";
import type {
  ProjectCreationOptions,
  ProjectWorkspaceHandle,
} from "./project-workspace.client.ts";

export type ProjectErrorKind = "auto-save" | "tools-disabled";

const PROJECT_AUTO_SAVE_DELAY_MS = 800;

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
  folderAccessAvailable: boolean;
  createProject(): ProjectFile;
  currentDraft(): UpdateProjectDraft;
  onApplyDraft(draft: ProjectDraft): void;
}): ProjectWorkspaceHandleState {
  const {
    activeProfileId,
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

  function advanceProjectChangeVersion(): number {
    projectChangeVersionRef.current += 1;
    setProjectChangeVersion(projectChangeVersionRef.current);
    return projectChangeVersionRef.current;
  }

  function updateProjectErrorKind(kind: ProjectErrorKind | undefined): void {
    projectErrorKindRef.current = kind;
    setProjectErrorKind(kind);
  }

  function setCurrentWorkspace(workspace: ProjectWorkspaceHandle | null): void {
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

  function mapProfile(profileId: string): void {
    if (projectFile) setMappedProfileId(profileId);
  }

  function mapActiveProfile(): void {
    if (projectFile) {
      setMappedProfileId(activeProfileId);
      setProjectError(undefined);
    }
  }

  /**
   * Releases the mapping when the profile it names goes away. The project is
   * left unmapped rather than pointed at a replacement: which connection runs a
   * project is the user's choice, and asking again is better than guessing.
   */
  function unmapProfile(profileId: string): void {
    setMappedProfileId((current) =>
      current === profileId ? undefined : current,
    );
  }

  function currentProjectDocument(): ProjectFile {
    return updateProjectDraft(projectFile ?? createProject(), currentDraft());
  }

  function applyProjectDocument(
    project: ProjectFile,
    workspace: ProjectWorkspaceHandle | null,
    profileId?: string,
  ): void {
    const draft = projectDraft(project);
    advanceProjectChangeVersion();
    setProjectFile(project);
    setCurrentWorkspace(workspace);
    onApplyDraft(draft);
    setMappedProfileId(profileId);
    setProjectDirty(false);
    dismissError();
  }

  useEffect(() => {
    if (!projectWorkspace || !projectFile || !projectDirty) return;

    const workspace = projectWorkspace;
    const version = projectChangeVersion;
    const timer = window.setTimeout(() => {
      const project = currentProjectDocument();

      void writeProjectWorkspace(workspace, project)
        .then(() => {
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
          updateProjectErrorKind("auto-save");
          setProjectError(
            error instanceof Error
              ? error.message
              : "Could not auto-save the project.",
          );
        });
    }, PROJECT_AUTO_SAVE_DELAY_MS);

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
    saveProject,
    exportProject,
    importProject,
  };
}
