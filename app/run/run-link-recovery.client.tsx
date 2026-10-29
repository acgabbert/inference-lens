"use client";
import { useState } from "react";
import { ModalDialog } from "../modal-dialog.client";
import type { useRunDeepLink } from "./use-run-deep-link.client";
export function RunLinkRecovery({ links }: { links: ReturnType<typeof useRunDeepLink> }) {
  const state = links.state;
  if (!state || state.status === "ready") return null;
  return <section className="run-link-recovery" aria-label="Saved run link">
    <h2>Open saved run</h2>
    {state.reference && <p>Project <code>{state.reference.projectId}</code> · Run <code>{state.reference.runId}</code></p>}
    <p role="status">{state.message}</p>
    {state.locations?.map(location => <div key={location.locationId}>
      <button type="button" className="button secondary" onClick={() => void links.choose(location)}>Reconnect {location.displayName} · {location.handle.name}</button>
      <button type="button" className="text-button" onClick={() => void links.forget(location.locationId)}>Forget location</button>
    </div>)}
    {state.reference && state.status !== "resolving" && <div className="confirmation-actions">
      <button type="button" className="button secondary" onClick={() => void links.locate()}>Locate project folder…</button>
      <button type="button" className="button secondary" onClick={links.retry}>{state.status === "handed-off" ? "Open here instead" : "Retry"}</button>
    </div>}
    <button type="button" className="text-button" onClick={() => links.cancel()}>Dismiss link</button>
  </section>;
}
export function OpenRunLinkDialog({ open, onClose, onOpen }: { open: boolean; onClose(): void; onOpen(text: string): void }) {
  const [value, setValue] = useState("");
  if (!open) return null;
  return <ModalDialog className="confirmation-dialog" labelledBy="open-run-link-title" onClose={onClose}>
    <h2 id="open-run-link-title">Open saved run link</h2>
    <p>Paste a browser or inference-lens:// run link. The saved evidence must be available in a local project folder.</p>
    <label>Run link<input value={value} onChange={event => setValue(event.target.value)} autoFocus /></label>
    <div className="confirmation-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={!value.trim()} onClick={() => { onOpen(value); onClose(); }}>Open link</button></div>
  </ModalDialog>;
}

export function RunLinkControls({ links }: { links: ReturnType<typeof useRunDeepLink> }) {
  return <>
    <RunLinkRecovery links={links} />
    <OpenRunLinkDialog open={links.pasteOpen} onClose={links.closePaste} onOpen={links.open} />
  </>;
}
