"use client";

import type { DecisionTemplateRevisionDiff } from "../../packages/core/src/decision-template-revision-diff";

type TextDiff = DecisionTemplateRevisionDiff["state"];
type QuestionDiff = DecisionTemplateRevisionDiff["questions"][number];

function DiffText({ diff }: { diff: TextDiff }) {
  return (
    <pre className="diff-code">
      {diff.lines.map((line, index) => (
        <span className={`diff-line ${line.kind}`} key={index}>
          <span className="diff-gutter" aria-hidden="true">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
          </span>
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}

function positionChange(entry: QuestionDiff): string {
  if (entry.beforeIndex === entry.afterIndex) return "";
  const before = entry.beforeIndex === undefined ? "new" : entry.beforeIndex + 1;
  const after = entry.afterIndex === undefined ? "removed" : entry.afterIndex + 1;
  return ` · position ${before} → ${after}`;
}

/** Ordered decision content and default changes between two revisions. */
export function DecisionRevisionDiff({ diff }: { diff: DecisionTemplateRevisionDiff }) {
  const questions = diff.questions.filter(
    (entry) => entry.status !== "identical" || entry.beforeIndex !== entry.afterIndex,
  );
  const defaults = diff.variableDefaults.filter(({ status }) => status !== "identical");
  return (
    <div className="template-revision-diff-body">
      {diff.identical && <p>These revisions have identical decision content and defaults.</p>}
      {!diff.state.identical && (
        <section>
          <h4>State</h4>
          <DiffText diff={diff.state} />
        </section>
      )}
      {diff.questionOrderChanged && <p>Question ordering changed.</p>}
      {questions.map((entry) => (
        <section key={entry.id}>
          <h4>
            {entry.id} · {entry.status}
            {positionChange(entry)}
          </h4>
          {(entry.status === "added" || entry.status === "removed") && (
            <p>Type: {entry.after?.type ?? entry.before?.type}</p>
          )}
          {entry.typeChanged && (
            <p>
              Type: {entry.before?.type} → {entry.after?.type}
            </p>
          )}
          {!entry.instructions.identical && (
            <>
              <h5>Instructions</h5>
              <DiffText diff={entry.instructions} />
            </>
          )}
          {!entry.criteria.identical && (
            <>
              <h5>Criteria and ordering</h5>
              <DiffText diff={entry.criteria} />
            </>
          )}
        </section>
      ))}
      {defaults.map((entry) => (
        <p key={entry.name}>
          <code>{`{{${entry.name}}}`}</code> · {entry.status}: {entry.before ?? "No default"} →{" "}
          {entry.after ?? "No default"}
        </p>
      ))}
    </div>
  );
}
