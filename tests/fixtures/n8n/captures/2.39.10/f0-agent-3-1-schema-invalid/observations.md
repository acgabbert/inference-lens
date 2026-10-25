# F0: schema-invalid formatter call, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Formatter call contains valid JSON with wrong type | Scripted call to `format_final_json_response` supplies `{"output":{"answer":"IL_F0_ANSWER","count":"IL_F0_WRONG_TYPE"}}`; wire schema requires integer count. |
| Parser receives exact arguments | One parser sub-run has the call argument string as its input text. |
| Schema mismatch rejected | Parser and Agent statuses are `error`, as is top-level status. Serialized `finished` is false. |
| Diagnostic distinguishes schema from syntax | Message: `Model output doesn't fit required format`; context `outputParserFailReason`: `Model output does not match the expected schema`. The invalid-text fixture instead reports `Invalid JSON in model output`. |
| No successful answer | Parser records input text without a parsed response; Agent run has no output data. |
| No repair or continuation | One buffered request and one saved model sub-run. Provider status recorded one received/accepted request, complete without a problem. |
| No ordinary tool execution | No `il_echo_string` run entry. |

This proves rejection of this nonnumeric string for an integer field. It does
not establish numeric-string coercion, missing required fields, extra-property
handling, or behavior with auto-fix enabled. Scripted model responses measure
orchestration, not model reliability. No generic runtime policy is approved.
