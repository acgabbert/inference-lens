/**
 * The bound on provider turns one repetition may spend before it is failed.
 *
 * It lives in its own module because two documents now carry it — an
 * experiment plan and an evaluation suite — and a project must not import the
 * experiment module to validate a number both of them agree on.
 */
export const DEFAULT_EXPERIMENT_TURN_CEILING = 5;
export const MIN_EXPERIMENT_TURN_CEILING = 2;
export const MAX_EXPERIMENT_TURN_CEILING = 20;

/** Clamps an edited value into the supported range, with no diagnostic. */
export function normalizedTurnCeiling(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPERIMENT_TURN_CEILING;
  return Math.max(
    MIN_EXPERIMENT_TURN_CEILING,
    Math.min(MAX_EXPERIMENT_TURN_CEILING, Math.trunc(value)),
  );
}
