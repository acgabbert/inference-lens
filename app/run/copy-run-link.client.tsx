"use client";
import { useEffect, useRef, useState } from "react";
import type { RunId } from "../../packages/core/src/run-kernel/types.ts";
import { savedRunReferenceForWorkspace, type ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { browserRunLink } from "./run-link-url.client.ts";
interface CopyState { workspace: ProjectWorkspaceHandle; runId: RunId; message?: string; fallback?: string; busy?: boolean }
export function CopyRunLink({ workspace, runId, saved }: { workspace: ProjectWorkspaceHandle | null; runId: RunId; saved: boolean }) {
  const [result, setResult] = useState<CopyState>();
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [workspace, runId]);
  const visible = result?.workspace === workspace && result.runId === runId ? result : undefined;
  const eligible = saved && workspace?.kind === "browser-directory";
  async function copy() {
    if (!workspace || !eligible) return;
    const token = ++generation.current;
    const update = (state: Omit<CopyState, "workspace" | "runId">) => {
      if (token === generation.current) setResult({ workspace, runId, ...state });
    };
    update({ busy: true });
    try {
      const ref = await savedRunReferenceForWorkspace(workspace, runId);
      if (token !== generation.current) return;
      const url = browserRunLink(ref, location.href);
      try { await navigator.clipboard.writeText(url); update({ message: "Link copied" }); }
      catch { update({ fallback: url, message: "Clipboard unavailable. Copy the link below." }); }
    } catch (error) { update({ message: error instanceof Error ? error.message : "Could not create a saved run link." }); }
  }
  if (workspace?.kind === "tauri-directory") return null;
  // Sits in the pane header, so the ineligibility reason is the button's title
  // rather than a line of its own.
  return <div className="run-link-copy">
    <button className="button secondary" disabled={!eligible || visible?.busy} type="button"
      title={eligible ? undefined : "Finish and save the run to a project folder before copying a link."}
      onClick={() => void copy()}>Copy link</button>
    {visible?.message && <p role="status">{visible.message}</p>}
    {visible?.fallback && <label>Saved run link<input readOnly value={visible.fallback} onFocus={event => event.currentTarget.select()} /></label>}
  </div>;
}
