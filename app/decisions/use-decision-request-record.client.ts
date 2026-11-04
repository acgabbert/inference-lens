"use client";

import { useState } from "react";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { WorkbenchDecisionRequestContent } from "../../packages/core/src/personal-workbench.ts";
import type { DecisionRequestId, DecisionRequestRevisionId } from "../../packages/core/src/run-kernel/types.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";
import { decisionRevisionContent } from "../workbench/personal-workbench-controller.ts";
import type { PersonalWorkbenchHandle } from "../workbench/use-personal-workbench.client.ts";
import {
  decisionScratchNeedsName,
  selectedDecisionRecord,
  suggestedDecisionRequestName,
} from "./local-decision-request.ts";
import type { SelectedDecisionRecord } from "./local-decision-request.ts";

export type { SelectedDecisionRecord };

/**
 * Which record Decision Compose edits in a `personal` session: a clean saved
 * revision, its request draft, a scratch, or nothing yet
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 4 decisions"). Edits become
 * a draft or scratch update, Save publishes it, and a new request is a scratch
 * (Q2). Decision runs carry no request pin (D12), so there is no run identity
 * or branch here.
 *
 * Disabled in a legacy session or without a project: every caller then takes
 * today's path.
 */
export interface DecisionRequestRecordHandle {
  enabled: boolean;
  /** The personal workbench takes edits: loaded, or session-only. */
  ready: boolean;
  /** Undefined while disabled. */
  record: SelectedDecisionRecord | undefined;
  /** Whether Save will ask for a name: a scratch with no saved ancestor. */
  needsName: boolean;
  /** The name Save offers when it asks for one (Q2). */
  suggestedName: string;
  saving: boolean;
  /** Records valid content as a draft or scratch. False after reporting why not. */
  edit(content: WorkbenchDecisionRequestContent): boolean;
  /** Starts and selects a new local request with no parent (Q2). False after reporting why not. */
  startNew(content: WorkbenchDecisionRequestContent): boolean;
  /** Saves the selected draft or scratch. Resolves true once it landed. */
  save(name?: string): Promise<boolean>;
  discard(): Promise<void>;
  /** Selects a saved revision, as returning from a run or a prompt source does. */
  selectSaved(revisionId: DecisionRequestRevisionId): void;
}

type PersonalDecisionOwner = Pick<
  PersonalWorkbenchHandle,
  | "enabled" | "status" | "decisionSelection" | "scratch" | "draftById" | "selectDecision"
  | "updateDecisionRequestDraft" | "createDecisionScratch" | "updateDecisionScratch"
  | "discardDecisionRequestDraft" | "discardScratch" | "publishDecisionRequestDraft" | "publishScratch"
>;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The decision request could not be kept.";
}

export function useDecisionRequestRecord(input: {
  personal: PersonalDecisionOwner;
  project: ProjectFile | null;
  onError(message: string | undefined): void;
}): DecisionRequestRecordHandle {
  const { personal, project, onError } = input;
  const [saving, setSaving] = useState(false);
  // The prompt a scratch was started from names it even after a detach. Held
  // for this session only: the record format has no place for it.
  const [startedFrom, setStartedFrom] = useState<Readonly<Record<string, string>>>({});
  const enabled = personal.enabled && Boolean(project);
  const record = enabled && project ? selectedDecisionRecord(project, personal.decisionSelection, personal) : undefined;
  const needsName = record?.kind === "scratch" && decisionScratchNeedsName(record.scratch, personal);
  const suggestedName = (record?.kind === "scratch" && startedFrom[record.scratch.scratchId])
    || (project && record?.content ? suggestedDecisionRequestName(project, record.content) : "");

  function ready(): boolean {
    if (personal.status.kind === "ready" || personal.status.kind === "session") return true;
    onError(personal.status.kind === "blocked"
      ? personal.status.message
      : "Your personal workbench is still loading. Try again in a moment.");
    return false;
  }

  function startNew(content: WorkbenchDecisionRequestContent): boolean {
    if (!enabled || !ready()) return false;
    try {
      const scratch = personal.createDecisionScratch(content, {});
      if (!scratch) return false;
      if (project && content.kind === "template-use") {
        const name = suggestedDecisionRequestName(project, content);
        setStartedFrom((current) => ({ ...current, [scratch.scratchId]: name }));
      }
    } catch (error) {
      onError(message(error));
      return false;
    }
    return true;
  }

  return {
    enabled,
    ready: personal.status.kind === "ready" || personal.status.kind === "session",
    record,
    needsName,
    suggestedName,
    saving,
    edit(content) {
      if (!record || !ready()) return false;
      try {
        switch (record.kind) {
          case "none":
            return startNew(content);
          case "saved": {
            const draft = personal.updateDecisionRequestDraft(record.revision, content);
            if (!draft && !same(content, record.content)) {
              onError("An earlier save of this request needs review before it can be edited.");
              return false;
            }
            return true;
          }
          case "draft": {
            const base = record.revision ?? record.draft.base.snapshot;
            const draft = personal.updateDecisionRequestDraft(base, content, { draftId: record.draft.draftId });
            if (!draft && !same(content, decisionRevisionContent(record.draft.base.snapshot))) {
              onError("An earlier save of this request needs review before it can be edited.");
              return false;
            }
            return true;
          }
          case "scratch":
            personal.updateDecisionScratch(record.scratch.scratchId, content);
            return true;
        }
      } catch (error) {
        onError(message(error));
        return false;
      }
    },
    startNew,
    async save(name) {
      if (!record || record.kind === "saved" || record.kind === "none" || !ready()) return false;
      setSaving(true);
      try {
        const outcome = record.kind === "draft"
          ? await personal.publishDecisionRequestDraft(record.draft.asset.id as DecisionRequestId)
          : await personal.publishScratch(record.scratch.scratchId, name);
        if (outcome.kind !== "published") {
          onError(outcome.message);
          return false;
        }
        onError(undefined);
        return true;
      } finally {
        setSaving(false);
      }
    },
    async discard() {
      if (!record || record.kind === "saved" || record.kind === "none") return;
      const outcome = record.kind === "draft"
        ? await personal.discardDecisionRequestDraft(record.draft.asset.id as DecisionRequestId)
        : await personal.discardScratch(record.scratch.scratchId);
      if (outcome && outcome.kind !== "saved" && outcome.kind !== "deleted") {
        onError("message" in outcome ? outcome.message : "The local request could not be discarded.");
      }
    },
    selectSaved(revisionId) {
      personal.selectDecision({ kind: "saved-decision-request-revision", revisionId });
    },
  };
}
