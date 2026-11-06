"use client";

import { useMemo, useState } from "react";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { EvaluationSuite } from "../../packages/core/src/evaluation-suites.ts";
import type { EvaluationSuiteId } from "../../packages/core/src/run-kernel/types.ts";
import type { WorkbenchSuiteDraftV1 } from "../../packages/core/src/personal-workbench.ts";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import type { PersonalWorkbenchHandle } from "../workbench/use-personal-workbench.client";
import { routeSuiteMutation, withSuiteDrafts } from "./suite-drafts.ts";

/** What the suite editor shows about the selected suite's draft (2c-1). */
export interface SuiteDraftState {
  /** `stale`: the saved suite changed since the draft started (C4). */
  kind: "draft" | "stale";
  saving: boolean;
  message?: string;
  onSave(): void;
  onOverwrite(): void;
  onDiscard(): void;
}

export interface SuiteDraftsHandle {
  /** The shared project with the user's suite drafts in place; what suite owners read and run (C3). */
  project: ProjectFile | null;
  /** Routes a suite owner's mutation of `project` to drafts and the shared document. */
  adoptProjectMutation(project: ProjectFile): void;
  /** Applies the drafts to a document built from the shared project, such as a folded request. */
  overlay(project: ProjectFile): ProjectFile;
  draftSuiteIds: ReadonlySet<EvaluationSuiteId>;
  stateFor(suiteId: EvaluationSuiteId | undefined): SuiteDraftState | undefined;
}

interface SaveState {
  suiteId: EvaluationSuiteId;
  saving: boolean;
  stale?: boolean;
  message?: string;
}

/**
 * Slice 2c-1 (C1–C4): edits to a saved suite are a personal draft until the
 * user saves it. Owners of suite content (authoring, decision suite settings,
 * case promotion) and the evaluation run read `project`, so a run uses the
 * draft. Without a personal session the mutation is written as before.
 */
export function useSuiteDrafts(input: {
  shared: ProjectFile | null;
  personal: Pick<PersonalWorkbenchHandle, "enabled" | "revision" | "draftFor" | "updateSuiteDraft" | "publishSuiteDraft" | "discardDraft">;
  adoptProjectMutation(project: ProjectFile): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onError(message: string): void;
}): SuiteDraftsHandle {
  const { shared, personal } = input;
  const [save, setSave] = useState<SaveState>();

  function draftFor(id: EvaluationSuiteId): EvaluationSuite | undefined {
    if (!personal.enabled) return undefined;
    return (personal.draftFor({ kind: "suite", id }) as WorkbenchSuiteDraftV1 | undefined)?.edited;
  }
  // The controller's revision changes whenever a record does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo(() => (shared ? withSuiteDrafts(shared, draftFor) : null), [shared, personal.enabled, personal.revision]);
  const draftSuiteIds = useMemo(
    () => new Set(shared?.evaluationSuites.filter(({ id }) => draftFor(id)).map(({ id }) => id) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shared, personal.enabled, personal.revision],
  );

  function adoptProjectMutation(next: ProjectFile): void {
    if (!personal.enabled || !shared || !view || next.projectId !== shared.projectId) {
      input.adoptProjectMutation(next);
      return;
    }
    const route = routeSuiteMutation(shared, view, next);
    if (route.shared) input.adoptProjectMutation(route.shared);
    for (const { base, edited } of route.drafts) personal.updateSuiteDraft(base, edited);
    for (const id of route.removed) void personal.discardDraft({ kind: "suite", id });
  }

  async function publish(suiteId: EvaluationSuiteId, overwrite: boolean): Promise<void> {
    setSave({ suiteId, saving: true });
    const outcome = await personal.publishSuiteDraft(suiteId, { overwrite });
    if (outcome.kind === "published") {
      setSave(undefined);
      return;
    }
    if (outcome.kind === "stale") {
      setSave({ suiteId, saving: false, stale: true, message: outcome.message });
      return;
    }
    setSave({ suiteId, saving: false, message: outcome.message });
    input.onError(outcome.message);
  }

  function discard(suiteId: EvaluationSuiteId, name: string): void {
    input.requestConfirmation({
      title: "Discard changes to this suite?",
      description: `Your unsaved changes to “${name}” are removed from this device. The saved suite stays as it is.`,
      confirmLabel: "Discard changes",
      destructive: true,
      onConfirm() {
        setSave(undefined);
        void personal.discardDraft({ kind: "suite", id: suiteId }).then((outcome) => {
          if (outcome?.kind === "blocked" || outcome?.kind === "failed") input.onError(outcome.message);
          else if (outcome?.kind === "conflict") input.onError("Another window changed this draft. Open Recovery to compare.");
        });
      },
    });
  }

  return {
    project: view,
    adoptProjectMutation,
    overlay(project) {
      return personal.enabled ? withSuiteDrafts(project, draftFor) : project;
    },
    draftSuiteIds,
    stateFor(suiteId) {
      if (!suiteId || !draftSuiteIds.has(suiteId)) return undefined;
      const name = view?.evaluationSuites.find(({ id }) => id === suiteId)?.name ?? "this suite";
      const current = save?.suiteId === suiteId ? save : undefined;
      return {
        kind: current?.stale ? "stale" : "draft",
        saving: current?.saving ?? false,
        ...(current?.message ? { message: current.message } : {}),
        onSave() { void publish(suiteId, false); },
        onOverwrite() { void publish(suiteId, true); },
        onDiscard() { discard(suiteId, name); },
      };
    },
  };
}
