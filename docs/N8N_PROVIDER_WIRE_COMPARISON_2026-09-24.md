# n8n provider-wire comparison, first pass

**Date:** September 24, 2026

**Reference:** committed captures under `tests/fixtures/n8n/captures/2.39.10/`

**Scope:** the eleven complete two-turn captures for AI Agent 2.2, 3, and 3.1 with Call n8n Workflow Tool 2.2 and OpenAI Chat Model 1.2. This is a comparison of model-visible requests, not an MCP-backed Inference Lens run.

## Method and boundary

For each capture, I passed the captured model, temperature, buffered delivery, system/user messages, and ordered function descriptors through the current `buildChatCompletionsRequest`. Each n8n function descriptor was mapped into a `ToolDefinition` with its captured `name`, `description`, and `parameters`; `strict` was carried in `providerOptions`. This isolates the current provider serializer. It does **not** show that an MCP discovery snapshot would produce the same schema.

For the continuation, I supplied the original scripted provider response's tool-call ID, name, and argument text as an Inference Lens assistant call. I supplied the n8n continuation's tool-result string as one text part, so the diff isolates message serialization rather than guessing how a future MCP adapter would project a result. JSON object key order was ignored; array order, values, field presence, and strings were compared.

The comparison ran locally against the committed fixtures and `packages/core/src/openai-compatible.ts`; it did not contact n8n or a provider. The temporary comparison program was not added to the product. The capture manifests identify the exact node versions and redaction provenance.

## Initial request

All eleven reconstructed initial requests matched their capture structurally, including complete `tools` arrays, tool order, messages, model, temperature, and `stream: false`. Both omit `tool_choice` and `parallel_tool_calls`. This result is conditional on supplying the *captured n8n descriptors* to Inference Lens; it does not imply that a generic MCP tool has an n8n-equivalent descriptor.

The two-tool capture advertises `il_echo_primitives` before `il_echo_string`. Inference Lens serializes tools in the order it receives them, so that captured order is representable without a serializer rule. A future attachment flow must keep the user's selected order stable if exact order matters to a comparison.

Every captured n8n function has `strict: false`, `additionalProperties: false`, and the draft-07 `$schema` URL. The captured required lists and property definitions survive Inference Lens serialization unchanged when attached as supplied. An MCP server can advertise a different valid schema; copying n8n's keywords onto every discovered tool would change that server's contract and is not justified by this comparison.

### Fixed-only and mixed inputs

The fixed-only workflow advertises one optional `input: string` property even though the scripted call supplies `{}`. That property is synthetic model-facing shape in the captured n8n workflow, not evidence that the fixed source value is model-controlled. The mixed fixed-and-AI captures advertise only required `text: string`; the fixed `source` does not appear in the schema. This behavior should be treated as n8n workflow-tool behavior, not a generic MCP schema rule. A tool attached from MCP should keep its discovered input schema unless a later, explicit presentation policy is justified by an equivalent use case.

## Continuation request

With the same tool-result *text* supplied to both sides, the structural differences are:

| JSON path | Captured n8n | Current Inference Lens | Scope / classification |
| --- | --- | --- | --- |
| `/messages/2/content` | `[]` for Agent 3 and 3.1; `""` for Agent 2.2 | `null` | Wire-value difference, node-version specific; provider impact untested. |
| `/messages/2/tool_calls/0/function/arguments` | Agent 3 and 3.1 append `"id":"call_inference_lens_n8n_001"` inside the JSON argument string; Agent 2.2 preserves the original text | Preserves the original provider argument text | Semantic argument-string difference for Agent 3 and 3.1; no difference for Agent 2.2. |
| `/messages/3/name` | Absent | Tool name present | Extra tool-message field; provider impact untested. |

All eleven continuations preserved the assistant/tool role sequence, `tool_call_id` linkage, tool name in the assistant call, and the supplied tool-result content. Ten Agent 3/3.1 captures had all three differences above. The Agent 2.2 capture had the content and tool-message-name differences only.

The ID appended to Agent 3.x argument text was **not** in the scripted provider response. It is an n8n transformation. It should not be folded into an MCP `tools/call` argument object by default: that would send a field the remote tool did not ask for. A possible future presentation rule could alter the provider continuation alone, but its replay and compatibility contracts need a separate design decision.

## Result and error content

n8n sends each captured sub-workflow output as a **string containing a JSON array** in one `role: "tool"` message. The two-item fixture preserves item order inside that array. The workflow-error and rejected-arguments fixtures send arrays containing an `error` object, respectively:

```json
[{"error":"IL_N0_EXPECTED_WORKFLOW_ERROR:IL_N0_EXPECTED_ERROR [line 2]"}]
```

```json
[{"error":"Received tool input did not match expected schema\n\n✖ Expected number, received string\n  → at count"}]
```

The current Inference Lens provider serializer can send those exact strings if its tool result already contains them as text. Its generic execution projection joins text parts without constructing an n8n item array. It also records a completed executor result's `isError` in execution evidence, while the provider-facing message carries the projected content. A failed execution has no fabricated tool-result continuation. Therefore these captures establish the n8n target string, but **do not** establish that an arbitrary MCP `content` or `structuredContent` result will naturally produce it. That mapping remains an M3/M4 integration test and, if needed, a presentation-policy decision.

The Agent 2.2 mixed-input capture formats the one-item array with indentation; Agent 3 and 3.1 format it compactly. The parsed array value is the same, but the provider-visible string differs. This is another version-specific formatting observation, not grounds for a global result rewrite.

## Compatibility assessment and next evidence

1. **No initial-request serializer change is indicated.** Equivalent attached descriptors yield equivalent initial requests in these fixtures. The attachment flow must still be checked against actual MCP discovery output.
2. **The continuation is not byte- or value-identical.** Empty assistant content, Agent 3.x argument augmentation, and tool-result `name` require a provider-backed comparison before deciding whether exact emulation helps compatibility. Preserve the original MCP call arguments at the execution boundary.
3. **Error and multi-item projection remain the consequential open contract.** An MCP fixture should return text, structured success, two ordered items, and `isError: true`; compare the resulting provider tool-message strings with the captured arrays. Keep transport/protocol failure separate from a completed tool-reported error.
4. **No n8n presentation mode is justified yet.** The first complete MCP-backed run should report exact mismatches against these versioned captures. Only then decide whether a small run-owned policy is needed, and which differences it should reproduce.

No browser run was needed for this read-only contract comparison and documentation change. No production code or portable schema changed.
