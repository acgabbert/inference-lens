# Parallel experiment cells

**Status:** decisions agreed October 9, 2026; not yet implemented. The decisions
below need no further sign-off, but the implementation should come back for
review if it finds that one of them cannot hold.
**Baseline:** `main` at `ee5f292`.
**Depends on:** slice 1 of the [headless CLI design](HEADLESS_CLI_DESIGN.md),
which moves the scheduler into a shared module.

## Goal

Let one experiment run several cells at once, so a long evaluation suite or
repeated-run batch finishes in a fraction of the time. The app and the
headless CLI share the feature because they share the scheduler.

## Non-goals

- Parallel tool calls *within* one turn (`parallelToolCalls`). That setting
  controls what a model may ask for. This design is about how many cells
  the scheduler runs.
- Automatic retry or adaptive backoff on rate-limit errors. A rate-limited
  attempt fails its own repetition, exactly as it does today.
- Running several experiments at once.

## Sequencing

1. **After the scheduler move.** Headless slice 1 is a pure move that the
   existing unit tests and Playwright suite are expected to prove unchanged.
   Changing the scheduler's behavior in the same change would remove that
   proof. Writing parallelism first would mean moving freshly changed code.
2. **Separate from the headless plan.** Parallelism is not headless-specific,
   and it changes contracts that the headless plan treats as fixed.
3. **Alongside headless slices 2–4, with one ordering rule.** The result
   contract change (decision 3) must be agreed before the CLI's JSON summary
   ships with schema version 1. That summary reports per-case outcomes and
   the stopped status, so both changes should settle on the same result shape.
   The CLI exposes parallelism through a `--concurrency` flag as a follow-up.

## What assumes one cell at a time today

All references are to `packages/runner/src/sequential-experiment-controller.ts`
(formerly `app/run/sequential-experiment-controller.client.ts`), unless noted
otherwise.

| Assumption | Where | Effect of parallelism |
| --- | --- | --- |
| No cell starts after a stop | `assertResultReferences` in `packages/core/src/experiment.ts` ("No repetition may start after the stop") | Later cells in plan order may already be running or finished when a tool becomes unavailable. Valid parallel results would fail validation. |
| Result cells are appended in completion order and must match plan order | `cells.push` in `runCell`; "must retain plan order" check | Cells finish out of order. The scheduler must place them by plan index. |
| One active request | `activeAbortController` | `cancel()` would abort only the most recent cell. |
| One current cell | `SequentialExperimentProgress.currentOrdinal`; `evaluation-results-workspace.client.tsx` treats every later ordinal as queued; `repeated-experiment-workspace.client.tsx` shows one active ordinal | Running cells would appear queued, and finished ones would appear running. |
| An aborted turn ends the experiment | `outcome === "aborted"` in `runCell` | Still true, but it must abort every in-flight cell, not just one. |
| Tools are never called concurrently | Implicit | Command and MCP tools may share state between calls. |
| Latency is measured in isolation | Implicit | Timings taken under concurrent load are not comparable to sequential ones. |

The derived IDs (run, tool-execution, and tool-result IDs) do not depend on
order, so traces stay comparable across concurrency settings.

## Decisions

### 1. Where concurrency is declared

| Option | Effect |
| --- | --- |
| A. In the frozen plan | Reproducible, but the plan stops being portable: the right limit depends on the machine and account running it, not on the experiment. |
| B. Runtime option only | Portable plan, but a saved result no longer says how its timings were produced. |
| **C. Runtime option recorded in the result (agreed)** | The plan stays portable, and the result states the concurrency the run actually used. |

The controller takes the setting as an option next to `transport` and
`prepareCredential`. The result records the effective per-connection limits.
Any view or summary that compares latency across results should show this
value whenever two results differ in it.

### 2. In-flight cells when a stop occurs

A stop happens when a tool binding is found unavailable
(`ExperimentStop`, reason `tool_unavailable`).

| Option | Effect |
| --- | --- |
| A. Cancel in-flight cells | Saves the rest of their turns, but discards provider calls that were already paid for, and labels the cells cancelled even though no person stopped them. |
| **B. Let in-flight cells finish (agreed)** | No new cell starts. Cells already running finish normally and keep their real outcome. A cell that calls the unavailable tool fails on its own, the same way the stopping cell did. |

The invariant becomes: **no cell starts after the stop is recorded**. Every
cell that had not started is `not-run`. A person's cancellation still wins
over a stop, as it does today, and aborts every in-flight cell.

If more than one cell finds a tool unavailable, the result records the first
to do so.

### 3. Result compatibility

The changed stop invariant and the recorded concurrency both change the
persisted result.

| Option | Effect |
| --- | --- |
| A. Keep Version 5 and loosen its rule | Older readers would accept files that break a rule they enforce, and nothing would show that the rule changed. |
| **B. Result Version 6 (agreed)** | Version 6 adds the recorded concurrency and the "no cell starts after the stop" rule. |

Details:

- Readers accept Versions 4, 5, and 6, upgrading older versions on read as
  `parseExperimentResultFile` already does for Version 4. A Version 4 or 5
  result upgrades to a concurrency of 1, which is how it actually ran.
- Under Version 6, a stopped result may contain terminal cells after the
  stopping cell in plan order. To keep the "no cell starts after the stop"
  rule checkable, Version 6 records each started cell's start order. Whether
  that is an ordinal or a timestamp is an implementation detail. The
  validator checks that every terminal cell started before the stop and
  every `not-run` cell did not start.
- Cells stay in plan order, whatever order they finished in.
- The writer always writes Version 6, including when the concurrency is 1.
- An older app opening a project with Version 6 results rejects them with its
  existing "unsupported version" message. This is accepted, as it was for
  Version 5.

### 4. Scope of the limit

| Option | Effect |
| --- | --- |
| A. One global limit | Simple, but a suite comparing a local model with a hosted one is held to whichever endpoint is most fragile. |
| **B. Per connection, default 1 (agreed)** | Each connection has its own limit. With no setting, every limit is 1 and behavior matches today exactly. |

A connection is identified the same way the scheduler already keys prepared
credentials: the target's connection profile ID plus its endpoint. Cells for
different connections run independently. Within one connection, cells start
in plan order as slots free up, so early cells finish first and partial
progress reads naturally.

The setting is a map from connection to limit, plus an optional default for
connections it does not name. The app's control for it, and the CLI flag's
exact syntax, are presentation choices for the implementation.

### 5. Tools under concurrency

| Option | Effect |
| --- | --- |
| A. All tools run concurrently | Fastest, but a command tool that writes a file or an MCP server that keeps session state can corrupt other cells. |
| **B. Mocks concurrent; command and MCP sequential (agreed)** | Mock tools are pure and run freely. Calls to command and MCP bindings are serialized across the whole experiment, one call at a time per binding. |
| C. Opt-in per binding | The eventual goal, but it needs a new field on device-local bindings and a way for a person to assert the tool is safe. |

Serializing a tool call holds only that call, not the cell's whole turn, so
provider requests still overlap. Option C can be added later without
changing the result or plan, because bindings never travel in either.

## Progress contract

`SequentialExperimentProgress` replaces `currentOrdinal` with the set of
running ordinals. Because the class is no longer sequential, it is renamed as
part of this change; the rename is mechanical and is not a separate decision.
Both workspaces then derive each cell's display state from that set and the
terminal states, rather than comparing against one ordinal. With a
concurrency of 1 the set has at most one member and the screens look exactly
as they do today.

## Delivery slices

1. **Result Version 6.** Add the type, parser, upgrade path, and validator
   in `packages/core`. Write Version 6 at a concurrency of 1. Behavior is
   unchanged.
2. **Concurrent scheduler.** Per-connection slots, per-cell abort
   controllers, ordered result placement, the new stop rule, and serialized
   command and MCP calls. Default limits stay at 1. Unit tests drive it with a
   controllable fake transport.
3. **Progress and app surfaces.** The running-ordinals progress contract,
   both workspaces, and a concurrency control at experiment start.
4. **CLI flag.** `--concurrency`, after headless slice 2 lands.

## Verification expectations

- Unit tests, written red first, for:
  - The Version 6 validator: a stopped result with terminal cells after the
    stopping cell is accepted only when those cells started before the stop.
  - Upgrading Version 4 and 5 results to a concurrency of 1.
  - Plan-order placement when cells finish in reverse order.
  - A stop that lets in-flight cells finish and leaves unstarted cells
    `not-run`.
  - Cancellation aborting every in-flight cell.
  - Per-connection limits never being exceeded, observed through the fake
    transport's peak in-flight count.
  - Command and MCP calls never overlapping, and mock calls overlapping.
- With the default limit of 1, the existing unit tests and full Playwright
  suite pass unchanged. That shows the default changes no behavior.
- A Playwright spec runs a suite with a concurrency above 1 against a local
  fixture provider. It checks that several cells show as running at once,
  that the finished result shows every cell in plan order, and that the
  recorded concurrency is visible where timings are compared. The fixture
  provider must hold its responses long enough for cells to overlap, or the
  spec passes without exercising any concurrency; see the
  [provider fixture guide](PROVIDER_FIXTURES.md).
