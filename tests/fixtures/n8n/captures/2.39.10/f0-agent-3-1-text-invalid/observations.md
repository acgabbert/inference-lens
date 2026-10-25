# F0: invalid final-text fallback, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Formatter offered but not called | Initial request contains formatter descriptor/instruction. Scripted response has plain assistant text `IL_F0_NOT_JSON`, finish reason `stop`, no tool calls. |
| Fallback parsing attempted | One parser sub-run consumes that exact text. |
| Invalid JSON rejected | Parser and Agent runs have execution status `error`; top-level status is `error` and serialized `finished` is false. |
| Diagnostic distinguishes JSON syntax | Message: `Model output doesn't fit required format`; context `outputParserFailReason`: `Invalid JSON in model output`. |
| No successful answer | Parser records input text without a parsed response; Agent run has no output data. |
| No repair or continuation observed | One buffered provider request and one saved model sub-run. Provider status recorded one received/accepted request, complete without a problem. |
| No ordinary tool execution | No `il_echo_string` run entry. |

The provider completed its script successfully; n8n rejected the scripted text.
This failure is the intended observation. It does not establish formatter
schema-mismatch behavior or behavior with auto-fix enabled. No live model
reliability, other Agent versions, streaming, or generic runtime policy is implied.
