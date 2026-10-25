# F0: ordinary tool then formatter, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**, with execution-snapshot
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
Workflow Tool **2.2**, and auto-fix disabled. Source inspection reference from
PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e`; this is not a verified
instance build SHA. Exact source/projected hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Two real buffered requests | Initial request and continuation both have `stream: false`; saved parent has two chat-model sub-runs. Provider status recorded two received and two accepted requests, complete with no problem. |
| Ordinary tool executed first | Initial scripted response calls `il_echo_string`; parent tool metadata links the captured child execution, which succeeds. |
| Continuation preserves result linkage | Assistant call and tool result use `call_il_ordinary_001`. Child output matches the parsed JSON-array string sent to the model. |
| n8n augments ordinary arguments | Continuation arguments include an `id` equal to the call ID; scripted arguments contain only `text`. Assistant continuation content is an empty array. |
| Formatter descriptor/instruction retained | Continuation tools equal initial tools; original system/user messages remain the prefix. |
| Formatter terminates the sequence | Second response calls `format_final_json_response`; one successful parser run consumes those exact argument bytes. No third provider request or formatter tool-result continuation was observed. |
| Effective node result | Final Agent output item is `{"output":{"answer":"IL_F0_ANSWER","count":7}}`, matching formatter arguments and the earlier formatter-only run. |

The echo child had to be published/active on this instance. The earlier inactive
child attempt returned `Workflow is not active and cannot be executed.` as its
ordinary tool result; the provider refused it. That incomplete attempt remains
in ignored raw staging and is not represented by these successful fixtures.

Scripted responses demonstrate orchestration, not model compliance. This capture
does not establish fallback, streaming, other Agent versions, mixed/duplicate
calls, or invalid-schema behavior. It approves no runtime/artifact contract.
