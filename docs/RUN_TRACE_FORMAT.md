# Run trace format

Trace Lens run traces are immutable, credential-free diagnostic artifacts.
Version 2 uses deterministic JSON and is stored as `traces/<runId>.json` when a
run belongs to an open project folder. A terminal ad hoc run can be exported
from the Project menu, and Version 1 and Version 2 traces can be imported for
inspection.

The response pane always reports trace storage state. Project runs show the
project display path and relative `traces/<runId>.json` location. Ad hoc runs
remain visibly unsaved until the user chooses **Save trace…**. Tauri uses a
native Save As dialog and reports the chosen path; browsers initiate a download
and report the filename because the browser controls the final destination.

For an open folder, **Project → Run history** enumerates JSON files under
`traces/`, validates each artifact through this format's canonical parser, and
derives display summaries from its reconstructed run state. No history index is
written. Invalid files are reported as skipped without hiding valid traces, and
selecting an entry opens the same read-only inspection state as an imported
trace.

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
- complete provider SSE data lines, indexed in arrival order.

Normalized run events are stored separately and refer to their source exchange
and frame index. This keeps provider-native evidence available without making
the reducer or UI depend on a provider's payload shape.

The artifact also stores the immutable resolved input, ordered events, derived
turn and attempt projections, tool results, terminal status, and timestamps.
Import reconstructs those projections from the event stream and rejects a file
when the stored projections disagree.

## Compatibility and immutability

The root `schemaVersion` is currently `2`. Version 1 is accepted with its
original strict root schema; Version 2 adds the optional `branchedFrom` field:

```ts
{
  runId: RunId;
  parentConversationRevisionId?: ConversationRevisionId;
  messageId: MessageId;
}
```

It records the source run and the last source-transcript message included in a
branch input. It is trace metadata, not an execution input or event, so a
parent trace need not be present when it is imported. New serialization always
writes Version 2. Unknown root fields, unsupported versions, invalid
identifiers, non-contiguous event sequences, and unsafe run IDs are rejected.

Trace writes are write-once by run ID. Writing identical contents again is
idempotent; writing different contents to an existing filename fails. Future
schema versions must use explicit parsers or migrations rather than silently
reinterpreting Version 1 evidence.
