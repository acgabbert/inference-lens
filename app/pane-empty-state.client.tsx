"use client";

interface PaneEmptyStateProps {
  /** Names which pane this is, when the pane doesn't already say so nearby. */
  eyebrow?: string;
  /** A single glyph shown in the existing empty-state circle. Defaults to the
   *  arrow used elsewhere in the app for "this fills in from elsewhere." */
  icon?: string;
  heading: string;
  detail: string;
  /** Only pass this when the pane owns a genuine primary action. A pane that
   *  fills as a side effect of something else (a run trace, an attempt diff)
   *  should omit it and explain itself with `detail` alone. */
  action?: { label: string; onClick(): void };
}

/**
 * The one empty-state shape shared by panes that can legitimately start with
 * zero items — a first-run project has no tools, no suites, no saved runs.
 * Centralizing the markup here means every such pane looks native to this
 * app instead of hand-rolling its own "nothing here" box, and a filtered or
 * still-loading collection is never routed through this component: those
 * are different situations with different copy, decided by the caller.
 */
export function PaneEmptyState({
  eyebrow,
  icon = "↗",
  heading,
  detail,
  action,
}: PaneEmptyStateProps) {
  return (
    <div className="pane-empty-state">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <span className="empty-glyph" aria-hidden="true">
        {icon}
      </span>
      <h3>{heading}</h3>
      <p>{detail}</p>
      {action && (
        <button
          className="button primary"
          type="button"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
