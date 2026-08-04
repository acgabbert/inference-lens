"use client";

/**
 * The affordance a native `details` marker — and a plain toggle button — is too
 * quiet to provide. Drawn rather than typed: U+2304's ink sits high in its em
 * box, which a bordered square exposes as an off-centre glyph. `currentColor`
 * keeps it on the theme tokens.
 *
 * The caller owns the box and the rotation, so open and closed stay the same
 * object turning rather than two glyphs swapping.
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
