export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  leftLine?: number;
  rightLine?: number;
}

export interface TextDiff {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  identical: boolean;
  /** True when the line cap forced a whole-block replacement. */
  truncated: boolean;
}

export const TEXT_DIFF_LINE_CAP = 4_000;

function textLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function wholeBlockReplace(left: string[], right: string[]): TextDiff {
  return {
    lines: [
      ...left.map((text, index): DiffLine => ({
        kind: "removed",
        text,
        leftLine: index + 1,
      })),
      ...right.map((text, index): DiffLine => ({
        kind: "added",
        text,
        rightLine: index + 1,
      })),
    ],
    addedCount: right.length,
    removedCount: left.length,
    identical: left.length === 0 && right.length === 0,
    truncated: true,
  };
}

/**
 * Computes a deterministic line-oriented LCS diff. The direction table is one
 * byte per cell; two compact rows hold LCS lengths while it is constructed.
 */
export function diffLines(leftText: string, rightText: string): TextDiff {
  if (leftText === rightText) {
    const lines = textLines(leftText).map((text, index): DiffLine => ({
      kind: "context",
      text,
      leftLine: index + 1,
      rightLine: index + 1,
    }));
    return {
      lines,
      addedCount: 0,
      removedCount: 0,
      identical: true,
      truncated: false,
    };
  }

  const left = textLines(leftText);
  const right = textLines(rightText);
  if (
    left.length > TEXT_DIFF_LINE_CAP ||
    right.length > TEXT_DIFF_LINE_CAP
  ) {
    return wholeBlockReplace(left, right);
  }

  const width = right.length + 1;
  const directions = new Uint8Array((left.length + 1) * width);
  let next = new Uint16Array(width);

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    const current = new Uint16Array(width);
    for (
      let rightIndex = right.length - 1;
      rightIndex >= 0;
      rightIndex -= 1
    ) {
      const cell = leftIndex * width + rightIndex;
      if (left[leftIndex] === right[rightIndex]) {
        current[rightIndex] = next[rightIndex + 1] + 1;
        directions[cell] = 1;
      } else if (next[rightIndex] >= current[rightIndex + 1]) {
        current[rightIndex] = next[rightIndex];
        directions[cell] = 2;
      } else {
        current[rightIndex] = current[rightIndex + 1];
        directions[cell] = 3;
      }
    }
    next = current;
  }

  const lines: DiffLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  let addedCount = 0;
  let removedCount = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const direction =
      leftIndex < left.length && rightIndex < right.length
        ? directions[leftIndex * width + rightIndex]
        : leftIndex < left.length
          ? 2
          : 3;
    if (direction === 1) {
      lines.push({
        kind: "context",
        text: left[leftIndex]!,
        leftLine: leftIndex + 1,
        rightLine: rightIndex + 1,
      });
      leftIndex += 1;
      rightIndex += 1;
    } else if (direction === 2) {
      lines.push({
        kind: "removed",
        text: left[leftIndex]!,
        leftLine: leftIndex + 1,
      });
      removedCount += 1;
      leftIndex += 1;
    } else {
      lines.push({
        kind: "added",
        text: right[rightIndex]!,
        rightLine: rightIndex + 1,
      });
      addedCount += 1;
      rightIndex += 1;
    }
  }

  return {
    lines,
    addedCount,
    removedCount,
    identical: false,
    truncated: false,
  };
}
