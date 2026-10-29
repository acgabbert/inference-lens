import type { RunState } from "../../core/src/run-kernel/index.ts";

export {
  DEFAULT_RATE_LIMIT_PAUSE_MS,
  MAX_RATE_LIMIT_PAUSE_MS,
  rateLimitPauseMs,
} from "../../core/src/rate-limit-pause.ts";

/**
 * The run's latest attempt, with its response headers, when that attempt
 * failed because the provider answered 429. Read from the run itself, so it holds
 * for every transport that records its response.
 */
export function rateLimitedAttempt(
  state: RunState,
): { headers?: Readonly<Record<string, string>> } | undefined {
  const attempt = state.turns.at(-1)?.attempts.at(-1);
  if (
    attempt?.status !== "failed" ||
    attempt.error?.code !== "provider_error" ||
    attempt.error.providerStatus !== 429
  ) {
    return undefined;
  }
  return { headers: state.exchanges[attempt.exchangeId]?.response?.headers };
}
