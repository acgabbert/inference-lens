"use client";

import { useId } from "react";

import type { ToolAttachmentDestination } from "../request/use-request-draft.client";

/**
 * The one question every attach route asks, worded the same everywhere.
 * "This tab only" is the default: attaching to the project changes a saved
 * project default that every run in the project picks up.
 */
export function AttachDestinationControl({
  value,
  onChange,
  disabled,
}: {
  value: ToolAttachmentDestination;
  onChange(value: ToolAttachmentDestination): void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="attach-destination" disabled={disabled}>
      <legend>Attach to</legend>
      <label>
        <input type="radio" name={name} checked={value === "request"} onChange={() => onChange("request")} />
        This tab only
      </label>
      <label>
        <input type="radio" name={name} checked={value === "project"} onChange={() => onChange("project")} />
        Project
      </label>
      <small>
        {value === "request"
          ? "Kept across runs in this tab; cleared on reload or opening a different project."
          : "Saved with the project and attached to every run in it."}
      </small>
    </fieldset>
  );
}
