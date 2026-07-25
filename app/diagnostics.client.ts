"use client";

import type { InferenceRequest } from "../packages/core/src/types.ts";

/** Boundaries the client observes while a request is in flight. */
export type DiagnosticBoundary =
  | "client.request_started"
  | "client.retry_started"
  | "client.response_received"
  | "client.ndjson_record_received"
  | "client.stream_finished"
  | "client.request_aborted"
  | "client.request_failed"
  | "client.stop_requested";

export type DiagnosticRecord = {
  index: number;
  recordedAt: string;
  boundary: DiagnosticBoundary;
  detail?: unknown;
};

/**
 * An exportable trace of one request's client-side boundaries. Captures are
 * downloaded by users and attached to bug reports, so every value entering a
 * capture passes through `redactDiagnosticValue` first. Message bodies are
 * deliberately preserved; credentials never are.
 */
export type DiagnosticCapture = {
  schemaVersion: 1;
  startedAt: string;
  request: InferenceRequest;
  records: DiagnosticRecord[];
};

/**
 * Matched as substrings, so vendor-prefixed header names redact without being
 * enumerated: `x-api-key`, `anthropic-api-key`, `x-goog-api-key`, Azure's
 * `api-key`. A key is never a legitimate value to report, so over-matching
 * here is the safe direction.
 */
const secretKeyPatterns = ["apikey", "api_key", "api-key"];

/**
 * Matched exactly. `token` and `access_token` deliberately stay exact so token
 * accounting (`totalTokens`, `total_tokens`, `tokenCount`) survives into a
 * report, where it is often the reason the report was filed.
 */
const secretKeys = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "access_token",
];

/** Credential-bearing query parameters beyond those `isSecretKey` covers. */
const secretQueryParameters = ["secret"];

const redacted = "••••";

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    secretKeys.includes(normalized) ||
    secretKeyPatterns.some((pattern) => normalized.includes(pattern))
  );
}

function isSecretQueryParameter(key: string): boolean {
  return isSecretKey(key) || secretQueryParameters.includes(key.toLowerCase());
}

/**
 * Recursively replaces credential-bearing values with a placeholder. Keys are
 * matched case-insensitively; `endpoint` and `url` values keep their shape so
 * a report still shows which host was called.
 */
export function redactDiagnosticValue(value: unknown, key?: string): unknown {
  if (key && isSecretKey(key)) {
    return redacted;
  }
  if (key === "endpoint" || key === "url") {
    return redactDiagnosticUrl(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactDiagnosticValue(entryValue, entryKey),
    ]),
  );
}

/** Strips credentials passed as query parameters, leaving the URL readable. */
export function redactDiagnosticUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretQueryParameter(key)) {
        url.searchParams.set(key, redacted);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function startDiagnosticCapture(
  request: InferenceRequest,
): DiagnosticCapture {
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    request: redactDiagnosticValue(request) as InferenceRequest,
    records: [],
  };
}

export function recordDiagnostic(
  capture: DiagnosticCapture,
  boundary: DiagnosticBoundary,
  detail?: unknown,
): void {
  capture.records.push({
    index: capture.records.length,
    recordedAt: new Date().toISOString(),
    boundary,
    detail: detail === undefined ? undefined : redactDiagnosticValue(detail),
  });
}
