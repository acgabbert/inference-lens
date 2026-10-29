"use client";

import { useState } from "react";
import { projectDirectoryName } from "../packages/core/src/project.ts";
import type { ProjectGitPolicy } from "../packages/core/src/project.ts";
import type { ProjectCreationOptions } from "./project-workspace.client.ts";
import { useModalDialog } from "./modal-dialog.client";

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
  const [gitPolicy, setGitPolicy] = useState<ProjectGitPolicy>("private");
  const valid = Boolean(name.trim());

  // The hook rather than <ModalDialog>: the dialog element is the form itself.
  const dialogRef = useModalDialog<HTMLFormElement>(onClose);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <form
        aria-labelledby="project-creation-title"
        aria-modal="true"
        className="confirmation-dialog project-creation-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onClose();
          onCreate({ name: name.trim(), gitPolicy });
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
        <fieldset className="project-creation-git-policy">
          <legend>Git sharing</legend>
          {([
            ["private", "Keep this project out of Git", "Excludes the entire project from ordinary Git staging."],
            ["definitions", "Share definitions; keep run history local", "Shares all content in project.json, including persisted drafts and saved values. Run history and other files stay excluded by default."],
            ["unmanaged", "Manage Git rules myself", "Creates no .gitignore. Your Git rules decide which files are staged."],
          ] as const).map(([value, title, description]) => (
            <label className="project-creation-protection" key={value}>
              <input
                type="radio"
                name="git-policy"
                value={value}
                aria-label={title}
                aria-describedby={`git-policy-${value}-description`}
                checked={gitPolicy === value}
                onChange={() => setGitPolicy(value)}
              />
              <span>
                <strong>{title}</strong>
                <small id={`git-policy-${value}-description`}>{description}</small>
              </span>
            </label>
          ))}
        </fieldset>
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
