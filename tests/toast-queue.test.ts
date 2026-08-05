import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIONABLE_TOAST_DURATION_MS,
  DEFAULT_TOAST_DURATION_MS,
  MAX_VISIBLE_TOASTS,
  advanceToasts,
  dismissToast,
  emptyToastQueue,
  nextToastDeadline,
  pauseToasts,
  publishToast,
  resumeToasts,
} from "../app/notifications/toast-queue.client.ts";
import type { ToastQueueState, ToastRequest } from "../app/notifications/toast-queue.client.ts";

const T0 = 1_000_000;

function request(key: string, overrides: Partial<ToastRequest> = {}): ToastRequest {
  return {
    key,
    title: `Toast ${key}`,
    durableHome: "the Runs mode indicator",
    ...overrides,
  };
}

function publishAll(
  state: ToastQueueState,
  keys: readonly string[],
  now = T0,
): ToastQueueState {
  return keys.reduce(
    (current, key) => publishToast(current, request(key), `id-${key}`, now),
    state,
  );
}

test("a published toast is visible and counting down", () => {
  const state = publishToast(emptyToastQueue(), request("saved"), "id-1", T0);
  assert.equal(state.visible.length, 1);
  assert.equal(state.pending.length, 0);
  assert.equal(state.visible[0]!.durationMs, DEFAULT_TOAST_DURATION_MS);
  assert.equal(state.visible[0]!.expiresAt, T0 + DEFAULT_TOAST_DURATION_MS);
  assert.equal(nextToastDeadline(state), T0 + DEFAULT_TOAST_DURATION_MS);
});

test("a toast carrying an action is given longer to be reached", () => {
  const state = publishToast(
    emptyToastQueue(),
    request("finished", { action: { label: "View results", onSelect() {} } }),
    "id-1",
    T0,
  );
  assert.equal(state.visible[0]!.durationMs, ACTIONABLE_TOAST_DURATION_MS);
  assert.ok(
    ACTIONABLE_TOAST_DURATION_MS > DEFAULT_TOAST_DURATION_MS,
    "reading and travelling to an action costs more than reading alone",
  );
});

test("beyond the cap toasts queue rather than stacking into a wall", () => {
  const state = publishAll(emptyToastQueue(), ["a", "b", "c", "d", "e"]);
  assert.equal(state.visible.length, MAX_VISIBLE_TOASTS);
  assert.deepEqual(
    state.visible.map(({ key }) => key),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    state.pending.map(({ key }) => key),
    ["d", "e"],
    "publication order is preserved; the queue is not a stack",
  );
});

test("a freed slot admits the next queued toast, starting its lifetime then", () => {
  const queued = publishAll(emptyToastQueue(), ["a", "b", "c", "d"]);
  const later = T0 + DEFAULT_TOAST_DURATION_MS + 1;
  const advanced = advanceToasts(queued, later);
  assert.deepEqual(
    advanced.visible.map(({ key }) => key),
    ["d"],
    "the three that expired retire together and the queued one takes a slot",
  );
  assert.equal(
    advanced.visible[0]!.expiresAt,
    later + DEFAULT_TOAST_DURATION_MS,
    "a queued toast gets its full lifetime from admission, not from publication",
  );
});

test("publishing the same subject replaces it rather than stacking a second copy", () => {
  const first = publishToast(emptyToastQueue(), request("project-saved"), "id-1", T0);
  const second = publishToast(
    first,
    request("project-saved", { title: "Project saved" }),
    "id-2",
    T0 + 2_000,
  );
  assert.equal(second.visible.length, 1);
  assert.equal(second.visible[0]!.id, "id-2");
  assert.equal(second.visible[0]!.title, "Project saved");
  assert.equal(
    second.visible[0]!.expiresAt,
    T0 + 2_000 + DEFAULT_TOAST_DURATION_MS,
    "the replacement restarts the lifetime; the reader has new text to read",
  );
});

test("a repeat replaces a queued copy too, so the queue cannot hold two of one subject", () => {
  const filled = publishAll(emptyToastQueue(), ["a", "b", "c", "dup"]);
  const again = publishToast(filled, request("dup"), "id-dup-2", T0 + 10);
  assert.deepEqual(
    again.pending.map(({ key }) => key),
    ["dup"],
  );
  assert.equal(again.pending[0]!.id, "id-dup-2");
});

test("pausing freezes what is left, and resuming continues from there", () => {
  const state = publishToast(emptyToastQueue(), request("saved"), "id-1", T0);
  const paused = pauseToasts(state, T0 + 2_000);
  assert.equal(paused.paused, true);
  assert.equal(paused.visible[0]!.remainingMs, DEFAULT_TOAST_DURATION_MS - 2_000);
  assert.equal(
    paused.visible[0]!.expiresAt,
    undefined,
    "nothing is counting down while the region is being read",
  );
  assert.equal(
    nextToastDeadline(paused),
    undefined,
    "a paused region schedules no timer at all",
  );

  // Long enough that an unpaused toast would have expired several times over.
  const resumed = resumeToasts(paused, T0 + 60_000);
  assert.equal(resumed.visible.length, 1, "hovering does not consume the lifetime");
  assert.equal(
    resumed.visible[0]!.expiresAt,
    T0 + 60_000 + (DEFAULT_TOAST_DURATION_MS - 2_000),
    "the remainder resumes rather than restarting from the top",
  );
});

test("time does not pass while paused, even for a toast admitted during the pause", () => {
  const filled = publishAll(emptyToastQueue(), ["a", "b", "c", "d"]);
  const paused = pauseToasts(filled, T0 + 1_000);
  const afterDismiss = dismissToast(paused, "id-a", T0 + 1_000);
  const admitted = afterDismiss.visible.find(({ key }) => key === "d");
  assert.ok(admitted, "a freed slot still admits while paused");
  assert.equal(admitted.expiresAt, undefined);
  assert.equal(admitted.remainingMs, DEFAULT_TOAST_DURATION_MS);
});

test("dismissing removes exactly one toast and refills the slot", () => {
  const filled = publishAll(emptyToastQueue(), ["a", "b", "c", "d"]);
  const dismissed = dismissToast(filled, "id-b", T0 + 100);
  assert.deepEqual(
    dismissed.visible.map(({ key }) => key),
    ["a", "c", "d"],
  );
  assert.equal(dismissed.pending.length, 0);
});

/**
 * Identity, not equality. The hook reschedules its timer whenever the state
 * object changes, so a reducer that always allocated would reschedule forever.
 */
test("a reducer that changes nothing returns its input unchanged", () => {
  const state = publishToast(emptyToastQueue(), request("saved"), "id-1", T0);
  assert.equal(advanceToasts(state, T0 + 1), state);
  assert.equal(dismissToast(state, "absent", T0), state);
  assert.equal(resumeToasts(state, T0), state, "resuming a running queue is a no-op");
  const paused = pauseToasts(state, T0 + 1);
  assert.equal(pauseToasts(paused, T0 + 2), paused, "pausing twice is a no-op");
  const empty = emptyToastQueue();
  assert.equal(advanceToasts(empty, T0), empty, "an empty queue never allocates");
});
