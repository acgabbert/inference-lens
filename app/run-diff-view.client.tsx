"use client";

import type {
  AttemptDiff,
  DiffCandidate,
  DiffSection,
  ScalarValue,
} from "../packages/core/src/run-diff";
import type { RunId } from "../packages/core/src/run-kernel";
import {
  ABSENT,
  attemptLabel,
  formatDuration,
  formatTokens,
} from "./run-metrics-format.client";

export interface RunDiffViewProps {
  diff: AttemptDiff | null;
  candidates: DiffCandidate[];
  leftKey?: string;
  rightKey?: string;
  onSelect(side: "left" | "right", key: string): void;
  parent: {
    available: boolean;
    runId?: RunId;
    status: "idle" | "loading" | "ready" | "error";
    error?: string;
  };
  onLoadParent(): void;
}

export function diffCandidateKey(candidate: DiffCandidate): string {
  return `${candidate.runId}:${candidate.exchangeId}`;
}

function CandidateSelect({
  side,
  value,
  oppositeKey,
  candidates,
  onSelect,
}: {
  side: "left" | "right";
  value?: string;
  oppositeKey?: string;
  candidates: DiffCandidate[];
  onSelect(side: "left" | "right", key: string): void;
}) {
  const groups = new Map<string, DiffCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.runId}:${candidate.runLabel}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const selected = candidates.find((candidate) => diffCandidateKey(candidate) === value);
  const label = selected
    ? `${side === "left" ? "Attempt A" : "Attempt B"} · ${selected.runLabel === "Parent run" ? "Parent" : "Current"}`
    : side === "left" ? "Attempt A" : "Attempt B";

  return (
    <label className="diff-picker">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onSelect(side, event.target.value)}>
        <option value="">Select an attempt</option>
        {[...groups.entries()].map(([groupKey, group]) => (
          <optgroup key={groupKey} label={group[0]!.runLabel}>
            {group.map((candidate) => (
              <option
                key={diffCandidateKey(candidate)}
                disabled={diffCandidateKey(candidate) === oppositeKey}
                value={diffCandidateKey(candidate)}
              >
                {attemptLabel(candidate)} · {candidate.status}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function formatScalar(value?: ScalarValue): string {
  if (!value) return ABSENT;
  if (value.kind === "duration") return formatDuration(value.ms);
  if (value.kind === "tokens") return formatTokens(value.count);
  return value.text;
}

function SectionDiff({ section }: { section: DiffSection }) {
  const count = section.diff
    ? `+${section.diff.addedCount} / −${section.diff.removedCount}`
    : undefined;
  return (
    <details className={`diff-section ${section.status}`}>
      <summary>
        <span className={`diff-status ${section.status}`} aria-hidden="true" />
        <span>
          {section.label}
          {section.normalized && (
            <span className="diff-normalized"> normalized JSON</span>
          )}
        </span>
        <span className="diff-section-meta">
          {section.status}
          {count ? ` · ${count}` : ""}
        </span>
      </summary>
      {section.status === "absent" ? (
        <p className="diff-absent">Neither attempt captured this evidence.</p>
      ) : (
        <>
          {section.diff?.truncated && (
            <p className="diff-warning">
              This input exceeded the 4,000-line limit. Showing a whole-block
              replacement instead of a computed line diff.
            </p>
          )}
          <pre className="diff-code">
            {section.diff?.lines.map((line, index) => (
              <span
                className={`diff-line ${line.kind}`}
                key={`${line.kind}:${line.leftLine ?? ""}:${line.rightLine ?? ""}:${index}`}
              >
                <span className="diff-gutter" aria-hidden="true">
                  {line.kind === "added"
                    ? "+"
                    : line.kind === "removed"
                      ? "−"
                      : " "}
                </span>
                <span>{line.text || " "}</span>
              </span>
            ))}
          </pre>
        </>
      )}
    </details>
  );
}

export function RunDiffView({
  diff,
  candidates,
  leftKey,
  rightKey,
  onSelect,
  parent,
  onLoadParent,
}: RunDiffViewProps) {
  if (candidates.length === 0) {
    return (
      <p className="trace-empty">
        Attempt comparison will appear after a provider request is captured.
      </p>
    );
  }

  return (
    <div className="run-diff">
      <p className="diff-description">
        Compare provider attempts from this run, or compare this branch with its parent.
      </p>
      <div className="diff-controls">
        <CandidateSelect
          side="left"
          value={leftKey}
          oppositeKey={rightKey}
          candidates={candidates}
          onSelect={onSelect}
        />
        <CandidateSelect
          side="right"
          value={rightKey}
          oppositeKey={leftKey}
          candidates={candidates}
          onSelect={onSelect}
        />
        {parent.available && parent.status !== "ready" && (
          <div className="diff-parent-load">
            <p>Parent/current comparison is available for parent run {parent.runId}.</p>
            <button
              className="secondary diff-load-parent"
              type="button"
              disabled={parent.status === "loading"}
              onClick={onLoadParent}
            >
              {parent.status === "loading" ? "Loading parent…" : "Load parent run"}
            </button>
          </div>
        )}
      </div>

      {parent.status === "error" && (
        <p className="diff-parent-error" role="alert">{parent.error}</p>
      )}

      {!diff ? (
        <p className="diff-prompt">Choose two different attempts to compare.</p>
      ) : (
        <>
          {diff.sameTurn && (
            <p className="diff-note">
              The request is identical because a retry reuses the same turn input;
              inspect the error, output, timing, and usage differences below.
            </p>
          )}
          {!diff.scalars.some((comparison) => comparison.changed) &&
            !diff.sections.some((section) => section.status !== "identical" && section.status !== "absent") && (
              <p className="diff-note">No captured differences between these attempts.</p>
            )}
          <div className="run-metrics-table-scroll">
            <table className="run-metrics-table diff-scalars">
              <caption className="visually-hidden">Attempt scalar comparison</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {diff.scalars.map((comparison) => (
                  <tr
                    key={comparison.id}
                    data-changed={comparison.changed ? "true" : undefined}
                  >
                    <th scope="row">
                      {comparison.label}
                      {comparison.changed && (
                        <span className="visually-hidden"> changed</span>
                      )}
                    </th>
                    <td>{formatScalar(comparison.left)}</td>
                    <td>{formatScalar(comparison.right)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="diff-sections">
            {diff.sections.map((section) => (
              <SectionDiff key={section.id} section={section} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
