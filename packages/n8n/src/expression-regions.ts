export interface N8nExpressionRegion {
  expression: string;
  startOffset: number;
  endOffset: number;
}

export type N8nExpressionScan =
  | { ok: true; regions: N8nExpressionRegion[] }
  | { ok: false; errorOffset: number; reason: string };

type ScanMode =
  | { kind: "code"; braceDepth: number; templateExpression: boolean }
  | { kind: "single-quote" | "double-quote" | "template" }
  | { kind: "line-comment" | "block-comment" };

const MISSING_DELIMITER = "Expression is missing its closing }} delimiter.";
const UNSUPPORTED_REGEX =
  "Regular expression literals are not supported in n8n expressions.";

/**
 * Finds {{...}} n8n regions without evaluating JavaScript. Offsets are UTF-16
 * string offsets, so callers can use them directly with String#slice.
 */
export function scanN8nExpressionRegions(source: string): N8nExpressionScan {
  const regions: N8nExpressionRegion[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const startOffset = source.indexOf("{{", cursor);
    if (startOffset < 0) break;
    const modes: ScanMode[] = [
      { kind: "code", braceDepth: 0, templateExpression: false },
    ];
    let index = startOffset + 2;
    let endOffset: number | undefined;
    while (index < source.length) {
      const mode = modes.at(-1)!;
      const character = source[index]!;
      const next = source[index + 1];
      if (mode.kind === "single-quote" || mode.kind === "double-quote") {
        const quote = mode.kind === "single-quote" ? "'" : '"';
        if (character === "\\") index += 2;
        else if (character === quote) {
          modes.pop();
          index += 1;
        } else index += 1;
        continue;
      }
      if (mode.kind === "template") {
        if (character === "\\") index += 2;
        else if (character === "`") {
          modes.pop();
          index += 1;
        } else if (character === "$" && next === "{") {
          modes.push({ kind: "code", braceDepth: 0, templateExpression: true });
          index += 2;
        } else index += 1;
        continue;
      }
      if (mode.kind === "line-comment") {
        if (character === "\n" || character === "\r") modes.pop();
        index += 1;
        continue;
      }
      if (mode.kind === "block-comment") {
        if (character === "*" && next === "/") {
          modes.pop();
          index += 2;
        } else index += 1;
        continue;
      }
      if (mode.kind !== "code") {
        throw new Error("Unreachable n8n expression scanner mode.");
      }
      if (!mode.templateExpression && mode.braceDepth === 0 && character === "}" && next === "}") {
        endOffset = index + 2;
        break;
      }
      if (character === "'") {
        modes.push({ kind: "single-quote" });
        index += 1;
      } else if (character === '"') {
        modes.push({ kind: "double-quote" });
        index += 1;
      } else if (character === "`") {
        modes.push({ kind: "template" });
        index += 1;
      } else if (character === "/" && next === "/") {
        modes.push({ kind: "line-comment" });
        index += 2;
      } else if (character === "/" && next === "*") {
        modes.push({ kind: "block-comment" });
        index += 2;
      } else if (character === "/") {
        return { ok: false, errorOffset: index, reason: UNSUPPORTED_REGEX };
      } else if (character === "{") {
        mode.braceDepth += 1;
        index += 1;
      } else if (character === "}") {
        if (mode.braceDepth > 0) mode.braceDepth -= 1;
        else if (mode.templateExpression) modes.pop();
        index += 1;
      } else index += 1;
    }
    if (endOffset === undefined) {
      return { ok: false, errorOffset: startOffset, reason: MISSING_DELIMITER };
    }
    regions.push({ expression: source.slice(startOffset, endOffset), startOffset, endOffset });
    cursor = endOffset;
  }
  return { ok: true, regions };
}
