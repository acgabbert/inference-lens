"use client";

import { useState } from "react";
import type { ReactNode } from "react";

export type ComposeKind = "chat" | "decision";

/**
 * What the topbar's primary slot and ⌘↵ do for the kind on screen (D29-A).
 * A refused run names, by id, the element whose visible text says why; the
 * reason is never only a tooltip.
 */
export type ComposePrimary =
  | { kind: "run"; label: string; disabled: boolean; disabledReasonId?: string; run(): void }
  | { kind: "stop"; stop(): void }
  /** Paused: the action is on the failure card. */
  | { kind: "none" };

/**
 * One request kind as Compose sees it. Each feature builds its own; this is an
 * application-local adapter, not a union over the chat and decision kernels.
 */
export interface ComposeKindHandle {
  /** An attempt is in flight. Feeds the switch lock (D17) and the route's activity guard (D24). */
  executing: boolean;
  primary: ComposePrimary;
  /** What ⌘↵ does when nothing else owns the keyboard; usually `primary`'s run, or Retry. */
  shortcut(): void;
  /**
   * The request pane receives the Chat / Decision switch to place in its own
   * header, beside its tabs: Compose owns the choice, the pane owns the layout.
   */
  panes: { request: (kindSwitch: ReactNode) => ReactNode; response: ReactNode; inspect: ReactNode };
  inspectAvailable: boolean;
  /** Shown as the mobile Response tab's dot. */
  responseStatus?: string;
  trace: { available: boolean; export(): void };
  /** Idempotent. Stops this kind's live work. */
  stop(): void;
}

export interface ComposeHandle extends Omit<ComposeKindHandle, "stop"> {
  kind: ComposeKind;
  /** A no-op while `kindLocked`. */
  setKind(kind: ComposeKind): void;
  /** Either kind is executing (D17). Opening a trace is not blocked by it (D30). */
  kindLocked: boolean;
  /** Stops whichever kind is executing, whichever is on screen. */
  stopExecuting(): void;
  /**
   * Switches to `kind` for an explicit open (D30): whichever kind is executing
   * is stopped first, so the lock never strands a live run off screen.
   */
  openKind(kind: ComposeKind): void;
}

/**
 * Owns which request kind Compose shows (U1, D19) and selects that kind's
 * handle for the topbar, the keyboard shortcut, and the panes. Each kind's
 * draft, target, and result live with its own feature, above this choice, so
 * switching is lossless.
 */
export function useCompose(kinds: Record<ComposeKind, ComposeKindHandle>): ComposeHandle {
  const [kind, setKindState] = useState<ComposeKind>("chat");
  const kindLocked = kinds.chat.executing || kinds.decision.executing;
  const active = kinds[kind];
  return {
    primary: active.primary,
    shortcut: active.shortcut,
    panes: active.panes,
    inspectAvailable: active.inspectAvailable,
    ...(active.responseStatus ? { responseStatus: active.responseStatus } : {}),
    trace: active.trace,
    // The whole Compose surface is busy while either kind runs, whichever is shown.
    executing: kindLocked,
    kind,
    kindLocked,
    setKind(next) {
      if (kindLocked) return;
      setKindState(next);
    },
    stopExecuting() {
      if (kinds.chat.executing) kinds.chat.stop();
      if (kinds.decision.executing) kinds.decision.stop();
    },
    openKind(next) {
      if (kinds.chat.executing) kinds.chat.stop();
      if (kinds.decision.executing) kinds.decision.stop();
      setKindState(next);
    },
  };
}
