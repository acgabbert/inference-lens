"use client";

import { useState } from "react";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { ToolId } from "../../packages/core/src/run-kernel/types.ts";
import { setLaunchDefaults } from "../../packages/core/src/workbench-local-input.ts";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client.tsx";
import type { PersonalWorkbenchHandle } from "../workbench/use-personal-workbench.client.ts";
import {
  chatLaunchDifferences,
  chatExecutionAfterLaunchSave,
  effectiveChatExecution,
  patchChatExecution,
} from "./chat-execution.ts";
import type {
  ChatExecutionPatch,
  ChatSelectionForLaunch,
  EffectiveChatExecution,
  LaunchDefaultDifference,
} from "./chat-execution.ts";
import type { SelectedChatRecord } from "./local-chat-request.ts";

/**
 * A personal session's chat execution choices and the chat launch-default
 * action (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 5 decisions"). Model,
 * temperature, protocol, tool-enable and environment choices become sparse
 * overrides in `selections.json` (T2); "Use as launch default" copies the
 * selected saved revision and the execution into `defaults` in one shared
 * write (D13, T3). Disabled in a legacy session or without a project: every
 * caller then takes today's path.
 */
export interface ChatExecutionHandle {
  enabled: boolean;
  /** Undefined while disabled. */
  execution: EffectiveChatExecution | undefined;
  /**
   * The tool selection as recorded, not filtered by the saved project's
   * tools: a tool attached a moment ago reaches the project at its next save.
   */
  enabledToolIds: ToolId[] | undefined;
  patch(patch: ChatExecutionPatch): void;
  /** Where the selection differs from the launch default (T4); empty while disabled. */
  differences: LaunchDefaultDifference[];
  /** Why "Use as launch default" is unavailable now (T3). */
  launchDefaultBlockedReason: string | undefined;
  saving: boolean;
  /** Previews, then writes the launch default. */
  useAsLaunchDefault(): void;
}

type PersonalExecutionOwner = Pick<
  PersonalWorkbenchHandle,
  "enabled" | "status" | "chatExecution" | "updateChatExecution" | "writeLaunchDefaults"
>;

function selectionForLaunch(record: SelectedChatRecord): ChatSelectionForLaunch | undefined {
  switch (record.kind) {
    case "saved": return record.revision ? { kind: "saved", revisionId: record.revision.id } : undefined;
    case "draft": return { kind: "local", baseRevisionId: record.draft.base.revisionId };
    case "scratch": return { kind: "local" };
  }
}

export function useChatExecution(input: {
  personal: PersonalExecutionOwner;
  project: ProjectFile | null;
  record: SelectedChatRecord | undefined;
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onError(message: string | undefined): void;
}): ChatExecutionHandle {
  const { personal, project, record } = input;
  const [saving, setSaving] = useState(false);
  const enabled = personal.enabled && Boolean(project);
  const overrides = personal.chatExecution;
  const execution = enabled && project ? effectiveChatExecution(project, overrides) : undefined;
  const enabledToolIds = enabled && project ? [...(overrides?.enabledToolIds ?? project.defaults.enabledToolIds)] : undefined;
  const selection = record && selectionForLaunch(record);
  const differences = project && execution && selection ? chatLaunchDifferences(project, selection, execution) : [];
  const launchDefaultBlockedReason = !enabled
    ? undefined
    : selection?.kind === "local"
      ? "Save the request first to use it as the launch default."
      : !selection
        ? "The selected request no longer exists."
        : saving
          ? "The launch default is being saved."
          : undefined;

  return {
    enabled,
    execution,
    enabledToolIds,
    patch(patch) {
      if (!enabled || !project) return;
      personal.updateChatExecution((current) => patchChatExecution(project, current, patch));
    },
    differences,
    launchDefaultBlockedReason,
    saving,
    useAsLaunchDefault() {
      if (!project || !execution || selection?.kind !== "saved" || launchDefaultBlockedReason) return;
      const revisionId = selection.revisionId;
      const capturedOverrides = structuredClone(overrides);
      const target = structuredClone(execution.target);
      const options = structuredClone(execution.options);
      const toolIds = [...execution.enabledToolIds];
      input.requestConfirmation({
        title: "Use as project launch default?",
        description: "Teammates and the CLI will run this request with these settings. Environment keeps its own project default.",
        details: differences.map(({ label, from, to }) => ({ label, value: `${from} → ${to}` })),
        confirmLabel: "Use as launch default",
        onConfirm() {
          setSaving(true);
          void personal.writeLaunchDefaults((current) => {
            const known = new Set(current.tools.map(({ id }) => id));
            return setLaunchDefaults(current, {
              chat: { revisionId, target, options, enabledToolIds: toolIds.filter((id) => known.has(id)) },
            });
          }).then((outcome) => {
            if (outcome.kind !== "confirmed") {
              input.onError(outcome.message || "The launch default could not be saved.");
              return;
            }
            // Clear published fields, rebasing newer edits onto the confirmed defaults.
            personal.updateChatExecution((current) =>
              chatExecutionAfterLaunchSave(project, outcome.project, capturedOverrides, current));
            input.onError(undefined);
          }, (error: unknown) => {
            input.onError(error instanceof Error ? error.message : "The launch default could not be saved.");
          }).finally(() => setSaving(false));
        },
      });
    },
  };
}
