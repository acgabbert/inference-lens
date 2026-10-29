"use client";

import { useEffect, useState } from "react";

const STATUS_RESET_MS = 2000;

/**
 * Copies model output exactly as produced. The pane renders it as Markdown, so
 * selecting the rendered text loses the syntax; this hands back the source.
 *
 * Clicks and keys stop here because a transcript message header toggles the
 * message on both, and copying should not collapse what is being copied.
 */
export function CopySourceButton({ text, className }: { text: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const id = window.setTimeout(() => setStatus("idle"), STATUS_RESET_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      // Clipboard access is denied on insecure origins, where this workbench
      // is otherwise usable. Say so instead of appearing to have copied.
      setStatus("failed");
    }
  }

  return (
    <span
      className={className ? `copy-source ${className}` : "copy-source"}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="copy-source-status" role="status">
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copying needs clipboard access. Switch to Raw and select the text."
            : ""}
      </span>
      <button className="text-button" type="button" onClick={copy}>
        Copy Markdown
      </button>
    </span>
  );
}
