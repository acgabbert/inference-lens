"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The shared modal contract: capture-phase Escape that only the topmost modal
 * handles, a Tab trap, initial focus, focus restore on close, and a ref-counted
 * body scroll lock. The markup keeps the `role="dialog" aria-modal="true"`
 * boundary that `modalOwnsKeyboardCommands` keys on.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const openModals: symbol[] = [];
let scrollLocks = 0;
let scrollOverflowBeforeLock = "";

function lockScroll(): () => void {
  if (scrollLocks === 0) {
    scrollOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  return () => {
    scrollLocks -= 1;
    if (scrollLocks === 0) document.body.style.overflow = scrollOverflowBeforeLock;
  };
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  );
}

export function useModalDialog<Element extends HTMLElement>(
  onClose: () => void,
  initialFocus?: string,
) {
  const dialogRef = useRef<Element>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const token = Symbol("modal");
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    openModals.push(token);
    const unlockScroll = lockScroll();

    if (!dialog.contains(document.activeElement)) {
      const target = (initialFocus ? dialog.querySelector<HTMLElement>(initialFocus) : null)
        ?? focusableWithin(dialog)[0]
        ?? dialog;
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== token) return;
      if (event.key === "Escape") {
        // Stop here so the same press cannot also reach a bubble-phase Escape
        // listener on whatever the modal is layered over.
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const index = openModals.indexOf(token);
      if (index >= 0) openModals.splice(index, 1);
      unlockScroll();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  return dialogRef;
}

export function ModalDialog({
  labelledBy,
  className,
  backdropClassName = "confirmation-backdrop",
  initialFocus,
  onClose,
  children,
}: {
  labelledBy: string;
  className: string;
  backdropClassName?: string;
  /** CSS selector inside the dialog to focus first; defaults to its first focusable element. */
  initialFocus?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const dialogRef = useModalDialog<HTMLElement>(onClose, initialFocus);
  return (
    <div className={backdropClassName} role="presentation">
      <section
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={className}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
