"use client";

import { useEffect, useRef, useState } from "react";
import type { CredentialSelection, DecisionTransport } from "../../packages/contracts/src";
import type { DecisionExecution, DecisionRun, ResolvedDecisionRunInput, ResolvedDecisionTarget } from "../../packages/core/src/decision";
import {
  beginDecisionAttempt,
  createDecisionRun,
  decisionRetryWaitMs,
  driveDecisionAttempt,
  retryDecisionRun,
  stopDecisionRun,
} from "../../packages/core/src/decision-run";
import { decisionRunFromTrace, decisionRunTrace } from "../../packages/core/src/decision-trace";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace";
import { isTerminalRunStatus } from "../../packages/core/src/run-kernel";
import { exportRunTraceFile, runTraceWorkspaceLocation, runTraceWorkspacePath, saveRunTraceWorkspace } from "../project-workspace.client";
import type { ProjectWorkspaceHandle } from "../project-workspace.client";
import type { TraceStorageStatus } from "../response-output.client";
import type { TraceOrigin } from "../run/use-run-session.client";

export interface DecisionSessionStartContext {
  workspace: ProjectWorkspaceHandle | null;
}

/**
 * Ports invoked only from commands or their asynchronous work, never during
 * render. No callback identity is required to be stable.
 */
export interface UseDecisionSessionOptions {
  transport: DecisionTransport;
  /** For the run's frozen target, so a retry never follows a changed selection. */
  prepareCredential(target: ResolvedDecisionTarget): Promise<CredentialSelection>;
  /** Synchronous in start and retry. */
  onShowResponse(): void;
  /** After an autosave succeeds; may arrive after another run has become visible. */
  onTraceSaved(): void;
  /** A failure outside the run itself, such as a transition that could not apply. */
  onError(message: string): void;
}

/**
 * The decision kind's one live run (D29). Snapshots describe this render;
 * commands own invalidation and persistence. The transitions themselves are
 * core's (D27); this hook keeps only React state, refs, persistence, and the
 * D23 wait. Not a serialized project, trace, or provider contract.
 */
export interface DecisionSessionHandle {
  /** Live or opened; paused per D28. */
  run: DecisionRun | null;
  /** An attempt is in flight (D24). A paused run is not executing. */
  executing: boolean;
  /** Epoch ms when Retry may run after a 429 (D23); absent once it may. */
  retryAvailableAt?: number;
  traceStorage: TraceStorageStatus | null;
  traceWorkspace: ProjectWorkspaceHandle | null;
  /** Freezes the input; aborts and supersedes any prior run. */
  start(input: ResolvedDecisionRunInput, context: DecisionSessionStartContext): Promise<void>;
  /** Acts only on a live paused run whose wait is over; otherwise a no-op. */
  retry(): Promise<void>;
  /** Idempotent: executing → cancelled, paused → failed. */
  stop(): void;
  /** Stops and clears the run. */
  reset(): void;
  /** Exports only a finished run; failures are surfaced through traceStorage. */
  exportTrace(): Promise<void>;
  /** Requires a validated trace; invalidates live work before adopting it. */
  adoptTrace(trace: DecisionRunTrace, origin: TraceOrigin): void;
}

function isFinished(run: DecisionRun | null): run is DecisionRun {
  return Boolean(run && isTerminalRunStatus(run.status));
}

function traceFor(run: DecisionRun | null): DecisionRunTrace | undefined {
  if (!isFinished(run)) return undefined;
  try { return decisionRunTrace(run); } catch { return undefined; }
}

export function useDecisionSession(options: UseDecisionSessionOptions): DecisionSessionHandle {
  const [run, setRun] = useState<DecisionRun | null>(null);
  const [executing, setExecuting] = useState(false);
  const [retryAvailableAt, setRetryAvailableAt] = useState<number>();
  const [traceStorage, setTraceStorage] = useState<TraceStorageStatus | null>(null);
  const runRef = useRef<DecisionRun | null>(null);
  const retryAvailableAtRef = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const [traceWorkspace, setTraceWorkspace] = useState<ProjectWorkspaceHandle | null>(null);
  const workspaceRef = useRef<ProjectWorkspaceHandle | null>(null);
  const persistedRunIdsRef = useRef(new Set<string>());

  function setRetryWait(at: number | undefined): void {
    retryAvailableAtRef.current = at;
    setRetryAvailableAt(at);
  }

  // The countdown is session state, never trace content (D23). Clearing it
  // when the wait is over re-renders Retry as available.
  useEffect(() => {
    if (retryAvailableAt === undefined) return;
    const timer = setTimeout(() => setRetryWait(undefined), Math.max(0, retryAvailableAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAvailableAt]);

  function replaceRun(next: DecisionRun | null): void {
    const previous = runRef.current;
    runRef.current = next;
    setRun(next);
    if (next?.status.kind === "paused") {
      // The wait starts when the paused attempt's 429 arrives, which is now.
      if (previous?.status.kind !== "paused") {
        const now = Date.now();
        const wait = decisionRetryWaitMs(next, now);
        setRetryWait(wait === undefined ? undefined : now + wait);
      }
    } else {
      setRetryWait(undefined);
    }
    if (!next) { setTraceStorage(null); return; }
    if (!isFinished(next)) return;
    const workspace = workspaceRef.current;
    if (!workspace) { setTraceStorage({ kind: "unsaved" }); return; }
    if (persistedRunIdsRef.current.has(next.runId)) return;
    const trace = traceFor(next);
    if (!trace) return;
    const saved = { kind: "decision", trace } as const;
    const location = runTraceWorkspaceLocation(workspace, saved);
    setTraceStorage({ kind: "saving", location });
    persistedRunIdsRef.current.add(next.runId);
    void saveRunTraceWorkspace(workspace, saved).then(() => {
      if (runRef.current?.runId === next.runId) setTraceStorage({ kind: "saved", location });
      options.onTraceSaved();
    }).catch((error) => {
      persistedRunIdsRef.current.delete(next.runId);
      if (runRef.current?.runId === next.runId) setTraceStorage({ kind: "error", message: error instanceof Error ? error.message : "The project trace could not be saved." });
    });
  }

  async function drive(started: DecisionRun, execution: DecisionExecution): Promise<void> {
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController(); abortRef.current = controller;
    replaceRun(started);
    options.onShowResponse(); setExecuting(true);
    try {
      await driveDecisionAttempt({
        run: started,
        execution,
        signal: controller.signal,
        isCurrent: () => generationRef.current === generation,
        onRunChange: replaceRun,
        async open(execution, signal) {
          const credential = await options.prepareCredential(execution.input.target);
          const stream = await options.transport.executeDecision({ execution, credential }, signal);
          return stream.events;
        },
      });
    } catch (error) {
      if (generationRef.current === generation) options.onError(error instanceof Error ? error.message : "The decision run could not continue.");
    } finally {
      if (generationRef.current === generation) { abortRef.current = null; setExecuting(false); }
    }
  }

  async function start(input: ResolvedDecisionRunInput, context: DecisionSessionStartContext): Promise<void> {
    workspaceRef.current = context.workspace; setTraceWorkspace(context.workspace);
    setTraceStorage(null);
    const begun = beginDecisionAttempt(createDecisionRun(input), new Date().toISOString());
    await drive(begun.run, begun.execution);
  }

  async function retry(): Promise<void> {
    const current = runRef.current;
    if (current?.status.kind !== "paused") return;
    const waitUntil = retryAvailableAtRef.current;
    if (waitUntil !== undefined && Date.now() < waitUntil) return;
    const next = retryDecisionRun(current, new Date().toISOString());
    await drive(next.run, next.execution);
  }

  function stop(): void {
    const controller = abortRef.current;
    generationRef.current += 1;
    abortRef.current = null;
    controller?.abort();
    setExecuting(false);
    const current = runRef.current;
    if (current && (current.status.kind === "running" || current.status.kind === "paused")) {
      replaceRun(stopDecisionRun(current, new Date().toISOString()));
    }
  }

  function reset(): void { stop(); replaceRun(null); }

  async function exportTrace(): Promise<void> {
    const trace = traceFor(runRef.current);
    if (!trace) return;
    const previous = traceStorage;
    const preserve = previous?.kind === "saved" && Boolean(workspaceRef.current);
    setTraceStorage({ kind: "saving" });
    try {
      const result = await exportRunTraceFile({ kind: "decision", trace });
      setTraceStorage(
        result.kind === "saved" ? (preserve ? previous! : { kind: "saved", location: result.location })
          : result.kind === "downloaded" ? (preserve ? previous! : { kind: "downloaded", fileName: result.fileName })
            : previous ?? { kind: "unsaved" },
      );
    } catch (error) {
      setTraceStorage({ kind: "error", message: error instanceof Error ? error.message : "The trace could not be saved." });
    }
  }

  function adoptTrace(trace: DecisionRunTrace, origin: TraceOrigin): void {
    stop();
    workspaceRef.current = origin.workspace; setTraceWorkspace(origin.workspace);
    if (origin.workspace) persistedRunIdsRef.current.add(trace.runId);
    replaceRun(decisionRunFromTrace(trace));
    setTraceStorage(origin.workspace
      ? { kind: "saved", location: runTraceWorkspacePath(origin.workspace, origin.fileName) }
      : { kind: "loaded", fileName: origin.fileName });
  }

  return { traceWorkspace, run, executing, retryAvailableAt, traceStorage, start, retry, stop, reset, exportTrace, adoptTrace };
}
