import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// These are comparator controls, not MCP execution evidence.
for (const scenario of ["primitive-inputs", "nested-inputs", "multiple-output-items", "workflow-error"]) {
  test(`N1 CLI compares both phases against the selected ${scenario} baseline`, async (t) => {
    const output = await mkdtemp(path.join(tmpdir(), "n1-comparator-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    const baseline = `tests/fixtures/n8n/captures/2.39.10/${scenario}-tool-workflow`;
    for (const phase of ["initial", "continuation"]) {
      const name = `provider-request-${phase}.json`;
      await copyFile(path.join(baseline, name), path.join(output, name));
    }
    execFileSync(process.execPath, ["scripts/n1-compare-capture.mjs", output, scenario]);
    const report = JSON.parse(await readFile(path.join(output, "wire-differences.json"), "utf8"));
    assert.equal(report.baseline, baseline);
    assert.deepEqual(report.phases, { initial: [], continuation: [] });
  });
}

test("N1 CLI refuses unknown scenarios and preserves an existing difference report", async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), "n1-comparator-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  for (const phase of ["initial", "continuation"]) {
    const name = `provider-request-${phase}.json`;
    await copyFile(`tests/fixtures/n8n/captures/2.39.10/string-input-tool-workflow/${name}`, path.join(output, name));
  }
  const invoke = (scenario) => spawnSync(process.execPath, ["scripts/n1-compare-capture.mjs", output, scenario], { encoding: "utf8" });
  assert.notEqual(invoke("unknown").status, 0);
  await writeFile(path.join(output, "wire-differences.json"), "reviewed evidence\n");
  assert.notEqual(invoke("string-input").status, 0);
  assert.equal(await readFile(path.join(output, "wire-differences.json"), "utf8"), "reviewed evidence\n");
});
