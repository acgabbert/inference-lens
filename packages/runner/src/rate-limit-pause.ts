import type { RunState } from "../../core/src/run-kernel/index.ts";

/** How long a connection pauses after a 429 that names no wait of its own. */
export const DEFAULT_RATE_LIMIT_PAUSE_MS = 5_000;
/** No header can pause a connection longer than this; a later 429 starts another pause. */
export const MAX_RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * How long to pause after a 429: `retry-after-ms` if readable, otherwise
 * `Retry-After` as delta seconds or an HTTP date, otherwise the default.
 * Provider-specific quota headers are deliberately not read.
 */
export function rateLimitPauseMs(
  headers: Readonly<Record<string, string>> | undefined,
  now: number,
): number {
  const header = (name: string) =>
    Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]?.trim();
  const waited = millisecondsHeader(header("retry-after-ms"))
    ?? retryAfterHeader(header("retry-after"), now)
    ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
  return Math.min(MAX_RATE_LIMIT_PAUSE_MS, Math.max(0, waited));
}

function millisecondsHeader(value: string | undefined): number | undefined {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  return Number(value);
}

function retryAfterHeader(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date - now;
}

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
