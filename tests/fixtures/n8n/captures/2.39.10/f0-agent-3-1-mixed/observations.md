# F0: formatter-first mixed calls, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Mixed scripted calls | Response contains formatter call `call_il_formatter_001` first, then ordinary `il_echo_string` call `call_il_ordinary_001`. |
| Formatter succeeds | One parser sub-run consumes exactly the formatter's argument text. |
| Ordinary call is not dispatched | No echo-tool run entry; Agent trace reports zero completed ordinary tool calls. The attached child was published for this capture. |
| Final Agent result | `{"output":{"answer":"IL_F0_ANSWER","count":7}}`, matching formatter payload. |
| One buffered request | One saved model sub-run; provider status recorded one received/accepted request, complete without a problem. No continuation observed. |

This establishes suppression of the ordinary call for **formatter-first** order
on this version/configuration. It does not establish the reverse order, invalid
formatter plus ordinary calls, other Agent versions, or streaming. Scripted
responses demonstrate orchestration, not model compliance. Whether Inference
Lens reproduces or rejects mixed calls remains an explicit contract decision.
