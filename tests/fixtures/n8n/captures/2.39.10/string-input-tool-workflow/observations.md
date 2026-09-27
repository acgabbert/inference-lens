# String-input tool workflow observations

This fixture pairs one successful parent execution with its successful child
execution and the controlled provider's two-turn exchange. The saved provider
requests are the authoritative model-visible evidence; the execution records
show that the child actually received and returned the string.

## Observed contract

- The initial request sent `system` and `user` messages and one ordinary
  function tool named `il_echo_string`. It omitted `tool_choice` and
  `parallel_tool_calls`.
- The tool schema required `text` as a string and included
  `additionalProperties: false` and the JSON Schema draft-07 `$schema` URL.
- The scripted provider returned arguments containing only `text`. In the
  continuation, n8n preserved the call ID and added that same ID as an `id`
  property inside the assistant call's argument JSON. Assistant `content` was
  an empty array.
- The child returned one item with `fixture`, `echoed`, and `receivedType`.
  n8n sent that item to the provider as a JSON-array string in a `role: "tool"`
  message linked by `tool_call_id`, without a `name` field.
- The provider returned `IL_N0_CAPTURE_COMPLETE`, which is also the parent's
  saved output.

## Comparison boundary

The current Inference Lens serializer emits the attached `ToolDefinition`
schema as supplied, preserves the model's original argument text, serializes
empty assistant content as `null`, and includes the tool name on a tool-result
message. The schema can be compared only after attaching an equivalent
definition; the continuation differences are directly visible in this capture.
One string-input scenario does not establish whether these differences are
stable across n8n versions, tool types, or multiple arguments.

The fixed-input versus `$fromAI()` case remains unmeasured. A later paired
capture should compare a call supplying only model-owned inputs with a call
that also supplies a fixed input, recording the advertised schema, rejection
point, child execution count, and any provider continuation.

## Redaction review

The projection keeps both workflow snapshots and execution identities
separate. Credential and provider connection fields, the cached child-workflow
URL, source IDs, and execution timestamps were removed or replaced. The
provider request content and synthetic sentinels were preserved. The fixture
contains no API key, instance URL, or raw workflow ID.
