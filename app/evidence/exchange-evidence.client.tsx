"use client";

import { useState } from "react";

import type { RedactedProviderRequest } from "../../packages/core/src/run-kernel";

/**
 * Presentation of one provider exchange's evidence, shared by every run kind.
 * It takes only exchange evidence: chat's event stream, tools, transcript,
 * comparison, and template resolution stay with chat's inspector.
 */

/**
 * Reformats the sent body for reading. The copy action deliberately does not
 * use this: comparing this workbench's request against another client's is only
 * conclusive on the bytes that were actually sent.
 */
function readableRequestBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * The exact request handed to the HTTP client, offered as one copy so it can be
 * diffed against whatever another client sends. Only the credential is
 * withheld, and the header block says so rather than omitting it silently.
 */
export function RequestEvidence({ request }: { request: RedactedProviderRequest }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyBody(): Promise<void> {
    if (!request.body) return;
    try {
      await navigator.clipboard.writeText(request.body);
      setStatus("copied");
    } catch {
      // Clipboard access is denied on insecure origins, where this workbench
      // is otherwise usable. Say so instead of appearing to have copied.
      setStatus("failed");
    }
  }

  return (
    <div className="request-evidence">
      <div className="request-evidence-header">
        <span>
          {request.method} {request.url}
        </span>
        {request.body && (
          <span className="request-evidence-actions">
            <button className="text-button" type="button" onClick={copyBody}>
              Copy raw request
            </button>
            <span aria-live="polite" className="request-evidence-status">
              {status === "copied"
                ? "Copied the exact bytes sent."
                : status === "failed"
                  ? "Copying needs clipboard access. Select the text below instead."
                  : ""}
            </span>
          </span>
        )}
      </div>
      {request.body && (
        <pre className="request-evidence-body">
          {readableRequestBody(request.body)}
        </pre>
      )}
      <p className="request-evidence-note">
        Reformatted for reading. Copy gives the exact bytes sent. Headers:{" "}
        {Object.entries(request.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join(", ")}
      </p>
    </div>
  );
}
