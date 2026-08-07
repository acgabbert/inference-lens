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

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  capture = captureN8nContract,
} = {}) {
  try {
    const argumentsMap = parseCliArguments(argv);
    const workflowId = oneArgument(argumentsMap, "--workflow-id");
    const executionIds = manyArguments(argumentsMap, "--execution-id");
    const captureName = oneArgument(argumentsMap, "--capture-name");
    const baseUrl = normalizeN8nBaseUrl(
      env.INFERENCE_LENS_N8N_BASE_URL,
    );
    const apiKey = env.INFERENCE_LENS_N8N_API_KEY;

    const directory = await capture({
      baseUrl,
      apiKey,
      workflowId,
      executionIds,
      captureName,
    });
    stdout.write(`Raw capture written to ${directory}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof N8nContractError
        ? error.message
        : "Unexpected n8n contract probe failure.";
    stderr.write(`${message}\n${usage}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
