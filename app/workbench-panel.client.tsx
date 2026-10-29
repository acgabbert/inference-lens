"use client";

import type { ReactNode, Ref, UIEventHandler } from "react";

type WorkbenchPanelProps = {
  /** Rendered as the header's eyebrow and `h2` when the pane names itself. */
  eyebrow?: string;
  title?: string;
  /** The rest of the header row: kind switch, tabs, status, header actions. */
  header?: ReactNode;
  headerClassName?: string;
  /**
   * Readiness notices, pins, storage notices and action rows. They open the
   * scroll area rather than sitting above it: a fixed sibling of a flex
   * scroller shrinks the scroller, not itself, so on a short window a stack of
   * them leaves the content below the fold out of reach.
   */
  notices?: ReactNode;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  children: ReactNode;
};

/**
 * A workbench pane's header and its one scroll viewport.
 *
 * Only the header sits outside the scroll area; everything else, notices
 * included, scrolls with the content. The caller owns the surrounding element,
 * because the panes differ there (a focus-mode dialog, a section inside the
 * response pane), and that element is a flex column the scroll area fills.
 */
export function WorkbenchPanel({
  eyebrow,
  title,
  header,
  headerClassName,
  notices,
  scrollClassName,
  scrollRef,
  onScroll,
  children,
}: WorkbenchPanelProps) {
  return (
    <>
      <div className={headerClassName ? `panel-header ${headerClassName}` : "panel-header"}>
        {title !== undefined && (
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
        )}
        {header}
      </div>
      <div
        className={scrollClassName ? `pane-scroll ${scrollClassName}` : "pane-scroll"}
        ref={scrollRef}
        onScroll={onScroll}
      >
        {notices}
        {children}
      </div>
    </>
  );
}
