# F0: two distinct formatter calls, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Two calls to same formatter | Response contains distinct call IDs ending 001 and 002 for format_final_json_response. |
| Payloads distinguish selection | First payload is answer IL_F0_ANSWER/count 7; second is IL_F0_SECOND_ANSWER/count 8. Both are valid for the authored schema. |
| First formatter selected | Exactly one parser sub-run consumes the first call's argument text. Final Agent output matches that first payload. |
| Second call not parsed | No second parser sub-run; second payload does not become the Agent result. |
| One buffered request | One saved model sub-run; provider status recorded one received/accepted request, complete without a problem. No continuation observed. |
| No ordinary tool dispatch | No echo-tool run entry. |

This demonstrates first-call selection when both formatter payloads are valid.
It does not establish whether an invalid first formatter could fall through to
a valid second one, other versions, or streaming. The recipe was changed to use
different payloads before live execution; identical payloads could not prove
selection. Scripted output demonstrates orchestration, not model compliance.
The Inference Lens duplicate-call policy remains a contract-design decision.
