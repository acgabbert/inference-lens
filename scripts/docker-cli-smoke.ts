// Runs the headless CLI through the published image, with the one-off
// container command docs/DOCKER.md recommends, against the committed buffered
// fixture provider on the host. Linux only: the provider binds the Docker
// bridge address, which is what host.docker.internal:host-gateway resolves to.
//
//   docker build -t inference-lens:local .
//   npm run test:docker-cli -- inference-lens:local

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { parseExperimentPlanJson, parseExperimentResultJson } from "../packages/core/src/experiment.ts";
import { parseRunTraceJson } from "../packages/core/src/run-trace.ts";
import { headlessProject, writeHeadlessProjectFolder } from "../tests/fixtures/headless/project.ts";

const image = process.argv[2];
if (!image) {
  console.error("Usage: npm run test:docker-cli -- <image>");
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, "..");
const bridge = execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).trim();
assert.match(bridge, /^\d+\.\d+\.\d+\.\d+$/, `Could not read the Docker bridge gateway (got "${bridge}").`);

const port = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, bridge, () => {
    const { port: free } = probe.address() as AddressInfo;
    probe.close(() => resolve(free));
  });
});
const provider = spawn(process.execPath, [path.join(root, "scripts/buffered-openai-provider.mjs")], {
  env: { ...process.env, INFERENCE_LENS_BUFFERED_HOST: bridge, INFERENCE_LENS_BUFFERED_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
await once(provider.stdout!, "data");

try {
  const endpoint = `http://host.docker.internal:${port}/v1`;
  const directory = await writeHeadlessProjectFolder(headlessProject({
    endpoint,
    cases: [
      { id: "evaluation-case_sum", name: "States the sum", topic: "addition", checks: [{ checkId: "check_sum", kind: "contains", value: "2 + 2 = 4" }] },
      { id: "evaluation-case_rollback", name: "Mentions rollback", topic: "deploys", checks: [{ checkId: "check_rollback", kind: "contains", value: "rollback" }] },
    ],
  }));
  const uid = process.getuid!();
  const gid = process.getgid!();

  // The documented command, plus --json so stdout can be checked as data.
  const cli = spawn("docker", [
    "run", "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-e", "INFERENCE_LENS_API_KEY", "-e", "INFERENCE_LENS_API_ENDPOINT",
    "-v", `${directory}:/project`,
    "--user", `${uid}:${gid}`,
    image,
    "inference-lens", "run", "/project", "--json",
  ], {
    env: { ...process.env, INFERENCE_LENS_API_KEY: "sk-docker-smoke", INFERENCE_LENS_API_ENDPOINT: endpoint },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.on("data", (chunk) => { stdout += chunk; });
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(cli, "exit");

  assert.equal(code, 1, `Expected exit 1 (one case fails). stderr:\n${stderr}`);
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch {
    assert.fail(`stdout is not only the JSON summary:\n${stdout}`);
  }
  assert.equal(summary.verdict, "failed");
  assert.deepEqual(
    summary.configurations[0].cases.map(({ name, passed }: { name: string; passed: boolean }) => [name, passed]),
    [["States the sum", true], ["Mentions rollback", false]],
  );

  const experimentFiles = await readdir(path.join(directory, "experiments"));
  const traceFiles = await readdir(path.join(directory, "traces"));
  const planFile = experimentFiles.find((name) => name.endsWith(".plan.json"));
  const resultFile = experimentFiles.find((name) => name.endsWith(".result.json"));
  assert.ok(planFile && resultFile, `Expected a plan and a result, found ${experimentFiles.join(", ")}`);
  const plan = parseExperimentPlanJson(await readFile(path.join(directory, "experiments", planFile), "utf8"));
  parseExperimentResultJson(await readFile(path.join(directory, "experiments", resultFile), "utf8"), plan);
  assert.equal(traceFiles.length, 2);
  for (const name of traceFiles) parseRunTraceJson(await readFile(path.join(directory, "traces", name), "utf8"));

  for (const file of [
    path.join(directory, "experiments", planFile),
    path.join(directory, "experiments", resultFile),
    ...traceFiles.map((name) => path.join(directory, "traces", name)),
  ]) {
    const { uid: owner } = await stat(file);
    assert.equal(owner, uid, `${path.basename(file)} belongs to uid ${owner}, not the host user ${uid}.`);
  }

  console.log(`Container CLI smoke test passed against ${image}.`);
} finally {
  provider.kill("SIGTERM");
}
