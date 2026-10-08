"use client";

import { useEffect, useState } from "react";
import { projectDirectoryName } from "../packages/core/src/project.ts";
import type { ProjectCreationOptions } from "./project-workspace.client.ts";

/**
 * Why a folder is being chosen: a new project, a first save of the open one,
 * or a save the user asked for before switching to another project.
 */
export type ProjectCreationMode = "new" | "save" | "save-before-switch";

const copyByMode: Record<
  ProjectCreationMode,
  { eyebrow: string; title: string; description: string; submitLabel: string }
> = {
  new: {
    eyebrow: "New project",
    title: "Create an Inference Lens project",
    description: "Name the project, then choose its parent folder.",
    submitLabel: "Choose location…",
  },
  save: {
    eyebrow: "Save project",
    title: "Save this project",
    description:
      "Choose a folder for this project. Its current prompts and settings will be saved there.",
    submitLabel: "Save to folder…",
  },
  "save-before-switch": {
    eyebrow: "Save before switching",
    title: "Save the current project",
    description:
      "Choose a folder for the current project. Inference Lens will switch projects only after the save succeeds.",
    submitLabel: "Save and switch…",
  },
};

export function ProjectCreationDialog({
  mode,
  initialName,
  onClose,
  onCreate,
}: {
  mode: ProjectCreationMode;
  initialName: string;
  onClose(): void;
  onCreate(options: ProjectCreationOptions): void;
}) {
  const copy = copyByMode[mode];
  const [name, setName] = useState(initialName);
  const [protectFromGit, setProtectFromGit] = useState(true);
  const valid = Boolean(name.trim());

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <form
        aria-labelledby="project-creation-title"
        aria-modal="true"
        className="confirmation-dialog project-creation-dialog"
        role="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onClose();
          onCreate({ name: name.trim(), protectFromGit });
        }}
      >
        <span className="eyebrow">{copy.eyebrow}</span>
        <h2 id="project-creation-title">
          {copy.title}
        </h2>
        <p>{copy.description}</p>
        <label className="project-creation-name">
          <span>Project name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <small>{projectDirectoryName(name)}</small>
        </label>
        <label className="project-creation-protection">
          <input
            type="checkbox"
            checked={protectFromGit}
            onChange={(event) => setProtectFromGit(event.target.checked)}
          />
          <span>
            <strong>Keep this project out of Git</strong>
            <small>
              Adds .gitignore rules for prompts, traces, and future project data.
            </small>
          </span>
        </label>
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!valid} type="submit">
            {copy.submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
