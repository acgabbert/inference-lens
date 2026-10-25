# F0: formatter-only, Agent 3.1, buffered

Captured 2026-10-25 from the operator's n8n **2.39.10** instance. The application
version is operator-reported. The execution-time snapshot confirms Agent **3.1**,
OpenAI Chat Model **1.2**, Structured Output Parser **1.3**, and attached Workflow
Tool **2.2**. The model is the synthetic `template-echo-model`; no live model
compliance is measured. Source inspection reference from PR185:
`cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified build SHA for this
instance). Source and projected-file SHA-256 hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| One buffered request; no continuation | Two provider files, request `stream: false`, one saved chat-model sub-run; provider status recorded one received and one accepted request with no problem. |
| Formatter added beside attached ordinary tool | Request exposes `il_echo_string` and `format_final_json_response`. |
| Authored schema is wrapped | Formatter parameters require an `output` object containing the original answer/count/note schema. Both wrapper and authored object forbid additional properties. |
| Required and optional fields preserved in descriptor | `answer` and `count` required; `note` optional. Omitted note succeeds. |
| Instruction injected into system message | Authored system text is followed by the formatter requirement in the exact captured request. |
| Terminal arguments | Scripted call arguments are `{"output":{"answer":"IL_F0_ANSWER","count":7}}`. Assistant text is null; finish reason is `tool_calls`. |
| Parser invocation | One parser run receives exactly the argument string and reports successful parsing. Execution snapshot records `autoFix: false`. |
| Result shapes | Parser response and final Agent output item are both `{"output":{"answer":"IL_F0_ANSWER","count":7}}`. The payload is the inner object; the Agent output item retains an output field. |
| No ordinary tool dispatch | No `il_echo_string` run entry; attached child is captured only to preserve its identity and topology. |

This is evidence for this single path, not a general n8n compatibility profile.
The [ordinary-then-format path](../f0-agent-3-1-after-tool/observations.md)
is now captured separately. Streaming, Agent 2.2/3, fallback, invalid arguments, extra
properties, nested output keys, and mixed/duplicate calls remain uncaptured.
No runtime or saved-artifact design decision is approved by this capture.
