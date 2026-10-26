"use client";

import { useRef } from "react";
import {
  activeDecisionRequestRevision,
  resolveProjectDecisionRequestRevision,
  updateDecisionRequestDraft,
  updateDecisionRequestOverrides,
} from "../../packages/core/src/decision-request";
import type { ProjectFile } from "../../packages/core/src/project";
import type { DecisionRequestRevisionId } from "../../packages/core/src/run-kernel/types";
import type { DecisionDraftHandle } from "./use-decision-draft.client";

export interface DecisionProjectHandle {
  /**
   * The project with the editor's draft written into its active decision
   * request (D42). Called whenever the workspace builds the document to save,
   * so it is idempotent: folding the same draft into the same project twice
   * gives the same revision ids.
   */
  fold(project: ProjectFile): ProjectFile;
  /** A project was opened, created, or replaced: load its active request. */
  adopt(project: ProjectFile): void;
  /**
   * A run is starting from the draft. Writes it into the open project now and
   * freezes that revision, so the next edit appends a child (D38).
   */
  freezeForRun(): void;
  /** The project's request lags the editor because the draft does not validate. */
  unsaved: boolean;
  /** An incomplete draft cannot be represented in a portable project. */
  saveBlockedReason?: string;
}

/**
 * Connects the decision draft to the open project. The draft stays the only
 * thing the editor touches; this owns which revision it writes to and when
 * that revision may no longer change in place.
 */
export function useDecisionProject(options: {
  draft: DecisionDraftHandle;
  project: ProjectFile | null;
  adoptProjectMutation(project: ProjectFile): void;
}): DecisionProjectHandle {
  const { draft } = options;
  // Revisions that ran in this session or came from disk.
  const frozenRef = useRef(new Set<DecisionRequestRevisionId>());
  // The id suffix the next new revision takes, kept until the project holds
  // it, so repeated folds of one draft agree.
  const pendingSuffixRef = useRef<string | undefined>(undefined);

  function fold(project: ProjectFile): ProjectFile {
    const validated = draft.validated();
    if (!draft.touched || !("input" in validated)) return project;
    const active = activeDecisionRequestRevision(project);
    if (active && active.id === `decision-revision_${pendingSuffixRef.current}`) {
      pendingSuffixRef.current = undefined;
    }
    pendingSuffixRef.current ??= globalThis.crypto.randomUUID();
    if (active?.kind === "template-use") {
      const resolved = resolveProjectDecisionRequestRevision(project, active.id)!;
      const overrides = Object.fromEntries(resolved.variables.flatMap((name) =>
        Object.hasOwn(draft.values, name) && (Object.hasOwn(active.overrides, name) || draft.values[name] !== resolved.values[name])
          ? [[name, draft.values[name]!]] : []));
      return updateDecisionRequestOverrides(project, { decisionRequestRevisionId: active.id, overrides,
        branch: frozenRef.current.has(active.id), idSuffix: pendingSuffixRef.current });
    }
    return updateDecisionRequestDraft(project, {
      decision: validated.input,
      values: draft.values,
      branch: active ? frozenRef.current.has(active.id) : false,
      idSuffix: pendingSuffixRef.current,
    });
  }

  return {
    fold,
    adopt(project) {
      pendingSuffixRef.current = undefined;
      const activeId = project.defaults.decisionRequestRevisionId;
      const resolved = activeId && resolveProjectDecisionRequestRevision(project, activeId);
      if (!resolved) {
        draft.reset();
        return;
      }
      frozenRef.current.add(resolved.source.decisionRequestRevisionId);
      draft.adopt(resolved.decision, resolved.values);
    },
    freezeForRun() {
      if (!options.project) return;
      const next = fold(options.project);
      if (next !== options.project) options.adoptProjectMutation(next);
      const active = activeDecisionRequestRevision(next);
      if (active) frozenRef.current.add(active.id);
    },
    unsaved: Boolean(options.project) && draft.touched && !("input" in draft.validated()),
    ...(draft.touched && !("input" in draft.validated())
      ? { saveBlockedReason: "Fix the decision request before saving. Its incomplete edits have not been saved to the project." }
      : {}),
  };
}
