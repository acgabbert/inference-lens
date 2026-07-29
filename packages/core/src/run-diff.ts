import type {
  ExchangeId,
  ModelTurnAttemptState,
  RunId,
  RunState,
  TurnId,
} from "./run-kernel/types.ts";
import {
  runMetrics,
  type AttemptMetricStatus,
  type AttemptMetrics,
} from "./run-metrics.ts";
import { stableJsonValue } from "./stable-json.ts";
import { diffLines, type TextDiff } from "./text-diff.ts";

export interface DiffCandidate {
  runId: RunId;
  runLabel: string;
  turnId: TurnId;
  turnIndex: number;
  attempt: number;
  exchangeId: ExchangeId;
  status: AttemptMetricStatus;
}

export type ScalarValue =
  | { kind: "duration"; ms: number }
  | { kind: "tokens"; count: number }
  | { kind: "text"; text: string };

export interface ScalarComparison {
  id: string;
  label: string;
  left?: ScalarValue;
  right?: ScalarValue;
  changed: boolean;
}

export type DiffSectionStatus =
  | "identical"
  | "changed"
  | "left-only"
  | "right-only"
  | "absent";

export interface DiffSection {
  id: "request" | "output" | "reasoning" | "toolCalls";
  label: string;
  status: DiffSectionStatus;
  normalized: boolean;
  diff?: TextDiff;
}

export interface AttemptDiff {
  left: DiffCandidate;
  right: DiffCandidate;
  sameRun: boolean;
  sameTurn: boolean;
  scalars: ScalarComparison[];
  sections: DiffSection[];
}

export function diffCandidates(
  state: RunState,
  runLabel: string,
): DiffCandidate[] {
  return runMetrics(state).attempts.map((attempt) => ({
    runId: state.runId,
    runLabel,
    turnId: attempt.turnId,
    turnIndex: attempt.turnIndex,
    attempt: attempt.attempt,
    exchangeId: attempt.exchangeId,
    status: attempt.status,
  }));
}

function candidateAttempt(
  state: RunState,
  candidate: DiffCandidate,
): ModelTurnAttemptState {
  const attempt = state.turns
    .find(({ turnId }) => turnId === candidate.turnId)
    ?.attempts.find(
      (item) =>
        item.attempt === candidate.attempt &&
        item.exchangeId === candidate.exchangeId,
    );
  if (!attempt) {
    throw new Error(
      `Attempt ${candidate.exchangeId} does not belong to run ${state.runId}.`,
    );
  }
  return attempt;
}

function candidateMetrics(
  state: RunState,
  candidate: DiffCandidate,
): AttemptMetrics {
  const metrics = runMetrics(state).attempts.find(
    ({ exchangeId }) => exchangeId === candidate.exchangeId,
  );
  if (!metrics) {
    throw new Error(`Metrics are unavailable for ${candidate.exchangeId}.`);
  }
  return metrics;
}

function canonicalJsonText(text: string): {
  text: string;
  normalized: boolean;
} {
  try {
    return {
      text: JSON.stringify(stableJsonValue(JSON.parse(text)), null, 2),
      normalized: true,
    };
  } catch {
    return { text, normalized: false };
  }
}

function canonicalArguments(text: string): string {
  try {
    return JSON.stringify(stableJsonValue(JSON.parse(text)), null, 2);
  } catch {
    return text;
  }
}

function toolCallText(attempt: ModelTurnAttemptState): string | undefined {
  const completed = attempt.completedToolCalls;
  if (completed?.length) {
    return completed
      .map((call) => {
        const argumentsText = call.arguments.parsed
          ? JSON.stringify(stableJsonValue(call.arguments.parsed), null, 2)
          : canonicalArguments(call.arguments.text);
        return `${call.name}(${argumentsText})`;
      })
      .join("\n\n");
  }
  if (attempt.toolCalls.length === 0) return undefined;
  return attempt.toolCalls
    .map(
      (call) =>
        `${call.name}(${canonicalArguments(call.argumentsText)})`,
    )
    .join("\n\n");
}

function section(
  id: DiffSection["id"],
  label: string,
  left: { text?: string; normalized?: boolean; present?: boolean },
  right: { text?: string; normalized?: boolean; present?: boolean },
): DiffSection {
  const leftPresent =
    left.present ?? (left.text !== undefined && left.text !== "");
  const rightPresent =
    right.present ?? (right.text !== undefined && right.text !== "");
  const normalized =
    id === "request"
      ? (leftPresent || rightPresent) &&
        left.normalized !== false &&
        right.normalized !== false
      : false;

  if (!leftPresent && !rightPresent) {
    return { id, label, status: "absent", normalized };
  }
  const diff = diffLines(left.text ?? "", right.text ?? "");
  const status: DiffSectionStatus =
    !leftPresent
      ? "right-only"
      : !rightPresent
        ? "left-only"
        : diff.identical
          ? "identical"
          : "changed";
  return { id, label, status, normalized, diff };
}

function textValue(text?: string): ScalarValue | undefined {
  return text === undefined || text === "" ? undefined : { kind: "text", text };
}

function durationValue(ms?: number): ScalarValue | undefined {
  return ms === undefined ? undefined : { kind: "duration", ms };
}

function tokenValue(count?: number): ScalarValue | undefined {
  return count === undefined ? undefined : { kind: "tokens", count };
}

function sameScalar(
  left: ScalarValue | undefined,
  right: ScalarValue | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scalar(
  id: string,
  label: string,
  left: ScalarValue | undefined,
  right: ScalarValue | undefined,
): ScalarComparison {
  return { id, label, left, right, changed: !sameScalar(left, right) };
}

function finishReasonText(attempt: ModelTurnAttemptState): string | undefined {
  const finish = attempt.finishReason;
  if (!finish) return undefined;
  return finish.raw && finish.raw !== finish.normalized
    ? `${finish.normalized} (${finish.raw})`
    : finish.normalized;
}

function errorText(attempt: ModelTurnAttemptState): string | undefined {
  return attempt.error
    ? `${attempt.error.code}: ${attempt.error.message}`
    : undefined;
}

export function diffAttempts(
  left: { state: RunState; candidate: DiffCandidate },
  right: { state: RunState; candidate: DiffCandidate },
): AttemptDiff {
  const leftAttempt = candidateAttempt(left.state, left.candidate);
  const rightAttempt = candidateAttempt(right.state, right.candidate);
  const leftMetrics = candidateMetrics(left.state, left.candidate);
  const rightMetrics = candidateMetrics(right.state, right.candidate);
  const leftRequestBody =
    left.state.exchanges[left.candidate.exchangeId]?.request?.body;
  const rightRequestBody =
    right.state.exchanges[right.candidate.exchangeId]?.request?.body;
  const leftRequest =
    leftRequestBody === undefined
      ? {}
      : { ...canonicalJsonText(leftRequestBody), present: true };
  const rightRequest =
    rightRequestBody === undefined
      ? {}
      : { ...canonicalJsonText(rightRequestBody), present: true };

  return {
    left: left.candidate,
    right: right.candidate,
    sameRun: left.state.runId === right.state.runId,
    sameTurn:
      left.state.runId === right.state.runId &&
      left.candidate.turnId === right.candidate.turnId,
    scalars: [
      scalar(
        "status",
        "Status",
        textValue(left.candidate.status),
        textValue(right.candidate.status),
      ),
      scalar(
        "finishReason",
        "Finish reason",
        textValue(finishReasonText(leftAttempt)),
        textValue(finishReasonText(rightAttempt)),
      ),
      scalar(
        "ttfb",
        "Time to first byte",
        durationValue(leftMetrics.ttfbMs),
        durationValue(rightMetrics.ttfbMs),
      ),
      scalar(
        "ttfo",
        "Time to first output",
        durationValue(leftMetrics.ttfoMs),
        durationValue(rightMetrics.ttfoMs),
      ),
      scalar(
        "duration",
        "Duration",
        durationValue(leftMetrics.durationMs),
        durationValue(rightMetrics.durationMs),
      ),
      scalar(
        "inputTokens",
        "Input tokens",
        tokenValue(leftMetrics.usage?.inputTokens),
        tokenValue(rightMetrics.usage?.inputTokens),
      ),
      scalar(
        "outputTokens",
        "Output tokens",
        tokenValue(leftMetrics.usage?.outputTokens),
        tokenValue(rightMetrics.usage?.outputTokens),
      ),
      scalar(
        "totalTokens",
        "Total tokens",
        tokenValue(leftMetrics.usage?.totalTokens),
        tokenValue(rightMetrics.usage?.totalTokens),
      ),
      scalar(
        "error",
        "Error",
        textValue(errorText(leftAttempt)),
        textValue(errorText(rightAttempt)),
      ),
    ],
    sections: [
      section("request", "Request body", leftRequest, rightRequest),
      section(
        "output",
        "Assistant output",
        { text: leftAttempt.text },
        { text: rightAttempt.text },
      ),
      section(
        "reasoning",
        "Reasoning",
        { text: leftAttempt.reasoning },
        { text: rightAttempt.reasoning },
      ),
      section(
        "toolCalls",
        "Tool calls",
        { text: toolCallText(leftAttempt) },
        { text: toolCallText(rightAttempt) },
      ),
    ],
  };
}
