import type { DecisionInput, DecisionResult, DecisionRun } from "../../packages/core/src/decision";
import type { DisplayStatus } from "../run/response-view";
import type { JsonValue, RunTokenUsage } from "../../packages/core/src/run-kernel/types";

/**
 * What the decision result view renders (U5), derived from a run's input and
 * result. Pure, so the exact strings on screen can be checked against known
 * fixture values without a browser.
 */

export interface DecisionBar {
  key: string;
  label: string;
  probability: number;
  percent: string;
}

export type DecisionAnswerView =
  | {
      id: string;
      type: "choice";
      instructions: string;
      choice: string;
      /** Authored order, not sorted by probability (U5). */
      bars: (DecisionBar & { selected: boolean })[];
      confidence?: string;
    }
  | {
      id: string;
      type: "score";
      instructions: string;
      score: string;
      /** Where the marker sits on the level line, 0…1. */
      position: number;
      levelCount: number;
      bars: DecisionBar[];
      confidence?: string;
    }
  | {
      id: string;
      type: "noul";
      instructions: string;
      /** P(true). Noul has no confidence, and none is shown (U5). */
      bar: DecisionBar;
    }
  | { id: string; type: "missing"; instructions: string };

export function displayJson(value: JsonValue | null | undefined): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/** Finite probabilities only; anything else reads as missing rather than NaN. */
export function formatPercent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function bar(key: string, label: string, probability: number | undefined): DecisionBar {
  const finite = typeof probability === "number" && Number.isFinite(probability) ? probability : 0;
  return { key, label, probability: Math.min(1, Math.max(0, finite)), percent: formatPercent(probability) };
}

function confidence(value: number | undefined): { confidence?: string } {
  return typeof value === "number" && Number.isFinite(value) ? { confidence: formatPercent(value) } : {};
}

export function decisionAnswerViews(input: DecisionInput, result: DecisionResult): DecisionAnswerView[] {
  return Object.entries(input.questions).map(([id, question]): DecisionAnswerView => {
    const instructions = displayJson(question.instructions);
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) return { id, type: "missing", instructions };
    switch (answer.type) {
      case "choice": {
        const authored = question.type === "choice" ? Object.keys(question.criteria) : [];
        const labels = [...authored, ...Object.keys(answer.probabilities).filter((label) => !authored.includes(label))];
        return {
          id, type: "choice", instructions, choice: answer.choice,
          bars: labels.map((label) => ({ ...bar(label, label, answer.probabilities[label]), selected: label === answer.choice })),
          ...confidence(answer.confidence),
        };
      }
      case "score": {
        const criteria = question.type === "score" ? question.criteria : [];
        const levelCount = Math.max(criteria.length, Object.keys(answer.probabilities).length);
        const position = levelCount > 1 && Number.isFinite(answer.score)
          ? Math.min(1, Math.max(0, answer.score / (levelCount - 1)))
          : 0;
        return {
          id, type: "score", instructions,
          score: Number.isFinite(answer.score) ? answer.score.toFixed(2) : "—",
          position,
          levelCount,
          bars: Array.from({ length: levelCount }, (_, level) => {
            const key = String(level);
            // Labelled from the response's legend, else the asked criteria.
            const label = displayJson(answer.legend?.[key] ?? criteria[level] ?? key);
            return bar(key, `${level} · ${label}`, answer.probabilities[key]);
          }),
          ...confidence(answer.confidence),
        };
      }
      case "noul":
        return { id, type: "noul", instructions, bar: bar("true", "P(true)", answer.noul) };
    }
  });
}

export function formatDuration(startedAt: string | undefined, endedAt: string | undefined): string | undefined {
  if (!startedAt || !endedAt) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Reported usage only; a missing count stays missing rather than zero. */
export function formatUsage(usage: RunTokenUsage | undefined): string {
  if (!usage) return "Not reported";
  const parts = [
    usage.inputTokens !== undefined ? `${usage.inputTokens} input` : undefined,
    usage.outputTokens !== undefined ? `${usage.outputTokens} output` : undefined,
    usage.totalTokens !== undefined ? `${usage.totalTokens} total` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" · ")} tokens` : "Not reported";
}

/** The completed attempt's result, if the run has one. */
export function decisionRunResult(run: DecisionRun): DecisionResult | undefined {
  return run.attempts.find(({ status }) => status === "completed")?.result;
}

/** Chat's status vocabulary, so the pane chip and mobile dot read the same. */
export function decisionDisplayStatus(run: DecisionRun | null, executing: boolean): DisplayStatus {
  if (executing) return "running";
  if (!run) return "idle";
  switch (run.status.kind) {
    case "completed":
      return "complete";
    case "paused":
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "running";
  }
}
