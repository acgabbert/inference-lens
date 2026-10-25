# F0: extra formatter payload property, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Authored and wire payload schema are closed | `additionalProperties: false`; only answer, count, and optional note are declared. |
| Scripted formatter payload contains extra key | Arguments: `{"output":{"answer":"IL_F0_ANSWER","count":7,"extra":"IL_F0_EXTRA"}}`. |
| Extra property is rejected | Parser receives exact argument text and fails. No successful stripped or preserved payload is returned. |
| Schema diagnostic | `Model output doesn't fit required format`, with `outputParserFailReason: Model output does not match the expected schema`. |
| No successful answer | Top-level, parser, and Agent statuses are `error`. Parser has no parsed response; Agent has no output data. |
| One buffered request | One saved model sub-run; provider status recorded one received/accepted request, complete without a problem. No repair or continuation observed. |

The tested extra property is inside the authored payload, under the formatter's
output wrapper. This does not establish behavior for extra wrapper properties,
open or unspecified additionalProperties, other parser versions, or auto-fix.
Scripted output demonstrates orchestration, not model compliance. No portable
validation or runtime contract is approved by this capture.
