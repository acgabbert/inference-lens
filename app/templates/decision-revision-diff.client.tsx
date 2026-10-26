"use client";

import type { DecisionTemplateRevisionDiff } from "../../packages/core/src/decision-template-revision-diff";

export function DecisionRevisionDiff({ diff }: { diff: DecisionTemplateRevisionDiff }) {
  const text = (value: DecisionTemplateRevisionDiff["state"]) => <pre className="diff-code">{value.lines.map((line, index) => <span className={`diff-line ${line.kind}`} key={index}><span className="diff-gutter" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>{line.text || " "}</span>)}</pre>;
  return <div className="template-revision-diff-body">
    {diff.identical && <p>These revisions have identical decision content and defaults.</p>}
    {!diff.state.identical && <section><h4>State</h4>{text(diff.state)}</section>}
    {diff.questionOrderChanged && <p>Question ordering changed.</p>}
    {diff.questions.filter((entry) => entry.status !== "identical" || entry.beforeIndex !== entry.afterIndex).map((entry) => <section key={entry.id}><h4>{entry.id} · {entry.status}{entry.beforeIndex !== entry.afterIndex ? ` · position ${entry.beforeIndex === undefined ? "new" : entry.beforeIndex + 1} → ${entry.afterIndex === undefined ? "removed" : entry.afterIndex + 1}` : ""}</h4>{(entry.status === "added" || entry.status === "removed") && <p>Type: {entry.after?.type ?? entry.before?.type}</p>}{entry.typeChanged && <p>Type: {entry.before?.type} → {entry.after?.type}</p>}{!entry.instructions.identical && <><h5>Instructions</h5>{text(entry.instructions)}</>}{!entry.criteria.identical && <><h5>Criteria and ordering</h5>{text(entry.criteria)}</>}</section>)}
    {diff.variableDefaults.filter(({ status }) => status !== "identical").map((entry) => <p key={entry.name}><code>{`{{${entry.name}}}`}</code> · {entry.status}: {entry.before ?? "No default"} → {entry.after ?? "No default"}</p>)}
  </div>;
}
