import { z } from "zod";

import {
  validateSameOrigin,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "./request-security.ts";
import type { WorkbenchRequestPolicy } from "./request-security.ts";
import {
  extractN8nPromptCandidates,
  parseN8nWorkflowSnapshot,
} from "./n8n-prompt-extractors.ts";
import type { N8nPromptExtraction } from "./n8n-prompt-extractors.ts";

export const N8N_BASE_URL_VARIABLE = "INFERENCE_LENS_N8N_BASE_URL";
export const N8N_API_KEY_VARIABLE = "INFERENCE_LENS_N8N_API_KEY";

const DEFAULT_TIMEOUT_MS = 15_000;
const LIST_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const DETAIL_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const REQUEST_BODY_LIMIT_BYTES = 4 * 1024;
const PAGE_SIZE = 50;

export type N8nIntegrationErrorCode =
  | "configuration-unavailable"
  | "configuration-invalid"
  | "request-invalid"
  | "authentication-failed"
  | "permission-denied"
  | "resource-not-found"
  | "rate-limited"
  | "request-timeout"
  | "remote-unavailable"
  | "response-too-large"
  | "response-incompatible";

export class N8nIntegrationError extends Error {
  readonly code: N8nIntegrationErrorCode;
  readonly retryable: boolean;

  constructor(
    code: N8nIntegrationErrorCode,
    message: string,
    { retryable = false, cause }: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "N8nIntegrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface N8nConnection {
  baseUrl: URL;
  apiKey: string;
}

export interface N8nExecutionLinkSelection {
  workflowId: string;
  executionId: string;
}

export type N8nConfiguration =
  | { state: "unavailable" }
  | { state: "misconfigured"; message: string }
  | { state: "configured"; connection: N8nConnection };

export type PublicN8nConfiguration =
  | { state: "unavailable" }
  | { state: "misconfigured"; message: string }
  | { state: "configured" };

function parseN8nBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new N8nIntegrationError(
      "configuration-invalid",
      `${N8N_BASE_URL_VARIABLE} must be a valid HTTP or HTTPS URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new N8nIntegrationError(
      "configuration-invalid",
      `${N8N_BASE_URL_VARIABLE} must use HTTP or HTTPS.`,
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new N8nIntegrationError(
      "configuration-invalid",
      `${N8N_BASE_URL_VARIABLE} must not contain credentials, a query, or a fragment.`,
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.pathname.endsWith("/api/v1")) {
    throw new N8nIntegrationError(
      "configuration-invalid",
      `${N8N_BASE_URL_VARIABLE} must exclude the /api/v1 suffix.`,
    );
  }
  return parsed;
}

export function parseN8nConfiguration(
  environment: Record<string, string | undefined>,
): N8nConfiguration {
  const baseUrl = environment[N8N_BASE_URL_VARIABLE]?.trim();
  const apiKey = environment[N8N_API_KEY_VARIABLE]?.trim();
  if (!baseUrl && !apiKey) return { state: "unavailable" };
  if (!baseUrl || !apiKey) {
    return {
      state: "misconfigured",
      message: `Set both ${N8N_BASE_URL_VARIABLE} and ${N8N_API_KEY_VARIABLE}, or leave both unset.`,
    };
  }
  try {
    return {
      state: "configured",
      connection: { baseUrl: parseN8nBaseUrl(baseUrl), apiKey },
    };
  } catch (error) {
    return {
      state: "misconfigured",
      message:
        error instanceof N8nIntegrationError
          ? error.message
          : "The n8n integration configuration is invalid.",
    };
  }
}

export class EnvironmentN8nCredentialSource {
  readonly #environment: Record<string, string | undefined>;

  constructor(environment: Record<string, string | undefined>) {
    this.#environment = environment;
  }

  publicConfiguration(): PublicN8nConfiguration {
    const configuration = parseN8nConfiguration(this.#environment);
    if (configuration.state !== "configured") return configuration;
    return { state: "configured" };
  }

  resolve(): N8nConnection {
    const configuration = parseN8nConfiguration(this.#environment);
    if (configuration.state === "configured") return configuration.connection;
    if (configuration.state === "misconfigured") {
      throw new N8nIntegrationError(
        "configuration-invalid",
        configuration.message,
      );
    }
    throw new N8nIntegrationError(
      "configuration-unavailable",
      "The n8n integration is not configured.",
    );
  }
}

const opaqueIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{1,160}$/,
    "must contain only letters, numbers, underscores, or hyphens",
  );
const dateTimeSchema = z.iso.datetime({ offset: true });
const looseObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).catchall(z.unknown());

const workflowSummarySchema = looseObject({
  id: opaqueIdSchema,
  name: z.string(),
  active: z.boolean().optional(),
  createdAt: dateTimeSchema.optional(),
  updatedAt: dateTimeSchema.optional(),
});
const executionSummarySchema = looseObject({
  id: opaqueIdSchema,
  workflowId: opaqueIdSchema,
  status: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  finished: z.boolean().optional(),
  startedAt: dateTimeSchema.optional(),
  stoppedAt: dateTimeSchema.nullable().optional(),
  retryOf: opaqueIdSchema.nullable().optional(),
});
const pageSchema = <T extends z.ZodType>(item: T) =>
  looseObject({
    data: z.array(item),
    nextCursor: z.string().nullable().optional(),
  });
const workflowDetailSchema = looseObject({
  id: opaqueIdSchema,
  name: z.string(),
  active: z.boolean().optional(),
  nodes: z.array(z.unknown()),
  connections: z.record(z.string(), z.unknown()),
});
const executionDetailSchema = looseObject({
  id: opaqueIdSchema,
  workflowId: opaqueIdSchema,
  status: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  finished: z.boolean().optional(),
  startedAt: dateTimeSchema.optional(),
  stoppedAt: dateTimeSchema.nullable().optional(),
  data: z.unknown().optional(),
});

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface N8nExecutionSummary {
  id: string;
  workflowId: string;
  status?: string;
  mode?: string;
  finished?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  retryOf?: string;
}

export interface N8nPage<T> {
  items: T[];
  nextCursor?: string;
}

export type N8nWorkflowDetail = z.infer<typeof workflowDetailSchema>;
export type N8nExecutionDetail = z.infer<typeof executionDetailSchema>;

function workflowSummary(
  value: z.infer<typeof workflowSummarySchema>,
): N8nWorkflowSummary {
  return {
    id: value.id,
    name: value.name,
    ...(value.active === undefined ? {} : { active: value.active }),
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

function executionSummary(
  value: z.infer<typeof executionSummarySchema>,
): N8nExecutionSummary {
  return {
    id: value.id,
    workflowId: value.workflowId,
    ...(value.status ? { status: value.status } : {}),
    ...(value.mode ? { mode: value.mode } : {}),
    ...(value.finished === undefined ? {} : { finished: value.finished }),
    ...(value.startedAt ? { startedAt: value.startedAt } : {}),
    ...(value.stoppedAt ? { stoppedAt: value.stoppedAt } : {}),
    ...(value.retryOf ? { retryOf: value.retryOf } : {}),
  };
}

function validateOpaqueId(value: string, label: string): string {
  const parsed = opaqueIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new N8nIntegrationError(
      "request-invalid",
      `${label} ${parsed.error.issues[0]?.message ?? "is invalid"}.`,
    );
  }
  return parsed.data;
}

export function parseN8nExecutionLink(
  configuredBaseUrl: URL,
  value: string,
): N8nExecutionLinkSelection {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new N8nIntegrationError(
      "request-invalid",
      "Execution link must be a valid absolute URL.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new N8nIntegrationError(
      "request-invalid",
      "Execution link must be an HTTP or HTTPS URL without credentials.",
    );
  }

  const basePath = configuredBaseUrl.pathname.replace(/\/+$/, "");
  if (
    parsed.origin !== configuredBaseUrl.origin ||
    (basePath &&
      parsed.pathname !== basePath &&
      !parsed.pathname.startsWith(`${basePath}/`))
  ) {
    throw new N8nIntegrationError(
      "request-invalid",
      "Execution link does not belong to the configured n8n instance.",
    );
  }

  const relativePath = parsed.pathname.slice(basePath.length);
  const match = relativePath.match(
    /^\/workflow\/([^/]+)\/executions\/([^/]+)\/?$/,
  );
  if (!match) {
    throw new N8nIntegrationError(
      "request-invalid",
      "Execution link must point to a saved n8n workflow execution.",
    );
  }

  let workflowId: string;
  let executionId: string;
  try {
    workflowId = decodeURIComponent(match[1] ?? "");
    executionId = decodeURIComponent(match[2] ?? "");
  } catch (error) {
    throw new N8nIntegrationError(
      "request-invalid",
      "Execution link contains an invalid encoded ID.",
      { cause: error },
    );
  }
  return {
    workflowId: validateOpaqueId(workflowId, "Workflow ID"),
    executionId: validateOpaqueId(executionId, "Execution ID"),
  };
}

function validateCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new N8nIntegrationError(
      "request-invalid",
      "Pagination cursor is invalid.",
    );
  }
  return value;
}

function buildN8nApiUrl(
  baseUrl: URL,
  pathSegments: readonly string[],
  query?: URLSearchParams,
): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/v1/${pathSegments
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  url.search = query?.toString() ?? "";
  return url;
}

async function readBoundedBody(
  response: Response,
  limitBytes: number,
): Promise<string> {
  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new N8nIntegrationError(
      "response-too-large",
      `The n8n response exceeded the ${limitBytes}-byte limit.`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel();
      throw new N8nIntegrationError(
        "response-too-large",
        `The n8n response exceeded the ${limitBytes}-byte limit.`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function remoteStatusError(status: number): N8nIntegrationError {
  if (status === 401) {
    return new N8nIntegrationError(
      "authentication-failed",
      "n8n rejected the configured API key.",
    );
  }
  if (status === 403) {
    return new N8nIntegrationError(
      "permission-denied",
      "The configured n8n API key does not have permission for this resource.",
    );
  }
  if (status === 404) {
    return new N8nIntegrationError(
      "resource-not-found",
      "The selected n8n resource was not found.",
    );
  }
  if (status === 429) {
    return new N8nIntegrationError(
      "rate-limited",
      "n8n rate-limited the request.",
      { retryable: true },
    );
  }
  return new N8nIntegrationError(
    "remote-unavailable",
    `n8n returned HTTP ${status}.`,
    { retryable: status >= 500 },
  );
}

export interface N8nClientOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export class N8nClient {
  readonly #connection: N8nConnection;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(connection: N8nConnection, options: N8nClientOptions = {}) {
    this.#connection = connection;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #request(
    pathSegments: readonly string[],
    query: URLSearchParams | undefined,
    responseLimitBytes: number,
    schema: z.ZodType,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", relayAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(
        buildN8nApiUrl(this.#connection.baseUrl, pathSegments, query),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "X-N8N-API-KEY": this.#connection.apiKey,
          },
          redirect: "manual",
          signal: controller.signal,
        },
      );

      if (response.status >= 300 && response.status < 400) {
        throw new N8nIntegrationError(
          "remote-unavailable",
          "n8n returned a redirect; redirects are refused.",
        );
      }
      if (!response.ok) {
        // Never reflect a remote error body. It may contain credentials,
        // workflow data, or deployment topology.
        throw remoteStatusError(response.status);
      }

      const body = await readBoundedBody(response, responseLimitBytes);
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch (error) {
        throw new N8nIntegrationError(
          "response-incompatible",
          "n8n returned invalid JSON.",
          { cause: error },
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new N8nIntegrationError(
          "response-incompatible",
          "The n8n response does not match the supported public API shape.",
          { cause: parsed.error },
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof N8nIntegrationError) throw error;
      if (timedOut) {
        throw new N8nIntegrationError(
          "request-timeout",
          "The n8n request timed out.",
          { retryable: true, cause: error },
        );
      }
      throw new N8nIntegrationError(
        "remote-unavailable",
        callerSignal?.aborted
          ? "The n8n request was cancelled."
          : "The n8n instance could not be reached.",
        { retryable: !callerSignal?.aborted, cause: error },
      );
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", relayAbort);
    }
  }

  async listWorkflows(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<N8nPage<N8nWorkflowSummary>> {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE),
      excludePinnedData: "true",
    });
    const safeCursor = validateCursor(cursor);
    if (safeCursor) query.set("cursor", safeCursor);
    const page = (await this.#request(
      ["workflows"],
      query,
      LIST_RESPONSE_LIMIT_BYTES,
      pageSchema(workflowSummarySchema),
      signal,
    )) as z.infer<ReturnType<typeof pageSchema<typeof workflowSummarySchema>>>;
    return {
      items: page.data.map(workflowSummary),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async listExecutions(
    workflowId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<N8nPage<N8nExecutionSummary>> {
    const safeWorkflowId = validateOpaqueId(workflowId, "Workflow ID");
    const query = new URLSearchParams({
      workflowId: safeWorkflowId,
      includeData: "false",
      limit: String(PAGE_SIZE),
    });
    const safeCursor = validateCursor(cursor);
    if (safeCursor) query.set("cursor", safeCursor);
    const page = (await this.#request(
      ["executions"],
      query,
      LIST_RESPONSE_LIMIT_BYTES,
      pageSchema(executionSummarySchema),
      signal,
    )) as {
      data: Array<z.infer<typeof executionSummarySchema>>;
      nextCursor?: string | null;
    };
    return {
      items: page.data.map(executionSummary),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async getWorkflow(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<N8nWorkflowDetail> {
    return (await this.#request(
      ["workflows", validateOpaqueId(workflowId, "Workflow ID")],
      undefined,
      DETAIL_RESPONSE_LIMIT_BYTES,
      workflowDetailSchema,
      signal,
    )) as N8nWorkflowDetail;
  }

  async getExecution(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<N8nExecutionDetail> {
    return (await this.#request(
      ["executions", validateOpaqueId(executionId, "Execution ID")],
      new URLSearchParams({ includeData: "true" }),
      DETAIL_RESPONSE_LIMIT_BYTES,
      executionDetailSchema,
      signal,
    )) as N8nExecutionDetail;
  }
}

export interface N8nSelectedExecution {
  execution: N8nExecutionSummary;
  detailAvailable: boolean;
  discovery:
    | { status: "ready" }
    | {
        status: "no-supported-invocations" | "workflow-incompatible";
        message: string;
      };
  extractions: N8nPromptExtraction[];
}

export async function loadN8nSelectedExecution(
  client: N8nClient,
  workflowId: string,
  executionId: string,
  signal?: AbortSignal,
): Promise<N8nSelectedExecution> {
  const safeWorkflowId = validateOpaqueId(workflowId, "Workflow ID");
  const detail = await client.getExecution(executionId, signal);
  if (detail.workflowId !== safeWorkflowId) {
    throw new N8nIntegrationError(
      "request-invalid",
      "The selected execution does not belong to the selected workflow.",
    );
  }
  const detailAvailable = detail.data !== undefined && detail.data !== null;
  const data = detail.data;
  const executionWorkflowSnapshot =
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "workflowData" in data
      ? parseN8nWorkflowSnapshot(data.workflowData)
      : undefined;
  const currentWorkflow = executionWorkflowSnapshot
    ? undefined
    : await client.getWorkflow(safeWorkflowId, signal);
  const currentWorkflowSnapshot = currentWorkflow
    ? parseN8nWorkflowSnapshot(currentWorkflow)
    : undefined;
  const extractions = await extractN8nPromptCandidates(
    detail,
    currentWorkflow,
  );
  const discovery: N8nSelectedExecution["discovery"] =
    !executionWorkflowSnapshot && !currentWorkflowSnapshot
      ? {
          status: "workflow-incompatible",
          message:
            "The saved and current workflow snapshots are not compatible with this importer.",
        }
      : extractions.length === 0
        ? {
            status: "no-supported-invocations",
            message:
              "This workflow contains no AI invocation supported by this importer.",
          }
        : { status: "ready" };
  return {
    execution: executionSummary(detail),
    detailAvailable,
    discovery,
    extractions,
  };
}

function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
}

function routeErrorResponse(error: unknown): Response {
  if (error instanceof WorkbenchRequestError) {
    return noStoreJson(
      {
        error: {
          code: "request-invalid",
          message: error.message,
          retryable: false,
        },
      },
      { status: error.status },
    );
  }
  const normalized =
    error instanceof N8nIntegrationError
      ? error
      : new N8nIntegrationError(
          "remote-unavailable",
          "The n8n request failed.",
          { retryable: true, cause: error },
        );
  const status =
    normalized.code === "request-invalid"
      ? 400
      : normalized.code === "configuration-unavailable" ||
          normalized.code === "configuration-invalid"
        ? 503
        : normalized.code === "resource-not-found"
          ? 404
          : normalized.code === "request-timeout"
            ? 504
            : 502;
  return noStoreJson(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    },
    { status },
  );
}

function requireAllowedQuery(
  request: Request,
  allowedNames: readonly string[],
): URLSearchParams {
  const query = new URL(request.url).searchParams;
  for (const name of query.keys()) {
    if (!allowedNames.includes(name)) {
      throw new N8nIntegrationError(
        "request-invalid",
        `Unexpected query parameter "${name}".`,
      );
    }
    if (query.getAll(name).length !== 1) {
      throw new N8nIntegrationError(
        "request-invalid",
        `Query parameter "${name}" may be supplied only once.`,
      );
    }
  }
  return query;
}

function clientFromEnvironment(
  environment: Record<string, string | undefined>,
  fetchImplementation?: typeof fetch,
): N8nClient {
  const connection = new EnvironmentN8nCredentialSource(environment).resolve();
  return new N8nClient(connection, { fetchImplementation });
}

export function handleN8nStatusRequest(
  incoming: Request,
  environment: Record<string, string | undefined>,
  policy?: WorkbenchRequestPolicy,
): Response {
  try {
    validateSameOrigin(incoming, policy);
    requireAllowedQuery(incoming, []);
    return noStoreJson(
      new EnvironmentN8nCredentialSource(environment).publicConfiguration(),
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function handleN8nWorkflowsRequest(
  incoming: Request,
  environment: Record<string, string | undefined>,
  policy?: WorkbenchRequestPolicy,
  fetchImplementation?: typeof fetch,
): Promise<Response> {
  try {
    validateSameOrigin(incoming, policy);
    const query = requireAllowedQuery(incoming, ["cursor"]);
    const page = await clientFromEnvironment(
      environment,
      fetchImplementation,
    ).listWorkflows(query.get("cursor") ?? undefined, incoming.signal);
    return noStoreJson({
      workflows: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function handleN8nExecutionsRequest(
  incoming: Request,
  environment: Record<string, string | undefined>,
  policy?: WorkbenchRequestPolicy,
  fetchImplementation?: typeof fetch,
): Promise<Response> {
  try {
    validateSameOrigin(incoming, policy);
    const query = requireAllowedQuery(incoming, ["workflowId", "cursor"]);
    const workflowId = query.get("workflowId");
    if (!workflowId) {
      throw new N8nIntegrationError(
        "request-invalid",
        "workflowId is required.",
      );
    }
    const page = await clientFromEnvironment(
      environment,
      fetchImplementation,
    ).listExecutions(
      workflowId,
      query.get("cursor") ?? undefined,
      incoming.signal,
    );
    return noStoreJson({
      executions: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function handleN8nExecutionDetailRequest(
  incoming: Request,
  environment: Record<string, string | undefined>,
  policy?: WorkbenchRequestPolicy,
  fetchImplementation?: typeof fetch,
): Promise<Response> {
  try {
    validateWorkbenchRequest(incoming, policy);
    requireAllowedQuery(incoming, []);
    const bodyText = await incoming.text();
    if (new TextEncoder().encode(bodyText).byteLength > REQUEST_BODY_LIMIT_BYTES) {
      throw new N8nIntegrationError(
        "request-invalid",
        "Request body is too large.",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      throw new N8nIntegrationError(
        "request-invalid",
        "Request body must be valid JSON.",
        { cause: error },
      );
    }
    const idSelectionSchema = z
      .object({
        workflowId: opaqueIdSchema,
        executionId: opaqueIdSchema,
      })
      .strict();
    const linkSelectionSchema = z
      .object({
        executionUrl: z.string().min(1).max(2048),
      })
      .strict();
    const selection = z
      .union([idSelectionSchema, linkSelectionSchema])
      .safeParse(body);
    if (!selection.success) {
      throw new N8nIntegrationError(
        "request-invalid",
        "Request must contain either valid workflowId and executionId values or an executionUrl.",
        { cause: selection.error },
      );
    }
    const connection = new EnvironmentN8nCredentialSource(
      environment,
    ).resolve();
    const identifiers =
      "executionUrl" in selection.data
        ? parseN8nExecutionLink(connection.baseUrl, selection.data.executionUrl)
        : selection.data;
    const selected = await loadN8nSelectedExecution(
      new N8nClient(connection, { fetchImplementation }),
      identifiers.workflowId,
      identifiers.executionId,
      incoming.signal,
    );
    return noStoreJson(selected);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
