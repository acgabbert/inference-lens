"use client";

import { useState } from "react";
import {
  removeProjectEnvironment,
  setProjectDefaultEnvironment,
  setProjectEnvironment,
} from "../../packages/core/src/environment";
import type {
  EnvironmentReference,
  ProjectEnvironment,
} from "../../packages/core/src/environment";
import type { ProjectFile } from "../../packages/core/src/project";
import type { EnvironmentId } from "../../packages/core/src/run-kernel";
import type { ProjectDocumentAdoption } from "../use-project-workspace.client";

export interface UseProjectEnvironmentsInput {
  projectFile: ProjectFile | null;
  ensureProjectDocument(): ProjectFile;
  /**
   * Re-renders the composer for `environmentId`, adopting `project` when it is
   * given. Reached only from this owner's commands, never during render.
   */
  applyEnvironment(environmentId: EnvironmentId | undefined, project?: ProjectFile): void;
}

export interface ProjectEnvironmentsHandle {
  environments: readonly ProjectEnvironment[];
  /** The session's choice, present only while the open project still has it. */
  selectedId?: EnvironmentId;
  selected?: ProjectEnvironment;
  /** The project's authored launch default. */
  defaultId?: EnvironmentId;
  /**
   * Settles the selection for an arriving document: a new document starts
   * from its default, and a refresh keeps the choice while it still exists.
   */
  adopt(project: ProjectFile, adoption: ProjectDocumentAdoption): EnvironmentId | undefined;
  select(environmentId: EnvironmentId | undefined): void;
  /** Inserts or replaces by ID. The editor only offers a draft the project accepts. */
  save(environment: ProjectEnvironment): void;
  /** Refused while a default, suite or variant selects it. */
  remove(environmentId: EnvironmentId): { ok: true } | { ok: false; references: EnvironmentReference[] };
  setDefault(environmentId: EnvironmentId | undefined): void;
}

/**
 * The project's environments and the session's choice of one.
 *
 * The choice is session state, like the composer's model: switching it never
 * writes the project. Only "use as project default" does.
 */
export function useProjectEnvironments(input: UseProjectEnvironmentsInput): ProjectEnvironmentsHandle {
  const [chosenId, setChosenId] = useState<EnvironmentId>();
  const environments = input.projectFile?.environments ?? [];
  const selected = chosenId ? environments.find(({ id }) => id === chosenId) : undefined;

  function adopt(project: ProjectFile, adoption: ProjectDocumentAdoption): EnvironmentId | undefined {
    const kept = adoption === "refresh" && chosenId && project.environments.some(({ id }) => id === chosenId)
      ? chosenId
      : undefined;
    const next = adoption === "refresh" ? kept : project.defaults.environmentId;
    setChosenId(next);
    return next;
  }

  function select(environmentId: EnvironmentId | undefined): void {
    setChosenId(environmentId);
    input.applyEnvironment(environmentId);
  }

  function save(environment: ProjectEnvironment): void {
    const project = setProjectEnvironment(input.ensureProjectDocument(), environment);
    input.applyEnvironment(selected?.id, project);
  }

  function remove(environmentId: EnvironmentId) {
    const result = removeProjectEnvironment(input.ensureProjectDocument(), environmentId);
    if (!result.ok) return result;
    const next = selected?.id === environmentId ? undefined : selected?.id;
    setChosenId(next);
    input.applyEnvironment(next, result.project);
    return { ok: true as const };
  }

  function setDefault(environmentId: EnvironmentId | undefined): void {
    input.applyEnvironment(
      selected?.id,
      setProjectDefaultEnvironment(input.ensureProjectDocument(), environmentId),
    );
  }

  return {
    environments,
    ...(selected ? { selectedId: selected.id, selected } : {}),
    ...(input.projectFile?.defaults.environmentId ? { defaultId: input.projectFile.defaults.environmentId } : {}),
    adopt,
    select,
    save,
    remove,
    setDefault,
  };
}
