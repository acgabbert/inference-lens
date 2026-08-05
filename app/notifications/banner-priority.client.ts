/**
 * Which of the app's standing conditions gets the one banner slot.
 *
 * The banner is the loudest tier and the only one that displaces layout, so
 * there is exactly one of it. That constraint is the whole reason this module
 * exists: with six hand-rolled notices each deciding its own visibility, two
 * could stack and push the workbench down the page, and no single place stated
 * which one mattered more.
 *
 * Priority is the caller's argument order, because it is a product judgement
 * rather than a property of a banner: a failure the user cannot work around
 * outranks an environment advisory, which outranks an offer. What this module
 * adds is that losing is never silent — a suppressed condition is counted and
 * named, so the slot can say there is more behind it and the user is not left
 * to discover a second problem only after fixing the first.
 */

export type AppBannerTone = "failure" | "advisory";

export interface AppBannerAction {
  key: string;
  label: string;
  /** Resolves the condition. Rendered first and styled as the primary. */
  primary?: boolean;
  /**
   * Navigates rather than acting. Rendered as a link so it keeps the browser's
   * own affordances — opening in a new tab, copying the address.
   */
  href?: string;
  onSelect?(): void;
}

export interface AppBanner {
  /** Stable across renders of the same condition; used as the React key. */
  id: string;
  tone: AppBannerTone;
  title: string;
  detail?: string;
  actions: readonly AppBannerAction[];
}

export interface AppBannerSelection {
  banner: AppBanner;
  /**
   * Titles of the conditions this one displaced, in priority order. The slot
   * reports the count so suppression is visible; each returns to the slot on
   * its own once whatever outranked it is resolved or dismissed.
   */
  suppressed: readonly string[];
}

export function chooseAppBanner(
  candidates: readonly (AppBanner | undefined)[],
): AppBannerSelection | undefined {
  const present = candidates.filter(
    (candidate): candidate is AppBanner => candidate !== undefined,
  );
  const [banner, ...rest] = present;
  if (!banner) return undefined;
  return { banner, suppressed: rest.map(({ title }) => title) };
}
