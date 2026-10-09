# Parallel experiment cells

**Status:** decisions 1–5 agreed October 9, 2026; decisions 6–8 (rate
limits and retry) agreed the same day as recommended. A review the same day
amended decisions 4, 5, and 8 and added decision 9; see
[Review amendments](#review-amendments). Slices 1–4 are implemented,
including the retry policy that decision 8 adds to slice 1; see
[Implementation status](#implementation-status), and the
[headless CLI design](HEADLESS_CLI_DESIGN.md) for slice 4's flags. The decisions below need no
further sign-off, but the implementation should come back for review if it
finds that one of them cannot hold.
**Baseline:** `main` at `ee5f292`.
**Depends on:** slice 1 of the [headless CLI design](HEADLESS_CLI_DESIGN.md),
which moves the scheduler into a shared module.

## Goal

Let one experiment run several cells at once, so a long evaluation suite or
repeated-run batch finishes in a fraction of the time. The app and the
headless CLI share the feature because they share the scheduler.

Running cells at once makes rate limits likelier, so the same design covers
them: the scheduler backs off a connection that answers 429, results report
rate-limited repetitions apart from model failures, and a run can opt in to
retrying them.

## Non-goals

- Parallel tool calls *within* one turn (`parallelToolCalls`). That setting
  controls what a model may ask for. This design is about how many cells
  the scheduler runs.
- Retrying anything other than a provider 429. Transport errors and 5xx
  responses still fail their own repetition; a 5xx may have been billed.
- Reading provider-specific quota headers (`x-ratelimit-reset-*`,
  `anthropic-ratelimit-*`). Only `retry-after-ms` and `Retry-After` are used.
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

### 9. A trace that cannot be saved

Today, if a finished cell's trace cannot be saved, `run()` rejects, no
result is written, and the experiment reads as interrupted. With several
cells in flight, the others need an answer too (added on review).

| Option | Effect |
| --- | --- |
| A. Let in-flight cells finish | Spends provider calls whose traces are unlikely to save either. |
| **B. Stop, abort, drain, then fail (agreed)** | No new cell starts. Every in-flight cell is aborted, and the scheduler waits for all of them to settle before rejecting with the first save failure, exactly as today: no result is written. |

Draining before rejecting means no request is still running when the
caller hears that the experiment failed. Further save failures from the
aborted cells are ignored; the first one is the error reported.

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
- On each connection, cells start in plan order: the started cells are a
  prefix of that connection's cells, with rising start orders. The validator
  refuses a result that breaks this. A future scheduler that reorders cells,
  such as running previously failed cases first, would need a new version.
- The writer always writes Version 6, including when the concurrency is 1.
- An older app opening a project with Version 6 results rejects them with its
  existing "unsupported version" message. This is accepted, as it was for
  Version 5.

### 4. Scope of the limit

| Option | Effect |
| --- | --- |
| A. One global limit | Simple, but a suite comparing a local model with a hosted one is held to whichever endpoint is most fragile. |
| B. Per connection, default 1 | Each connection has its own limit. But with every limit at 1, a suite using two connections runs two cells at once, which is not today's behavior. |
| **C. Overall limit plus per connection, both default 1 (agreed, amended)** | At most `maxInFlight` cells run across the experiment, and at most each connection's limit on that connection. With no setting, every limit is 1 and behavior matches today exactly. |

Option B was agreed first, but it cannot keep its own promise: with every
limit at 1, cells for different connections would still run at once, and the
result could not tell that run from a one-at-a-time run that recorded the
same per-connection limits. The overall limit fixes both. Running
connections independently is something a person chooses by raising it.

A connection is identified the same way the scheduler already keys prepared
credentials: the target's connection profile ID plus its endpoint. Within
the overall limit, cells for different connections run independently.
Within one connection, cells start in plan order as slots free up, so early
cells finish first and partial progress reads naturally. The result
validator enforces that order (see decision 3).

The setting is an overall limit, a map from connection to limit, and an
optional default for connections the map does not name. The app's control for it, and the CLI flag's
exact syntax, are presentation choices for the implementation.

### 5. Tools under concurrency

| Option | Effect |
| --- | --- |
| A. All tools run concurrently | Fastest, but a command tool that writes a file or an MCP server that keeps session state can corrupt other cells. |
| **B. Mocks concurrent; command and MCP sequential (agreed, amended)** | Mock tools are pure and run freely. Calls that reach the same MCP server or the same declared command are serialized across the whole experiment, one call at a time per resource. |
| C. Opt-in per binding | The eventual goal, but it needs a new field on device-local bindings and a way for a person to assert the tool is safe. |

The lock is per **resource**, not per binding. A binding is per tool, and
two tools can reach the same stateful MCP server (`serverId`) or the same
declared command (`executorId`); one lock per binding would let their calls
overlap. So an MCP binding takes the lock for `mcp:<serverId>` and a command
binding the lock for `command:<executorId>`.

Serializing a tool call holds only that call, not the cell's whole turn, so
provider requests still overlap. Option C can be added later without
changing the result or plan, because bindings never travel in either.

### 6. Pausing a connection after a 429

When a provider answers any attempt with HTTP 429, the scheduler stops new
cells on that connection from starting until a pause ends. The attempt that
got the 429 is not hidden: without decision 8 its cell fails, exactly as it
does today. The pause only keeps the scheduler from making things worse.

- **Where the signal comes from.** No new plumbing. A 429 reaches the
  coordinator as `provider_error` with `providerStatus: 429` on both the web
  and desktop transports, and the exchange's recorded response headers
  already include `retry-after`.
- **How long.** `retry-after-ms` if present, otherwise `Retry-After` (delta
  seconds or an HTTP date). With neither, or an unreadable value, **5
  seconds**. Every pause is capped at **60 seconds**, so one header cannot
  stall a batch for an hour; if the provider is still limiting after that,
  the next 429 starts another pause.
- **Scope.** One connection, keyed the same way as decision 4. Other
  connections keep starting cells. Cells already in flight on the paused
  connection are not interrupted. A later 429 extends a pause only if it
  would end later.
- **Where it lives.** In slice 2's per-connection slots: a paused connection
  has no free slot until the pause ends. It is not added to the current
  one-at-a-time loop first, because that loop is being replaced and a pause
  there would also hold up cells for other connections.
- **Cancellation** ends a pause at once.
- **Not persisted.** The result format does not record pauses. Each 429 is
  already in its run's trace.

This reverses the earlier non-goal "adaptive backoff on rate-limit errors".

### 7. Rate-limited repetitions are reported apart from failures

A repetition is **rate-limited** when its run failed and its final error is
`provider_error` with `providerStatus: 429`. That is derived from the trace,
like every other classification, so no saved artifact changes.

| Option | Effect |
| --- | --- |
| A. Keep it as `run-failed` with a flag | Every count and verdict still treats a quota problem as a model failure unless each reader checks the flag. |
| **B. New `rate-limited` classification, counted as incomplete (agreed)** | A rate-limited case is neither passed nor failed: it is missing evidence. |

Consequences:

- `EvaluationRepetitionClassification` gains `rate-limited`. A case with a
  rate-limited repetition and no failing one counts as **incomplete**, not
  failed, so a suite whose only problem is rate limiting has the verdict
  `incomplete` and the CLI exits 3, not 1. A CI job then cannot report a
  model regression that was really a quota problem.
- Baseline comparisons treat a rate-limited repetition as missing evidence,
  as they do `not-run`. Without this, a case that passed before and was
  rate-limited now would show as regressed.
- `RepeatedExperimentAggregate` gains a `rateLimited` count, separate from
  `failed`.
- The CLI's `--json` summary v1 gains `rate-limited` as a classification
  value **without a version bump**. A new enum value would normally be a
  breaking change, but v1 has never been in a tagged release.
- The Runs and Evaluations workspaces label it "rate limited", separately
  from "run failed".

### 8. Automatic retry of 429s

| Option | Effect |
| --- | --- |
| A. Never retry | Results stay simple, but a suite that brushes its rate limit has gaps. |
| B. Always retry | Suites finish, but the default behavior changes and a result cannot say whether retries were allowed. |
| **C. Opt-in, bounded, recorded in the result (agreed)** | Off by default, so behavior matches today; when on, the result says so. |

- **What retries.** A 429 only, at most **2 retries per provider turn**,
  so at most 3 attempts per turn. A run with tool calls has several turns,
  and each turn has its own budget. (Amended on review: "2 retries per
  attempt that got one" could be read as never ending, because every retry
  is itself an attempt.) Each retry waits the same way as a pause (decision 6: the header,
  else 5 seconds, capped at 60). The cell keeps its slot while it waits.
  The connection pause still applies to other cells.
- **How.** The run kernel already supports it: a retryable failure pauses
  the coordinator at `attempt_failed`, which the scheduler today turns into
  a failure (`coordinator.fail`). With retry on, it calls
  `coordinator.retry()` instead. Each retry is a recorded attempt in the
  trace, latency is already measured per attempt, and runs with retries
  are already counted, so the evidence stays honest.
- **When retries run out,** the cell fails and is classified `rate-limited`
  (decision 7).
- **Recorded in the result.** Version 6 gains a `retryPolicy`, so a result
  says whether retries were allowed, just as it says what concurrency it
  ran at. This is added to Version 6 before it merges, rather than costing a
  Version 7 later. Versions 4 and 5 upgrade to retries off.
- **Shown in summaries.** Assessments, the repeated-request aggregate, and
  the CLI summary report how many repetitions needed retries after rate
  limiting, so retry cannot quietly hide a configuration that keeps hitting
  its limit.
- **Turning it on.** A control at experiment start in the app, and a CLI
  flag (`--retry-rate-limits`). The exact presentation is an implementation
  choice.

## Progress contract

`SequentialExperimentProgress` replaces `currentOrdinal` with the set of
running ordinals. Because the class is no longer sequential, it is renamed as
part of this change; the rename is mechanical and is not a separate decision.
Both workspaces then derive each cell's display state from that set and the
terminal states, rather than comparing against one ordinal. Progress also
reports, per connection, the time a rate-limit pause ends (decision 6), so a
paused batch does not look frozen; the CLI prints a line to stderr when a
pause starts. With a
concurrency of 1 the set has at most one member and the screens look exactly
as they do today.

## Delivery slices

1. **Result Version 6.** Add the type, parser, upgrade path, and validator
   in `packages/core`. Write Version 6 at a concurrency of 1, with retries
   off. Behavior is unchanged.
2. **Concurrent scheduler.** Per-connection slots, per-cell abort
   controllers, ordered result placement, the new stop rule, serialized
   command and MCP calls, and the rate-limit pause (decision 6). Default
   limits stay at 1. Unit tests drive it with a controllable fake transport.
3. **Progress and app surfaces.** The running-ordinals progress contract,
   the pause indicator, both workspaces, and a concurrency control at
   experiment start.
4. **CLI flag.** `--concurrency`, after headless slice 2 lands.

Nothing that can raise a limit above 1 ships before slice 3's progress
contract and its consumers. Slice 2 adds no way to set a limit, and the
default keeps one cell at a time, so slice 2 alone cannot make either
workspace mislabel running cells.
5. **Rate-limited classification** (decision 7) in core assessments, the
   repeated-request aggregate, comparisons, the CLI summary, and both
   workspaces. It depends only on slice 1, so it can land before or after
   slices 2–4.
6. **Automatic retry** (decision 8): the scheduler calls `retry()` when the
   result's policy allows it, the start control, `--retry-rate-limits`, and
   the retry counts in summaries. After slices 2 and 5.

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
  - Command and MCP calls never overlapping, including calls from two
    different bindings that reach the same MCP server or the same declared
    command; calls to different servers overlapping; mock calls
    overlapping.
  - A trace save failure with other cells in flight: no new cell starts,
    the in-flight cells are aborted, the rejection waits for them, and no
    result is written.
  - An overall limit of 1 running a two-connection suite one cell at a
    time, observed through the fake transport's peak in-flight count.
  - A 429 pausing only its own connection: no new cell on it starts before
    the pause ends, other connections keep starting cells, cancellation
    ends the pause, and the wait follows `retry-after-ms`, then
    `Retry-After` in both forms, then the 5-second default, capped at 60
    seconds. A fake clock, not real waiting.
  - A failed run whose final error is a provider 429 classified
    `rate-limited`, its case counted incomplete, the CLI verdict
    `incomplete`, and a comparison treating it as missing evidence.
  - With retries on, a 429 followed by success recorded as two attempts and
    classified by its checks; three 429s in a row classified
    `rate-limited`. With retries off, the first 429 fails the cell.
  - `retryPolicy` validation, and Versions 4 and 5 upgrading to retries off.
- With the default limit of 1, the existing unit tests and full Playwright
  suite pass unchanged. That shows the default changes no behavior.
- A Playwright spec runs a suite with a concurrency above 1 against a local
  fixture provider. It checks that several cells show as running at once,
  that the finished result shows every cell in plan order, and that the
  recorded concurrency is visible where timings are compared. The fixture
  provider must hold its responses long enough for cells to overlap, or the
  spec passes without exercising any concurrency; see the
  [provider fixture guide](PROVIDER_FIXTURES.md).
- A Playwright spec runs a suite against a fixture provider that answers
  some requests with 429 and a short `Retry-After`. It checks that the
  results label those repetitions "rate limited" rather than "run failed",
  and, with retries on, that they recover and the retry count is shown.
  The fixture must actually return the 429 to the app's transport; a test
  that injects the classification directly exercises nothing.

## Implementation status

### Slice 1: what exists

`ExperimentResultV6` in `packages/core/src/experiment.ts`, with its parser,
validator, and the upgrade from Versions 4 and 5. The scheduler writes Version
6 at a concurrency of 1 with retries off, and otherwise behaves as before. The format is
documented in [experiment artifacts](EXPERIMENT_ARTIFACTS.md).

Choices made in implementation, within the agreed decisions:

- **Recorded concurrency.** `concurrency` is the effective limits,
  `{ maxInFlight, connections }`, with one `{ profileId, endpoint, limit }`
  per distinct connection in plan first-use order, rather than the setting
  a person supplied (an overall limit, a map, and a default). The validator
  requires exactly the plan's connections, each once.
  `sequentialExperimentConcurrency(plan)` builds the all-ones value, and
  `experimentConnectionKey` is the one key the scheduler's credential cache
  and the result share.
- **Start order.** A one-based `startOrder` on each started cell, not a
  timestamp: it is deterministic and directly checkable. The validator also
  checks plan order on each connection.
- **Checking the stop.** A start order alone cannot show that a cell started
  after the stop, because a stop is recorded when the stopping cell fails,
  after other cells may have started. So the stop records
  `startedCells`, the number of cells that had started at that moment. The
  validator refuses any started cell beyond that count and a count that
  includes cells that never started.
- **Retry policy.** `retryPolicy` is keyed by failure class:
  `{ rateLimited: { maxRetries } }`, with `maxRetries: 0` meaning off, which
  is what the scheduler writes until slice 6 and what Versions 4 and 5
  upgrade to. Version 6 refuses any other class. The keying lets a later
  version add a class with its own bound (see below) without reshaping the
  field.
- **Headless summary.** The CLI's `--json` summary v1 keeps its `stop` at
  `{ reason, cellId, toolId }`; `startedCells` is result bookkeeping and is
  not copied into it. Reporting concurrency in the summary is left to the
  slice 4 `--concurrency` flag.

Verification: `tests/experiment.test.ts` (Version 6 validation, including
the overall limit, start order on one connection, and the retry policy, and
both upgrades), `tests/evaluation-execution.test.ts` (independent start
order across two connections), `tests/repeated-experiment-controller.test.ts` (the scheduler's
Version 6 output), and `tests/cli-summary.test.ts`.

### Slice 2: what exists

The scheduler in `packages/runner/src/sequential-experiment-controller.ts`
runs cells concurrently up to the limits, with per-cell abort controllers,
plan-index result placement, the stop rule of decision 2, per-resource tool
locks (decision 5), the rate-limit pause (decision 6), and the
abort-and-drain failure of decision 9. Nothing in the app or CLI sets a
limit yet, so every run still goes one cell at a time.

Choices made in implementation, within the agreed decisions:

- **The setting.** `ExperimentConcurrencySetting` in `packages/core` is
  `{ maxInFlight?, connectionLimit?, connections? }`: an overall limit, a
  default for connections not named, and per-connection limits keyed like
  the result's. Every value defaults to 1 and must be a positive whole
  number. `resolveExperimentConcurrency(plan, setting)` turns it into the
  recorded `ExperimentConcurrency`: entries for connections the plan does
  not use are ignored, and no connection's limit exceeds `maxInFlight`,
  because it could never be reached.
- **Scheduling.** Each time a slot frees, the scheduler walks the unstarted
  cells in plan order and starts every one whose connection has a free slot
  and is not paused, while the overall limit allows. Skipping a full or
  paused connection skips all of its cells, which is what keeps each
  connection in plan order. A cell holds its slot until its trace is saved,
  as the sequential loop did.
- **Pauses.** Time comes from an injectable `SchedulerClock`
  (`packages/runner/src/scheduler-clock.ts`), so tests move it by hand. A
  pause ends when its timer fires, not when the clock passes its end, so a
  timer that fires a millisecond early cannot strand the scheduler. The
  header reading is `rateLimitPauseMs` in
  `packages/runner/src/rate-limit-pause.ts`, which slice 6 can reuse for its
  retry wait. A pause applies at the default limits too: after a 429, the
  next cell on that connection waits instead of starting at once.
- **Tool locks.** `ToolResourceLocks` (`tool-resource-locks.ts`) serves each
  `mcp:<serverId>` or `command:<executorId>` key first come, first served.
  A cell whose experiment ended while it waited for a lock does not run the
  call.
- **Decision 9's aborted cells** are cancelled with the reason "Stopped
  because another repetition's trace could not be saved.", not "Stopped by
  user.", and do not mark the experiment as cancelled.
- **Not yet done.** The class keeps its `Sequential` name and
  `SequentialExperimentProgress` keeps `currentOrdinal`, which is the
  ordinal of the cell that last reported. Slice 3 replaces `currentOrdinal`
  and renames both (see slice 3 below).

Verification: `tests/concurrent-experiment-scheduler.test.ts` (plan-order
placement, the per-connection limit, the stop, cancellation, tool locks,
decision 9, the pause headers, and the pause itself on a fake clock) and
`tests/evaluation-execution.test.ts` (resolving a setting, the overall limit
across two connections, and a pause that leaves the other connection
running). The existing controller tests pass unchanged.

### Slice 3: what exists

`ExperimentProgress` reports `runningOrdinals` and
`pausedConnections` in place of `currentOrdinal`. Both workspaces read
them, both start dialogs set a limit, and a comparison names a changed
concurrency.

Choices made in implementation, within the agreed decisions (the first two
agreed on review, October 9, 2026):

- **The rename.** `SequentialExperimentController` is now
  `ExperimentController` in `packages/runner/src/experiment-controller.ts`,
  with `ExperimentControllerOptions` and `ExperimentProgress`. It landed in
  its own commit after slice 4 merged, because slice 4 was changing the CLI,
  which imports the class, at the same time. Earlier sections keep the old
  names, as they were written.
- **The CLI's pause line.** `evaluation-run.ts` prints a stderr line when a
  connection's pause starts or lengthens, naming the connection by its
  requirement ID; see the [headless CLI design](HEADLESS_CLI_DESIGN.md).
- **Progress.** `runningOrdinals` lists the cells started and not yet
  terminal, ascending. A cell leaves it when its run ends, before its trace
  is saved, so a finished repetition never reads as running.
  `pausedConnections` lists `{ profileId, endpoint, until }` per paused
  connection, in plan first-use order, with `until` in epoch milliseconds
  from the scheduler's clock. The scheduler reports progress when a pause
  begins and when it ends, so a resumption is visible before the next cell
  starts. A terminal emission has both lists empty.
- **The start control.** Both dialogs open at 1 every time; nothing is
  remembered, so running cells at once is always a choice made for that run.
  The repeated experiment has one connection and one field, which sets
  both limits. The evaluation dialog has an overall field, which also sets
  the default for every connection, and one field per connection when the
  suite's configurations use more than one. Each field allows at most 16
  (`MAX_EXPERIMENT_CONCURRENCY`), a ceiling on what one click can send, not a
  scheduler rule. The setting travels on the draft, never in the plan.
- **The workspaces.** One running cell is named as before; several are
  counted ("2 running", "Running 3 repetitions"). A cell is queued only if
  it has not started. A pause shows as a "Rate limited" status chip with the
  seconds left, naming the configurations it holds back.
- **Where timings are compared.** A result that ran more than one cell at
  once says "up to N at once" in the evaluation header and under the
  repeated experiment's latency. One at a time needs no caveat. A baseline
  comparison gains a `concurrency` drift field,
  `{ maxInFlight, connectionLimit }` for the compared configuration's
  connection; a Version 4 or 5 result reads as one at a time, and a side with
  no result has none to compare.

Verification: `tests/experiment-progress.test.ts` (the running set at a limit
of 2 and of 1, a pause reported and cleared, cancellation clearing it),
`tests/evaluation-comparison.test.ts` (concurrency drift),
`tests/repeated-experiment-render.test.mjs`,
`tests/evaluation-results-render.test.mjs`, and
`tests/evaluation-suite-render.test.mjs` (both workspaces, both dialogs), and
`tests/e2e/experiment-concurrency.spec.ts` (a repeated experiment holding
three calls in flight at the app's inference route, and an evaluation run
once at the default and once two at a time, then compared).

## Review amendments

A review on October 9, 2026, found four problems and two gaps; all were
accepted.

| Finding | Resolution |
| --- | --- |
| Per-connection limits of 1 still run different connections at once, contradicting "behavior matches today", and the result could not tell the two apart. | Decision 4 adds an overall limit, `maxInFlight`, default 1, recorded in Version 6. |
| One lock per binding lets two tools on the same MCP server or command overlap. | Decision 5 locks per resource: `mcp:<serverId>` and `command:<executorId>`. |
| The validator accepted out-of-order starts on one connection, which the scheduler must never produce. | Decision 3 adds the per-connection plan-order rule, and the validator enforces it. |
| A concurrent scheduler shipped before the progress contract could mislabel cells. | With the overall limit defaulting to 1 and no way to raise it before slice 3, it cannot; the delivery slices now say so. |
| "2 retries per attempt" was ambiguous. | Decision 8 says 2 retries per provider turn. |
| The plan did not say what happens to in-flight cells when a trace cannot be saved. | Decision 9: stop, abort, drain, then fail as today. |

### Extending retry to other failures

Retrying a 5xx, a timeout, or a dropped connection later is cheap in code:
`isRetryableRunError` already marks 408, 429, and 5xx retryable, and the
coordinator pauses on every retryable failure, so the scheduler's retry
path from slice 6 needs only to pick the bound for the new class. The cost
is elsewhere:

- **A result version.** Results are parsed strictly, so a new key under
  `retryPolicy` is a Version 7, which older apps refuse. The upgrade itself
  is trivial: a Version 6 result reads as Version 7 with the new class off.
- **Billing.** A 429 is rejected before the model runs. A 5xx, or a
  connection dropped mid-stream, may already have produced billed tokens,
  so a retry can pay twice. The metrics already sum usage across attempts,
  so the cost is visible, but the policy needs its own, likely lower, bound.
- **Waiting.** A 5xx rarely carries `Retry-After`, so it needs its own
  backoff rather than decision 6's header-driven pause, and whether a 5xx
  should also pause the whole connection is a separate decision.
- **Classification.** Decision 7's `rate-limited` would need a sibling (for
  example `provider-unavailable`) so that a run that ran out of 5xx retries
  is not reported as a model failure either.
