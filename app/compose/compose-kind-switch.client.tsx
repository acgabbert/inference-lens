"use client";

import type { KeyboardEvent } from "react";
import type { ComposeKind } from "./use-compose.client";

const KINDS: { id: ComposeKind; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "decision", label: "Decision" },
];

/**
 * The Chat / Decision request-kind switch inside Compose (U1), rendered in the
 * request pane's header beside its tabs. Locked while either kind executes
 * (D17), with the reason in visible text.
 */
export function ComposeKindSwitch({
  kind,
  locked,
  onChange,
}: {
  kind: ComposeKind;
  locked: boolean;
  onChange(kind: ComposeKind): void;
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || locked) return;
    event.preventDefault();
    const next = KINDS[(index + step + KINDS.length) % KINDS.length]!;
    onChange(next.id);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-compose-kind="${next.id}"]`)
      ?.focus();
  }

  return (
    <div className="compose-kind">
      <div
        aria-describedby={locked ? "compose-kind-locked" : undefined}
        aria-label="Request kind"
        className="pane-tabs compose-kind-switch"
        role="radiogroup"
      >
        {KINDS.map(({ id, label }, index) => (
          <button
            aria-checked={kind === id}
            className={kind === id ? "active" : undefined}
            data-compose-kind={id}
            disabled={locked && kind !== id}
            key={id}
            role="radio"
            tabIndex={kind === id ? 0 : -1}
            type="button"
            onClick={() => onChange(id)}
            onKeyDown={(event) => move(event, index)}
          >
            {label}
          </button>
        ))}
      </div>
      {locked && (
        <small className="compose-kind-locked" id="compose-kind-locked">
          Stop the running request to switch.
        </small>
      )}
    </div>
  );
}
