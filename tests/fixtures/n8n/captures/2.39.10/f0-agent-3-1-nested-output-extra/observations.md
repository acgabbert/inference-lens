# F0: extra nested key with authored additionalProperties omitted

Captured 2026-10-25 on operator-reported n8n **2.39.10**. Execution snapshot:
Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser **1.3**,
attached Workflow Tool **2.2**, auto-fix disabled. Source inspection reference
from PR185: `cfbd9a56cba2e73901dc1962e47727adbea0b23e` (not a verified
instance build SHA). Source/projected-file hashes are in `manifest.json`.

| Observation | Evidence |
| --- | --- |
| Authored schema leaves nested extras unspecified | The authored output object requires label but omits additionalProperties. The enclosing payload explicitly has additionalProperties false. |
| Wire schema closes nested object | Formatter parameters add additionalProperties false to that nested output object. |
| Script supplies an extra nested key | Raw call arguments include output.output.extra = IL_F0_NESTED_EXTRA alongside label. |
| Parser strips the extra key | Parser input retains the exact raw arguments, but successful parsed response omits extra and preserves label. |
| Final output follows normalized result | Agent item is `{"output":{"answer":"IL_F0_ANSWER","count":7,"output":{"label":"IL_F0_NESTED"}}}`. |
| One buffered request | One saved model sub-run; provider status recorded one received/accepted request, complete without a problem. No continuation, repair, or ordinary-tool run. |

This differs from the explicitly closed extra-property fixture, which fails.
A validator merely applying the wire schema to raw arguments would reject this
capture; one applying the authored schema without transformation would retain
the key. Neither reproduces this observed normalized result automatically.

The compatibility design must choose explicit supported schema/normalization
rules or disclose reduced parity. Do not silently turn this observation into a
provider-neutral stripping rule. Other schema conversion rules, versions,
coercion, defaults, and repair behavior remain unverified. Scripted responses
measure orchestration, not model reliability.
