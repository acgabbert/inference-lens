"use client";

import { useState } from "react";
import type { ExternalImportReceipt, PromptTemplateMessages } from "../../packages/core/src/project";
import { copyFilePromptAsN8nText } from "../../packages/core/src/file-prompt-import";
import { ModalDialog } from "../modal-dialog.client";
import { WorkbenchPanel } from "../workbench-panel.client";

export function FilePromptCopy({ messages, receipts }: { messages: PromptTemplateMessages; receipts: ExternalImportReceipt[] }) {
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const result = copyFilePromptAsN8nText(messages, receipts);
  return <>
    <div className="file-prompt-actions">
      <span>Imported from {receipts.at(-1)?.source.resource.name}</span>
      <button type="button" className="button secondary" onClick={() => { setCopyStatus(""); setOpen(true); }}>Copy as n8n text…</button>
    </div>
    {open && <ModalDialog backdropClassName="file-prompt-backdrop" className="file-prompt-dialog" labelledBy="file-copy-title" onClose={() => setOpen(false)}>
      <WorkbenchPanel header={<h2 id="file-copy-title">Copy as n8n text</h2>}>
        <div className="file-prompt-body">
          <p>Apply this text to your source file yourself.</p>
          {result.ok ? <>
            <label>n8n text<textarea readOnly rows={12} value={result.text} /></label>
            <button className="button secondary" type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(result.text); setCopyStatus("Copied"); }
              catch { setCopyStatus("Clipboard access is unavailable. Select the text above to copy it."); }
            }}>Copy text</button>
            <p role="status">{copyStatus}</p>
          </> : <p role="alert">{result.message}</p>}
          <div className="file-prompt-actions"><button className="button secondary" type="button" onClick={() => setOpen(false)}>Close</button></div>
        </div>
      </WorkbenchPanel>
    </ModalDialog>}
  </>;
}
