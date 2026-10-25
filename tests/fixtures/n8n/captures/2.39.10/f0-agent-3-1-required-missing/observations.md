# F0: required count omitted, Agent 3.1, buffered

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Required field omitted | Formatter arguments are `{"output":{"answer":"IL_F0_ANSWER"}}`; authored and wire payload schemas require answer and count. |
| Missing count rejected | Parser receives exact argument text and fails with `Model output does not match the expected schema`. |
| No successful answer | Top-level, parser, and Agent statuses are `error`. Parser has no parsed response; Agent has no output data. |
| One buffered request | One saved model sub-run; provider status recorded one received/accepted request, complete without a problem. No repair or continuation observed. |
| No ordinary tool execution | No `il_echo_string` run entry. |

Together with the formatter-only success fixture, this distinguishes omission
of required count (rejected) from optional note (accepted). It does not establish
behavior when the outer output wrapper is omitted, inferred schemas, other node
versions, or auto-fix. Scripted output measures orchestration, not model
reliability. No portable validation or runtime contract is approved here.
