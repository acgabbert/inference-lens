"use client";

import type { PromptTemplateRevisionDiff } from "../../packages/core/src/prompt-template-revision-diff";

/** Positional message, default, and import-provenance changes between two chat revisions. */
export function ChatRevisionDiff({ diff }: { diff: PromptTemplateRevisionDiff }) {
  const changedMessages = diff.messages.filter(({ status }) => status !== "identical");
  const changedDefaults = diff.variableDefaults.filter(({ status }) => status !== "identical");
  return <div className="template-revision-diff-body">
    {changedMessages.length > 0 && <section>
      <h4>Messages</h4>
      {changedMessages.map((message) => <details className="template-diff-message" key={message.index} open>
        <summary>Message {message.index + 1} · {message.status}{message.roleChanged ? ` · ${message.before!.role} → ${message.after!.role}` : ""}</summary>
        {message.content.truncated && <p className="diff-warning">This message exceeded the 4,000-line limit. Showing a whole-block replacement.</p>}
        <pre className="diff-code">{message.content.lines.map((line, index) => <span className={`diff-line ${line.kind}`} key={`${line.kind}-${index}`}><span className="diff-gutter" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><span>{line.text || " "}</span></span>)}</pre>
      </details>)}
    </section>}
    {changedDefaults.length > 0 && <section>
      <h4>Variable defaults</h4>
      <ul className="template-diff-defaults">{changedDefaults.map((value) => <li key={value.name}><code>{`{{${value.name}}}`}</code> · {value.status}<span>{value.before ?? "No default"} → {value.after ?? "No default"}</span></li>)}</ul>
    </section>}
    {diff.importProvenance.status !== "identical" && <p className="template-diff-provenance">Import provenance {diff.importProvenance.status}: {diff.importProvenance.beforePresent ? "imported" : "not imported"} → {diff.importProvenance.afterPresent ? "imported" : "not imported"}.</p>}
  </div>;
}
