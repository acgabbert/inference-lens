# MCP SDK interoperability spike decision

- **Status:** accepted for M2 implementation; the n8n comparison remains an N0/M3 integration gate
- **Date:** 2026-09-23
- **Repository baseline:** `d969875` (`feat/n8n-tool-workflow-stubs`)
- **Scope:** M1 only; no product implementation or portable-format change

## Decision

Inference Lens will use `@modelcontextprotocol/client` `2.1.0` in the Node host
service for MCP Streamable HTTP discovery and calls. The SDK must not be
imported by `packages/core`, browser-owned feature code, or the Tauri shell.

The host will explicitly opt into SDK protocol negotiation. It will prefer
MCP `2026-07-28`, accept `2025-11-25` as the first-release legacy fallback,
and reject other negotiated revisions until an interoperability fixture covers
them. The SDK supports older revisions, but SDK capability alone is not an
Inference Lens compatibility claim.

The first release will not fall back to the legacy HTTP+SSE transport. A server
must accept Streamable HTTP. This keeps one transport, authorization boundary,
timeout policy, and evidence path in the initial product slice.

## Spike environment

The disposable spike used:

- Node `22.14.0`;
- `@modelcontextprotocol/client` `2.1.0`;
- Python `3.12.14`;
- official Python package `mcp==2.1.1`;
- a Python `MCPServer` on `127.0.0.1` with static bearer authorization;
- one deterministic read-only tool and one harmless mutation sentinel;
- a two-page `tools/list` response containing one tool per page;
- the existing Inference Lens `buildChatCompletionsRequest` serializer.

The server and clients were created under `/private/tmp` and are not part of
this change. The spike sources, lockfile, and captured evidence were secret-
scanned before disposal. No authorization value appeared in an evidence file.

The reference server exposed:

| Tool | Inputs | Results exercised |
| --- | --- | --- |
| `lookup_test_record` | required string and optional boolean | deterministic structured success |
| `submit_test_action` | action enum, string, optional delay | success, deliberate tool error, unexpected exception, delay |

Both official clients negotiated `2026-07-28`, reported the same server
identity, reconstructed the same complete two-tool catalog, and observed equal
content, structured content, and `isError` values for all four completed result
cases. The TypeScript client aggregates cursor pages when `listTools()` is
called without a cursor. The Python client returns one page and required an
explicit cursor loop. Inference Lens must own an explicit page and item ceiling
even though the selected TypeScript client performs the cursor loop.

## Observed behavior

### Protocol and authorization

- Explicit TypeScript `versionNegotiation: { mode: "auto" }` selected
  `2026-07-28`. The SDK default is legacy negotiation, so relying on defaults
  would silently select the wrong protocol era.
- A forced legacy connection negotiated `2025-11-25` successfully against the
  same server.
- An unauthenticated discovery attempt failed as `SdkHttpError` with
  `CLIENT_HTTP_AUTHENTICATION` before tools were exposed.
- A host-supplied `Authorization` header reached every authorized request. It
  appeared in no tool definition, result, normalized mapping, or saved
  evidence.
- A connection-refused discovery attempt failed as `SdkError` with
  `ERA_NEGOTIATION_FAILED`.

### Discovery and descriptor mapping

The generated descriptor fields relevant to the model were `name`,
`description`, and `inputSchema`. Copying those values into the existing
`ToolDefinition` preserved them exactly. The existing OpenAI-compatible
serializer then produced the expected ordinary function-tool shape:

```json
{
  "type": "function",
  "function": {
    "name": "lookup_test_record",
    "description": "Look up one deterministic synthetic record by identifier.",
    "parameters": {
      "type": "object",
      "properties": {
        "record_id": { "type": "string" },
        "include_history": { "type": "boolean", "default": false }
      },
      "required": ["record_id"]
    }
  }
}
```

The example omits generated `title` fields for readability; the executable
check compared the complete nested value. MCP `outputSchema`, annotations,
icons, and `_meta` are not part of the current provider-visible
`ToolDefinition` contract. They may be
retained in bounded discovery data, a source receipt, and the discovery
fingerprint without being copied into provider options. No core schema needs
to be weakened for the measured MCP tools.

The provider-wire comparison against n8n cannot be completed from authored
workflow stubs. It must compare this ordinary function-tool request with the
redacted N0 provider capture after that capture exists. This is an N0/M3 gate,
not a reason to couple MCP SDK types to N0.

### Results and failures

The official Python server returned structured successes as both a text content
part and `structuredContent`. A deliberate `ToolError` and an unexpected
exception both arrived as completed `CallToolResult` values with
`isError: true`. The unexpected exception detail remained server-side; the
client received only `Error executing tool submit_test_action`.

That confirms the following boundary:

| Observed condition | Inference Lens outcome |
| --- | --- |
| Valid `CallToolResult`, `isError` absent/false | `completed`, `isError: false` |
| Valid `CallToolResult`, `isError: true` | `completed`, `isError: true` |
| SDK invalid-result/schema-validation error | `failed.invalid_result` |
| Host deadline expires | `failed.timeout` |
| Caller aborts | `failed.cancelled` |
| Local policy refuses the call | `failed.rejected` |
| Authentication, negotiation, JSON-RPC, HTTP, disconnect, or other transport error | `failed.execution_failed` |

The adapter must classify from host-owned intent before consulting the SDK
error. In the selected TypeScript SDK, both a request timeout and an explicit
abort surfaced as `SdkError` code `REQUEST_TIMEOUT`. They remain
distinguishable because the caller's signal was aborted only in the explicit
cancellation case.

More importantly, neither a modern per-request stream abort nor a forced
`2025-11-25` cancellation stopped the delayed Python tool coroutine in this
HTTP/ASGI fixture. Client cancellation is therefore a local terminal outcome,
not proof that a remote mutation stopped. M2/M3 must not automatically retry a
cancelled or timed-out mutation, and the approval/result UI must avoid saying
the remote action was undone.

### Size and dependency measurements

The small fixture produced:

- 24 measured TypeScript HTTP exchanges across all scenarios and benchmark
  connections;
- 7,468 total request bytes and 13,153 total response bytes;
- a largest request of 348 bytes and largest response page of 1,094 bytes;
- normalized result JSON between 276 and 794 bytes;
- 17,308 KiB installed Node dependency tree on disk;
- 6,796 KiB installed `@modelcontextprotocol/client` package on disk;
- a minified Node bundle of 447,988 bytes, 122,632 bytes gzip, for the complete
  spike client.

The bundle measurement is an upper-bound integration signal, not a browser
asset budget: the package belongs in the server-only graph and the spike entry
also contained diagnostics and evidence writing.

## Host contract for M2/M3

### Placement and lifetime

- Own MCP clients in `services/api`, beside the existing provider and command
  host capabilities.
- Pool one lazily connected client per server-profile ID and authorization
  context. Never key a pool by a browser-supplied endpoint or token.
- Close and discard a client on declaration removal, authorization-context
  change, terminal transport failure, application shutdown, or five minutes
  idle. Reconnect through negotiation rather than retaining MCP session data in
  browser state.
- Use explicit TypeScript `listMaxPages: 64`; also stop after 512 normalized
  tools or 4,194,304 aggregate raw discovery-response bytes, whichever occurs
  first.

The local timing sample did not show a meaningful latency difference between
five pooled calls and five fresh modern connections because the server was
same-process-local and the 2026 protocol is stateless. Pooling is still the
right host contract: it avoids repeated discovery, keeps pagination and schema
caches coherent, and gives shutdown and catalog revocation one owner.

### Timeout and cancellation ownership

- The host owns the deadline and creates one combined `AbortController` per
  discovery or call.
- Record whether the controller was aborted by the caller, the host deadline,
  profile revocation, or shutdown before mapping the SDK error.
- Use 10 seconds for connect/discovery and 30 seconds for a call by default;
  later per-profile call timeouts may only narrow or deliberately replace that
  value through an approved local contract.
- Treat cancellation and timeout as locally final and remotely ambiguous. Do
  not retry mutation-capable tools automatically.

### Result and evidence limits

- Stop reading a tool-call HTTP response after 1,048,576 bytes, matching the
  current default command-tool output ceiling.
- Stop normalized MCP content plus structured content after 1,048,576 bytes.
  Oversize or undecodable results map to `invalid_result`; no truncated value
  is sent to the provider as if complete.
- Enforce limits in a host-owned `fetch` wrapper before the SDK buffers an
  unbounded response. A `Content-Length` check is only an early refusal; the
  stream reader remains authoritative.
- Raw MCP evidence, when M3 introduces it, belongs in the separate linked raw
  evidence artifact already chosen by the executor plan. Persist redacted
  method, bounded params/result, protocol revision, timing, and error class.
  Never persist request headers, endpoint, authorization data or references,
  cookies, MCP session IDs, or unknown `_meta` keys by default.

### Catalog feasibility

The operator-owned server catalog is feasible. The TypeScript transport
accepted authorization supplied only by the host's request initialization,
while normalized discovery and results remained credential-free. The product
contract should retain the plan's environment-variable reference rather than
allowing browser-provided headers.

## Rejected alternatives

- **`@modelcontextprotocol/sdk` v1 compatibility package:** rejected for new
  implementation. The released v2 client package has the required negotiated
  Streamable HTTP behavior and a narrower dependency surface.
- **SDK default negotiation:** rejected because `2.1.0` defaults to the legacy
  era. The product requires an explicit, reviewable mode.
- **Per-call client construction:** rejected because it repeats negotiation and
  loses coherent discovery/cache ownership.
- **Browser-owned MCP client:** rejected because it would move endpoint,
  authorization, CORS, limits, and raw evidence across the trust boundary.
- **Legacy HTTP+SSE fallback:** deferred. The SDK exposes a fallback transport,
  but the first release has no compatibility evidence or security need for it.
- **SDK errors as the failure taxonomy:** rejected. Timeout and abort already
  collapse to the same SDK code, and the existing executor vocabulary is the
  product contract.

## Acceptance and remaining gate

M1 established:

- official Python server interoperability with official TypeScript and Python
  clients;
- equal paginated discovery and tool results across both clients;
- distinct tool errors, transport failure, host timeout, and host
  cancellation;
- host-only authorization;
- exact descriptor mapping into current `ToolDefinition` and the ordinary
  OpenAI-compatible provider request;
- no need for MCP SDK types in `packages/core`;
- exact SDK, protocol, placement, lifetime, limit, evidence, transport, and
  failure-mapping decisions for M2/M3.

N0 must still supply the authoritative n8n provider request. Once it does, N1
or M3 can compare its function-tool descriptor with the request shape proven
here. Until then, this record makes no n8n compatibility claim.

## References

- [Official TypeScript SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [Official TypeScript client connection documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md)
- [Official Python SDK releases](https://github.com/modelcontextprotocol/python-sdk/releases)
- [Official Python protocol-version documentation](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/protocol-versions.md)
- [MCP Streamable HTTP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)
- [Existing executor contract](TOOL_EXECUTION.md)
- [Existing command-host limits and security model](COMMAND_TOOLS.md)
