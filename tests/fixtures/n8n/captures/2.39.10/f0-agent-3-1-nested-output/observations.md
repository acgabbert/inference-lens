# F0: authored nested output field, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Authored output field | Payload schema requires answer, count, and output; authored output is an object requiring string label. |
| Separate formatter wrapper | Wire parameters require an outer output property containing the authored payload shape, including its own output field. |
| Schema conversion differs from authored schema | Authored nested output omits additionalProperties, but its wire schema adds additionalProperties false. This is a descriptor observation, not a test of parsing an extra nested key. |
| Exact scripted arguments | `{"output":{"answer":"IL_F0_ANSWER","count":7,"output":{"label":"IL_F0_NESTED"}}}`. |
| Nested authored data preserved | One parser run receives those exact arguments; parsed response and Agent output item both retain answer/count and the inner output object. Execution succeeds. |
| One buffered request | One saved model sub-run; provider status recorded one received/accepted request, complete without a problem. No continuation or ordinary-tool run. |

The public API returned this execution's workflow snapshot at top-level
workflowData; the existing projection normalizes that into data.workflowData.
The exact execution snapshot, not the later current workflow, establishes the
schema used for the run.

The first fixture assertion assumed equality between authored and wrapped wire
schemas and failed on the added nested additionalProperties field. The assertion
now records that exact observed conversion instead of assuming equality.

This demonstrates these two levels of output without flattening authored data.
It does not approve an effective-answer projection for Inference Lens, nor prove
other root shapes, legacy wrappers, versions, or streaming. Scripted output
measures orchestration, not model compliance.
