"use client";

import { useEffect, useState } from "react";

/** A browser task boundary, never a verdict deadline. */
async function yieldToUI(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield(): Promise<void> };
  }).scheduler;
  if (scheduler?.yield) await scheduler.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** How much synchronous work one task may take before yielding again. The
 * timer fallback is clamped to several milliseconds per task, so yielding
 * after every microsecond-scale check would dominate the derivation. */
export interface ScheduledSlice {
  budgetMs?: number;
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 8;

/** Resumes only while this input is current; publishes no partial value. */
export async function runScheduledDerivation<T>(
  steps: Generator<void, T>,
  signal: AbortSignal,
  pause: () => Promise<void> = yieldToUI,
  { budgetMs = DEFAULT_BUDGET_MS, now = () => performance.now() }: ScheduledSlice = {},
): Promise<T | undefined> {
  try {
    while (!signal.aborted) {
      await pause();
      const sliceStart = now();
      do {
        if (signal.aborted) return undefined;
        const next = steps.next();
        if (next.done) return next.value;
      } while (now() - sliceStart < budgetMs);
    }
    return undefined;
  } finally {
    // Release suspended local work, including on cancellation or an exception.
    steps.return(undefined as T);
  }
}

/** The immutable factory identity stamps the value. A changed input hides
 * the old value during render, before effect cleanup has a chance to run,
 * unless both inputs share a `retainKey`: then the last complete value stays
 * visible, marked pending, until its replacement completes. Each effect gets
 * fresh work, including React StrictMode effect replay. */
export function useScheduledDerivation<T>(
  createSteps: (() => Generator<void, T>) | undefined,
  { retainKey, budgetMs, now }: ScheduledSlice & { retainKey?: unknown } = {},
): {
  value?: T;
  pending: boolean;
  error?: Error;
} {
  const [completed, setCompleted] = useState<{
    createSteps: () => Generator<void, T>;
    retainKey?: unknown;
    value?: T;
    error?: Error;
  }>();
  // The key changes only alongside its input in practice, and callers pass
  // stable slice settings, so the extra dependencies never churn work.
  useEffect(() => {
    if (!createSteps) return;
    const steps = createSteps();
    const controller = new AbortController();
    void runScheduledDerivation(steps, controller.signal, undefined, { budgetMs, now }).then(
      (value) => {
        if (!controller.signal.aborted) setCompleted({ createSteps, retainKey, value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setCompleted({
          createSteps,
          retainKey,
          error: error instanceof Error ? error : new Error("Check results could not be computed."),
        });
      },
    );
    return () => controller.abort();
  }, [createSteps, retainKey, budgetMs, now]);
  if (!createSteps) return { pending: false };
  if (completed?.createSteps !== createSteps) {
    const retained = retainKey !== undefined && completed?.retainKey === retainKey && !completed.error;
    return retained ? { value: completed.value, pending: true } : { pending: true };
  }
  return { value: completed.value, error: completed.error, pending: false };
}
