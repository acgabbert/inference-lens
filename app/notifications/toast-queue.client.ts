/**
 * What the toast layer decides, with no React and no DOM in it.
 *
 * A toast is the one notification tier that expires, which is what makes it the
 * only one with a policy worth writing down. Three rules live here rather than
 * in the component, so they can be tested without a browser:
 *
 * - **A bounded number are on screen.** Beyond that they queue and are admitted
 *   as slots free, rather than stacking into a wall that covers the app.
 * - **Time only passes while nobody is reading.** Hovering or tabbing into the
 *   region freezes every remaining lifetime; leaving resumes it from where it
 *   stopped rather than restarting it. A toast cannot expire underneath the
 *   pointer that is reaching for its action.
 * - **A repeat replaces rather than stacks.** Saving twice is one message about
 *   the current state, not two about the past.
 *
 * The rule this module cannot enforce is the important one: *no toast is the
 * sole carrier of information the user needs later.* `durableHome` is required
 * so that every call site has to name where the message still exists once the
 * toast is gone — an unanswerable field is the signal that the message wanted a
 * chip or a banner instead.
 */

export type ToastTone = "success" | "info";

export interface ToastAction {
  label: string;
  onSelect(): void;
}

export interface ToastRequest {
  /**
   * Identifies the *subject*, not the occurrence. Publishing a key that is
   * already queued or on screen replaces it and restarts its lifetime.
   */
  key: string;
  /** Defaults to `success`; `info` for something that merely happened. */
  tone?: ToastTone;
  title: string;
  detail?: string;
  action?: ToastAction;
  /**
   * Where this message still exists after the toast expires, in the words a
   * reviewer can check — "the Runs mode indicator", "the project name in the
   * topbar". Not rendered. It is required because a call site that cannot fill
   * it in is publishing something that should not have been a toast.
   */
  durableHome: string;
  durationMs?: number;
}

export interface Toast extends ToastRequest {
  id: string;
  tone: ToastTone;
  durationMs: number;
}

export interface VisibleToast extends Toast {
  /** Lifetime left. Authoritative while paused, when nothing is counting down. */
  remainingMs: number;
  /** Epoch ms this retires at. Absent while paused. */
  expiresAt?: number;
}

export interface ToastQueueState {
  visible: readonly VisibleToast[];
  pending: readonly Toast[];
  paused: boolean;
}

export const MAX_VISIBLE_TOASTS = 3;
export const DEFAULT_TOAST_DURATION_MS = 6_000;
/**
 * A toast carrying an action stays twice as long. The reader has to notice it,
 * read it, decide, and travel to it with a pointer or the keyboard, and the
 * default duration is budgeted for reading alone.
 */
export const ACTIONABLE_TOAST_DURATION_MS = 12_000;

export function emptyToastQueue(): ToastQueueState {
  return { visible: [], pending: [], paused: false };
}

function prepared(request: ToastRequest, id: string): Toast {
  return {
    ...request,
    id,
    tone: request.tone ?? "success",
    durationMs:
      request.durationMs ??
      (request.action ? ACTIONABLE_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS),
  };
}

function admitted(toast: Toast, paused: boolean, now: number): VisibleToast {
  return {
    ...toast,
    remainingMs: toast.durationMs,
    ...(paused ? {} : { expiresAt: now + toast.durationMs }),
  };
}

/**
 * Fills free slots from the queue, preserving publication order.
 *
 * Returns the input untouched when nothing moved. Identity matters: the hook
 * reschedules its timer whenever the state object changes, so a state that
 * always allocated would reschedule forever.
 */
function withPendingAdmitted(
  state: ToastQueueState,
  now: number,
): ToastQueueState {
  const free = MAX_VISIBLE_TOASTS - state.visible.length;
  if (free <= 0 || state.pending.length === 0) return state;
  const admitting = state.pending.slice(0, free);
  return {
    ...state,
    visible: [
      ...state.visible,
      ...admitting.map((toast) => admitted(toast, state.paused, now)),
    ],
    pending: state.pending.slice(admitting.length),
  };
}

export function publishToast(
  state: ToastQueueState,
  request: ToastRequest,
  id: string,
  now: number,
): ToastQueueState {
  const toast = prepared(request, id);
  return withPendingAdmitted(
    {
      ...state,
      visible: state.visible.filter((current) => current.key !== toast.key),
      pending: [
        ...state.pending.filter((current) => current.key !== toast.key),
        toast,
      ],
    },
    now,
  );
}

/** Retires everything whose lifetime has run out, then refills from the queue. */
export function advanceToasts(
  state: ToastQueueState,
  now: number,
): ToastQueueState {
  if (state.paused) return withPendingAdmitted(state, now);
  const visible = state.visible.filter(
    (toast) => toast.expiresAt === undefined || toast.expiresAt > now,
  );
  return withPendingAdmitted(
    visible.length === state.visible.length ? state : { ...state, visible },
    now,
  );
}

export function dismissToast(
  state: ToastQueueState,
  id: string,
  now: number,
): ToastQueueState {
  const visible = state.visible.filter((toast) => toast.id !== id);
  const pending = state.pending.filter((toast) => toast.id !== id);
  if (visible.length === state.visible.length && pending.length === state.pending.length) {
    return state;
  }
  return withPendingAdmitted({ ...state, visible, pending }, now);
}

/** Freezes every visible lifetime at what is left of it. */
export function pauseToasts(state: ToastQueueState, now: number): ToastQueueState {
  if (state.paused) return state;
  return {
    ...state,
    paused: true,
    visible: state.visible.map(({ expiresAt, ...toast }) => ({
      ...toast,
      remainingMs:
        expiresAt === undefined ? toast.remainingMs : Math.max(0, expiresAt - now),
    })),
  };
}

/** Restarts every visible lifetime from what was left, not from the top. */
export function resumeToasts(state: ToastQueueState, now: number): ToastQueueState {
  if (!state.paused) return state;
  return advanceToasts(
    {
      ...state,
      paused: false,
      visible: state.visible.map((toast) => ({
        ...toast,
        expiresAt: now + toast.remainingMs,
      })),
    },
    now,
  );
}

/**
 * When the soonest retirement falls due, or `undefined` when nothing is
 * counting down — an empty region, or a paused one.
 */
export function nextToastDeadline(state: ToastQueueState): number | undefined {
  const deadlines = state.visible.flatMap((toast) =>
    toast.expiresAt === undefined ? [] : [toast.expiresAt],
  );
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}
