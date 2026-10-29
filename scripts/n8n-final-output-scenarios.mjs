// Capture recipes, not a runtime compatibility profile. n8n's result is observed.
const formatter = "format_final_json_response";
const payload = { answer: "IL_F0_ANSWER", count: 7 };
const common = {
  sentinel: "IL_F0_CAPTURE",
  model: "template-echo-model",
  toolName: formatter,
  toolCallId: "call_il_formatter_001",
  arguments: JSON.stringify({ output: payload }),
  terminal: true,
  finalAnswer: JSON.stringify({ output: payload }),
};
export const FINAL_OUTPUT_SCENARIOS = Object.fromEntries([
  ["formatter-success", {}],
  ["formatter-extra-properties", { arguments: JSON.stringify({ output: { ...payload, extra: "IL_F0_EXTRA" } }) }],
  ["formatter-optional-omitted", {}],
  ["formatter-required-missing", { arguments: '{"output":{"answer":"IL_F0_ANSWER"}}' }],
  ["formatter-nested-output", { arguments: JSON.stringify({ output: { ...payload, output: { label: "IL_F0_NESTED" } } }) }],
  ["formatter-invalid", { arguments: '{"output":{"answer":"IL_F0_ANSWER","count":"IL_F0_WRONG_TYPE"}}' }],
  ["formatter-text-valid", { responseKind: "text" }],
  ["formatter-text-unwrapped", { responseKind: "text", finalAnswer: JSON.stringify(payload) }],
  ["formatter-nested-output-extra", { arguments: JSON.stringify({ output: { ...payload, output: { label: "IL_F0_NESTED", extra: "IL_F0_NESTED_EXTRA" } } }) }],
  ["formatter-text-invalid", { responseKind: "text", finalAnswer: "IL_F0_NOT_JSON" }],
  ["formatter-duplicate", { duplicate: true }],
  ["formatter-mixed", { mixed: true }],
  ["formatter-mixed-ordinary-first", { mixed: true, ordinaryFirst: true }],
  ["formatter-after-tool", {
    terminal: false,
    toolName: "il_echo_string",
    toolCallId: "call_il_ordinary_001",
    arguments: '{"text":"IL_N0_STRING_VALUE"}',
    expectedResult: [{ fixture: "IL_N0_STRING_INPUT", echoed: "IL_N0_STRING_VALUE", receivedType: "string" }],
    finalTool: true,
  }],
].map(([id, overrides]) => [id, { ...common, ...overrides }]));

export function formatterCalls(scenario) {
  const call = {
    id: "call_il_formatter_001", type: "function",
    function: { name: formatter, arguments: common.arguments },
  };
  if (scenario.duplicate) return [call, {
    ...call, id: "call_il_formatter_002",
    function: { name: formatter, arguments: JSON.stringify({ output: { answer: "IL_F0_SECOND_ANSWER", count: 8 } }) },
  }];
  if (scenario.mixed) {
    const ordinary = {
      id: "call_il_ordinary_001", type: "function",
      function: { name: "il_echo_string", arguments: '{"text":"IL_N0_STRING_VALUE"}' },
    };
    return scenario.ordinaryFirst ? [ordinary, call] : [call, ordinary];
  }
  return [call];
}
