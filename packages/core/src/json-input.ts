import type { JsonValue } from "./run-kernel/types.ts";

export type JsonInputPolicy = "strict" | "surrounding-fence" | "first-json-fence";
export type JsonInputPath = "whole-answer" | "surrounding-fence" | "first-json-fence";
export type JsonTopLevel = "object" | "array" | "string" | "number" | "boolean" | "null";

/** Safe to include in evidence; it contains no answer text or engine messages. */
export interface JsonInputDiagnostic {
  code: "invalid-json";
  message: string;
}

/** Parsed values are temporary evaluation inputs, never persisted evidence. */
export type JsonInputResult =
  | {
      valid: true;
      value: JsonValue;
      topLevel: JsonTopLevel;
      inputPolicy: JsonInputPolicy;
      path: JsonInputPath;
    }
  | {
      valid: false;
      inputPolicy: JsonInputPolicy;
      diagnostic: JsonInputDiagnostic;
    };

function topLevel(value: JsonValue): JsonTopLevel {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as JsonTopLevel;
}

interface Fence {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

/** Scan delimiter lines, leaving the enclosed JSON text intact. */
function firstJsonFence(text: string): Fence | undefined {
  let block: {
    marker: string;
    width: number;
    recognized: boolean;
    start: number;
    bodyStart: number;
  } | undefined;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(start, newline === -1 ? end : newline).trim();
    const marker = line[0];
    let width = 0;
    if (marker === "`" || marker === "~") {
      while (line[width] === marker) width += 1;
    }
    const suffix = line.slice(width);
    if (block) {
      const closes = marker === block.marker && suffix === "" &&
        (block.recognized ? width === 3 : width >= block.width);
      if (closes) {
        if (block.recognized) return { start: block.start, bodyStart: block.bodyStart, bodyEnd: start, end };
        block = undefined;
      }
    } else if (width >= 3) {
      block = {
        marker, width, start, bodyStart: end,
        recognized: marker === "`" && width === 3 && (suffix === "" || suffix.toLowerCase() === "json"),
      };
    }
    start = end;
  }
  return undefined;
}

export function parseJsonInput(
  text: string,
  inputPolicy: JsonInputPolicy = "strict",
): JsonInputResult {
  try {
    const value: JsonValue = JSON.parse(text);
    return { valid: true, value, topLevel: topLevel(value), inputPolicy, path: "whole-answer" };
  } catch {
    // Engine messages can contain answer fragments. Only owned diagnostics escape.
  }
  if (inputPolicy !== "strict") {
    const fence = firstJsonFence(text);
    const surrounds = fence !== undefined &&
      text.slice(0, fence.start).trim() === "" && text.slice(fence.end).trim() === "";
    if (fence && (inputPolicy === "first-json-fence" || surrounds)) {
      try {
        const value: JsonValue = JSON.parse(text.slice(fence.bodyStart, fence.bodyEnd));
        return { valid: true, value, topLevel: topLevel(value), inputPolicy, path: inputPolicy };
      } catch {
        // Never search a later block after the selected block fails to parse.
      }
    }
  }
  return {
    valid: false,
    inputPolicy,
    diagnostic: {
      code: "invalid-json",
      message: "Final assistant output is not valid JSON under the selected input policy.",
    },
  };
}
