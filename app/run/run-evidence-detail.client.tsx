"use client";

import { useMemo, useRef, useState } from "react";

import {
  transcriptFromRunState,
  type RunTrace,
} from "../../packages/core/src/run-kernel";
import { runStateFromTrace } from "../../packages/core/src/run-trace";
import { traceFileName } from "../../packages/core/src/run-trace";
import { ResponseOutput, type TraceStorageStatus } from "../response-output.client";
import { RunTracePanel, type ParentTraceState } from "../run-trace-panel.client";

/**
 * Reduces one immutable trace into the existing response and trace renderers
 * without adopting it into the live Compose session. Browsing evidence is
 * read-only: it cannot resume or retry a run, and the only way out of it is
 * the explicit Branch handoff.
 */
export function RunEvidenceDetail({
  trace,
  eyebrow,
  storage,
  onBranch,
  readTrace,
  onPromoteTrace,
}: {
  trace: RunTrace;
  eyebrow: string;
  storage: TraceStorageStatus;
  onBranch(trace: RunTrace): void;
  /** Reads a sibling trace from the project folder, for the parent diff. */
  readTrace?(fileName: string): Promise<RunTrace>;
  onPromoteTrace?(trace: RunTrace): void;
}) {
  const runState = useMemo(() => runStateFromTrace(trace), [trace]);
  const transcript = useMemo(() => transcriptFromRunState(runState), [runState]);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [traceOpen, setTraceOpen] = useState(false);
  const [parent, setParent] = useState<{ runId: RunTrace["runId"]; state: ParentTraceState }>();
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const attempts = runState.turns.flatMap((turn) => {
    const latest = turn.attempts.at(-1);
    return latest ? [latest] : [];
  });
  // Keyed by the trace it belongs to, so selecting another run never shows the
  // previous run's parent.
  const parentTrace = parent?.runId === trace.runId ? parent.state : { status: "idle" as const };

  async function loadParentTrace(): Promise<void> {
    const provenance = trace.branchedFrom;
    if (!provenance) return;
    const runId = trace.runId;
    if (!readTrace) {
      setParent({ runId, state: { status: "error", error: `Open the project folder that contains parent run ${provenance.runId}.` } });
      return;
    }
    setParent({ runId, state: { status: "loading" } });
    try {
      const loaded = await readTrace(traceFileName(provenance.runId));
      if (loaded.runId !== provenance.runId) throw new Error("The parent trace file contains a different run.");
      setParent((current) => current?.runId === runId ? { runId, state: { status: "ready", trace: loaded } } : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The trace could not be read.";
      setParent((current) => current?.runId === runId
        ? { runId, state: { status: "error", error: `The parent trace for ${provenance.runId} could not be read: ${message}` } }
        : current);
    }
  }

  return (
    <section className="result">
      <div className="run-evidence-actions">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <strong>{trace.input.target.model}</strong>
        </div>
        <button className="button primary" type="button" onClick={() => onBranch(trace)}>
          Branch from this run
        </button>
      </div>
      <ResponseOutput
        output={attempts.map((attempt) => attempt.text).join("")}
        reasoning={attempts.map((attempt) => attempt.reasoning).join("")}
        status={runState.status.kind === "completed" ? "complete" : "failed"}
        runState={runState}
        isRequestActive={false}
        markdownPreview={markdownPreview}
        outputFollowing
        outputScrollRef={outputScrollRef}
        completedToolCalls={attempts.flatMap((attempt) => attempt.completedToolCalls ?? [])}
        toolResultDrafts={{}}
        traceStorage={storage}
        transcript={transcript}
        nonBranchableMessageIds={new Set()}
        {...(trace.branchedFrom ? { branchedFrom: trace.branchedFrom } : {})}
        readOnly
        onMarkdownPreviewChange={setMarkdownPreview}
        onOutputScroll={() => {}}
        onJumpToLatest={() => {}}
        onToolResultDraftChange={() => {}}
        onContinue={() => {}}
        onRetry={() => {}}
        onDiscardFailedRun={() => {}}
        onSaveTrace={() => {}}
        onEditFromHere={() => {}}
        onEmptyStateAction={() => {}}
        emptyState={{
          headline: "Evidence unavailable",
          detail: "This saved trace does not contain a readable response.",
        }}
      />
      <RunTracePanel
        open={traceOpen}
        runState={runState}
        {...(trace.branchedFrom ? { branchedFrom: trace.branchedFrom } : {})}
        parentTrace={parentTrace}
        onLoadParentTrace={() => void loadParentTrace()}
        onOpenChange={setTraceOpen}
        {...(onPromoteTrace ? { onPromoteTrace } : {})}
      />
    </section>
  );
}
