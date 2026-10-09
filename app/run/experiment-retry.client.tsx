"use client";

import { RATE_LIMIT_MAX_RETRIES } from "../../packages/core/src/experiment.ts";
import type { ExperimentRetryPolicy } from "../../packages/core/src/experiment.ts";

/**
 * The start dialogs' opt-in for retrying a 429. Off every time a dialog opens,
 * like the concurrency limit: nothing is remembered, so a retried run is always
 * a choice made for that run.
 */
export function ExperimentRetryField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="experiment-retry-field">
      <input
        aria-label="Retry rate-limited requests"
        checked={checked}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        Retry rate-limited requests
        <small>
          A request the provider refuses with HTTP 429 is retried up to {RATE_LIMIT_MAX_RETRIES} times per turn,
          after the wait it asks for. The result records that retries were allowed.
        </small>
      </span>
    </label>
  );
}

/** "rate-limited requests retried up to 2 times" for a result that allowed it; undefined otherwise. */
export function recordedRetryLabel(policy: ExperimentRetryPolicy | undefined): string | undefined {
  const maxRetries = policy?.rateLimited.maxRetries ?? 0;
  if (maxRetries <= 0) return undefined;
  return `rate-limited requests retried up to ${maxRetries} ${maxRetries === 1 ? "time" : "times"}`;
}
