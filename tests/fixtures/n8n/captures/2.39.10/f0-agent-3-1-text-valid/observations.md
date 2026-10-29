# F0: wrapped JSON final-text fallback, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**, with execution-snapshot
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**, and
attached Workflow Tool **2.2**. Auto-fix is disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file SHA-256 hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Formatter is offered and requested | Initial request includes the formatter descriptor and injected system instruction, as in the formatter-only baseline. |
| Script skips the formatter | Response has plain assistant content `{"output":{"answer":"IL_F0_ANSWER","count":7}}`, finish reason `stop`, and no tool calls. |
| n8n accepts final-text fallback | Execution succeeds; one parser run consumes that exact assistant text and returns the parsed wrapped object. |
| Final result agrees with formatter path | Final Agent output item is `{"output":{"answer":"IL_F0_ANSWER","count":7}}`. |
| One buffered model request | Request `stream: false`; one saved chat-model sub-run. Provider status recorded one received/accepted request, complete without a problem. No continuation or repair request observed. |
| No ordinary tool dispatch | No `il_echo_string` run entry. |

This proves acceptance of this **wrapped** JSON text on this version/configuration.
It does not establish unwrapped JSON, fenced JSON, scalar roots, invalid-text
handling, streaming, other Agent versions, or automatic repair. Scripted output
is orchestration evidence, not a measure of model compliance. The captures do
not approve generic fallback policy or a runtime/artifact contract.
