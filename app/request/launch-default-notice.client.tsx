"use client";

import { StatusChip } from "../notifications/status-chip.client";

/** What the composer shows when the personal selection differs from the launch default. */
export interface LaunchDefaultState {
  /** Short names of what differs, in display order. */
  differences: readonly string[];
  /** Why the action is unavailable (T3); the chip then says so instead of offering it. */
  blockedReason?: string;
  saving: boolean;
  onUse(): void;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Says what a teammate or the CLI would get instead of what this composer
 * runs (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 5 decisions", T4).
 * Lives among the pane's notices, inside its scroll area.
 */
export function LaunchDefaultNotice({ state }: { state: LaunchDefaultState }) {
  const detail = `Your ${list(state.differences.map((item) => item.toLowerCase()))} ${state.differences.length === 1 ? "differs" : "differ"} from the project's launch default, which teammates and the CLI run.`;
  return (
    <StatusChip
      tone="advisory"
      label="Personal settings"
      detail={state.blockedReason ? `${detail} ${state.blockedReason}` : detail}
      actions={state.saving
        ? [{ key: "saving", label: "Saving…", onSelect() {} }]
        : state.blockedReason
          ? []
          : [{ key: "use", label: "Use as launch default…", onSelect: state.onUse }]}
    />
  );
}
