"use client";

import type { RequestMenu, RequestMenuTarget } from "./request-menu.ts";
import styles from "./request-switcher.module.css";

interface RequestSwitcherProps {
  /** "request" or "decision request", for the labels. */
  noun: string;
  menu: RequestMenu;
  /** Why switching is unavailable now, such as a run in progress. */
  disabledReason?: string;
  onSelect(target: RequestMenuTarget): void;
}

/**
 * Which request the composer edits (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md,
 * "Step 5 decisions", T1). One entry per saved request opens its draft or its
 * newest revision; the selected request's revisions sit in a second list;
 * local requests have their own group. Switching moves only the personal
 * selection, never the launch default.
 */
export function RequestSwitcher({ noun, menu, disabledReason, onSelect }: RequestSwitcherProps) {
  const selectedRequest = menu.selectedKey?.startsWith("request:")
    ? menu.requests.find(({ requestId }) => `request:${requestId}` === menu.selectedKey)
    : undefined;
  const showRevisions = selectedRequest && (selectedRequest.revisions.length > 1 || selectedRequest.draft);
  const disabled = Boolean(disabledReason);
  const capitalized = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <div className={styles.switcher} title={disabledReason}>
      <label>
        {capitalized}
        <select
          disabled={disabled}
          value={menu.selectedKey ?? ""}
          onChange={(event) => {
            const key = event.target.value;
            if (key.startsWith("scratch:")) {
              onSelect({ kind: "scratch", scratchId: key.slice("scratch:".length) });
              return;
            }
            const request = menu.requests.find(({ requestId }) => `request:${requestId}` === key);
            if (request) onSelect(request.open);
          }}
        >
          {!menu.selectedKey && <option value="">No {noun} selected</option>}
          {menu.requests.length > 0 && (
            <optgroup label={`Saved ${noun}s`}>
              {menu.requests.map((request) => (
                <option key={request.requestId} value={`request:${request.requestId}`}>
                  {request.name}
                  {request.launchDefault ? " (launch default)" : ""}
                  {request.draft ? " · unsaved changes" : ""}
                </option>
              ))}
            </optgroup>
          )}
          {menu.scratches.length > 0 && (
            <optgroup label="On this device">
              {menu.scratches.map(({ scratchId, label }) => (
                <option key={scratchId} value={`scratch:${scratchId}`}>{label}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {showRevisions && (
        <label>
          Revision
          <select
            disabled={disabled}
            value={menu.selectedRevisionKey ?? ""}
            onChange={(event) => {
              const key = event.target.value;
              if (key === "draft" && selectedRequest.draft) onSelect({ kind: "draft", draftId: selectedRequest.draft.draftId });
              else if (key) onSelect({ kind: "saved", revisionId: key });
            }}
          >
            {selectedRequest.draft && <option value="draft">Unsaved changes</option>}
            {selectedRequest.revisions.map(({ revisionId, ordinal, launchDefault }) => (
              <option key={revisionId} value={revisionId}>
                Revision {ordinal}{launchDefault ? " (launch default)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
