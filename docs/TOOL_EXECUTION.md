# Tool execution

Inference Lens can pause a run at a tool call. This document covers what
happens when something actually serves that call, and where the evidence goes.

There are two executors: the project mock, and
[the command tool](COMMAND_TOOLS.md). The mock could not falsify this contract —
it has no transport, no timeout, and no asynchronous failure — so the command
tool is what actually tested it. The contract held: the command executor added a
binding kind, an identity case, and a host module, and changed nothing in the
run model. An MCP client arrives later against the same seam.

## Descriptor and binding

Two things are easy to conflate and must not be:

- A **`ToolDefinition`** is a portable descriptor. It says what a tool is
  called and what it accepts. It travels in projects, run plans, and traces, and
  it is what the provider is shown.
- A **`ToolBinding`** says how that tool is served *on this device* — which
  mock, which executable, which server, with which credential. It travels
  nowhere.

The only part of a binding that may be persisted is its
`ToolExecutorIdentity`: a kind, a stable secret-free `executorId`, and an
optional human-readable label. `toolExecutorIdentity` in
`packages/core/src/tool-execution.ts` is the seam that produces it, and it is
written as an explicit construction per binding kind rather than as a field
deletion, so a binding kind added later cannot leak its configuration by
default — it has to be given an identity there first.

A mock binding is **derived, not stored** (`toolBindingForMock` in
`app/run/run-session-state.client.ts`). Mocks live in the project because their
*content* is authored material a teammate should receive; there is nothing
device-local about them to remember.

A command binding **is** stored, in
`app/tools/command-tool-bindings.client.ts`: a grant of `toolId → commandId`
with the moment it was made. What it deliberately does not store is the
executable, its arguments, or its timeout — those live in the operator's catalog
on the host, so the registry stays safe in browser storage and the page can
never name what runs. `toolBindingFor` composes the two, and a grant on this
device outranks a mock that arrived with the project.

Where **timeout policy** lives follows from the same split. `executeToolCall`
classifies only thrown errors, so a transport-bearing executor classifies its
own timeouts; for command tools the value is declared per command in the
catalog, beside the executable it bounds.

## Outcomes

`ToolExecutionOutcome` distinguishes two things that are constantly confused:

- A tool that **ran and reported an error** is a *completed* execution carrying
  `isError: true`. The provider is entitled to see it and reason about it.
- A tool that **could not produce a result** is a *failed* execution, classified
  as `execution_failed`, `invalid_result`, `timeout`, `cancelled`, or
  `rejected`.

A failed execution never fabricates a tool result. The call stays pending, the
failure is shown, and a human can supply a result by hand. Telling a model that
a tool "said" something when the truth is that a process did not start would
make every downstream assertion about that run meaningless.

An executor that throws instead of returning a classified failure is classified
by `executeToolCall` rather than left to propagate: an unhandled rejection that
left an execution open would make the run permanently unable to accept a result
for that call.

## Result content

`ToolExecutionContentPart` is wider than `MessageContentPart`, which stays
text-only. A tool that returns an image or a resource can say so, and
`projectToolExecutionContent` reduces it to the text vocabulary a provider
message and a trace can carry.

Nothing is dropped silently. Each non-text part becomes visible placeholder
text — `[image content not sent — image/png]` — and the substitution is recorded
on the execution as a projection note, so the UI can say what stood in for what.
Someone comparing two runs has to be able to tell "the tool returned an image we
cannot send" from "the tool returned nothing".

Raw bytes are held in memory only. They do not enter a run trace; a linked
evidence artifact for raw protocol content arrives with the MCP work, which is
the change that actually creates the trace-size problem.

## Evidence

Three normalized events carry execution into the run model:

```text
tool.execution_started  → tool.execution_completed  → tool.result_supplied
                        ↘ tool.execution_failed     (call stays pending)
```

They reduce into `RunState.toolExecutions`, and RunTrace v6 stores that
projection alongside `turns`, `exchanges`, and `toolResults`. Like every other
projection, it is re-derived from the event stream during parsing and the
artifact is rejected when the two disagree — an execution record is evidence, so
it has to be checkable rather than merely present.

Invariants the reducer enforces:

- an execution may only start for a call the run is actually waiting on;
- a call may hold at most one live execution, and a result cannot be supplied
  while one is open;
- a *failed* execution does not forbid another attempt, so a retrying executor
  does not need a new event vocabulary.

Execution IDs are derived from the call ID and the attempt number, so identical
runs produce identical traces.

## Interactive runs

The pause is unchanged: a run still stops at a tool call and still shows the
prefilled draft. **The executor runs on submit, not on arrival.** The pause is
the approval gate, and an executor with side effects must not run before a human
approves it — which is the shape MCP's per-call approval needs.

A mock prefills the draft with its answer. An executor with a transport cannot:
its answer does not exist until it runs. So a command-served call shows an empty
box and says what continuing will do, because otherwise it is indistinguishable
from a call waiting on a person.

A draft the user has typed into is a manual result. Its resolution becomes
`{ kind: "manual" }` and no execution evidence is recorded, because a
human-supplied result is not an execution and a trace claiming otherwise would
assert that a mock returned text a person typed. The same rule catches the
failure path: when an execution fails, the call stays pending and its draft
becomes an ordinary manual one, so a second attempt sends the person's answer
rather than re-running an executor that just failed. The transcript then leads
with where the shown value came from and reports the failed attempt after it.

Result provenance and execution evidence answer different questions and stay
separate. `ToolResolution` says where a value came from in project terms
(`mock`, `manual`, `replay`, `live`); the execution events say what ran, under
which binding identity, and how long it took. They are joined by `toolCallId`.

## Shell parity

Mock execution works in every shell — browser, self-hosted web service, and
Tauri — because it involves no transport. Command tools work only where there is
an Inference Lens service to spawn through: the local web app and the
self-hosted service, not a bare browser and not yet the desktop build. The UI
names the reason it is unavailable rather than showing an empty picker, and
[docs/COMMAND_TOOLS.md](COMMAND_TOOLS.md) states the matrix.

## The core boundary

`packages/core` imports no protocol SDK and no host capability, and
`tests/core-dependencies.test.ts` asserts both. The command tool is the working
example: the catalog schema and the classification of a finished process are
pure core modules, while spawning — the only part that cannot be — lives in
`services/api/src/command-tool-runner.ts`.

The claim that a command tool and an MCP client can be added without
reshaping the run model is only true while the run model stays ignorant of every
protocol: the moment core imports one, its types start describing that
protocol's world and the next executor has to be bent to fit. An executor's
transport lives beside its binding, on the host side of the seam.
