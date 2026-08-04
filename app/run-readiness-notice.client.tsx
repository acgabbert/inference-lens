"use client";

import { BlockerChip } from "./blocker-chip.client";
import type {
  RunReadiness,
  RunReadinessAction,
} from "./run-readiness.client.ts";

/**
 * The id of the chip's summary line. The Run button lives in the topbar, and a
 * disabled button carries only a native tooltip — invisible on touch and
 * unreachable from the keyboard — so the button points at this text instead of
 * restating the reason itself.
 */
export const RUN_READINESS_SUMMARY_ID = "run-readiness-summary";

/**
 * Compose's readiness policy, rendered as the shared blocker chip.
 *
 * This file is the adapter and nothing else: it decides which part of a
 * `RunReadiness` is the visible reason and which parts explain it. The
 * headline is the reason, the primary action's own label is the fix, and the
 * prose detail, the rule behind it, and the facts sit behind the disclosure.
 */
interface RunReadinessNoticeProps {
  readiness?: RunReadiness;
  onAction(action: RunReadinessAction): void;
}

export function RunReadinessNotice({
  readiness,
  onAction,
}: RunReadinessNoticeProps) {
  if (!readiness) return null;
  const { blocked, headline, detail, explanation, facts, actions } = readiness;
  return (
    <div className="run-readiness-slot">
      <BlockerChip
        label="Run readiness"
        tone={blocked ? "blocked" : "advisory"}
        // A refused run is a state the user arrives at, not one they author
        // keystroke by keystroke, so it is announced assertively.
        assertive
        summary={headline}
        summaryId={RUN_READINESS_SUMMARY_ID}
        // Readiness reports the one condition to act on first, so the chip
        // stands for exactly one thing however many rules were evaluated.
        issues={[headline]}
        detail={detail}
        {...(explanation ? { explanation } : {})}
        facts={facts}
        actions={actions.map((action) => ({
          key: action.kind,
          label: action.label,
          ...(action.primary ? { primary: true as const } : {}),
          onSelect: () => onAction(action),
        }))}
      />
    </div>
  );
}
