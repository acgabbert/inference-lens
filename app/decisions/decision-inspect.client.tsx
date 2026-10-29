"use client";

import type { DecisionRun } from "../../packages/core/src/decision";
import { RequestEvidence } from "../evidence/exchange-evidence.client";
import { WorkbenchPanel } from "../workbench-panel.client";
import { formatDuration, formatUsage } from "./decision-result-view";

/**
 * The Decision kind's inspection: each attempt's complete, redacted exchange
 * evidence (D19). There is no event stream, tool, transcript, or token-timing
 * view; a decision exchange is one buffered request and one body.
 */
export function DecisionInspect({ run }: { run: DecisionRun | null }) {
  if (!run) {
    return (
      <section className="decision-inspect" aria-label="Decision evidence">
        <WorkbenchPanel eyebrow="Inspect" title="Decision evidence">
          <p className="decision-inspect-empty">Run a decision to see its request and response.</p>
        </WorkbenchPanel>
      </section>
    );
  }
  const duration = formatDuration(run.startedAt, run.endedAt);
  const usage = run.attempts.find(({ result }) => result)?.result?.usage;
  return (
    <section className="decision-inspect" aria-label="Decision evidence">
      <WorkbenchPanel eyebrow="Inspect" title="Decision evidence" scrollClassName="decision-inspect-body">
        <dl className="decision-run-facts">
          <div><dt>Run</dt><dd><code>{run.runId}</code></dd></div>
          <div><dt>Status</dt><dd>{run.status.kind}</dd></div>
          <div><dt>Endpoint</dt><dd><code>{run.input.target.endpoint}</code></dd></div>
          <div><dt>Model</dt><dd>{run.input.target.model}</dd></div>
          {duration && <div><dt>Duration</dt><dd>{duration}</dd></div>}
          <div><dt>Usage</dt><dd>{formatUsage(usage)}</dd></div>
        </dl>
        {run.attempts.map((attempt) => {
          const exchange = run.exchanges[attempt.exchangeId];
          const body = exchange?.frames[0]?.raw;
          return (
            <article className="decision-attempt" aria-label={`Attempt ${attempt.attempt}`} key={attempt.exchangeId}>
              <h3>Attempt {attempt.attempt} · {attempt.status}</h3>
              {attempt.error && <p className="decision-attempt-error" role="note">{attempt.error.message}</p>}
              <h4>Request</h4>
              {exchange?.request
                ? <RequestEvidence request={exchange.request} />
                : <p className="decision-evidence-missing">No request was sent for this attempt.</p>}
              <h4>Response</h4>
              {exchange?.response ? (
                <div className="decision-response-evidence">
                  <p>
                    HTTP <strong>{exchange.response.status}</strong>
                    {Object.keys(exchange.response.headers).length > 0 && (
                      <> · {Object.entries(exchange.response.headers).map(([name, value]) => `${name}: ${value}`).join(", ")}</>
                    )}
                  </p>
                  {body !== undefined
                    ? <pre className="decision-raw-body" aria-label={`Attempt ${attempt.attempt} raw response body`}>{body}</pre>
                    : <p className="decision-evidence-missing">No body was received.</p>}
                </div>
              ) : (
                <p className="decision-evidence-missing">No response was received.</p>
              )}
            </article>
          );
        })}
      </WorkbenchPanel>
    </section>
  );
}
