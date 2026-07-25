# Architecture boundaries

Trace Lens is packaged as both a local web application and a Tauri desktop
application. Its execution and project contracts are independent of the
presentation and deployment shell.

```text
React UI -> RunCoordinator -> ProviderTurnTransport -> HTTP or Tauri -> provider
                     |
                     +-> canonical RunEvent / RunState
```

`packages/core` owns the provider-neutral run model, reducer, and client-side
`RunCoordinator`. The coordinator owns complete-run IDs, ordered `RunEvent`
creation, tool-result pauses, and construction of subsequent model turns.
Retryable transport failures and HTTP 408, 429, and 5xx provider failures pause
the current turn. Retrying reuses that attempt's immutable
`ProviderTurnInput`, keeps its `turnId`, increments the attempt number, and
creates a new exchange; the failed attempt and exchange remain inspectable.
Non-retryable failures terminate the run.

`packages/contracts` owns the browser-to-host request shape. A
`ProviderTurnTransport` executes exactly one `ProviderExecution` and streams
normalized `ProviderTransportEvent` values. `packages/core/src/openai-compatible.ts`
is the single, provider-neutral implementation of request construction, SSE
parsing, and normalization; both hosts call into it rather than each keeping
their own copy. The HTTP and Tauri hosts own credentials and provider
networking, but not provider-specific serialization, and they do not retain
complete-run state.

`app/http-inference-transport.client.ts` is the only UI module that knows the
current `/api/*` URLs and NDJSON parsing details.

The API service resolves credentials through `CredentialStore`. The initial
`EnvironmentCredentialStore` reads `TRACE_LENS_API_KEY` inside the API process.
It releases that credential only to the origin configured by
`TRACE_LENS_API_ENDPOINT`, making it suitable for an individual developer's
local container while keeping the secret out of client JavaScript. The HTTP
routes also require same-origin JSON requests. A `provided` credential is
session-only input for the local workbench; it is never included in profile
metadata, projects, diagnostics, or browser persistence.

Tauri implements `ProviderTurnTransport` with IPC rather than HTTP. Rust is an
origin-pinned streaming proxy: `app/tauri-inference-transport.client.ts` builds
the request body with the shared core adapter and derives the credential's
approved origin, but the request URL is always derived in Rust from the same
endpoint the credential was resolved against — never accepted pre-built from
the webview — so a compromised webview cannot redirect a keychain secret to an
arbitrary host. Rust forwards raw SSE lines over the existing event channel;
`packages/core/src/openai-compatible.ts` parses and normalizes them on the
TypeScript side, the same code path the web host uses. The same TypeScript
coordinator therefore drives web and desktop runs without duplicating the
resumable state machine, or the provider protocol parsing, in Rust.

Project persistence follows the same boundary:

```text
Project v2 parser/serializer -> ProjectWorkspace -> browser folder or Tauri filesystem
RunTrace v1 parser/serializer -> ProjectWorkspace -> traces/<runId>.json
```

`packages/core/src/project.ts` owns the strict, portable Project v2 document.
Browser and Tauri adapters own directory selection, permissions,
external-change detection, and writing. Imported projects contain portable
connection requirements; the UI requires an explicit mapping to a local
inference profile before a run can resolve that profile's credential.
Workspace handles expose a human-readable display location for status text,
but native filesystem commands continue to accept only the opaque workspace ID.

`packages/core/src/run-trace.ts` owns the versioned diagnostic artifact
boundary. It validates the file envelope, reconstructs canonical run state from
the ordered event stream, rejects projections that disagree with those events,
and serializes deterministically. A terminal run is written once to the
workspace that owned it when execution began. Trace writes are idempotent but
never replace different contents for the same run ID. Imported traces restore
inspectable terminal state; they do not recreate a live coordinator or
credential capability.

Runs without a writable project workspace are not silently persisted. Their
terminal UI state is explicitly marked unsaved. Saving one uses a native Save
As dialog in Tauri or an explicit browser download; the selected native path or
browser-controlled filename is then shown beside the run.

Raw exchange evidence remains distinct from normalized events. Each attempt
records the exact serialized request body supplied to the HTTP client, every
runtime-visible header after redaction, and complete SSE data lines without their
terminating CR/LF. Normalized deltas refer back to those frames by exchange and
frame index.
