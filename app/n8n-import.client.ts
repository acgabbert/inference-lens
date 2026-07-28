"use client";

import { z } from "zod";

import {
  externalPromptCandidateSchema,
} from "../packages/core/src/external-prompt-import.ts";

const N8N_API_ROOT = "/api/integrations/n8n";

const workflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    active: z.boolean().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const executionSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    status: z.string().optional(),
    mode: z.string().optional(),
    finished: z.boolean().optional(),
    startedAt: z.string().optional(),
    stoppedAt: z.string().optional(),
    retryOf: z.string().optional(),
  })
  .strict();

const statusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }).strict(),
  z
    .object({
      state: z.literal("misconfigured"),
      message: z.string(),
    })
    .strict(),
  z.object({ state: z.literal("configured") }).strict(),
]);

const workflowPageSchema = z
  .object({
    workflows: z.array(workflowSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

const executionPageSchema = z
  .object({
    executions: z.array(executionSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

const invocationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    version: z.string().optional(),
    runIndex: z.number().int().nonnegative().optional(),
    itemIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

const extractionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("candidate"),
      candidate: externalPromptCandidateSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      invocation: invocationSchema,
      code: z.enum([
        "unsupported-node-version",
        "unsupported-node-configuration",
        "incompatible-node-snapshot",
      ]),
      message: z.string(),
    })
    .strict(),
]);

const discoverySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }).strict(),
  z
    .object({
      status: z.enum([
        "no-supported-invocations",
        "workflow-incompatible",
      ]),
      message: z.string(),
    })
    .strict(),
]);

const selectedExecutionSchema = z
  .object({
    execution: executionSchema,
    detailAvailable: z.boolean(),
    discovery: discoverySchema,
    extractions: z.array(extractionSchema),
  })
  .strict();

const errorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type N8nImportStatus = z.infer<typeof statusSchema>;
export type N8nWorkflow = z.infer<typeof workflowSchema>;
export type N8nExecution = z.infer<typeof executionSchema>;
export type N8nPromptExtraction = z.infer<typeof extractionSchema>;
export type N8nSelectedExecution = z.infer<typeof selectedExecutionSchema>;

export class N8nImportClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = "N8nImportClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsedError = errorSchema.safeParse(body);
    if (parsedError.success) {
      throw new N8nImportClientError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        {
          retryable: parsedError.data.error.retryable,
          status: response.status,
        },
      );
    }
    throw new N8nImportClientError(
      "response-incompatible",
      `The n8n integration request failed (${response.status}).`,
      { status: response.status },
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new N8nImportClientError(
      "response-incompatible",
      "The n8n integration returned an incompatible response.",
    );
  }
  return parsed.data;
}

function cursorQuery(cursor?: string): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
}

export function loadN8nImportStatus(
  signal?: AbortSignal,
): Promise<N8nImportStatus> {
  return requestJson(`${N8N_API_ROOT}/status`, statusSchema, { signal });
}

export function loadN8nWorkflows(
  cursor?: string,
  signal?: AbortSignal,
): Promise<{ workflows: N8nWorkflow[]; nextCursor?: string }> {
  return requestJson(
    `${N8N_API_ROOT}/workflows${cursorQuery(cursor)}`,
    workflowPageSchema,
    { signal },
  );
}

export function loadN8nExecutions(
  workflowId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<{ executions: N8nExecution[]; nextCursor?: string }> {
  const query = new URLSearchParams({ workflowId });
  if (cursor) query.set("cursor", cursor);
  return requestJson(
    `${N8N_API_ROOT}/executions?${query}`,
    executionPageSchema,
    { signal },
  );
}

export function loadN8nExecutionDetail(
  workflowId: string,
  executionId: string,
  signal?: AbortSignal,
): Promise<N8nSelectedExecution> {
  return requestJson(
    `${N8N_API_ROOT}/execution-detail`,
    selectedExecutionSchema,
    {
      method: "POST",
      body: JSON.stringify({ workflowId, executionId }),
      signal,
    },
  );
}
