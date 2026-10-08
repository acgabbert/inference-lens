import { runStateFromTrace } from "../../packages/core/src/run-trace.ts";
import { transcriptFromRunState } from "../../packages/core/src/run-kernel/transcript.ts";
import type { TranscriptEntry } from "../../packages/core/src/run-kernel/transcript.ts";
import type {
  ConversationMessage,
  MessageId,
  RunState,
  RunTrace,
} from "../../packages/core/src/run-kernel/types.ts";
import type { TraceStorageStatus } from "../response-output.client.tsx";
import type { WorkbenchBranchContext } from "./prepare-workbench-run.client.ts";

/**
 * A branch the next run will record as its provenance.
 *
 * `parentTraceNeedsSaving` is presentation only: the composer offers to save
 * the parent so the branch's provenance points at a trace that still exists.
 */
export interface PendingBranch extends WorkbenchBranchContext {
  parentTraceNeedsSaving: boolean;
}

/** The draft a branch starts from, and the branch itself. */
export interface BranchStart {
  messages: ConversationMessage[];
  branch: PendingBranch;
}

const BRANCHABLE_STATUSES: ReadonlySet<RunState["status"]["kind"]> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * Starts a branch at one message of the live run's transcript.
 *
 * Only a run that has stopped can be branched; `undefined` otherwise, or when
 * the message is not in the transcript. The draft is the transcript up to and
 * including that message, cloned so editing it cannot reach the run's state.
 */
export function branchFromTranscript(input: {
  runState: RunState | null;
  transcript: readonly TranscriptEntry[];
  traceStorage: Pick<TraceStorageStatus, "kind"> | null | undefined;
  messageId: MessageId;
}): BranchStart | undefined {
  const { runState, transcript, traceStorage, messageId } = input;
  if (!runState || !BRANCHABLE_STATUSES.has(runState.status.kind)) return;
  const index = transcript.findIndex(({ message }) => message.id === messageId);
  if (index < 0) return;
  return {
    messages: structuredClone(
      transcript.slice(0, index + 1).map(({ message }) => message),
    ),
    branch: {
      parentRunId: runState.runId,
      parentConversationRevisionId: runState.input?.conversationRevisionId,
      branchMessageId: messageId,
      parentTraceNeedsSaving:
        traceStorage?.kind === "unsaved" || traceStorage?.kind === "error",
    },
  };
}

/**
 * Starts a branch after the last message of a saved trace.
 *
 * `undefined` when the trace has no message to branch from. A saved trace's
 * parent is already on disk, so it never needs saving.
 */
export function branchFromSavedTrace(trace: RunTrace): BranchStart | undefined {
  const transcript = transcriptFromRunState(runStateFromTrace(trace));
  const branchMessage = transcript.at(-1)?.message;
  if (!branchMessage) return;
  return {
    messages: structuredClone(transcript.map(({ message }) => message)),
    branch: {
      parentRunId: trace.runId,
      parentConversationRevisionId: trace.input.conversationRevisionId,
      branchMessageId: branchMessage.id,
      parentTraceNeedsSaving: false,
    },
  };
}

/**
 * Messages inside a message-set template's output, which is atomic: a branch
 * may follow its final message but not split it.
 */
export function nonBranchableMessageIds(runState: RunState | null): Set<MessageId> {
  return new Set(
    runState?.input?.templateResolutions.flatMap((resolution) =>
      resolution.outputMessageIds.slice(0, -1),
    ) ?? [],
  );
}
