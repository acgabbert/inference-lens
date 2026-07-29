#!/usr/bin/env node

import {
  N8nContractError,
  oneArgument,
  parseCliArguments,
  redactN8nCapture,
  validateRedactedCapture,
} from "./n8n-contract-lib.mjs";

const usage = `Usage:
  node scripts/n8n-redact-capture.mjs \\
    --input RAW_CAPTURE_DIRECTORY \\
    --output COMMITTABLE_FIXTURE_DIRECTORY \\
    --n8n-version VERSION
`;

try {
  const argumentsMap = parseCliArguments(process.argv.slice(2));
  const inputDirectory = oneArgument(argumentsMap, "--input");
  const outputDirectory = oneArgument(argumentsMap, "--output");
  const n8nVersion = oneArgument(argumentsMap, "--n8n-version");
  const knownSecrets = [
    process.env.INFERENCE_LENS_N8N_API_KEY,
    process.env.INFERENCE_LENS_N8N_BASE_URL,
  ].filter(Boolean);

  const directory = await redactN8nCapture({
    inputDirectory,
    outputDirectory,
    n8nVersion,
    knownSecrets,
  });
  await validateRedactedCapture({ directory, knownSecrets });
  console.log(`Redacted fixture validated at ${directory}`);
} catch (error) {
  const message =
    error instanceof N8nContractError
      ? error.message
      : "Unexpected n8n capture redaction failure.";
  console.error(message);
  console.error(usage);
  process.exitCode = 1;
}
