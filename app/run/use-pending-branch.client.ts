"use client";

import { useRef, useState } from "react";

import type { TranscriptEntry } from "../../packages/core/src/run-kernel/transcript.ts";
import type {
  ConversationId,
  ConversationMessage,
  MessageId,
  RunState,
  RunTrace,
} from "../../packages/core/src/run-kernel/types.ts";
import type { TraceStorageStatus } from "../response-output.client.tsx";
import {
  branchFromSavedTrace,
  branchFromTranscript,
  nonBranchableMessageIds,
} from "./pending-branch.ts";
import type { BranchStart, PendingBranch } from "./pending-branch.ts";
import type {
  PrepareWorkbenchRunInput,
  PrepareWorkbenchRunResult,
} from "./prepare-workbench-run.client.ts";

export interface UsePendingBranchOptions {
  /** The live run, which "Edit from here" branches from. */
  runState: RunState | null;
  transcript: readonly TranscriptEntry[];
  traceStorage: TraceStorageStatus | null | undefined;
  /** Replaces the request draft with the branch's messages. */
  resetMessages(messages: ConversationMessage[]): void;
  onError(message: string): void;
}

/**
 * The branch the next run will start from, and the ad hoc conversation that
 * unsaved runs share.
 *
 * The page calls this hook after the run session, because it reads the live
 * run, and calls `clear` from the transactions that drop a branch: applying a
 * project draft, applying an n8n import, adopting a trace, and discarding from
 * the composer. It never navigates; its commands report whether a branch was
 * started.
 */
export interface PendingBranchHandle {
  pending: PendingBranch | undefined;
  /** Messages a branch may not start at; see `nonBranchableMessageIds`. */
  nonBranchableMessageIds: ReadonlySet<MessageId>;
  /** Branches at a message of the live run. `false` when it cannot. */
  editFromHere(messageId: MessageId): boolean;
  /** Branches after a saved trace's last message. `false` after reporting why not. */
  branchFromTrace(trace: RunTrace): boolean;
  clear(): void;
  /** What run preparation reads from this owner. */
  preparationInputs(): Pick<PrepareWorkbenchRunInput, "branchContext" | "adHocConversationId">;
  /**
   * Applies a successful preparation once its run is committed to: remembers
   * the ad hoc conversation and drops a branch the run consumed.
   */
  settle(prepared: Extract<PrepareWorkbenchRunResult, { ok: true }>): void;
}

export function usePendingBranch(options: UsePendingBranchOptions): PendingBranchHandle {
  const { runState, transcript, traceStorage, resetMessages, onError } = options;
  const adHocConversationIdRef = useRef<ConversationId | null>(null);
  const [pending, setPending] = useState<PendingBranch>();

  function begin(start: BranchStart): void {
    resetMessages(start.messages);
    setPending(start.branch);
  }

  return {
    pending,
    nonBranchableMessageIds: nonBranchableMessageIds(runState),
    editFromHere(messageId) {
      const start = branchFromTranscript({ runState, transcript, traceStorage, messageId });
      if (!start) return false;
      begin(start);
      return true;
    },
    branchFromTrace(trace) {
      const start = branchFromSavedTrace(trace);
      if (!start) {
        onError("This saved trace has no message to branch from.");
        return false;
      }
      begin(start);
      return true;
    },
    clear() { setPending(undefined); },
    preparationInputs() {
      return {
        ...(pending ? { branchContext: pending } : {}),
        ...(adHocConversationIdRef.current
          ? { adHocConversationId: adHocConversationIdRef.current }
          : {}),
      };
    },
    settle(prepared) {
      if (prepared.adHocConversationId) {
        adHocConversationIdRef.current = prepared.adHocConversationId;
      }
      if (prepared.consumesPendingBranch) setPending(undefined);
    },
  };
}
