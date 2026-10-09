"use client";

import { experimentConnectionKey } from "../../packages/core/src/experiment.ts";
import type {
  ExperimentConcurrency,
  ExperimentConcurrencySetting,
  ExperimentConnectionConcurrency,
} from "../../packages/core/src/experiment.ts";
import type { ExperimentConnectionPause } from "../../packages/runner/src/sequential-experiment-controller.ts";

/**
 * The most cells a start dialog lets a person run at once. Not a scheduler
 * rule: a ceiling on what one click can send a provider, like the repetition
 * count's own maximum.
 */
export const MAX_EXPERIMENT_CONCURRENCY = 16;

/** One connection a plan uses, labelled for a person to recognize. */
export interface ExperimentConnectionChoice extends Pick<ExperimentConnectionConcurrency, "profileId" | "endpoint"> {
  label: string;
}

export function normalizedConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_EXPERIMENT_CONCURRENCY, Math.trunc(value)));
}

/** The overall limit a setting asks for; every limit defaults to 1. */
export function settingMaxInFlight(setting: ExperimentConcurrencySetting | undefined): number {
  return setting?.maxInFlight ?? 1;
}

/** The limit a setting gives one connection, never above the overall limit it could not exceed. */
export function settingConnectionLimit(
  setting: ExperimentConcurrencySetting | undefined,
  connection: Pick<ExperimentConnectionChoice, "profileId" | "endpoint">,
): number {
  const key = experimentConnectionKey(connection);
  const named = setting?.connections?.find((entry) => experimentConnectionKey(entry) === key)?.limit;
  return Math.min(settingMaxInFlight(setting), named ?? setting?.connectionLimit ?? 1);
}

/** "Up to 4 at once" for a recorded result; undefined for one at a time, which needs no caveat. */
export function recordedConcurrencyLabel(
  concurrency: ExperimentConcurrency | undefined,
  noun = "",
): string | undefined {
  if (!concurrency || concurrency.maxInFlight <= 1) return undefined;
  return `up to ${concurrency.maxInFlight}${noun ? ` ${noun}` : ""} at once`;
}

/** Whole seconds until a pause ends, never below 1 while it lasts. */
export function pauseSecondsRemaining(pause: ExperimentConnectionPause, nowMs: number): number {
  return Math.max(1, Math.ceil((pause.until - nowMs) / 1_000));
}

/**
 * The start dialog's limits. One field always sets the overall limit, and the
 * default for every connection, so a single number means what it says. A
 * suite on several connections also gets one field per connection, so a
 * fragile local model can be held to fewer than a hosted one.
 */
export function ExperimentConcurrencyFields({
  connections,
  value,
  onChange,
}: {
  connections: readonly ExperimentConnectionChoice[];
  value: ExperimentConcurrencySetting | undefined;
  onChange(next: ExperimentConcurrencySetting): void;
}) {
  const maxInFlight = settingMaxInFlight(value);
  return (
    <>
      <label className="inference-settings-count">
        Run at once
        <input
          aria-label="Run at once"
          min={1}
          max={MAX_EXPERIMENT_CONCURRENCY}
          type="number"
          value={maxInFlight}
          onChange={(event) => {
            const limit = normalizedConcurrency(Number(event.target.value));
            onChange({ ...value, maxInFlight: limit, connectionLimit: limit });
          }}
        />
      </label>
      {connections.length > 1 && connections.map((connection) => {
        const key = experimentConnectionKey(connection);
        return (
          <label className="inference-settings-count" key={key}>
            {connection.label}
            <input
              aria-label={`Run at once on ${connection.label}`}
              min={1}
              max={maxInFlight}
              type="number"
              value={settingConnectionLimit(value, connection)}
              onChange={(event) => {
                const limit = Math.min(maxInFlight, normalizedConcurrency(Number(event.target.value)));
                onChange({
                  ...value,
                  connections: [
                    ...(value?.connections ?? []).filter((entry) => experimentConnectionKey(entry) !== key),
                    { profileId: connection.profileId, endpoint: connection.endpoint, limit },
                  ],
                });
              }}
            />
          </label>
        );
      })}
    </>
  );
}
