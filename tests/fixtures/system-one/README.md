# System One wire fixtures

The `llamacpp-*` files are **captured** from a live `llama-server`; their
`provenance` block records the build, model, and date. Each one is the
request body sent and the response body exactly as received. The Bearer key
went only in a request header, which isn't stored. The rest are
**doc-derived**: assembled from the field names and examples
in the primary docs listed in
[the System One plan](../../../docs/SYSTEM_ONE_PROTOCOL_PLAN.md#sources), not
captured from a live server. Each file says so in its `provenance` block.

They exist so the Phase 1 adapter can be built and tested before any
implementation is reachable from this machine. Replace each one with a
redacted capture (set `provenance.kind` to `"captured"` and record the server,
version, and date) before host or UI work depends on it. A doc-derived fixture
can only prove the adapter agrees with the docs; it cannot prove the docs agree
with a server.

Shape:

```jsonc
{
  "provenance": { "kind": "doc-derived" | "captured", "implementation": "…", "sources": ["…"] /* or server, model, captured, note */ },
  "request": { … },          // the body Inference Lens sends, when relevant
  "response": {
    "status": 200,
    "body": { … }            // the response body exactly as the server would send it
  }
}
```
