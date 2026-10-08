"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { AppMode, ModeIndicator } from "../modes/app-mode";
import type { ToastRequest } from "../notifications/toast-queue.client";
import { finishedBatchToast, runsIndicator } from "./batch-completion";
import type { FinishedBatch, FinishedEvaluation } from "./batch-completion";

/** What this owner reads from a batch session: whether it runs, and what it holds. */
interface BatchSnapshot<Execution> {
  isRunning: boolean;
  execution?: Execution | undefined;
}

export interface UseBatchCompletionOptions {
  mode: AppMode;
  repeated: BatchSnapshot<{ plan: { experimentId: string } }>;
  evaluation: BatchSnapshot<FinishedEvaluation>;
  publishToast(request: ToastRequest): void;
  /** The toast's action. The page decides what showing the results means. */
  viewResults(): void;
}

/**
 * How a finished batch is signalled: the Runs dot and the completion toast.
 *
 * The page calls this hook after both batch sessions, because it reads their
 * snapshots, and hands `recordFinished` to their `onFinished`. It owns no
 * execution state and never switches modes itself.
 */
export interface BatchCompletion {
  /** Queues a batch for announcement once its result has committed. */
  recordFinished(batch: FinishedBatch): void;
  /** The Runs dot, or `undefined` when there is nothing to say. */
  indicator: ModeIndicator | undefined;
}

export function useBatchCompletion(options: UseBatchCompletionOptions): BatchCompletion {
  const { mode, repeated, evaluation } = options;
  const finishedBatchesRef = useRef<FinishedBatch[]>([]);
  const [finishedBatchCount, setFinishedBatchCount] = useState(0);
  // The batch the user has actually looked at in Runs. Without this a finished
  // batch is signalled only by the running dot disappearing, which is
  // indistinguishable from nothing having happened.
  const [viewedExperimentId, setViewedExperimentId] = useState<string>();

  const running = repeated.isRunning || evaluation.isRunning;
  const openExperimentId =
    evaluation.execution?.plan.experimentId ??
    repeated.execution?.plan.experimentId;
  // "Unread" is which batch was last seen, not a flag raised when one finishes.
  // A flag would have to be lowered by an effect and would re-raise itself
  // every time the user left Runs; identity cannot drift that way.
  //
  // Adjusted during render rather than in an effect, as the composer does for
  // its focus mode: while Runs is on screen and nothing is still running, what
  // it shows is by definition read, and the discarded state never reaches the
  // DOM.
  if (mode === "runs" && !running && openExperimentId !== viewedExperimentId) {
    setViewedExperimentId(openExperimentId);
  }
  const unread =
    Boolean(openExperimentId) && !running && openExperimentId !== viewedExperimentId;

  /**
   * Tells the user a batch they started has finished, and offers the one
   * click that gets them to it.
   *
   * This is the affordance the Runs mode was made conditional on: results no
   * longer appear in the pane the user was looking at, so a batch that finishes
   * while they are composing would otherwise be signalled only by a dot on the
   * mode strip. Nothing here is the sole carrier — the dot is still there, and
   * it does not expire — but the dot cannot interrupt and this can.
   *
   * Suppressed while Runs is already on screen: the results are being watched
   * live, and an action that navigates to where the user already is would be a
   * message about nothing.
   */
  const announceFinishedBatch = useEffectEvent((batch: FinishedBatch) => {
    if (mode === "runs") return;
    options.publishToast(finishedBatchToast(batch, evaluation.execution, {
      label: "View results",
      onSelect: options.viewResults,
    }));
  });
  // The counter is the trigger and the ref is the payload: draining the ref
  // rather than clearing state keeps this effect from scheduling a render of
  // its own, and makes a repeated invocation a no-op because the queue is
  // already empty by then.
  useEffect(() => {
    finishedBatchesRef.current.splice(0).forEach(announceFinishedBatch);
  }, [finishedBatchCount]);

  return {
    recordFinished(batch) {
      finishedBatchesRef.current.push(batch);
      setFinishedBatchCount((current) => current + 1);
    },
    indicator: runsIndicator({
      running,
      unread,
      ...(evaluation.execution ? { evaluation: evaluation.execution } : {}),
    }),
  };
}
