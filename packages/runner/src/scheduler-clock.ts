/** The scheduler's only source of time, so tests can move it by hand. */
export interface SchedulerClock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemSchedulerClock: SchedulerClock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  },
};
