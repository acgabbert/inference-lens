# Multiple-output tool workflow observations

The parent and child executions both succeeded on n8n `2.39.10`, as confirmed
by the user. The controlled provider saved the initial tool definition and the
continuation after the child ran.

- n8n exposed `il_multiple_items` with one required string property, `topic`,
  plus `additionalProperties: false` and the draft-07 `$schema` URL.
- The child emitted two separate items with ordinal values 1 and 2. The provider
  continuation sent one linked `role: "tool"` message whose string content was
  a JSON array containing those two items in the same order.
- The continuation preserved the scripted call ID and added that ID inside the
  assistant call argument JSON. The provider returned
  `IL_N0_CAPTURE_COMPLETE`, which the parent saved as its output.

An earlier parent run failed before child execution because the child workflow
was inactive. Its first rejected provider request contained a model-visible
tool error, `Workflow is not active and cannot be executed.` The provider
remained in its awaiting-continuation state; a later request received a 422
linkage error. That run is retained only in ignored raw staging and is not a
multi-item serialization reference.

The projected fixture contains no provider credential, instance URL, or source
workflow and execution IDs.
