"use client";

import { ModalDialog } from "../modal-dialog.client";
import type { ProjectMigrationHandle } from "./use-project-migration.client";

/**
 * The upgrade preview (D4). Opening and previewing write nothing; the one
 * confirmation stages the source and drafts, writes v19 and reopens.
 */
export function ProjectUpgradeDialog({
  migration,
  onExportCopy,
}: {
  migration: ProjectMigrationHandle;
  onExportCopy(): void;
}) {
  const { dialog } = migration;
  if (!dialog) return null;
  const preview = dialog.phase === "loading" ? undefined : dialog.preview;
  const upgrading = dialog.phase === "upgrading";
  const canUpgrade = Boolean(preview) && dialog.phase !== "loading" && !upgrading;
  return (
    <ModalDialog
      className="confirmation-dialog"
      labelledBy="project-upgrade-title"
      onClose={migration.closeUpgrade}
    >
      <span className="eyebrow">Upgrade project</span>
      <h2 id="project-upgrade-title">Upgrade this project to the shared format?</h2>
      {dialog.phase === "loading" && <p role="status">Reading project.json…</p>}
      {preview && (
        <>
          <p>
            Prompt drafts move out of project.json into this folder&apos;s personal
            workbench (.workbench/, which Git ignores). Saved prompts, requests,
            suites, tools and environments stay shared.
          </p>
          <dl className="confirmation-details">
            <div>
              <dt>Current format</dt>
              <dd>Project format {preview.sourceVersion}</dd>
            </div>
            <div>
              <dt>Drafts that become personal</dt>
              <dd>{preview.drafts.length ? preview.drafts.map((draft) => draft.name).join(", ") : "None"}</dd>
            </div>
            <div>
              <dt>Backup</dt>
              <dd>The original project.json is kept in .workbench/migrations/.</dd>
            </div>
          </dl>
          <p>
            Teammates on older builds of Inference Lens cannot open the project
            once the upgraded project.json is committed. Suite, tool, mock and
            environment edits still save straight to project.json.
          </p>
          {preview.staged && <p>An earlier attempt already prepared this upgrade, so it continues from there.</p>}
          {migration.discardsSharedChanges && (
            <p className="project-replacement-error">
              This session has project changes that could not be saved. Upgrading
              reopens the folder from disk and discards them. Export a JSON copy
              first to keep them.
            </p>
          )}
        </>
      )}
      {dialog.phase === "preview" && dialog.notice && <p className="project-replacement-error" role="alert">{dialog.notice}</p>}
      {dialog.phase === "failed" && <p className="project-replacement-error" role="alert">{dialog.message}</p>}
      <div className="confirmation-actions">
        <button
          autoFocus
          className="button secondary"
          disabled={upgrading}
          type="button"
          onClick={migration.closeUpgrade}
        >
          Cancel
        </button>
        {migration.discardsSharedChanges && preview && (
          <button className="button secondary" disabled={upgrading} type="button" onClick={onExportCopy}>
            Export JSON copy…
          </button>
        )}
        {preview && (
          <button
            className="button primary"
            disabled={!canUpgrade}
            type="button"
            onClick={migration.confirmUpgrade}
          >
            {upgrading ? "Upgrading…" : migration.discardsSharedChanges ? "Discard changes and upgrade" : "Upgrade"}
          </button>
        )}
      </div>
    </ModalDialog>
  );
}
