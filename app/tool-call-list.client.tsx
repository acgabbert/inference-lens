"use client";

import type {
  ToolCall,
  ToolExecutionRecord,
  ToolResult,
} from "../packages/core/src/run-kernel";
import {
  describeToolExecution,
  latestToolExecution,
} from "./tool-execution-format.client";

export type ToolResultDraft = {
  text: string;
  resolution: ToolResult["resolution"];
  /** Set when continuing will run an executor rather than send this text. */
  pendingExecutorLabel?: string;
};

interface ToolCallListProps {
  calls: ToolCall[];
  toolResultDrafts: Record<string, ToolResultDraft>;
  suppliedResults: ToolResult[];
  toolExecutions: ToolExecutionRecord[];
  awaitingResults: boolean;
  onDraftChange(callId: string, text: string): void;
  onContinue(): void;
}

/** Displays completed calls and collects any manual tool results. */
export function ToolCallList({
  calls,
  toolResultDrafts,
  suppliedResults,
  toolExecutions,
  awaitingResults,
  onDraftChange,
  onContinue,
}: ToolCallListProps) {
  if (calls.length === 0) return null;

  return (
    <div className="tool-call-list">
      {calls.map((call) => {
        const draft = toolResultDrafts[call.id];
        const supplied = suppliedResults.find(
          ({ toolCallId }) => toolCallId === call.id,
        );
        const execution = latestToolExecution(toolExecutions, call.id);
        const provenance = execution
          ? describeToolExecution(execution)
          : undefined;
        return (
          <article className="tool-call-card" key={call.id}>
            <div className="tool-call-heading">
              <div>
                <span className="eyebrow">Tool call</span>
                <h3>{call.name}</h3>
              </div>
              <span className="provider-pill">
                {provenance?.pill ??
                  (draft?.pendingExecutorLabel
                    ? "Command tool"
                    : draft?.resolution.kind === "mock"
                      ? "Static mock"
                      : supplied?.resolution.kind ?? "Manual")}
              </span>
            </div>
            <label>
              Arguments
              <pre>{call.arguments.text || "{}"}</pre>
            </label>
            {draft ? (
              <label>
                Result
                <textarea
                  value={draft.text}
                  onChange={(event) => onDraftChange(call.id, event.target.value)}
                />
              </label>
            ) : supplied ? (
              <label>
                Result
                <pre>{supplied.content.map(({ text }) => text).join("")}</pre>
              </label>
            ) : null}
            {/*
              An executor with a transport has nothing to prefill, so without
              this the card is indistinguishable from a call waiting on a
              human. Said before the run, not after: it is also the last point
              at which the user can decide not to run it.
            */}
            {!provenance && draft?.pendingExecutorLabel && (
              <p className="tool-call-pending-executor">
                Continuing runs the command tool “{draft.pendingExecutorLabel}”
                on this device. Type a result above to answer this call by hand
                instead.
              </p>
            )}
            {provenance && (
              <p className="tool-call-provenance">{provenance.detail}</p>
            )}
            {provenance?.projectionNote && (
              <p className="tool-call-projection">{provenance.projectionNote}</p>
            )}
          </article>
        );
      })}
      {awaitingResults && (
        <button
          className="button primary continue-tool-run"
          type="button"
          onClick={onContinue}
        >
          Supply results and continue
        </button>
      )}
    </div>
  );
}
