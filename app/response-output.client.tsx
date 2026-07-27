"use client";

import type { RefObject } from "react";
import type {
  ConversationMessage,
  RunState,
  RunTrace,
  ToolCall,
} from "../packages/core/src/run-kernel";
import { MarkdownView } from "./markdown-view.client";
import { PaneTabs } from "./workbench-shell.client";
import { ToolCallList, type ToolResultDraft } from "./tool-call-list.client";

export type TraceStorageStatus =
  | { kind: "saving"; location?: string }
  | { kind: "saved"; location: string }
  | { kind: "downloaded"; fileName: string }
  | { kind: "loaded"; fileName: string }
  | { kind: "unsaved" }
  | { kind: "error"; message: string };

type ResponseOutputProps = {
  output: string;
  reasoning: string;
  status: string;
  runState: RunState | null;
  isRequestActive: boolean;
  markdownPreview: boolean;
  outputFollowing: boolean;
  outputScrollRef: RefObject<HTMLDivElement | null>;
  completedToolCalls: ToolCall[];
  toolResultDrafts: Record<string, ToolResultDraft>;
  traceStorage: TraceStorageStatus | null;
  transcript: ConversationMessage[];
  nonBranchableMessageIds: ReadonlySet<ConversationMessage["id"]>;
  branchedFrom?: RunTrace["branchedFrom"];
  onMarkdownPreviewChange(markdown: boolean): void;
  onOutputScroll(): void;
  onJumpToLatest(): void;
  onToolResultDraftChange(callId: string, text: string): void;
  onContinue(): void;
  onRetry(): void;
  onSaveTrace(): void;
  onEditFromHere(messageId: ConversationMessage["id"]): void;
};

/** The response pane, excluding the independent trace panel below it. */
export function ResponseOutput({
  output, reasoning, status, runState, isRequestActive, markdownPreview,
  outputFollowing, outputScrollRef, completedToolCalls, toolResultDrafts,
  traceStorage,
  transcript, nonBranchableMessageIds, branchedFrom,
  onMarkdownPreviewChange, onOutputScroll, onJumpToLatest,
  onToolResultDraftChange, onContinue, onRetry,
  onSaveTrace, onEditFromHere,
}: ResponseOutputProps) {
  const awaitingResults = runState?.status.kind === "awaiting_tool_results";
  const retryableFailure =
    runState?.status.kind === "paused" &&
    runState.status.reason === "attempt_failed"
      ? runState.status
      : undefined;
  const terminal = Boolean(
    runState && ["completed", "cancelled", "failed"].includes(runState.status.kind),
  );
  return (
    <>
      <div className="panel-header result-header">
        <div><span className="eyebrow">Response</span><h2>Live output</h2></div>
        <div className="result-header-controls">
          <PaneTabs label="Output rendering" value={markdownPreview ? "markdown" : "raw"}
            onChange={(value) => onMarkdownPreviewChange(value === "markdown")}
            tabs={[{ id: "markdown", label: "Markdown" }, { id: "raw", label: "Raw" }]} />
          <span className={`status ${status}`}><span aria-hidden="true" />{status}</span>
        </div>
      </div>
      {traceStorage && (
        <div
          className={`trace-storage trace-storage-${traceStorage.kind}`}
          role={traceStorage.kind === "error" ? "alert" : "status"}
        >
          <span className="trace-storage-icon" aria-hidden="true">
            {traceStorage.kind === "saved" ||
            traceStorage.kind === "downloaded" ||
            traceStorage.kind === "loaded"
              ? "✓"
              : traceStorage.kind === "error"
                ? "!"
                : "·"}
          </span>
          <span className="trace-storage-copy">
            {traceStorage.kind === "saving" ? (
              <>
                <strong>Saving run trace…</strong>
                {traceStorage.location && <code>{traceStorage.location}</code>}
              </>
            ) : traceStorage.kind === "saved" ? (
              <>
                <strong>Run trace saved</strong>
                <code>{traceStorage.location}</code>
              </>
            ) : traceStorage.kind === "downloaded" ? (
              <>
                <strong>Run trace download requested</strong>
                <span>
                  {traceStorage.fileName} · your browser controls the download
                  location
                </span>
              </>
            ) : traceStorage.kind === "loaded" ? (
              <>
                <strong>Imported run trace</strong>
                <code>{traceStorage.fileName}</code>
              </>
            ) : traceStorage.kind === "error" ? (
              <>
                <strong>Run trace not saved</strong>
                <span>{traceStorage.message}</span>
              </>
            ) : (
              <>
                <strong>Run trace not saved</strong>
                <span>No project folder was open for this run.</span>
              </>
            )}
          </span>
          {(traceStorage.kind === "unsaved" ||
            traceStorage.kind === "error") && (
            <button
              className="button secondary trace-storage-action"
              type="button"
              onClick={onSaveTrace}
            >
              Save trace…
            </button>
          )}
        </div>
      )}
      {terminal && branchedFrom && (
        <p className="branch-provenance" role="status">
          Branched from run <code>{branchedFrom.runId}</code>.
        </p>
      )}
      <div className="output-scroll" ref={outputScrollRef} onScroll={onOutputScroll}>
        {terminal ? (
          <div className="transcript-list" aria-label="Run transcript">
            {transcript.map((message, index) => (
              <article className="transcript-message" key={message.id}>
                <div className="transcript-message-header">
                  <span className="eyebrow">{message.role}</span>
                  <span>Message {index + 1}</span>
                  <button
                    className="button secondary transcript-edit"
                    type="button"
                    disabled={nonBranchableMessageIds.has(message.id)}
                    title={
                      nonBranchableMessageIds.has(message.id)
                        ? "A message-set template is atomic. Branch after its final message or detach it first."
                        : undefined
                    }
                    onClick={() => onEditFromHere(message.id)}
                  >
                    Edit from here
                  </button>
                </div>
                {/* The rendering toggle governs model output, so it follows
                    the answer into the finished transcript. Authored and tool
                    messages stay verbatim: reformatting text the user typed,
                    or a tool's JSON, would misrepresent what was sent. */}
                {message.content.map((part, partIndex) =>
                  markdownPreview && message.role === "assistant" ? (
                    <MarkdownView key={partIndex} text={part.text} />
                  ) : (
                    <p key={partIndex}>{part.text}</p>
                  ),
                )}
                {message.role === "assistant" && message.toolCalls?.map((call) => (
                  <pre className="transcript-tool-call" key={call.id}>
                    {call.name}({call.arguments.text})
                  </pre>
                ))}
                {message.role === "tool" && (
                  <span className="transcript-tool-result">Tool result for {message.name ?? message.toolCallId}</span>
                )}
              </article>
            ))}
          </div>
        ) : <div className="output">
          {output ? (markdownPreview ? <MarkdownView text={output} /> : <p>{output}</p>)
            : reasoning ? <div className="waiting-for-answer" aria-live="polite"><span className="reasoning-dot" aria-hidden="true" /><div><h3>Thinking…</h3><p>Reasoning is streaming. The final answer will appear here.</p></div></div>
            : isRequestActive ? <div className="waiting-for-answer" role="status"><span className="reasoning-dot" aria-hidden="true" /><div><h3>Waiting for response…</h3><p>Request sent. The response will stream here.</p></div></div>
            : awaitingResults ? <div className="waiting-for-answer"><span className="reasoning-dot complete" aria-hidden="true" /><div><h3>Tool result needed</h3><p>Review the call below, supply its result, then continue.</p></div></div>
            : retryableFailure ? <div className="waiting-for-answer run-failure-state" role="alert"><span className="failure-glyph" aria-hidden="true">!</span><div><h3>Attempt failed</h3><p>{retryableFailure.error.message}</p><button className="button secondary" type="button" onClick={onRetry}>Retry attempt</button></div></div>
            : runState?.status.kind === "failed" ? <div className="waiting-for-answer run-failure-state" role="alert"><span className="failure-glyph" aria-hidden="true">!</span><div><h3>Request failed</h3><p>{runState.status.error.message}</p></div></div>
            : runState?.status.kind === "cancelled" ? <div className="waiting-for-answer"><span className="failure-glyph muted" aria-hidden="true">×</span><div><h3>Request stopped</h3><p>{runState.status.reason}</p></div></div>
            : <div className="empty-state"><span className="empty-glyph" aria-hidden="true">↗</span><h3>Ready when you are</h3><p>Add an API key, check your request, then run it to see the streamed response here.</p></div>}
          {reasoning && <details className="reasoning-stream"><summary><span className={status === "running" ? "reasoning-dot" : "reasoning-dot complete"} aria-hidden="true" /><span>{status === "running" ? "Thinking…" : "Reasoning"}</span><span className="reasoning-stream-hint">Show</span></summary><p>{reasoning}</p></details>}
          {(output || reasoning) && retryableFailure && <div className="waiting-for-answer run-failure-state" role="alert"><span className="failure-glyph" aria-hidden="true">!</span><div><h3>Attempt failed</h3><p>{retryableFailure.error.message}</p><button className="button secondary" type="button" onClick={onRetry}>Retry attempt</button></div></div>}
        </div>}
        {!terminal && <ToolCallList calls={completedToolCalls} toolResultDrafts={toolResultDrafts}
          suppliedResults={runState?.toolResults ?? []} awaitingResults={awaitingResults}
          onDraftChange={onToolResultDraftChange} onContinue={onContinue} />}
        {!outputFollowing && (output || reasoning) && <button className="jump-to-latest" type="button" onClick={onJumpToLatest}>Jump to latest ↓</button>}
      </div>
    </>
  );
}
