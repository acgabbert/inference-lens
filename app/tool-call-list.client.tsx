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
                  (draft?.resolution.kind === "mock"
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
