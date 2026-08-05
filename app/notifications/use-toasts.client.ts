"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceToasts,
  dismissToast,
  emptyToastQueue,
  nextToastDeadline,
  pauseToasts,
  publishToast,
  resumeToasts,
} from "./toast-queue.client";
import type { ToastQueueState, ToastRequest, VisibleToast } from "./toast-queue.client";

export interface ToastsHandle {
  toasts: readonly VisibleToast[];
  paused: boolean;
  publish(request: ToastRequest): void;
  dismiss(id: string): void;
  /** Freezes and resumes every lifetime; the region calls this, not features. */
  setPaused(paused: boolean): void;
}

/**
 * Owns the toast queue and the single timer that drives it.
 *
 * One timer, not one per toast: it is scheduled for the soonest retirement and
 * rescheduled whenever the queue changes, so a paused region schedules nothing
 * at all rather than holding a fleet of timers it has to remember to clear.
 * The queue's own reducers return their input unchanged when nothing moved,
 * which is what stops that rescheduling from looping.
 *
 * Publication is a callback threaded from the route into each feature hook,
 * matching the `onError` and `onTraceSaved` contracts already there. There is
 * deliberately no context and no module-level singleton: a toast is caused by a
 * feature the route already owns, and a global would let anything anywhere
 * interrupt the user with no reviewable path from cause to message.
 */
export function useToasts(): ToastsHandle {
  const [state, setState] = useState<ToastQueueState>(emptyToastQueue);
  const publishedRef = useRef(0);

  useEffect(() => {
    const deadline = nextToastDeadline(state);
    if (deadline === undefined) return;
    const timer = window.setTimeout(
      () => setState((current) => advanceToasts(current, Date.now())),
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  const publish = useCallback((request: ToastRequest) => {
    publishedRef.current += 1;
    const id = `toast-${publishedRef.current}`;
    setState((current) => publishToast(current, request, id, Date.now()));
  }, []);

  const dismiss = useCallback((id: string) => {
    setState((current) => dismissToast(current, id, Date.now()));
  }, []);

  const setPaused = useCallback((paused: boolean) => {
    setState((current) =>
      paused ? pauseToasts(current, Date.now()) : resumeToasts(current, Date.now()),
    );
  }, []);

  return { toasts: state.visible, paused: state.paused, publish, dismiss, setPaused };
}
