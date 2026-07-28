#!/usr/bin/env node

import {
  captureN8nContract,
  manyArguments,
  N8nContractError,
  normalizeN8nBaseUrl,
  oneArgument,
  parseCliArguments,
} from "./n8n-contract-lib.mjs";

const usage = `Usage:
  node scripts/n8n-contract-probe.mjs \\
    --workflow-id ID \\
    --execution-id ID [--execution-id ID ...] \\
    --capture-name NAME

Required environment:
  INFERENCE_LENS_N8N_BASE_URL  Instance root, excluding /api/v1
  INFERENCE_LENS_N8N_API_KEY   Public API key
`;

try {
  const argumentsMap = parseCliArguments(process.argv.slice(2));
  const workflowId = oneArgument(argumentsMap, "--workflow-id");
  const executionIds = manyArguments(argumentsMap, "--execution-id");
  const captureName = oneArgument(argumentsMap, "--capture-name");
  const baseUrl = normalizeN8nBaseUrl(
    process.env.INFERENCE_LENS_N8N_BASE_URL,
  );
  const apiKey = process.env.INFERENCE_LENS_N8N_API_KEY;

  const directory = await captureN8nContract({
    baseUrl,
    apiKey,
    workflowId,
    executionIds,
    captureName,
  });
  console.log(`Raw capture written to ${directory}`);
} catch (error) {
  const message =
    error instanceof N8nContractError
      ? error.message
      : "Unexpected n8n contract probe failure.";
  console.error(message);
  console.error(usage);
  process.exitCode = 1;
}
