"use client";

import { useEffect, useState } from "react";
import { projectDirectoryName } from "../packages/core/src/project.ts";
import type { ProjectCreationOptions } from "./project-workspace.client.ts";

export function ProjectCreationDialog({
  initialName,
  onClose,
  onCreate,
}: {
  initialName: string;
  onClose(): void;
  onCreate(options: ProjectCreationOptions): void;
}) {
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
        <span className="eyebrow">New project</span>
        <h2 id="project-creation-title">Create an Inference Lens project</h2>
        <p>
          Choose a name, then select the parent folder where the project bundle
          should be created.
        </p>
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
              Adds an internal .gitignore protecting authored prompts, traces,
              and future project data.
            </small>
          </span>
        </label>
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!valid} type="submit">
            Choose location…
          </button>
        </div>
      </form>
    </div>
  );
}
