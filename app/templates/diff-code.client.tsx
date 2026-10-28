"use client";

import { useState } from "react";

import type { DiffLine } from "../../packages/core/src/text-diff";
import { foldDiffLines } from "./diff-folding";

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <span className={`diff-line ${line.kind}`}>
      <span className="diff-gutter" aria-hidden="true">
        {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
      </span>
      <span>{line.text || " "}</span>
    </span>
  );
}

/** A line diff whose long unchanged stretches fold behind a "Show N" row. */
export function FoldedDiffCode({ lines }: { lines: readonly DiffLine[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  return (
    <pre className="diff-code">
      {foldDiffLines(lines).flatMap((segment) =>
        segment.kind === "fold" && !expanded.has(segment.start)
          ? [
              <button
                className="diff-fold"
                key={`fold-${segment.start}`}
                type="button"
                onClick={() => setExpanded((current) => new Set(current).add(segment.start))}
              >
                <span aria-hidden="true">⋯</span> Show {segment.lines.length} unchanged lines
              </button>,
            ]
          : segment.lines.map((line, offset) => (
              <DiffLineRow key={segment.start + offset} line={line} />
            )),
      )}
    </pre>
  );
}
