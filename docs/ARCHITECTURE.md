# Architecture boundaries

Inference Lens is packaged as both a local web application and a Tauri desktop
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
`EnvironmentCredentialStore` reads `INFERENCE_LENS_API_KEY` inside the API process.
It releases that credential only to the origin configured by
`INFERENCE_LENS_API_ENDPOINT`, making it suitable for an individual developer's
local container while keeping the secret out of client JavaScript. The HTTP
routes also require same-origin JSON requests. A `provided` credential is
session-only input for the local workbench; it is never included in profile
metadata, projects, diagnostics, or browser persistence.

Tauri implements `ProviderTurnTransport` with IPC rather than HTTP. Rust is an
origin-pinned response proxy: `app/tauri-inference-transport.client.ts` builds
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
Project v8 parser/serializer -> ProjectWorkspace -> browser bundle or Tauri filesystem
RunTrace v1 parser/serializer -> ProjectWorkspace -> traces/<runId>.json
```

`packages/core/src/project.ts` owns the strict, portable Project v8 document
and the provider-neutral bundle naming rules.
Browser and Tauri adapters own directory selection, permissions,
external-change detection, and writing. Imported projects contain portable
connection requirements; the UI requires an explicit mapping to a local
inference profile before a run can resolve that profile's credential.
The browser adapter also owns persistence of the directory grant, never the
project contents, and keeps the raw handle internal so `ProjectWorkspaceHandle`
stays opaque on both hosts.
Workspace handles expose a human-readable display location for status text,
but native filesystem commands continue to accept only the opaque workspace ID.

Every condition that refuses a run is derived once, by
`app/run-readiness.client.ts`, from the open project, its declared endpoint,
and its template resolution. Both the disabled Run button's tooltip and the
notice in the request pane read that one value, so a refused run always states
the same reason in both places, along with the action that clears it. A mapping
whose endpoint differs from the project's declared one is reported rather than
refused: moving a project between a hosted provider and a local server is
ordinary, but sending a request somewhere the document does not describe should
never be silent.

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

Run metrics, timelines, and attempt diffs are derived projections over
`RunState`. They are never persisted and are not part of the `RunTrace`
envelope. Attempt comparison canonicalizes captured JSON for display, but the
underlying exact request text remains unchanged in exchange evidence. Adding
the comparison view therefore does not change the trace schema or its
compatibility boundary.

`packages/core/src/run-output.ts` owns the one canonical projection of what a
run answered, and `packages/core/src/checks.ts` owns the provider-neutral
deterministic-check vocabulary evaluated over it. Both are pure derivations
over `RunState`. Check outcomes are never written into a `RunTrace`: a trace
stays immutable provider evidence, while whether that evidence satisfies an
assertion is re-derived. A run that failed or was cancelled makes every check
`not-evaluated` rather than failed, so provider instability is never reported
as a quality regression. See [deterministic checks](DETERMINISTIC_CHECKS.md).

## Workbench ownership

`app/page.tsx` is the workbench composition root. It owns top-level layout,
view selection, and the deliberate transactions that connect profile,
workspace, draft, template, and run features; it does not own feature-local
workflows.

| Concern | Owner |
| --- | --- |
| Profile, capability, credential, and profile deletion | `useConnectionProfiles` |
| Portable project lifecycle, folder resume, persistence, and profile mapping | `useProjectWorkspace` |
| Authored request messages, tools, and mocks | `useRequestDraft` |
| Run validation and provider-neutral input derivation | `app/run/prepare-workbench-run.client.ts` |
| Live coordination, retry, continuation, stop, diagnostics, and trace lifecycle | `app/run/use-run-session.client.ts` |
| Template-use state, immutable mutations, external-import application, and preview | `app/templates/use-project-templates.client.ts` |
| Request-pane presentation and local navigation | `app/request/request-composer.client.tsx` |
| Inference option-set presentation and its disclosure | `app/inference-settings-panel.client.tsx` |
| Run-history listing and artifact reads | `useProjectRunHistory` |

### The shared inference settings panel

Model, temperature, and delivery are one option set with three owners: the
request composer holds them as session state, an evaluation suite stores them as
portable project content in `suite.execution`, and a repeated experiment freezes
them into its plan. `InferenceSettingsPanel` presents that set once for all
three. It stores nothing — `value` in, `onChange` out — so each surface keeps the
persistence its own contract requires.

Two properties are contractual rather than cosmetic:

- **The disclosure is controlled by the surface.** The panel's controls are not
  in the document while it is collapsed, so run-readiness routing to
  `{ surface: "request", control: "model" }` has to open the composer's panel
  before it can focus the field. An uncontrolled disclosure would make that
  destination fail silently.
- **State that must outlive a collapse belongs above the disclosure.** The
  remembered temperature override lives in the panel, not in
  `TemperatureControl`, because the control unmounts every time the panel closes.

Surface-specific settings arrive as declared slots (`connection`,
`repetitions`), each carrying its own collapsed summary, so hiding the panel
never hides a value. Anything that is a *consequence* of the settings rather
than one of them — the composer's tool line, an evaluation's planned run count —
stays outside the panel, because those must remain readable while it is closed.
