# Run trace format

New traces use schema version 6. Versions 1 through 5 remain importable.
Versions 1 and 2 gain an empty `input.templateResolutions` collection during
migration; Versions 1 through 3 gain `responseMode: "streaming"` on the run,
turn events, and attempt projections. Version 5 replaces fragment-shaped
template provenance with a non-empty ordered message list; Versions 1 through 5
gain an empty `toolExecutions` collection during migration.

## Template provenance

When an authored conversation contains pinned template uses, version 3 stores
a self-contained `templateResolutions` array on `ResolvedRunInput`. Each entry
contains the use, template, and revision IDs; the template name; pinned messages
and defaults; the final selected non-secret values; and stable output message
IDs.

The ordinary resolved `input.messages` remain the provider-neutral execution
input. On import, Inference Lens renders every provenance entry and rejects the
trace if its emitted IDs, roles, or text differ from those messages. Older
traces import with no template provenance.

Because provenance is re-derived rather than trusted, the version 3 envelope
validates its shape before anything reads it: a missing, malformed, or
partially written `templateResolutions` array is rejected as an invalid trace
with the offending path named, not surfaced as an internal error. Duplicate
template-use or output-message identities are also rejected. Version 3
provenance must resolve without diagnostics: current Inference Lens execution
blocks missing or invalid variables, so an artifact claiming otherwise is not
accepted as a valid Inference Lens run. Version 1 and 2 compatibility remains
unchanged because those formats contain no template provenance.

Inference Lens run traces are immutable, credential-free diagnostic artifacts.
Version 6 uses deterministic JSON and is stored as `traces/<runId>.json` when a
run belongs to an open project folder. A terminal ad hoc run can be exported
from the Project menu, and older traces can be imported for
inspection.

The response pane always reports trace storage state. Project runs show the
project display path and relative `traces/<runId>.json` location. Ad hoc runs
remain visibly unsaved until the user chooses **Save trace…**. Tauri uses a
native Save As dialog and reports the chosen path; browsers initiate a download
and report the filename because the browser controls the final destination.

## Run history

For an open folder, **Project → Run history** enumerates trace files under
`traces/`, validates each artifact through this format's canonical parser, and
derives display summaries from its reconstructed run state. Invalid files are
reported as skipped without hiding valid traces, and selecting an entry opens
the same read-only inspection state as an imported trace.

No history index is written. The list is therefore worth exactly one full parse
and event reduction per artifact, every time it is built, and that cost is the
reason the folder is read only while the drawer is open. A run saved while it
is closed marks the list stale rather than re-reading the folder behind it.

A listed entry retains only its summary. The selected trace is read again from
its own file, so the opened run reflects the artifact as it is on disk, and the
history of a long-lived project does not sit in memory as every event and raw
SSE line it ever recorded.

Entry names are treated as untrusted input on the way back to the filesystem.
`isTraceEntryName` in `packages/core/src/run-trace.ts` defines the rule — a
`.json` suffix, no separators, no traversal, no leading dot — and
`src-tauri/src/lib.rs` mirrors it, because a discovered name is not derived
from a validated run ID the way a written one is. A name that does not match is
skipped when listing and refused when reading. An artifact renamed by hand is
still listed and still opens; it is shown and read under the name it actually
has rather than one recomputed from its run ID.

## Ownership and lifecycle

`packages/core/src/run-trace.ts` owns parsing, consistency validation,
deterministic serialization, and safe filenames. Browser and Tauri workspace
adapters own filesystem access. The project manifest never contains trace
paths or trace contents.

Only terminal runs have durable artifacts:

- completed runs;
- non-retryable failures;
- retryable failures that the user stops instead of retrying; and
- cancelled runs.

Paused tool calls and retryable failures remain live session state. Importing a
trace restores its terminal `RunState` for inspection but does not restore a
credential, active transport, or resumable `RunCoordinator`.

## Evidence model

Each attempt owns one `ExchangeTrace` containing:

- the final URL and method;
- runtime-visible request headers with secrets replaced;
- the exact serialized request body supplied to the HTTP client;
- response status and runtime-visible redacted headers; and
- complete provider SSE data lines, indexed in arrival order, or the complete
  JSON body for a buffered response.

Normalized run events are stored separately and refer to their source exchange
and frame index. This keeps provider-native evidence available without making
the reducer or UI depend on a provider's payload shape.

The artifact also stores the immutable resolved input, ordered events, derived
turn and attempt projections, tool executions, tool results, terminal status,
and timestamps.
Import reconstructs those projections from the event stream and rejects a file
when the stored projections disagree.

## Compatibility and immutability

The root `schemaVersion` is currently `6`. Version 1 is accepted with its
original strict root schema; Version 2 adds the optional `branchedFrom` field,
Version 3 adds required template provenance, Version 4 adds the required
run-level response mode, Version 5 stores template provenance as messages, and
Version 6 adds the required `toolExecutions` collection. The response mode is:

```ts
"streaming" | "buffered"
```

The mode is copied into each provider-turn input, so retries and tool-driven
continuation turns preserve how the run was executed. New serialization always
writes Version 6.

`toolExecutions` is required rather than optional so that an artifact cannot be
ambiguous between "this run executed no tools" and "this file predates the
field": the former is an empty array, the latter is a Version 5 envelope. Each
record names the executor that served a call by secret-free identity only —
never its binding configuration. See
[tool execution](TOOL_EXECUTION.md).

Unknown root fields, unsupported versions, invalid identifiers, non-contiguous
event sequences, and unsafe run IDs are rejected.

Trace writes are write-once by run ID. Writing identical contents again is
idempotent; writing different contents to an existing filename fails. Future
schema versions must use explicit parsers or migrations rather than silently
reinterpreting Version 1 evidence.
