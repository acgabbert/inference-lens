import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { wireDifferences } from "./n1-wire-diff.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/n1-compare-capture.mjs <MCP capture directory>");
const baseline = "tests/fixtures/n8n/captures/2.39.10/string-input-tool-workflow";
const report = { baseline, candidate: "Python MCP string-input", phases: {} };
for (const phase of ["initial", "continuation"]) {
  const name = `provider-request-${phase}.json`;
  const reference = JSON.parse(await readFile(path.join(baseline, name), "utf8"));
  const actual = JSON.parse(await readFile(path.join(directory, name), "utf8"));
  report.phases[phase] = wireDifferences(reference, actual);
}
await writeFile(path.join(directory, "wire-differences.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
