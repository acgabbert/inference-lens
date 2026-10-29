"use client";

import { useEffect, useRef, useState } from "react";
import type {
  EnvironmentReference,
  ProjectEnvironment,
} from "../../packages/core/src/environment";
import { createEntityId } from "../../packages/core/src/run-kernel";
import type { EnvironmentId } from "../../packages/core/src/run-kernel";
import { randomUUID } from "../../packages/core/src/random-id";
import { SideDrawer } from "../workbench-shell.client";
import {
  environmentDraftIssues,
  environmentDraftPreview,
  newEnvironmentName,
} from "./environment-draft";
import styles from "./environments.module.css";

export interface EnvironmentDrawerFocus {
  environmentId: EnvironmentId;
  entryName?: string;
}

interface EnvironmentDrawerProps {
  open: boolean;
  onClose(): void;
  environments: readonly ProjectEnvironment[];
  selectedId?: EnvironmentId;
  defaultId?: EnvironmentId;
  /** Opens on this environment, focusing the entry when one is named. */
  focus?: EnvironmentDrawerFocus;
  onFocusHandled(): void;
  onSave(environment: ProjectEnvironment): void;
  onRemove(environmentId: EnvironmentId): { ok: true } | { ok: false; references: EnvironmentReference[] };
  onSelect(environmentId: EnvironmentId | undefined): void;
}

function referenceLabel(reference: EnvironmentReference): string {
  switch (reference.kind) {
    case "project-default":
      return "the project default";
    case "evaluation-suite":
      return `suite “${reference.suiteName}”`;
    case "evaluation-variant":
      return `variant “${reference.variantName}” of suite “${reference.suiteName}”`;
  }
}

function sameEnvironment(left: ProjectEnvironment | undefined, right: ProjectEnvironment | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Edits one environment at a time as a local draft. Save writes it to the
 * project and stays disabled while the project would refuse it; the draft
 * outlives closing the drawer, so closing never discards an edit.
 */
export function EnvironmentDrawer({
  open,
  onClose,
  environments,
  selectedId,
  defaultId,
  focus,
  onFocusHandled,
  onSave,
  onRemove,
  onSelect,
}: EnvironmentDrawerProps) {
  // Held only while it differs from the project: a new environment, or
  // unsaved edits. Otherwise the drawer shows the saved environment.
  const [draft, setDraft] = useState<ProjectEnvironment>();
  const [editingId, setEditingId] = useState<EnvironmentId>();
  const [refusal, setRefusal] = useState<string>();
  const contentRef = useRef<HTMLDivElement>(null);
  // A readiness link chooses the environment once, when it arrives; an
  // unsaved draft of another environment is never replaced to reach it.
  const [arrivedFocus, setArrivedFocus] = useState(focus);
  if (focus !== arrivedFocus) {
    setArrivedFocus(focus);
    if (focus && !draft) setEditingId(focus.environmentId);
  }
  const shownId = draft?.id ?? editingId ?? selectedId;
  const saved = environments.find(({ id }) => id === shownId) ?? (draft ? undefined : environments[0]);
  const current = draft ?? saved;
  const dirty = Boolean(draft) && !sameEnvironment(draft, saved);

  function edit(environment: ProjectEnvironment | undefined): void {
    setDraft(undefined);
    setEditingId(environment?.id);
    setRefusal(undefined);
  }

  function change(next: ProjectEnvironment): void {
    setDraft(next);
  }

  useEffect(() => {
    if (!open || !focus) return;
    if (current?.id === focus.environmentId) {
      const field = focus.entryName
        ? contentRef.current?.querySelector<HTMLTextAreaElement>(`[data-environment-entry="${focus.entryName}"]`)
        : contentRef.current?.querySelector<HTMLInputElement>("[data-environment-name]");
      field?.scrollIntoView?.({ block: "center" });
      field?.focus();
    }
    onFocusHandled();
  }, [current?.id, focus, onFocusHandled, open]);

  const issues = current ? environmentDraftIssues(environments, current) : undefined;
  const preview = current ? environmentDraftPreview(current) : undefined;

  function updateEntry(index: number, patch: Partial<ProjectEnvironment["entries"][number]>): void {
    if (!current) return;
    change({
      ...current,
      entries: current.entries.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)),
    });
  }

  function remove(environmentId: EnvironmentId): void {
    const result = onRemove(environmentId);
    if (result.ok) {
      edit(environments.find(({ id }) => id !== environmentId));
      return;
    }
    setRefusal(
      `Still used by ${result.references.map(referenceLabel).join(", ")}. Choose another environment there first; clearing it would change what those runs render.`,
    );
  }

  return (
    <SideDrawer
      open={open}
      eyebrow="Project"
      title="Environments"
      description="Named values that fill template variables by name in every prompt a run sends."
      onClose={onClose}
    >
      <div className={styles.drawer} ref={contentRef}>
        <ul aria-label="Environments" className={styles.list}>
          {environments.map((environment) => (
            <li key={environment.id}>
              <button
                aria-pressed={current?.id === environment.id}
                className={styles.listItem}
                disabled={dirty && current?.id !== environment.id}
                title={dirty && current?.id !== environment.id ? "Save or discard this environment's changes first." : undefined}
                type="button"
                onClick={() => edit(environment)}
              >
                {environment.name}
                {environment.id === selectedId && <span className={styles.badge}>in use</span>}
                {environment.id === defaultId && <span className={styles.badge}>default</span>}
              </button>
            </li>
          ))}
          <li>
            <button
              className={styles.listItem}
              disabled={dirty}
              title={dirty ? "Save or discard this environment's changes first." : undefined}
              type="button"
              onClick={() => {
                setRefusal(undefined);
                change({
                  id: createEntityId("environment", randomUUID()),
                  name: newEnvironmentName(environments),
                  entries: [{ name: "", value: "" }],
                });
              }}
            >
              + New environment
            </button>
          </li>
        </ul>

        {!current ? (
          <p className={styles.muted}>
            No environments yet. Create one to fill the same variables in every prompt, then switch it
            from the composer.
          </p>
        ) : (
          <>
            <label className={styles.field}>
              <span>Name</span>
              <input
                data-environment-name
                value={current.name}
                onChange={(event) => change({ ...current, name: event.target.value })}
              />
              {issues?.name && <small className={styles.issue}>{issues.name}</small>}
            </label>
            {issues?.general.map((message) => (
              <p className={styles.issue} key={message}>{message}</p>
            ))}

            <div className={styles.entries}>
              {current.entries.map((entry, index) => (
                <div className={styles.entry} key={index}>
                  <div className={styles.entryHeading}>
                    <label className={styles.field}>
                      <span>Variable</span>
                      <input
                        aria-label={`Entry ${index + 1} name`}
                        placeholder="customer"
                        value={entry.name}
                        onChange={(event) => updateEntry(index, { name: event.target.value })}
                      />
                    </label>
                    <button
                      aria-label={`Remove entry ${index + 1}`}
                      className="remove-button"
                      type="button"
                      onClick={() => change({ ...current, entries: current.entries.filter((_, entryIndex) => entryIndex !== index) })}
                    >
                      Remove
                    </button>
                  </div>
                  {issues?.entries[index]?.name && <small className={styles.issue}>{issues.entries[index].name}</small>}
                  <label className={styles.field}>
                    <span>Value</span>
                    <textarea
                      aria-label={`Entry ${index + 1} value`}
                      data-environment-entry={entry.name}
                      placeholder="A literal value, or other entries as {{name}}"
                      rows={2}
                      value={entry.value}
                      onChange={(event) => updateEntry(index, { value: event.target.value })}
                    />
                  </label>
                  {issues?.entries[index]?.value && <small className={styles.issue}>{issues.entries[index].value}</small>}
                </div>
              ))}
              <div>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => change({ ...current, entries: [...current.entries, { name: "", value: "" }] })}
                >
                  + Add entry
                </button>
              </div>
            </div>

            <section aria-label="Resolved values">
              <div className="section-heading"><span>Resolved values</span></div>
              {!preview ? (
                <p className={styles.muted}>Fix the issues above to see what each entry resolves to.</p>
              ) : current.entries.length === 0 ? (
                <p className={styles.muted}>No entries.</p>
              ) : (
                <dl className={styles.preview}>
                  {current.entries.map(({ name }) => {
                    const diagnostics = preview.diagnostics.filter(({ entryName }) => entryName === name);
                    return (
                      <div key={name}>
                        <dt>{`{{${name}}}`}</dt>
                        <dd>{Object.hasOwn(preview.values, name) ? (preview.values[name] || "(empty)") : "Not resolved"}</dd>
                        {diagnostics.map(({ message }) => (
                          <small className={styles.issue} key={message}>{message}</small>
                        ))}
                      </div>
                    );
                  })}
                  {preview.diagnostics.filter(({ entryName }) => !entryName).map(({ message }) => (
                    <small className={styles.issue} key={message}>{message}</small>
                  ))}
                </dl>
              )}
            </section>

            <div className={styles.actions}>
              <button
                className="button primary"
                disabled={!dirty || (issues?.count ?? 0) > 0}
                title={(issues?.count ?? 0) > 0 ? "Fix the issues above before saving." : undefined}
                type="button"
                onClick={() => {
                  onSave(current);
                  edit(current);
                }}
              >
                Save
              </button>
              <button className="button secondary" disabled={!dirty} type="button" onClick={() => edit(saved ?? environments[0])}>
                Discard
              </button>
              {saved && saved.id !== selectedId && !dirty && (
                <button className="button secondary" type="button" onClick={() => onSelect(saved.id)}>
                  Use in composer
                </button>
              )}
              {saved && (
                <button className="text-button danger" type="button" onClick={() => remove(saved.id)}>
                  Delete
                </button>
              )}
            </div>
            {refusal && <p className={styles.issue} role="alert">{refusal}</p>}
            <p className={styles.muted}>
              Environments are saved in the project file and travel with it. Credentials belong in the
              connection, never here.
            </p>
          </>
        )}
      </div>
    </SideDrawer>
  );
}
