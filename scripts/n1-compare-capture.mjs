import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { wireDifferences } from "./n1-wire-diff.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/n1-compare-capture.mjs <MCP capture directory> [scenario]");
const scenario = process.argv[3] ?? "string-input";
if (!["string-input", "primitive-inputs", "nested-inputs", "multiple-output-items", "workflow-error"].includes(scenario)) {
  throw new Error(`Unsupported N1 comparison scenario: ${scenario}. Empty-output still needs an n8n capture.`);
}
const baseline = `tests/fixtures/n8n/captures/2.39.10/${scenario}-tool-workflow`;
const report = { baseline, candidate: `Python MCP ${scenario}`, phases: {} };
for (const phase of ["initial", "continuation"]) {
  const name = `provider-request-${phase}.json`;
  const reference = JSON.parse(await readFile(path.join(baseline, name), "utf8"));
  const actual = JSON.parse(await readFile(path.join(directory, name), "utf8"));
  report.phases[phase] = wireDifferences(reference, actual);
}
await writeFile(path.join(directory, "wire-differences.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
