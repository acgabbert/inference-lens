"use client";

import { useCallback, useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

interface FocusModeOptions {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  containerRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  initialFocusSelector: string;
}

/**
 * Focus-mode editors share modal keyboard behavior while continuing to own
 * their draft state locally. Closing only restores presentation and focus, so
 * every dismissal path — Escape and the visible control alike — goes through
 * the returned `close` and lands focus back on the trigger.
 */
export function useFocusMode({
  open,
  setOpen,
  containerRef,
  triggerRef,
  initialFocusSelector,
}: FocusModeOptions): { close: () => void } {
  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [setOpen, triggerRef]);

  useEffect(() => {
    if (!open) return;

    const container = containerRef.current;
    if (!container) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const focusEditor = window.setTimeout(() => {
      const preferred = container.querySelector<HTMLElement>(initialFocusSelector);
      (preferred ?? container.querySelector<HTMLElement>(focusableSelector))?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!container.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusEditor);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, containerRef, initialFocusSelector, open]);

  return { close };
}

/**
 * The toggle doubles as the dismiss control, so it keeps its identity across
 * the transition and stays a valid focus-restoration target.
 */
export function FocusModeToggle({
  className,
  open,
  subject,
  toggleRef,
  onToggle,
}: {
  className: string;
  open: boolean;
  subject: string;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
}) {
  return (
    <button
      aria-label={open ? `Exit ${subject} focus mode` : `Open ${subject} in focus mode`}
      className={`${open ? "icon-button" : "button secondary"} ${className}`}
      ref={toggleRef}
      type="button"
      onClick={onToggle}
    >
      {open ? "×" : "Expand"}
    </button>
  );
}
