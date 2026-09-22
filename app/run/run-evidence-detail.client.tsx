"use client";

import { useMemo, useRef, useState } from "react";

import {
  transcriptFromRunState,
  type RunTrace,
} from "../../packages/core/src/run-kernel";
import { runStateFromTrace } from "../../packages/core/src/run-trace";
import { ResponseOutput } from "../response-output.client";

/**
 * Reduces one immutable trace into the existing response renderer without
 * adopting it into the live Compose session. All callbacks are intentionally
 * inert: browsing evidence is read-only and cannot branch or resume a run.
 */
export function RunEvidenceDetail({
  trace,
  fileName,
  onBranch,
}: {
  trace: RunTrace;
  fileName: string;
  onBranch(trace: RunTrace): void;
}) {
  const runState = useMemo(() => runStateFromTrace(trace), [trace]);
  const transcript = useMemo(() => transcriptFromRunState(runState), [runState]);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const attempts = runState.turns.flatMap((turn) => {
    const latest = turn.attempts.at(-1);
    return latest ? [latest] : [];
  });

  return (
    <section className="result">
      <div className="run-evidence-actions">
        <div>
          <span className="eyebrow">Saved evidence</span>
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
        traceStorage={{ kind: "saved", location: fileName }}
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
    </section>
  );
}
