# F0: ordinary-first mixed calls, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Ordinary call appears first | Scripted response orders il_echo_string before format_final_json_response, with distinct IDs. |
| Formatter still selected | One parser sub-run consumes exactly the second call's arguments. |
| Ordinary call not dispatched | No echo-tool run entry; Agent tracing reports zero completed tool calls. |
| Successful final result | Agent output item is `{"output":{"answer":"IL_F0_ANSWER","count":7}}`. |
| One buffered request | One model sub-run; provider status recorded one received/accepted request, complete without a problem. No continuation observed. |

Together with the formatter-first fixture, this demonstrates ordinary-call
suppression in both tested orders. It does not establish invalid-formatter mixed
responses, other versions, or streaming. Scripted output demonstrates
orchestration, not model compliance. Whether Inference Lens reproduces or rejects
mixed calls remains an explicit contract-design decision.
