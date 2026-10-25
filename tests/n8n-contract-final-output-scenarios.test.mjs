import assert from "node:assert/strict";
import test from "node:test";
import { formatterCalls } from "../scripts/n8n-final-output-scenarios.mjs";

test("reverse mixed-call recipe puts the ordinary call before the formatter", () => {
  const calls = formatterCalls({ mixed: true, ordinaryFirst: true });
  assert.deepEqual(calls.map((call) => call.function.name), ["il_echo_string", "format_final_json_response"]);
  assert.notEqual(calls[0].id, calls[1].id);
});
