"use client";

import type {
  RunReadiness,
  RunReadinessActionKind,
} from "./run-readiness.client.ts";

/**
 * States a blocked run where it is being composed. The Run button is in the
 * top bar, and a disabled button can carry only a native tooltip — invisible
 * until hovered and unreachable by keyboard — so the reason and its fix are
 * rendered in the request pane instead.
 */
interface RunReadinessNoticeProps {
  readiness?: RunReadiness;
  onAction(kind: RunReadinessActionKind): void;
}

export function RunReadinessNotice({
  readiness,
  onAction,
}: RunReadinessNoticeProps) {
  if (!readiness) return null;
  const { blocked, headline, detail, explanation, facts, actions } = readiness;
  return (
    <div
      className={blocked ? "run-readiness blocked" : "run-readiness advisory"}
      role={blocked ? "alert" : "status"}
    >
      <span className="run-readiness-glyph" aria-hidden="true">
        {blocked ? "!" : "i"}
      </span>
      <div className="run-readiness-copy">
        <strong>{headline}</strong>
        <p>{detail}</p>
        {explanation && (
          // A disclosure rather than a title attribute: a native tooltip is
          // invisible on touch and unreachable from the keyboard.
          <details className="run-readiness-why">
            <summary>
              <span className="run-readiness-why-mark" aria-hidden="true">
                i
              </span>
              Why
            </summary>
            <p>{explanation}</p>
          </details>
        )}
        {facts.length > 0 && (
          <dl className="run-readiness-facts">
            {facts.map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="run-readiness-actions">
          {actions.map((action) => (
            <button
              className={action.primary ? "button primary" : "button secondary"}
              key={action.kind}
              type="button"
              onClick={() => onAction(action.kind)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
