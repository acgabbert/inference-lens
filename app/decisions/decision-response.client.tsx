"use client";

import { useEffect, useState } from "react";
import type { DecisionRun } from "../../packages/core/src/decision";
import { TraceStorageNotice } from "../response-output.client";
import type { TraceStorageStatus } from "../response-output.client";
import {
  decisionAnswerViews,
  decisionDisplayStatus,
  decisionRunResult,
  formatDuration,
  formatUsage,
} from "./decision-result-view";
import type { DecisionAnswerView, DecisionBar } from "./decision-result-view";

export interface DecisionResponseProps {
  run: DecisionRun | null;
  executing: boolean;
  retryAvailableAt?: number;
  /** Why another foreground activity refuses Retry now (D24); stated beside the button. */
  retryBlockedReason?: string;
  traceStorage: TraceStorageStatus | null;
  /** What to do first while nothing has run; the readiness summary when blocked. */
  emptyDetail: string;
  onRetry(): void;
  /** Stops a paused run, which makes it failed (D28). */
  onDiscard(): void;
  onSaveTrace(): void;
}

const RETRY_BLOCKED_ID = "decision-retry-blocked";

/** Whole seconds left until `at`, re-rendered while it counts down (D23). */
function useSecondsUntil(at: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [at]);
  return at === undefined ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

function Bar({ bar, selected = false }: { bar: DecisionBar; selected?: boolean }) {
  return (
    <li className={selected ? "decision-bar selected" : "decision-bar"}>
      <span className="decision-bar-label">{bar.label}</span>
      <span className="decision-bar-track" aria-hidden="true">
        <span className="decision-bar-fill" style={{ width: `${bar.probability * 100}%` }} />
      </span>
      <span className="decision-bar-value">{bar.percent}</span>
    </li>
  );
}

function AnswerRow({ answer }: { answer: DecisionAnswerView }) {
  return (
    <article className="decision-answer" aria-label={`Answer ${answer.id}`} data-question-id={answer.id}>
      <header className="decision-answer-header">
        <code>{answer.id}</code>
        <span className="decision-answer-type">{answer.type === "missing" ? "No answer" : answer.type}</span>
      </header>
      <p className="decision-answer-instructions">{answer.instructions}</p>
      {answer.type === "choice" && (
        <>
          <p className="decision-answer-headline">
            Choice <strong>{answer.choice}</strong>
            {answer.confidence && <span className="decision-confidence"> · confidence {answer.confidence}</span>}
          </p>
          <ul className="decision-bars" aria-label={`${answer.id} probabilities`}>
            {answer.bars.map((bar) => <Bar bar={bar} key={bar.key} selected={bar.selected} />)}
          </ul>
        </>
      )}
      {answer.type === "score" && (
        <>
          <p className="decision-answer-headline">
            Score <strong>{answer.score}</strong> of {Math.max(0, answer.levelCount - 1)}
            {answer.confidence && <span className="decision-confidence"> · confidence {answer.confidence}</span>}
          </p>
          <div className="decision-scale" aria-hidden="true">
            <span className="decision-scale-line" />
            {Array.from({ length: answer.levelCount }, (_, level) => (
              <span className="decision-scale-tick" key={level} style={{ left: `${answer.levelCount > 1 ? (level / (answer.levelCount - 1)) * 100 : 0}%` }}>{level}</span>
            ))}
            <span className="decision-scale-marker" style={{ left: `${answer.position * 100}%` }} />
          </div>
          <ul className="decision-bars" aria-label={`${answer.id} probabilities`}>
            {answer.bars.map((bar) => <Bar bar={bar} key={bar.key} />)}
          </ul>
        </>
      )}
      {answer.type === "noul" && (
        <ul className="decision-bars" aria-label={`${answer.id} probability`}>
          <Bar bar={answer.bar} />
        </ul>
      )}
      {answer.type === "missing" && <p className="decision-answer-missing">The response has no answer for this question.</p>}
    </article>
  );
}

/** The Decision kind's response pane (U5). */
export function DecisionResponse({
  run,
  executing,
  retryAvailableAt,
  retryBlockedReason,
  traceStorage,
  emptyDetail,
  onRetry,
  onDiscard,
  onSaveTrace,
}: DecisionResponseProps) {
  const secondsLeft = useSecondsUntil(retryAvailableAt);
  const status = decisionDisplayStatus(run, executing);
  const result = run ? decisionRunResult(run) : undefined;
  const duration = run ? formatDuration(run.startedAt, run.endedAt) : undefined;
  const paused = run?.status.kind === "paused" ? run.status : undefined;
  const waiting = secondsLeft !== undefined && secondsLeft > 0;
  return (
    <section className="result decision-response">
      <div className="panel-header result-header">
        <div><span className="eyebrow">Response</span><h2>Decision</h2></div>
        <div className="result-header-controls">
          <span className={`status ${status}`}><span aria-hidden="true" />{status}</span>
        </div>
      </div>
      {traceStorage && <TraceStorageNotice storage={traceStorage} onSaveTrace={onSaveTrace} />}
      <div className="output-scroll">
        <div className="output decision-output">
          {executing ? (
            <div className="waiting-for-answer" role="status"><span className="reasoning-dot" aria-hidden="true" /><div><h3>Waiting for decision…</h3><p>Request sent. The answers will appear here.</p></div></div>
          ) : paused ? (
            <div className="waiting-for-answer run-failure-state" role="alert">
              <span className="failure-glyph" aria-hidden="true">!</span>
              <div>
                <h3>Attempt {paused.attempt} failed</h3>
                <p>{paused.error.message}</p>
                {waiting && (
                  <p className="decision-retry-wait" role="status">
                    The server asked to wait. Retry is available in {secondsLeft} {secondsLeft === 1 ? "second" : "seconds"}.
                  </p>
                )}
                {retryBlockedReason && (
                  <p className="decision-retry-blocked" id={RETRY_BLOCKED_ID}>{retryBlockedReason}</p>
                )}
                <div className="run-failure-actions">
                  <button
                    aria-describedby={retryBlockedReason ? RETRY_BLOCKED_ID : undefined}
                    className="button primary"
                    disabled={waiting || Boolean(retryBlockedReason)}
                    type="button"
                    onClick={onRetry}
                  >
                    Retry attempt <span className="shortcut">⌘↵</span>
                  </button>
                  <button className="text-button" type="button" onClick={onDiscard}>
                    Discard failed run
                  </button>
                </div>
              </div>
            </div>
          ) : run?.status.kind === "failed" ? (
            <div className="waiting-for-answer run-failure-state" role="alert"><span className="failure-glyph" aria-hidden="true">!</span><div><h3>Request failed</h3><p>{run.status.error.message}</p></div></div>
          ) : run?.status.kind === "cancelled" ? (
            <div className="waiting-for-answer"><span className="failure-glyph muted" aria-hidden="true">×</span><div><h3>Request stopped</h3><p>{run.status.reason ?? "The decision was stopped before it finished."}</p></div></div>
          ) : run && result ? (
            <>
              <dl className="decision-run-facts">
                <div><dt>Model</dt><dd>{result.model ?? run.input.target.model}</dd></div>
                {duration && <div><dt>Duration</dt><dd>{duration}</dd></div>}
                <div><dt>Usage</dt><dd>{formatUsage(result.usage)}</dd></div>
                {run.attempts.length > 1 && <div><dt>Attempts</dt><dd>{run.attempts.length}</dd></div>}
              </dl>
              <div className="decision-answers">
                {decisionAnswerViews(run.input.decision, result).map((answer) => <AnswerRow answer={answer} key={answer.id} />)}
              </div>
            </>
          ) : (
            <div className="empty-state"><span className="empty-glyph" aria-hidden="true">↗</span><h3>No decision yet</h3><p>{emptyDetail}</p></div>
          )}
        </div>
      </div>
    </section>
  );
}
