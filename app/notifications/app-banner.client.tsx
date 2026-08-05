"use client";

import type { AppBannerSelection } from "./banner-priority.client";
import styles from "./app-banner.module.css";

interface AppBannerProps {
  selection?: AppBannerSelection;
}

/**
 * The one banner slot: a standing condition the user must resolve or
 * acknowledge before the app is fully useful.
 *
 * There is exactly one, and `chooseAppBanner` decides which. That is the whole
 * point of the tier — a banner displaces the workbench down the page, so two of
 * them is a layout the app cannot afford and a priority nobody stated. When a
 * condition loses the slot its title is counted here rather than dropped, so a
 * user fixing the first problem knows a second is waiting.
 *
 * `alert` for a failure, `status` for an advisory: an advisory the user could
 * have been reading past for minutes should not interrupt a screen reader
 * mid-sentence, and a failure that just refused their work should.
 */
export function AppBanner({ selection }: AppBannerProps) {
  if (!selection) return null;
  const { banner, suppressed } = selection;
  return (
    <div
      className={`${styles.banner} ${styles[banner.tone]}`}
      // Names which condition holds the slot. The scoped class is hashed, so
      // this is what lets a spec assert the count *and* the winner rather than
      // inferring the tier from copy that is free to change.
      data-app-banner={banner.id}
      role={banner.tone === "failure" ? "alert" : "status"}
    >
      <div className={styles.copy}>
        <strong className={styles.title}>{banner.title}</strong>
        {banner.detail && <span className={styles.detail}>{banner.detail}</span>}
        {suppressed.length > 0 && (
          <span className={styles.suppressed}>
            {suppressed.length === 1
              ? "1 more notice is waiting behind this one."
              : `${suppressed.length} more notices are waiting behind this one.`}
          </span>
        )}
      </div>
      <div className={styles.actions}>
        {banner.actions.map((action) =>
          action.href ? (
            <a
              className={action.primary ? "button primary" : "button"}
              href={action.href}
              key={action.key}
              onClick={action.onSelect}
            >
              {action.label}
            </a>
          ) : (
            <button
              className={action.primary ? "button primary" : "button"}
              key={action.key}
              type="button"
              onClick={action.onSelect}
            >
              {action.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
