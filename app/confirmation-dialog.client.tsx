"use client";

import { ModalDialog } from "./modal-dialog.client";

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
  return (
    <ModalDialog className="confirmation-dialog" labelledBy="confirmation-title" onClose={onClose}>
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
    </ModalDialog>
  );
}
