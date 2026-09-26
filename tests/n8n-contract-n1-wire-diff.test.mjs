import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { wireDifferences } from "../scripts/n1-wire-diff.mjs";

const baseline = new URL("./fixtures/n8n/captures/2.39.10/string-input-tool-workflow/", import.meta.url);
const read = async (phase) => JSON.parse(await readFile(new URL(`provider-request-${phase}.json`, baseline), "utf8"));

for (const phase of ["initial", "continuation"]) {
  for (const [field, value] of [["name", "deliberately_changed"], ["description", "Changed description"], ["parameters", { type: "number" }]]) {
    test(`N1 detects deliberate ${phase} tool ${field} changes at the exact wire path`, async () => {
      const reference = await read(phase);
      const actual = structuredClone(reference);
      actual.tools[0].function[field] = value;
      const differences = wireDifferences(reference, actual);
      assert.notDeepEqual(differences, []);
      assert.ok(differences.every(({ path }) => path.startsWith(`/tools/0/function/${field}`)));
      if (field !== "parameters") assert.deepEqual(differences, [{
        path: `/tools/0/function/${field}`, reference: { present: true, value: reference.tools[0].function[field] },
        actual: { present: true, value },
      }]);
      else assert.ok(differences.some(({ path, actual }) => path === "/tools/0/function/parameters/type" && actual.value === "number"));
    });
  }
}

test("N1 detects deliberate result and call-ID changes without normalizing them away", async () => {
  const reference = await read("continuation");
  for (const [field, value] of [["content", "Changed result"], ["tool_call_id", "wrong_call"]]) {
    const actual = structuredClone(reference);
    actual.messages[3][field] = value;
    assert.deepEqual(wireDifferences(reference, actual), [{ path: `/messages/3/${field}`,
      reference: { present: true, value: reference.messages[3][field] }, actual: { present: true, value } }]);
  }
});

test("N1 preserves absence, null and array order but ignores object key order", () => {
  assert.deepEqual(wireDifferences({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.deepEqual(wireDifferences({}, { content: null }), [{ path: "/content", reference: { present: false }, actual: { present: true, value: null } }]);
  assert.equal(wireDifferences({ required: ["a", "b"] }, { required: ["b", "a"] }).length, 2);
});

test("N1 locks both actual Python provider requests to the reviewed n8n difference inventory", async () => {
  const candidate = new URL("./fixtures/mcp-servers/n1-string-input/", import.meta.url);
  const report = JSON.parse(await readFile(new URL("wire-differences.json", candidate), "utf8"));
  for (const phase of ["initial", "continuation"]) {
    const reference = await read(phase);
    const actual = JSON.parse(await readFile(new URL(`provider-request-${phase}.json`, candidate), "utf8"));
    assert.deepEqual(wireDifferences(reference, actual), report.phases[phase]);
    for (const mutate of [
      (body) => { body.tools[0].function.name = "deliberately_changed"; },
      (body) => { body.tools[0].function.parameters.properties.text.type = "number"; },
      ...(phase === "continuation" ? [(body) => { body.messages[3].content = "Changed result"; }] : []),
    ]) {
      const changed = structuredClone(actual);
      mutate(changed);
      assert.throws(() => assert.deepEqual(wireDifferences(reference, changed), report.phases[phase]),
        { code: "ERR_ASSERTION" });
    }
  }
});
