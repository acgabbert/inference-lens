# Tool execution

Inference Lens can pause a run at a tool call. This document covers what
happens when something actually serves that call, and where the evidence goes.

Today the only executor is the project mock. The contract is deliberately wider
than the mock needs, because the mock cannot falsify it: it has no transport, no
timeout, and no asynchronous failure. A command-tool executor and an MCP client
arrive later against this same seam, and the point of settling it now is that
neither should be able to reshape it.

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

Bindings are currently **derived, not stored**. An enabled project mock stands
for a mock binding (`toolBindingForMock` in
`app/run/run-session-state.client.ts`). Mocks live in the project because their
*content* is authored material a teammate should receive; there is nothing
device-local about them to remember. A persisted binding registry arrives with
the first executor that has device-local configuration worth keeping out of the
project, which is the command-tool executor.

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

A draft the user has typed into is a manual result. Its resolution becomes
`{ kind: "manual" }` and no execution evidence is recorded, because a
human-supplied result is not an execution and a trace claiming otherwise would
assert that a mock returned text a person typed.

Result provenance and execution evidence answer different questions and stay
separate. `ToolResolution` says where a value came from in project terms
(`mock`, `manual`, `replay`, `live`); the execution events say what ran, under
which binding identity, and how long it took. They are joined by `toolCallId`.

## Shell parity

Mock execution works in every shell — browser, self-hosted web service, and
Tauri — because it involves no transport. Executors that do involve one will not,
and each must state where it works rather than degrading silently.

## The core boundary

`packages/core` imports no protocol SDK, and `tests/core-dependencies.test.ts`
asserts it. The claim that a command tool and an MCP client can be added without
reshaping the run model is only true while the run model stays ignorant of every
protocol: the moment core imports one, its types start describing that
protocol's world and the next executor has to be bent to fit. An executor's
transport lives beside its binding, on the host side of the seam.
