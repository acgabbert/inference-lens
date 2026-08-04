"use client";

import { useState, type RefObject } from "react";
import type {
  ConversationMessage,
  RunState,
  RunTrace,
  ToolCall,
  TranscriptEntry,
} from "../packages/core/src/run-kernel";
import { MarkdownView } from "./markdown-view.client";
import { PaneTabs } from "./workbench-shell.client";
import { ToolCallList, type ToolResultDraft } from "./tool-call-list.client";
import { describeSuppliedToolResult, latestToolExecution } from "./tool-execution-format.client";
import type { RunEmptyStatePresentation } from "./run-readiness.client";

/** System and user messages are usually re-reads of what was already typed;
 *  assistant and tool messages carry the outcome being inspected. */
function startsExpanded(role: ConversationMessage["role"]): boolean {
  return role !== "system" && role !== "user";
}

function previewText(message: ConversationMessage): string {
  return message.content.map((part) => part.text).join(" ");
}

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
  transcript: TranscriptEntry[];
  nonBranchableMessageIds: ReadonlySet<ConversationMessage["id"]>;
  branchedFrom?: RunTrace["branchedFrom"];
  emptyState: RunEmptyStatePresentation;
  onMarkdownPreviewChange(markdown: boolean): void;
  onOutputScroll(): void;
  onJumpToLatest(): void;
  onToolResultDraftChange(callId: string, text: string): void;
  onContinue(): void;
  onRetry(): void;
  /**
   * Abandons a failed attempt and returns the composer to idle. Destructive,
   * so it renders on the failure card next to the error that justifies it
   * rather than in the topbar beside the control a user clicks by reflex.
   */
  onDiscardFailedRun(): void;
  onSaveTrace(): void;
  onEditFromHere(messageId: ConversationMessage["id"]): void;
  onEmptyStateAction(): void;
};

/**
 * A failed attempt and everything that can be done about it, in one place.
 *
 * Both actions used to live in the topbar, where `Discard failed run` sat one
 * button away from `Retry` — a destructive action beside the control the user
 * reaches for by reflex, and neither of them next to the error message that
 * explains which one to pick. Retry leads; discarding is offered as a text
 * button, because it throws the attempt away.
 */
function RunFailureCard({
  message,
  onRetry,
  onDiscard,
}: {
  message: string;
  onRetry(): void;
  onDiscard(): void;
}) {
  return (
    <div className="waiting-for-answer run-failure-state" role="alert">
      <span className="failure-glyph" aria-hidden="true">!</span>
      <div>
        <h3>Attempt failed</h3>
        <p>{message}</p>
        <div className="run-failure-actions">
          <button className="button primary" type="button" onClick={onRetry}>
            Retry attempt <span className="shortcut">⌘↵</span>
          </button>
          <button className="text-button" type="button" onClick={onDiscard}>
            Discard failed run
          </button>
        </div>
      </div>
    </div>
  );
}

/** The response pane, excluding the independent trace panel below it. */
export function ResponseOutput({
  output, reasoning, status, runState, isRequestActive, markdownPreview,
  outputFollowing, outputScrollRef, completedToolCalls, toolResultDrafts,
  traceStorage,
  transcript, nonBranchableMessageIds, branchedFrom,
  emptyState,
  onMarkdownPreviewChange, onOutputScroll, onJumpToLatest,
  onToolResultDraftChange, onContinue, onRetry, onDiscardFailedRun,
  onSaveTrace, onEditFromHere, onEmptyStateAction,
}: ResponseOutputProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
            {transcript.map(({ message, reasoning: turnReasoning }, index) => {
              const isOpen = expanded[message.id] ?? startsExpanded(message.role);
              const bodyId = `${message.id}-body`;
              const toggle = () =>
                setExpanded((current) => ({ ...current, [message.id]: !isOpen }));
              return (
                <article className="transcript-message" key={message.id}>
                  {/* The whole row toggles, not just the chevron — a collapsed
                      message is nothing but this row, and an expanded one keeps
                      the toggle within reach without hunting for a small icon.
                      "Edit from here" stops its own click from bubbling here. */}
                  <div
                    className={
                      isOpen
                        ? "transcript-message-header transcript-message-header-open"
                        : "transcript-message-header"
                    }
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? bodyId : undefined}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${message.role} message`}
                    onClick={toggle}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggle();
                    }}
                  >
                    <span className="transcript-disclosure" aria-hidden="true">
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="eyebrow">{message.role}</span>
                    <span>Message {index + 1}</span>
                    {/* Collapsed rows fold their preview into the header itself, so a
                        collapsed message reads as one compact line, distinct at a
                        glance from an expanded card's full-size body below. */}
                    {!isOpen && (
                      <span className="transcript-preview">{previewText(message)}</span>
                    )}
                    <button
                      className="button secondary transcript-edit"
                      type="button"
                      disabled={nonBranchableMessageIds.has(message.id)}
                      title={
                        nonBranchableMessageIds.has(message.id)
                          ? "A message-set template is atomic. Branch after its final message or detach it first."
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditFromHere(message.id);
                      }}
                    >
                      Edit from here
                    </button>
                  </div>
                  {isOpen && (
                    <div className="transcript-body" id={bodyId}>
                      {message.role === "assistant" && turnReasoning && (
                        <details className="reasoning-stream transcript-reasoning">
                          <summary>
                            <span className="reasoning-dot complete" aria-hidden="true" />
                            <span>Reasoning</span>
                            <span className="reasoning-stream-hint">Show</span>
                          </summary>
                          {markdownPreview ? (
                            <MarkdownView text={turnReasoning} />
                          ) : (
                            <p>{turnReasoning}</p>
                          )}
                        </details>
                      )}
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
                        <span className="transcript-tool-result">
                          Tool result for {message.name ?? message.toolCallId}
                          {" · "}
                          {describeSuppliedToolResult(
                            runState?.toolResults.find(({ toolCallId }) => toolCallId === message.toolCallId),
                            latestToolExecution(runState?.toolExecutions ?? [], message.toolCallId),
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : <div className="output">
          {output ? (markdownPreview ? <MarkdownView text={output} /> : <p>{output}</p>)
            : reasoning ? <div className="waiting-for-answer" aria-live="polite"><span className="reasoning-dot" aria-hidden="true" /><div><h3>Thinking…</h3><p>Reasoning received. The final answer will appear here.</p></div></div>
            : isRequestActive ? <div className="waiting-for-answer" role="status"><span className="reasoning-dot" aria-hidden="true" /><div><h3>Waiting for response…</h3><p>Request sent. The response will appear here.</p></div></div>
            : awaitingResults ? <div className="waiting-for-answer"><span className="reasoning-dot complete" aria-hidden="true" /><div><h3>Tool result needed</h3><p>Review the call below, supply its result, then continue.</p></div></div>
            : retryableFailure ? <RunFailureCard message={retryableFailure.error.message} onRetry={onRetry} onDiscard={onDiscardFailedRun} />
            : runState?.status.kind === "failed" ? <div className="waiting-for-answer run-failure-state" role="alert"><span className="failure-glyph" aria-hidden="true">!</span><div><h3>Request failed</h3><p>{runState.status.error.message}</p></div></div>
            : runState?.status.kind === "cancelled" ? <div className="waiting-for-answer"><span className="failure-glyph muted" aria-hidden="true">×</span><div><h3>Request stopped</h3><p>{runState.status.reason}</p></div></div>
            : <div className="empty-state"><span className="empty-glyph" aria-hidden="true">↗</span><h3>{emptyState.headline}</h3><p>{emptyState.detail}</p>{emptyState.action && <button className="button secondary" type="button" onClick={onEmptyStateAction}>{emptyState.action.label}</button>}</div>}
          {reasoning && <details className="reasoning-stream"><summary><span className={status === "running" ? "reasoning-dot" : "reasoning-dot complete"} aria-hidden="true" /><span>{status === "running" ? "Thinking…" : "Reasoning"}</span><span className="reasoning-stream-hint">Show</span></summary><p>{reasoning}</p></details>}
          {(output || reasoning) && retryableFailure && <RunFailureCard message={retryableFailure.error.message} onRetry={onRetry} onDiscard={onDiscardFailedRun} />}
        </div>}
        {!terminal && <ToolCallList calls={completedToolCalls} toolResultDrafts={toolResultDrafts}
          suppliedResults={runState?.toolResults ?? []} toolExecutions={runState?.toolExecutions ?? []} awaitingResults={awaitingResults}
          onDraftChange={onToolResultDraftChange} onContinue={onContinue} />}
        {!outputFollowing && (output || reasoning) && <button className="jump-to-latest" type="button" onClick={onJumpToLatest}>Jump to latest ↓</button>}
      </div>
    </>
  );
}
