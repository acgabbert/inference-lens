"use client";

import { useEffect } from "react";

export interface ConfirmationDialogRequest {
  title: string;
  description: string;
  details?: Array<{ label: string; value: string }>;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): void;
}

export function ConfirmationDialog({
  request,
  onClose,
}: {
  request: ConfirmationDialogRequest;
  onClose(): void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // This dialog is always layered on top of another overlay (e.g. the tool
      // registry modal). Listening on the capture phase and stopping
      // propagation here means this Escape press only dismisses the
      // confirmation, instead of also reaching the bubble-phase Escape
      // listener of whatever is underneath it and closing that too.
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose]);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        aria-labelledby="confirmation-title"
        aria-modal="true"
        className="confirmation-dialog"
        role="dialog"
      >
        <span className="eyebrow">Confirm change</span>
        <h2 id="confirmation-title">{request.title}</h2>
        <p>{request.description}</p>
        {request.details && request.details.length > 0 && (
          <dl className="confirmation-details">
            {request.details.map(({ label, value }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={request.destructive ? "button stop" : "button primary"}
            type="button"
            onClick={() => {
              onClose();
              request.onConfirm();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
