"use client";

import { StatusChip } from "../notifications/status-chip.client";
import type { SuiteDraftState } from "./use-suite-drafts.client";

/**
 * Says the selected suite holds unsaved changes and offers Save and Discard
 * (slice 2c-1, C1). When the saved suite changed since the draft started it
 * offers Overwrite instead of Save (C4). Sits in the suite header, so it
 * scrolls with the suite like the preflight chip.
 */
export function SuiteDraftNotice({ state }: { state: SuiteDraftState }) {
  if (state.saving) {
    return <StatusChip tone="advisory" label="Unsaved changes" detail="Saving the suite…" />;
  }
  if (state.kind === "stale") {
    return (
      <StatusChip
        tone="failure"
        label="Suite changed elsewhere"
        detail={`${state.message ?? "Someone changed this suite since you started editing it."} Overwrite it with your version, or discard your changes.`}
        actions={[
          { key: "overwrite", label: "Overwrite with mine", onSelect: state.onOverwrite },
          { key: "discard", label: "Discard my draft", onSelect: state.onDiscard },
        ]}
      />
    );
  }
  return (
    <StatusChip
      tone="advisory"
      label="Unsaved changes"
      detail="Your edits to this suite stay on this device until you save them. Runs use them already."
      actions={[
        { key: "save", label: "Save suite", onSelect: state.onSave },
        { key: "discard", label: "Discard changes", onSelect: state.onDiscard },
      ]}
    />
  );
}
