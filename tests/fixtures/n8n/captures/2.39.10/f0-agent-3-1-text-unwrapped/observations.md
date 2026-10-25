# F0: unwrapped final-text fallback, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Model skips formatter | Plain assistant text is `{"answer":"IL_F0_ANSWER","count":7}`; finish reason stop; no tool calls. Initial request still offers formatter and its instruction. |
| Raw model text preserved | Saved model generation contains exactly that unwrapped assistant text. |
| n8n adds wrapper before parser | Parser input text is `{"output":{"answer":"IL_F0_ANSWER","count":7}}`, different from raw assistant text. |
| Successful result | Parser response and Agent output item equal the wrapped object; execution succeeds. |
| One buffered request | One model sub-run; provider status recorded one received/accepted request, complete without a problem. No repair, continuation, or ordinary-tool run. |

Both wrapped and unwrapped JSON text succeed in the captured baseline, but their
parser input attribution differs. A compatibility implementation must preserve
raw assistant text separately from this generated parser input and the final
node output. This is not evidence for arbitrary wrapper guessing, fenced JSON,
other root types, or legacy parsers. Generic fallback policy remains a design
decision; scripted responses measure orchestration, not model compliance.
