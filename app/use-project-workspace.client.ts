"use client";

import { useState } from "react";
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
import type { ProjectWorkspaceHandle } from "./project-workspace.client.ts";

export type ProjectErrorKind = "tools-disabled";

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
  newProjectFolder(): Promise<void>;
  openProjectWorkspace(): Promise<void>;
  saveProject(): Promise<void>;
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
  const [mappedProfileId, setMappedProfileId] = useState<string>();

  function markDirty(): void {
    if (projectFile) setProjectDirty(true);
  }

  function setError(
    message: string | undefined,
    options?: { clearKind?: boolean },
  ): void {
    if (options?.clearKind) setProjectErrorKind(undefined);
    setProjectError(message);
  }

  function dismissError(): void {
    setProjectError(undefined);
    setProjectErrorKind(undefined);
  }

  function clearErrorKind(): void {
    setProjectErrorKind(undefined);
  }

  function setToolsDisabledError(message: string): void {
    setProjectErrorKind("tools-disabled");
    setProjectError(message);
  }

  function clearToolsDisabledError(): void {
    if (projectErrorKind === "tools-disabled") dismissError();
  }

  function adoptBranchRevision(project: ProjectFile): void {
    setProjectFile(project);
    setProjectDirty(true);
    dismissError();
  }

  function materializeProject(): ProjectFile {
    const project = currentProjectDocument();
    setProjectFile(project);
    setProjectWorkspace(null);
    setMappedProfileId(activeProfileId);
    setProjectDirty(true);
    dismissError();
    return project;
  }

  function adoptProjectMutation(project: ProjectFile): void {
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
    setProjectFile(project);
    setProjectWorkspace(workspace);
    onApplyDraft(draft);
    setMappedProfileId(profileId);
    setProjectDirty(false);
    dismissError();
  }

  function projectFailure(error: unknown, fallback: string): void {
    setProjectErrorKind(undefined);
    setProjectError(error instanceof Error ? error.message : fallback);
  }

  async function newProjectFolder(): Promise<void> {
    try {
      const opened = await createProjectFolder(currentProjectDocument());
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

  async function saveProject(): Promise<void> {
    try {
      const project = currentProjectDocument();
      if (projectWorkspace) {
        await saveProjectWorkspace(projectWorkspace, project);
        setProjectFile(project);
        setProjectDirty(false);
        setProjectError(undefined);
        return;
      }
      if (folderAccessAvailable) {
        const opened = await createProjectFolder(project);
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
