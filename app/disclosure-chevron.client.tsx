"use client";

/**
 * Shared disclosure affordance. Drawn rather than typed because U+2304's ink
 * sits high in its em box, which a bordered square exposes as off-centre.
 * The caller owns the box and rotation so open and closed remain one object
 * turning rather than two glyphs swapping.
 */
export function DisclosureChevron({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={className}>
      <svg viewBox="0 0 10 10" width="10" height="10" fill="none">
        <path
          d="M2 3.5l3 3 3-3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
