import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const RAW_CAPTURE_SCHEMA_VERSION = 1;
export const FIXTURE_SCHEMA_VERSION = 1;
export const DEFAULT_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_LIMIT_BYTES = 1024;

export class N8nContractError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "N8nContractError";
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new N8nContractError(`${label} must be a JSON object.`);
  }
  return value;
}

export function parseCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new N8nContractError(`Unexpected argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new N8nContractError(`Missing value for ${argument}.`);
    }
    const existing = values.get(argument) ?? [];
    existing.push(value);
    values.set(argument, existing);
    index += 1;
  }
  return values;
}

export function oneArgument(argumentsMap, name, { required = true } = {}) {
  const values = argumentsMap.get(name) ?? [];
  if (values.length > 1) {
    throw new N8nContractError(`${name} may be supplied only once.`);
  }
  if (required && values.length === 0) {
    throw new N8nContractError(`Missing required argument ${name}.`);
  }
  return values[0];
}

export function manyArguments(argumentsMap, name, { required = true } = {}) {
  const values = argumentsMap.get(name) ?? [];
  if (required && values.length === 0) {
    throw new N8nContractError(`Supply at least one ${name}.`);
  }
  return values;
}

export function validateOpaqueId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new N8nContractError(
      `${label} must contain only letters, numbers, underscores, or hyphens.`,
    );
  }
  return value;
}

export function normalizeN8nBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new N8nContractError("INFERENCE_LENS_N8N_BASE_URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new N8nContractError("INFERENCE_LENS_N8N_BASE_URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new N8nContractError(
      "INFERENCE_LENS_N8N_BASE_URL must use http or https.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new N8nContractError(
      "INFERENCE_LENS_N8N_BASE_URL must not contain credentials, a query, or a fragment.",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.pathname.endsWith("/api/v1")) {
    throw new N8nContractError(
      "INFERENCE_LENS_N8N_BASE_URL must exclude the /api/v1 suffix.",
    );
  }
  return parsed;
}

export function buildPublicApiUrl(baseUrl, resourcePath) {
  const url = new URL(baseUrl.toString());
  const [pathname, query = ""] = resourcePath.split("?", 2);
  url.pathname = `${url.pathname}/api/v1/${pathname}`.replace(/\/{2,}/g, "/");
  url.search = query;
  return url;
}

function redactedErrorText(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result
    .replace(/(x-n8n-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*)(bearer|basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .slice(0, ERROR_BODY_LIMIT_BYTES);
}

async function readBoundedResponse(response, limitBytes) {
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > limitBytes) {
    throw new N8nContractError(
      `n8n response exceeds the ${limitBytes}-byte capture limit.`,
    );
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > limitBytes) {
      throw new N8nContractError(
        `n8n response exceeds the ${limitBytes}-byte capture limit.`,
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function fetchN8nJson({
  fetchImplementation = fetch,
  baseUrl,
  apiKey,
  resourcePath,
  responseLimitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
  timeoutMs = 15_000,
}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new N8nContractError("INFERENCE_LENS_N8N_API_KEY is required.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImplementation(buildPublicApiUrl(baseUrl, resourcePath), {
      method: "GET",
      headers: {
        accept: "application/json",
        "X-N8N-API-KEY": apiKey,
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "n8n request timed out."
        : "n8n request failed before a response was received.";
    throw new N8nContractError(message, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new N8nContractError(
      `n8n returned a redirect (${response.status}); redirects are refused.`,
    );
  }

  const bytes = await readBoundedResponse(response, responseLimitBytes);
  const body = bytes.toString("utf8");
  if (!response.ok) {
    throw new N8nContractError(
      `n8n returned HTTP ${response.status}: ${redactedErrorText(body, [apiKey])}`,
    );
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new N8nContractError("n8n returned invalid JSON.", { cause: error });
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function captureN8nContract({
  baseUrl,
  apiKey,
  workflowId,
  executionIds,
  captureName,
  stagingRoot = ".n8n-contract-staging",
  fetchImplementation = fetch,
  capturedAt = new Date().toISOString(),
  responseLimitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
}) {
  validateOpaqueId(workflowId, "workflow ID");
  validateOpaqueId(captureName, "capture name");
  for (const executionId of executionIds) {
    validateOpaqueId(executionId, "execution ID");
  }

  const normalizedBaseUrl =
    baseUrl instanceof URL ? baseUrl : normalizeN8nBaseUrl(baseUrl);
  const captureDirectory = path.resolve(stagingRoot, captureName);
  await mkdir(path.resolve(stagingRoot), { recursive: true });
  try {
    await mkdir(captureDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new N8nContractError(
        `Capture directory already exists: ${captureDirectory}`,
      );
    }
    throw error;
  }

  const request = (resourcePath) =>
    fetchN8nJson({
      fetchImplementation,
      baseUrl: normalizedBaseUrl,
      apiKey,
      resourcePath,
      responseLimitBytes,
    });

  try {
    const workflow = await request(
      `workflows/${encodeURIComponent(workflowId)}`,
    );
    await writeJson(path.join(captureDirectory, "workflow.raw.json"), workflow);

    const executionFiles = [];
    for (let index = 0; index < executionIds.length; index += 1) {
      const executionId = executionIds[index];
      const filename = `execution-${String(index + 1).padStart(2, "0")}.raw.json`;
      const execution = await request(
        `executions/${encodeURIComponent(executionId)}?includeData=true`,
      );
      await writeJson(path.join(captureDirectory, filename), execution);
      executionFiles.push(filename);
    }

    await writeJson(path.join(captureDirectory, "capture-manifest.json"), {
      rawCaptureSchemaVersion: RAW_CAPTURE_SCHEMA_VERSION,
      capturedAt,
      workflowId,
      executionIds,
      endpointShapes: [
        "GET /api/v1/workflows/{workflowId}",
        "GET /api/v1/executions/{executionId}?includeData=true",
      ],
      files: {
        workflow: "workflow.raw.json",
        executions: executionFiles,
      },
    });
  } catch (error) {
    throw new N8nContractError(
      `Capture did not complete. Partial raw files remain in ${captureDirectory}.`,
      { cause: error },
    );
  }

  return captureDirectory;
}

const REMOVED_KEY_FORMS = new Set([
  "apikey",
  "authorization",
  "baseurl",
  "binary",
  "credential",
  "credentials",
  "defaultheaders",
  "fetchoptions",
  "headers",
  "homeproject",
  "instanceid",
  "projectid",
  "requestheaders",
  "responseheaders",
  "shared",
  "webhookid",
]);

function sanitizeUnknown(value, context) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry, context));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        REMOVED_KEY_FORMS.has(normalizedKey) ||
        normalizedKey.endsWith("apikey") ||
        normalizedKey.endsWith("credentials") ||
        normalizedKey.endsWith("headers")
      ) {
        context.removedFields.add(key);
        continue;
      }
      result[key] = sanitizeUnknown(entry, context);
    }
    return result;
  }
  if (typeof value === "string" && context.idMap.has(value)) {
    return context.idMap.get(value);
  }
  return value;
}

function relevantSettings(settings, context) {
  const source =
    settings !== null && typeof settings === "object" ? settings : {};
  const allowed = [
    "executionOrder",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "saveManualExecutions",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => key in source)
      .map((key) => [key, sanitizeUnknown(source[key], context)]),
  );
}

function collectNodeIds(workflow, context) {
  if (!Array.isArray(workflow?.nodes)) return;
  for (const node of workflow.nodes) {
    if (
      node &&
      typeof node === "object" &&
      typeof node.id === "string" &&
      !context.idMap.has(node.id)
    ) {
      context.idMap.set(
        node.id,
        `node_fixture_${String(context.nodeCounter).padStart(3, "0")}`,
      );
      context.nodeCounter += 1;
    }
  }
}

export function projectWorkflow(rawWorkflow, context) {
  const workflow = requireObject(rawWorkflow, "workflow response");
  if (!Array.isArray(workflow.nodes)) {
    throw new N8nContractError("workflow response does not contain nodes.");
  }
  collectNodeIds(workflow, context);

  return {
    id: "workflow_fixture",
    name: workflow.name,
    active: workflow.active,
    nodes: workflow.nodes.map((rawNode) => {
      const node = requireObject(rawNode, "workflow node");
      const projected = {
        id:
          typeof node.id === "string"
            ? context.idMap.get(node.id)
            : `node_fixture_unknown`,
        name: node.name,
        type: node.type,
        typeVersion: node.typeVersion,
        position: sanitizeUnknown(node.position, context),
        parameters: sanitizeUnknown(node.parameters ?? {}, context),
      };
      if (node.disabled === true) projected.disabled = true;
      return projected;
    }),
    connections: sanitizeUnknown(workflow.connections ?? {}, context),
    settings: relevantSettings(workflow.settings, context),
  };
}

function projectExecution(rawExecution, context) {
  const execution = requireObject(rawExecution, "execution response");
  const workflowSnapshot =
    execution.data?.workflowData ?? execution.workflowData ?? undefined;
  if (workflowSnapshot) collectNodeIds(workflowSnapshot, context);

  const projectedData = {};
  const rawData =
    execution.data !== null && typeof execution.data === "object"
      ? execution.data
      : {};
  for (const key of ["startData", "resultData", "executionData"]) {
    if (key in rawData) {
      projectedData[key] = sanitizeUnknown(rawData[key], context);
    }
  }
  if (workflowSnapshot) {
    projectedData.workflowData = projectWorkflow(workflowSnapshot, context);
  }

  return {
    id: context.idMap.get(String(execution.id)) ?? "execution_fixture_unknown",
    workflowId: "workflow_fixture",
    mode: execution.mode,
    status: execution.status,
    finished: execution.finished,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    data: projectedData,
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (/^127\./.test(normalized) || normalized === "::1") return true;
  const match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [, firstText, secondText] = match;
  const first = Number(firstText);
  const second = Number(secondText);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function assertNoSensitiveText(text, knownSecrets = []) {
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.length >= 4 && text.includes(secret)) {
      throw new N8nContractError("Projected fixture contains a configured secret.");
    }
  }
  if (/x-n8n-api-key\s*["':=]/i.test(text)) {
    throw new N8nContractError("Projected fixture contains an n8n API-key header.");
  }
  if (/authorization\s*["']?\s*:\s*["']?(bearer|basic)\b/i.test(text)) {
    throw new N8nContractError("Projected fixture contains authorization material.");
  }

  const urls = text.match(/https?:\/\/[^\s"\\]+/gi) ?? [];
  for (const candidate of urls) {
    try {
      if (isPrivateHostname(new URL(candidate).hostname)) {
        throw new N8nContractError(
          "Projected fixture contains a private or loopback URL.",
        );
      }
    } catch (error) {
      if (error instanceof N8nContractError) throw error;
    }
  }

  const addresses = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  if (addresses.some(isPrivateHostname)) {
    throw new N8nContractError(
      "Projected fixture contains a private or loopback address.",
    );
  }
}

function countRunItems(execution) {
  const runData = execution?.data?.resultData?.runData;
  if (runData === null || typeof runData !== "object") return {};
  return Object.fromEntries(
    Object.entries(runData).map(([nodeName, runs]) => [
      nodeName,
      Array.isArray(runs)
        ? runs.map((run) =>
            Array.isArray(run?.data?.main?.[0]) ? run.data.main[0].length : undefined,
          )
        : [],
    ]),
  );
}

export async function redactN8nCapture({
  inputDirectory,
  outputDirectory,
  n8nVersion,
  knownSecrets = [],
  projectedAt = new Date().toISOString(),
}) {
  if (typeof n8nVersion !== "string" || n8nVersion.trim() === "") {
    throw new N8nContractError("An operator-supplied n8n version is required.");
  }
  const input = path.resolve(inputDirectory);
  const output = path.resolve(outputDirectory);
  const rawManifest = JSON.parse(
    await readFile(path.join(input, "capture-manifest.json"), "utf8"),
  );
  if (rawManifest.rawCaptureSchemaVersion !== RAW_CAPTURE_SCHEMA_VERSION) {
    throw new N8nContractError("Unsupported raw capture schema version.");
  }

  const rawWorkflow = JSON.parse(
    await readFile(path.join(input, rawManifest.files.workflow), "utf8"),
  );
  const rawExecutions = await Promise.all(
    rawManifest.files.executions.map(async (filename) =>
      JSON.parse(await readFile(path.join(input, filename), "utf8")),
    ),
  );

  const context = {
    idMap: new Map([[String(rawManifest.workflowId), "workflow_fixture"]]),
    nodeCounter: 1,
    removedFields: new Set(),
  };
  rawExecutions.forEach((execution, index) => {
    context.idMap.set(
      String(execution.id ?? rawManifest.executionIds[index]),
      `execution_fixture_${String(index + 1).padStart(3, "0")}`,
    );
  });
  collectNodeIds(rawWorkflow, context);
  for (const execution of rawExecutions) {
    collectNodeIds(execution?.data?.workflowData, context);
  }

  const workflow = projectWorkflow(rawWorkflow, context);
  const executions = rawExecutions.map((execution) =>
    projectExecution(execution, context),
  );
  const projectedFiles = new Map([["workflow.json", workflow]]);
  const statusCounts = new Map();
  executions.forEach((execution) => {
    const status =
      typeof execution.status === "string"
        ? execution.status.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        : "unknown";
    const count = (statusCounts.get(status) ?? 0) + 1;
    statusCounts.set(status, count);
    const suffix = count === 1 ? "" : `-${count}`;
    projectedFiles.set(`execution-${status}${suffix}.json`, execution);
  });

  const serializedFiles = new Map();
  for (const [filename, value] of projectedFiles) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    assertNoSensitiveText(serialized, knownSecrets);
    serializedFiles.set(filename, serialized);
  }

  try {
    await mkdir(output, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new N8nContractError(`Output directory already exists: ${output}`);
    }
    throw error;
  }

  for (const [filename, serialized] of serializedFiles) {
    await writeFile(path.join(output, filename), serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  const manifest = {
    fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
    n8nVersion: n8nVersion.trim(),
    capturedAt: rawManifest.capturedAt,
    projectedAt,
    workflowId: "workflow_fixture",
    nodeTypes: workflow.nodes.map((node) => ({
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
    })),
    workflowSettings: workflow.settings,
    executions: executions.map((execution) => ({
      id: execution.id,
      mode: execution.mode,
      status: execution.status,
      runItemCounts: countRunItems(execution),
    })),
    endpointShapes: rawManifest.endpointShapes,
    removedFields: [...context.removedFields].sort(),
    warnings: [
      "Projection requires manual review before commit.",
      "Evidence paths and save settings have not been classified automatically.",
    ],
    files: Object.fromEntries(
      [...serializedFiles].map(([filename, serialized]) => [
        filename,
        { sha256: sha256(serialized) },
      ]),
    ),
  };
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSensitiveText(serializedManifest, knownSecrets);
  await writeFile(path.join(output, "manifest.json"), serializedManifest, {
    encoding: "utf8",
    flag: "wx",
  });

  return output;
}

export async function validateRedactedCapture({
  directory,
  knownSecrets = [],
}) {
  const root = path.resolve(directory);
  const manifestText = await readFile(path.join(root, "manifest.json"), "utf8");
  assertNoSensitiveText(manifestText, knownSecrets);
  const manifest = JSON.parse(manifestText);
  if (manifest.fixtureSchemaVersion !== FIXTURE_SCHEMA_VERSION) {
    throw new N8nContractError("Unsupported fixture schema version.");
  }

  for (const [filename, metadata] of Object.entries(manifest.files ?? {})) {
    if (!/^[a-z0-9-]+\.json$/.test(filename)) {
      throw new N8nContractError(`Unsafe fixture filename: ${filename}`);
    }
    const text = await readFile(path.join(root, filename), "utf8");
    assertNoSensitiveText(text, knownSecrets);
    if (sha256(text) !== metadata.sha256) {
      throw new N8nContractError(`Digest mismatch for ${filename}.`);
    }
    JSON.parse(text);
  }
  return manifest;
}
