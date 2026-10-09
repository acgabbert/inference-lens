# Headless command-line experiments

**Status:** decisions 1–4 agreed as recommended (October 9, 2026). Slices 1
to 4 are implemented, in `packages/runner/`, `packages/cli/`, and the
container image; see [Implementation status](#implementation-status). Decision 3 was refined on
October 9, 2026 so that a grant names its target explicitly; see
[slice 3](#slice-3-what-exists). Slice 5's decisions were agreed the same day; see
[slice 5](#slice-5-selection-and-repeated-runs). Slice 5a is implemented; see
[slice 5a](#slice-5a-what-exists).
**Baseline:** `main` at `5755b57`, reviewed October 9, 2026.

## Goal

Run an evaluation suite in an Inference Lens project from a terminal, a CI
job, or a scheduled task, with no browser and no running server. Write the
same plan, result, and trace artifacts the app writes, so the Runs and
Evaluations workspaces can open a headless run later as if it had been started
there.

```sh
inference-lens run ./evals.inference-lens --suite triage
```

Typical uses:

- A CI regression gate that fails a pull request when a suite stops passing.
- Long or scheduled batches that should not depend on an open browser tab.
- Re-running a suite against a new model or protocol from a script.

## Non-goals

- A second user interface. The CLI starts runs and reports their outcome.
  Inspection stays in the app.
- Editing projects. The CLI never writes `project.json`.
- Hosting or proxying providers for other clients.
- Authenticated or remote MCP execution, which remains deferred as it is for
  the app.

## What already exists

Most of the work is already portable. The CLI is mainly a new host for
existing code.

| Concern | Owner today | Headless status |
| --- | --- | --- |
| Building an evaluation plan from a suite | `createEvaluationExperimentPlan` in `packages/core/src/evaluation-execution.ts` | Portable |
| Expanding a plan into run inputs | `materializeParsedExperimentCellInput` in `packages/core/src/experiment.ts` | Portable |
| Run kernel, protocol adapters, checks, aggregates | `packages/core` | Portable |
| Project, trace, plan, and result parsing and serialization | `packages/core` | Portable |
| Sequential scheduling, stop on unavailable tool, result writing | `SequentialExperimentController` in `app/run/sequential-experiment-controller.client.ts` | Client file, but its dependencies are injected (see below) |
| Provider HTTP | `executeProviderTurn` in `services/api/src/run-executor.ts` | Node; reusable in process |
| Server credentials | `EnvironmentCredentialStore` in `services/api/src/credential-store.ts` | Node; one connection only |
| Command and MCP tool execution | `services/api/src` (`command-tool-execution.ts`, `mcp-execution.ts`) | Node; reached from the app through the service API |
| Evaluation start checks | `app/evaluations/evaluation-start.client.ts` | Client; mixes UI wording with portable rules |
| Project folder I/O | Browser directory adapter and Tauri | No Node adapter |
| Tool grants | Browser storage, per browser profile | No headless equivalent |

The controller already takes `transport`, `prepareCredential`, `savePlan`,
`saveResult`, `onTerminalTrace`, `toolBindings`, `verifyToolBindings`, and
`createExecutor` as options. Its three client-side imports
(`provider-turn-driver.client.ts`, `run-session-state.client.ts`,
`tool-executors.client.ts`) do not touch browser APIs. Only the last one
chooses executors that call the service over HTTP, and the controller already
lets a caller replace that choice.

## Proposed shape

```text
packages/core (unchanged contracts)
    └── shared scheduler: SequentialExperimentController, moved out of app/
           ├── app/            browser transport, browser storage, UI grants
           └── packages/cli/   in-process transport, Node filesystem, flag grants
                                └── services/api provider, credential, tool code
```

1. **Move the scheduler.** Move `SequentialExperimentController` and its three
   helpers into a shared module that both `app/` and the CLI import. Move only
   the helpers' portable parts; keep the executor factory, which chooses
   service-backed executors, in `app/`. This is a pure move with no behavior
   change, and the app's existing tests and e2e suite cover it.
2. **Extract start checks.** Split the rules in `evaluation-start.client.ts`
   (missing model, unsupported protocol, streaming, tools, unbound tools)
   into a portable function that returns structured reasons. Both the app and
   the CLI phrase those reasons for their own medium.
3. **Add a Node project adapter.** Read and validate `project.json`. Write
   `experiments/<id>.plan.json`, `experiments/<id>.result.json`, and
   `traces/<runId>.json` with the same names and write behavior as the app's
   directory adapters (to be confirmed against them when implementing). Never
   write `project.json`.
4. **Add the CLI host.** Resolve credentials and tool grants (decisions 2 and
   3), build the plan, drive the controller with an in-process transport over
   `executeProviderTurn`, derive the assessment, and report it (decision 4).

The first version covers **evaluation suites only**. Repeated runs of the
project's current conversation can follow, because the controller already
handles both plan kinds; they are left out only to keep the first surface
small.

### Sharing a folder with the app

The CLI only creates new, immutable artifact files, so it can safely write
into a folder the app has open. The app reads saved history when the history
view is opened rather than watching the folder, so a headless run appears the
next time it is opened. Neither side ever rewrites the other's files.

## Decisions to agree

### 1. Invocation model

| Option | Effect |
| --- | --- |
| **A. Node CLI that calls providers directly (recommended)** | Self-contained and works in CI with no server. Reuses `services/api` code in process. Its credential and grant rules must be designed for the CLI. |
| B. Client of a running Inference Lens service | Reuses the server's credential and permission checks. Needs a new authenticated, script-facing API, since today's service API is built and guarded for the same-origin browser (`services/api/src/request-security.ts`). A CI job would need to start the service first. |

Recommendation: **A**. Option B can be added later if a central service is
wanted, without changing the artifacts.

### 2. Credentials

A project names *connection requirements* (`id`, `name`, `endpoint`,
capabilities) and never stores credentials. Each selected configuration
targets one requirement, and a suite may use several. The CLI must map each
requirement it uses to a key, without the key ever appearing in a command line,
a project file, or an artifact.

| Option | Effect |
| --- | --- |
| A. Existing server variables only | `INFERENCE_LENS_API_KEY` and its siblings serve every requirement whose endpoint origin matches `INFERENCE_LENS_API_ENDPOINT`. Simple, but only one provider per run. |
| B. A connections file | A local, uncommitted JSON file maps requirement IDs to an endpoint and the *name* of an environment variable holding the key. Supports many providers. It is one more file format to version. |
| **C. A plus per-requirement variables (recommended)** | The server variables work as in A. `INFERENCE_LENS_CONNECTION_<ID>_API_KEY` (and an optional `_ENDPOINT` override) covers any other requirement. |

Under every option:

- A key is released only to its endpoint's origin, as
  `EnvironmentCredentialStore` does today.
- A requirement with no credential fails before any provider call and is named
  in the error.
- Unauthenticated local endpoints are used only when explicitly declared,
  for example with `--no-auth <requirementId>`, so a missing variable is never
  read as "no key needed".

Recommendation: **C**. It matches what the Docker image and CI secrets already
supply, and it avoids a new file format.

### 3. Tool permissions

In the app, command and MCP tools run only after a person grants them in
browser storage. A headless run has no browser profile, and it must not
inherit grants from one.

| Option | Effect |
| --- | --- |
| A. Mocks only | Command and MCP tools are refused. Safest; it excludes suites that exist to exercise real tools. |
| **B. Explicit per-run grants (recommended)** | `--allow-tool <tool>=command:<command-id>` or `--allow-tool <tool>=mcp:<server-id>` grants one exposed tool for this invocation only, naming what serves it, because a project never records which command or server that is. Mocks need no grant. The operator catalogs (`INFERENCE_LENS_COMMAND_TOOLS` and `INFERENCE_LENS_MCP_SERVERS`) still decide what can be reached, and their checks, including the MCP fingerprint check, still run before any plan is saved. |
| C. A grants file | Lasting grants on disk. Convenient for CI, but it creates a second permission store with its own revocation story. |

Recommendation: **B**. An exposed tool that is neither mocked nor granted
stops the run before any provider call, naming the tool, as the app does
today.

### 4. Output and exit codes

Recommendation:

- Show progress and a human-readable summary by default. Progress goes to
  stderr, so stdout stays clean for `--json`.
- `--json` prints one machine-readable summary to stdout: the experiment ID,
  artifact paths, overall verdict, and per-configuration and per-case
  outcomes. It references traces and never copies model output, following the
  rule in [deterministic checks](DETERMINISTIC_CHECKS.md).
- Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | The suite passed under its strict scoring policy. |
| 1 | The suite ran to completion and at least one case failed. |
| 2 | Usage or setup error. Nothing was sent to a provider and no plan was written. |
| 3 | The run started but did not complete: stopped on an unavailable tool, interrupted, or failed to write an artifact. Also a completed run whose only shortfall is rate limiting: every repetition passed or was refused with a 429 (see decision 7 of the [parallel experiment design](PARALLEL_EXPERIMENT_DESIGN.md)). |

The JSON summary is a public contract, so it needs a schema version from the
first release.

## Slice 5: selection and repeated runs

**Status:** decisions 5 to 9 agreed October 9, 2026, as recommended except
the response mode in decision 8, which defaults to buffered.
npm publishing, the third follow-up, is deferred.

Two pull requests, in this order, so that the smaller one never waits on the
larger:

- **5a. Case and configuration selection** (decisions 5 and 6).
- **5b. Repeated runs of the project's conversation** (decisions 7 to 9).

### What 5a builds on

Selection is already native. The app's suite editor selects cases and
configurations, and `createEvaluationStartPlan` takes `selectedCaseIds` and
`selectedVariantIds` and copies only those into the plan's suite snapshot.
`evaluationSuitePreflight` and `evaluationStartBlocker` already count and check
only the selection. The CLI simply passes every ID today
(`packages/cli/src/evaluation-run.ts`). A CLI subset run therefore writes a
plan of exactly the shape the app writes for a subset, and the Evaluations
view already opens those. No artifact changes.

### 5. Selection flags

| Option | Effect |
| --- | --- |
| **A. `--case` and `--configuration`, repeatable, by ID or exact name (recommended)** | The rule `--suite` already follows: an ID wins, then a unique exact name; an ambiguous name is refused, listing the IDs. Omitting a flag selects everything, as today. |
| B. IDs only | Unambiguous, but names are what a person reads in the app and in the summary. |
| C. Patterns (`--case 'refund*'`) | Convenient for large suites, but a pattern that silently matches nothing or too much is worse than an error, and it is easy to add later. |

Under every option:

- An unknown case or configuration exits 2 and lists what is available, as an
  unknown suite does.
- A flag naming the same case twice is refused, like a repeated
  `--connection-concurrency` ID.
- Credentials, grants, and start checks apply to the selection only: a
  connection used only by an unselected configuration needs no key.
- `--configuration` rather than `--variant`: the app and the human summary say
  "configuration"; `variantId` stays the JSON field name.

### 6. Reporting a partial run

A "passed" verdict for 2 of 20 cases must not read in CI as the suite passing.

| Option | Effect |
| --- | --- |
| **A. Record the scope in the summary (recommended)** | Summary v1 gains `scope: { cases: { selected, total }, configurations: { selected, total } }`, always present. A new field is additive under the summary's contract, so the version stays 1. The human summary adds "Ran 2 of 20 cases" when anything was left out. The verdict and exit codes keep their meaning: they describe what ran. |
| B. A distinct verdict, such as `passed-partial` | Impossible to miss, but it changes an enum consumers already switch on, which is a version bump, and exit 0 versus 1 still has to choose. |
| C. Nothing; the plan already records it | True, but a consumer has to open the plan and compare it with `project.json` to find out. |

### What 5b builds on

`ExperimentController` already runs `repeated-request` plans, the Runs
workspace already opens them, and `repeatedExperimentAggregate` in
`packages/core/src/experiment.ts` already derives their counts and metric
ranges. What is missing is building the plan without the app:

- The app freezes the **composer's live request**
  (`prepareWorkbenchRun` in `app/run/prepare-workbench-run.client.ts`), and the
  plan itself is built in a React hook
  (`planFor` in `app/run/use-repeated-experiment-session.client.ts`).
- The saved project carries most of that request in `project.defaults`: the
  active conversation revision, the target, the inference options, and the
  enabled tools. `projectDraft` already resolves it, templates included.
- It does **not** carry the response mode (a per-device preference in the app,
  defaulting to streaming), the repetition count, or the turn ceiling; those
  live in the dialog.

Ownership, following slice 1: `planFor` and the repetition bounds move to
`packages/runner/src/repeated-start.ts` and the app imports them unchanged.
A new runner function builds a `ResolvedRunInput` from `project.defaults`
(it never writes `project.json`); the app keeps building from the composer.
The CLI gains `packages/cli/src/repeated-run.ts`. What both CLI commands share
(credentials, grants, concurrency, driving the controller, writing artifacts)
moves out of `evaluation-run.ts` into one module rather than being copied.

### 7. Command shape

| Option | Effect |
| --- | --- |
| **A. A `repeat` subcommand (recommended)** | `inference-lens repeat <project-folder> [--repetitions <n>]`. `--suite`, `--case`, and `--configuration` never apply to it and are rejected by the parser rather than ignored. It shares `--no-auth`, `--concurrency`, `--connection-concurrency`, `--allow-tool`, `--retry-rate-limits`, and `--json`, with the same meanings. `run` keeps its name and behavior. |
| B. `run --repeat <n>` | One command, but `run` becomes two modes with disjoint flags, and `run` with no flags would mean something different depending on whether the project has a suite. |

### 8. What a repeated run sends

What the CLI repeats is the project's saved defaults, not a composer that has
no headless equivalent.

| Setting | Recommendation |
| --- | --- |
| Conversation | `project.defaults.conversationRevisionId`, with template uses resolved by `projectDraft`. Choosing another revision is left for later. |
| Target, options, tools | `project.defaults`. Overriding the model or options from the command line is left for later; edit and save the project instead. |
| Repetitions | `--repetitions <n>`, default 5, 2 to 100: the app's dialog bounds, moved to the runner so both read one constant. |
| Response mode | `--response-mode streaming\|buffered`, default `buffered`. Unlike the app, which defaults to streaming, a headless job usually has nobody watching output arrive, and buffered needs no declared capability. The cost is that a buffered run measures no TTFO, so the summary reports the mode and the human summary says TTFO was not measured. `streaming` on a connection whose declared capabilities do not include it is refused (exit 2), never silently downgraded. |
| Turn ceiling | The default, as the app's dialog starts with. No flag yet. |

Tool rules are decision 3 unchanged: each tool in `enabledToolIds` needs an
enabled mock or an `--allow-tool` grant, or the run exits 2. In the app a
person can answer a repeated run's tool calls by hand; headless, nobody can.

### 9. Summary and exit codes

The v1 summary is built around a suite verdict (`suite`, `verdict`, and
`configurations` are required), which a repeated run does not have.

| Option | Effect |
| --- | --- |
| **A. A separate summary per command, told apart by `kind` (recommended)** | The evaluation summary gains `kind: "evaluation"`, additively, and stays version 1. `repeat --json` prints a `kind: "repeated-request"` summary with its own version, starting at 1. Nobody parsing today's output is affected. |
| B. Summary version 2 covering both | One schema, but every existing consumer has to handle a version bump for a command they do not use. |

The repeated summary, under the same rule as decision 4 (it names outcomes
and points at evidence, never copying model output): experiment ID,
lifecycle and stop, artifact paths, recorded concurrency and retry policy, the
target (connection, protocol, model), response mode, and conversation
revision, the counts
`repeatedExperimentAggregate` derives (requested, completed, failed,
rate limited, cancelled, not run, missing trace, retried after rate
limiting), its metric ranges (duration, TTFO, tokens, throughput, turns, tool
calls), `distinctFinalAssistantOutputs` as a number, and one entry per
repetition with its run ID, status, and trace path.

Exit codes for `repeat`:

| Option | Effect |
| --- | --- |
| **A. Mirror the evaluation meanings (recommended)** | 0: every repetition completed. 1: the batch ran to completion and at least one repetition failed for a reason other than a 429. 2: usage or setup error, as now. 3: the run did not complete (interrupted, stopped on a tool, an artifact write failed), or its only shortfall is rate limiting, as decision 4 already says for suites. |
| B. 0 whenever the batch finishes | Failures are evidence, not errors. Simpler, but CI cannot gate on a provider that errors one time in five. |

### Verification for slice 5

- **5a.** Unit tests for selection resolution (ID, name, ambiguous, unknown,
  repeated) and for `scope`, in `tests/cli-headless-run.test.ts`; a
  subprocess run of a subset against the buffered fixture provider. The
  plan shape is the app's own subset shape, so no new browser spec; the
  existing `headless-cli-artifacts.spec.ts` and the full suite run once.
- **5b.** Unit tests for building input from `project.defaults` (including a
  template-backed revision, the buffered default, and a refused streaming
  request), the repeated
  summary, and its exit codes; an integration run against the fixture
  provider that parses every artifact with the core parsers; and a new case
  in `headless-cli-artifacts.spec.ts` that opens a CLI-written repeated run in
  the Runs workspace. The app's repeated dialog is covered by its existing
  specs, which must stay green after `planFor` moves.

## Distribution

### Inside the published image

The image's entrypoint runs whatever command it is given
(`scripts/docker-entrypoint.sh` ends in `exec "$@"`). Shipping the CLI as a
second entry point in the image (`inference-lens` on `PATH`) is enough to run
it instead of the server. The runtime stage copied only the server's
standalone output, so the build must also bundle the CLI. One entrypoint
change turned out to be needed; see [slice 4](#slice-4-what-exists).

### Recommended use: one-off container per command

```sh
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e INFERENCE_LENS_API_KEY -e INFERENCE_LENS_API_ENDPOINT \
  -v "$PWD/evals.inference-lens:/project" \
  --user "$(id -u):$(id -g)" \
  ghcr.io/acgabbert/inference-lens:<version> \
  inference-lens run /project --suite triage
```

- A pinned image tag is the reproducibility story for CI.
- `--user` makes written artifacts belong to the host user rather than the
  image's `node` user (uid 1000). The Docker guide must explain this.
- Provider networking (`host.docker.internal`, Compose networks) works exactly
  as it does for the server; see the [Docker guide](DOCKER.md).
- The documentation should offer a shell alias or a small wrapper script for
  the long command line. The CLI itself never starts containers, which would
  require access to the Docker socket.

### Also possible: inside a running server container

```sh
docker compose exec inference-lens inference-lens run /project --suite triage
```

This reuses the server's environment, but the published Compose template
deliberately mounts no project folder and uses a read-only root filesystem.
Using it requires adding a writable project mount, which weakens that design.
Document it as possible, not as the main path.

### Later: a host install

Publishing to npm (`npx inference-lens run …`) gives the best developer
experience without Docker. It is a separate release decision; see
[releasing](RELEASING.md).

## Delivery slices

1. Move the scheduler and extract the start checks. No behavior change; the
   existing unit tests and full Playwright suite must stay green.
2. Add the Node project adapter and the CLI with mocks-only tools and decision
   2 credentials. Test it against the existing local fixture providers
   (`dev:echo-provider`, `dev:responses-provider`, `dev:anthropic-provider`),
   and confirm that the app's Runs and Evaluations workspaces open the
   artifacts it wrote.
3. Add explicit command and MCP grants, testing them with the committed MCP
   and command-tool fixtures.
4. Ship the CLI in the image and document it in the Docker guide.
5. Optional follow-ups: case and configuration selection flags (5a), then
   repeated-run plans (5b); see [slice 5](#slice-5-selection-and-repeated-runs).
   npm publishing is deferred.

## Verification expectations

- Unit tests cover credential resolution (including origin binding and the
  missing-credential error), grant refusal, exit-code mapping, and the JSON
  summary schema.
- An integration test runs the CLI against a fixture provider and validates
  every written artifact with the core parsers.
- A Playwright spec opens a project containing CLI-written artifacts and
  checks that Runs and Evaluations show the run and its assessment. This is
  the check that the artifacts are genuinely shared rather than merely
  well-formed.
- A container smoke test runs the CLI through the published-image command
  above against a fixture provider.

## Implementation status

### Sequencing change: slice 2 before slice 1

Slice 1 moves the scheduler out of `app/run/`, which another change to the Runs
workspace is editing at the same time. To avoid conflicting with it, slice 2
was built first and is purely additive: the CLI imports
`SequentialExperimentController`, `toolBindingForMock`,
`evaluationWorkspaceExecution`, and `createEvaluationStartDraft` from where
they live today, without editing them. Their imports were already safe to load
in Node; the unit suite has loaded them there all along. Slice 1 followed once
the Runs work landed; see below.

### Slice 1: what exists

The scheduler and the start checks moved into `packages/runner/`, a package
above `packages/core` and `packages/contracts`. It could not go into core:
contracts already imports core, and the controller needs contracts'
`ProviderTurnTransport`. Nothing in `packages/` imports from `app/` any more.

| Module | Owns |
| --- | --- |
| `packages/runner/src/sequential-experiment-controller.ts` | `SequentialExperimentController`, moved without behavior change |
| `packages/runner/src/provider-turn-driver.ts` | `driveProviderTurn` and its retry classification (`InferenceTransportError` beside it) |
| `packages/runner/src/mock-only-tool-executor.ts` | The executor factory for a host that serves project mocks only |
| `packages/runner/src/evaluation-batch-limits.ts` | Paid-batch limits as data (`evaluationBatchSize`) |
| `packages/runner/src/evaluation-start.ts` | Target resolution, `evaluationStartBlocker`, and `createEvaluationStartPlan` |
| `packages/core/src/tool-binding-resolution.ts` | Mock bindings, binding precedence, result provenance, pending calls |

Two contract changes came with the move:

- **`createExecutor` is required.** The app passes its service-backed
  factory; the CLI passes `createMockOnlyToolExecutor`. Before, the CLI
  inherited the app's factory by default, and with it `app/tools/`.
- **Start checks return a typed blocker** (`EvaluationStartBlocker`), not a
  sentence. The app phrases it exactly as before in
  `app/evaluations/evaluation-start.client.ts`; the app-only gates (no project,
  no suite, another run in progress) stay there. The CLI phrases it in
  `packages/cli/src/start-blockers.ts`, naming the `project.json` field that
  clears it rather than an app control.

### Slice 2: what exists

```sh
npm run cli -- run ./evals.inference-lens --suite triage [--json] [--no-auth <id>]
  [--concurrency <n>] [--connection-concurrency <id>=<n>] [--retry-rate-limits]
  [--allow-tool <tool>=command:<id>] [--allow-tool <tool>=mcp:<server-id>]
```

| Module | Owns |
| --- | --- |
| `packages/cli/src/credentials.ts` | Decision 2C, including origin binding and the `--no-auth` rule |
| `packages/cli/src/project-folder.ts` | Reading `project.json`; write-once plan, result, and trace files under the app's names |
| `packages/cli/src/transport.ts` | `executeProviderTurn` in process, behind the same `resolveProviderTurnRequest` validation the service applies |
| `packages/cli/src/evaluation-run.ts` | Suite selection, start checks, plan, controller, assessment |
| `packages/cli/src/start-blockers.ts` | The CLI's wording for each start blocker |
| `packages/cli/src/summary.ts` | `--json` schema version 1, the human summary, exit codes |
| `packages/cli/src/main.ts` | Argument parsing, interrupt handling, stdout/stderr split |

Choices made in implementation, within the agreed decisions:

- **Variable names.** `<ID>` is the requirement ID without its `connection_`
  prefix, upper-cased, with every other character replaced by `_`
  (`connection_evals-default` → `INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY`).
  Two connections that fold to one name are refused rather than sharing a key.
  Only connections the selected suite uses need a credential.
- **Capabilities.** With no device profile, a connection's capabilities are
  the project's declared `capabilityOverrides`, resolved the way the app
  resolves a profile. A suite whose protocol, streaming, or tools the
  declaration does not enable is refused with the app's start-gate message.
- **Tools.** Mocks only, as slice 2 specifies; slice 3 adds grants (below).
  A suite exposing any tool with neither an enabled project mock nor a grant
  exits 2, naming the tool.
- **Interrupts.** The first SIGINT or SIGTERM stops after the current request
  and writes a cancelled result (exit 3). A second exits immediately.
- **Running it.** `npm run cli` runs the TypeScript sources with Node's type
  stripping. A bundled `inference-lens` binary is slice 4.

Verification: `tests/cli-credentials.test.ts`, `tests/cli-headless-run.test.ts`
(including a subprocess run against `scripts/buffered-openai-provider.mjs`),
and `tests/e2e/headless-cli-artifacts.spec.ts`, which runs the CLI and then
opens what it wrote in the app's Run history and Evaluation results.

### Slice 3: what exists

Decision 3B, with one refinement agreed on October 9, 2026: a project never
records which command or MCP server serves a tool (in the app that is the
device-local grant), so `--allow-tool` names its target explicitly rather
than taking a bare tool name.

```sh
--allow-tool get_weather=command:weather     # a command in INFERENCE_LENS_COMMAND_TOOLS
--allow-tool lookup_record=mcp:docs-server   # a server in INFERENCE_LENS_MCP_SERVERS
```

| Module | Owns |
| --- | --- |
| `packages/cli/src/tool-grants.ts` | Parsing `--allow-tool`, resolving grants to bindings, and the in-process preflight against both catalogs |
| `packages/cli/src/tool-executor.ts` | The CLI's executor factory: mocks, and command and MCP tools run in process through the service's own execution code |

Choices made in implementation, within the agreed decision:

- **Precedence.** A grant outranks an enabled project mock for the same tool,
  as a grant does in the app (`toolBindingFor`).
- **Refusals, all exit 2 before anything is sent or written.** A malformed
  value; a tool named twice; a tool the project does not define; `mcp:` for a
  tool that was not attached from an MCP server; and, at the controller's
  `verifyToolBindings` preflight, a command the catalog does not declare, a
  missing or unreadable catalog, an MCP server that is not declared or not
  executable, and an MCP tool that is gone or whose fingerprint changed. Each
  names the tool and, where it helps, the variable that would fix it. A
  grant for a tool the selected suite does not expose is ignored, as an
  unused credential is.
- **The ceiling is unchanged.** Catalogs are read per call, as the service
  reads them, and an MCP call checks the live fingerprint first. Only
  loopback, unauthenticated MCP servers execute, as in the app.
- **Executor identity.** An MCP binding's `executorId` is derived exactly as
  the app derives it, so a trace names an MCP answer the same way whichever
  host ran it.
- **Interrupts.** The command runner used to install SIGINT and SIGTERM
  handlers that kill live commands and re-raise the signal, which turned the
  CLI's graceful first interrupt into an immediate exit with no result.
  `installCommandToolExitHook` lets a host that owns those signals keep only
  the exit-time cleanup; the first interrupt then cancels a running command
  through its abort signal, ending its process tree, and the run writes a
  cancelled result (exit 3).

Verification: `tests/cli-tool-grants.test.ts` runs the committed command
fixture (`weather.mjs`) and MCP fixture (`scripts/mcp-discovery-fixture.mjs`)
behind a provider that asks for one tool call and passes only if the tool's
text comes back; covers precedence over a mock, each refusal with no request
or artifact, an unexposed grant being ignored, and a changed MCP fingerprint;
and, in a CLI subprocess, interrupts a granted `hang.mjs` and checks for exit
3, a written result, and the command's own child process gone.

### Concurrency flags

Slice 4 of the [parallel experiment design](PARALLEL_EXPERIMENT_DESIGN.md)
exposes the shared scheduler's limits.

- **`--concurrency <n>`** sets both the overall limit and every connection's
  limit to `n`, so a one-connection suite actually runs `n` repetitions at
  once. Setting only the overall limit would leave a one-connection suite,
  the common case, at 1. Default 1, which is what every run did before.
- **`--connection-concurrency <id>=<n>`**, repeatable, lowers one
  connection's limit, keyed by the connection requirement ID that
  `--no-auth` and the credential variables already use. It may only lower:
  a value above `--concurrency` is refused rather than silently capped,
  because the overall limit would make it unreachable. An ID the project
  does not declare is refused; one the selected suite does not use is
  ignored, as it is for credentials.
- **Errors.** A value that is not a positive whole number, a repeated ID,
  or either refusal above exits 2 before anything is sent or written.
- **Reporting.** The `--json` summary v1 gains an optional `concurrency`,
  the limits the result recorded (`{ maxInFlight, connections }`), absent
  when no result was written. This adds a field without a version bump; v1
  has not been in a tagged release. The human summary adds "Ran up to `n`
  repetitions at once." only when `n` is above 1, so default output is
  unchanged.
- **Progress.** The per-repetition stderr line counts finished
  repetitions, so it reads correctly in any finishing order. When a
  provider 429 pauses a connection, or a later one lengthens the pause,
  stderr gets `Rate limited on <requirement ID> (<endpoint>); new
  repetitions there wait <n> s.`, from the pause times in parallel slice 3's
  progress contract. It names the connection by the ID
  `--connection-concurrency` takes.

Verification: `tests/cli-headless-run.test.ts` drives an in-process
provider that holds requests until two overlap, and checks the peak number
in flight (2 at `--concurrency 2` over three cases; 1 when
`--connection-concurrency` lowers it), the recorded and reported limits, plan
order in the summary, and each refusal.

### Retry flag

Slice 6 of the [parallel experiment design](PARALLEL_EXPERIMENT_DESIGN.md)
adds `--retry-rate-limits`.

- **`--retry-rate-limits`** retries a request the provider refuses with
  HTTP 429, up to 2 times per provider turn, after the wait the provider asks
  for (decision 6's reading, capped at 60 seconds). Off by default, so a run
  without it behaves as before. Nothing else is retried.
- **Reporting.** The `--json` summary v1 gains an optional `retryPolicy`,
  the policy the result recorded (`{ rateLimited: { maxRetries } }`), absent
  when no result was written, and each configuration gains
  `retriedAfterRateLimit`, the repetitions that retried at least one 429,
  whatever their outcome. Both are added without a version bump, for the
  reason `concurrency` was. The human summary adds "Retried rate-limited
  requests up to 2 times per turn." when retries were on, and
  ", N retried after rate limiting" on a configuration's line when N is
  above 0, so default output is unchanged.
- **Exit codes** are unchanged. A repetition whose retries ran out is
  rate-limited, so a suite held back only by that still exits 3.

Verification: `tests/cli-headless-run.test.ts` runs a suite against an
in-process provider that refuses the first request with a 429, once with
the flag (three requests, exit 0, the recorded policy and the retried count
reported) and once without (two requests, the policy reported as off).

### Slice 4: what exists

The published image runs the CLI in place of the server:
`docker run … ghcr.io/acgabbert/inference-lens:<version> inference-lens run
/project`. The [Docker guide](DOCKER.md#run-an-evaluation-suite-from-the-command-line)
documents the one-off-container command, `--user`, credentials, a shell
function for the long command line, real tools in a container, and
`docker compose exec` as possible but not preferred.

| Piece | Owns |
| --- | --- |
| `vite.cli.config.ts` | `npm run build:cli`: one self-contained ES module, `dist/cli/inference-lens.mjs`, with every dependency inlined and only `node:` imports left |
| `Dockerfile` | Building the bundle beside the server, and installing it root-owned at `/app/cli/inference-lens.mjs`, linked as `/usr/local/bin/inference-lens` |
| `scripts/docker-entrypoint.sh` | The browser banner, now printed only for the server command |
| `scripts/docker-cli-smoke.ts` | `npm run test:docker-cli -- <image>`: the documented command against the buffered fixture provider |

Choices made in implementation:

- **A bundle, not the sources.** The runtime stage has no TypeScript sources
  and only the server's traced `node_modules`, so the CLI ships as one file
  built with the Vite already in the repository. It does not depend on Node's
  type stripping or on what the server's standalone output happens to
  include. `npm run cli` still runs the sources, for development.
- **The banner moved off other commands' stdout.** The entrypoint printed its
  "open http://localhost:3000" banner before every command, which put it
  ahead of the `--json` summary and broke decision 4's stdout contract. It now
  prints only when the command is `node server.js`, the image's default, so
  the server's output is unchanged.
- **Fixture host.** `scripts/buffered-openai-provider.mjs` takes an optional
  `INFERENCE_LENS_BUFFERED_HOST`, as `n8n-echo-provider.mjs` already does, so
  the smoke test can bind it to the Docker bridge address that
  `host.docker.internal:host-gateway` resolves to rather than to every
  interface. It still defaults to loopback.

Verification: `tests/cli-bundle.test.ts` builds the bundle, copies it to a
directory with nothing else in it, and runs it through a symlink as the
image's `PATH` entry does. It checks that only `node:` imports remain, runs
a suite against the committed buffered fixture provider, and serves an MCP
grant through the bundled MCP client. The process must exit on its own.
`scripts/docker-cli-smoke.ts` runs in the image workflow on every pull
request, against a native amd64 build. It checks the exit code (1, for one
failing case), that stdout parses as the JSON summary and nothing else, that
the plan, result, and traces parse with the core parsers, and that they
belong to the host user.

### Slice 5a: what exists

Decisions 5A and 6A, as agreed:

```sh
inference-lens run <project-folder> [--suite <id-or-name>]
  [--case <id-or-name>]... [--configuration <id-or-name>]...
```

| Piece | Owns |
| --- | --- |
| `selectSuiteItems` in `packages/cli/src/evaluation-run.ts` | Resolving both flags as `--suite` resolves, and refusing an unknown, ambiguous, or repeated selection |
| `HeadlessScope` in `packages/cli/src/summary.ts` | `scope` in summary v1, and the human summary's "Ran 2 of 3 cases" line, printed only when something was left out |

Choices made in implementation:

- **Suite order.** The selection is returned in the suite's order, not the
  flags', so two invocations naming the same cases write the same plan order.
- **Only selected connections.** Credentials resolve for the connections the
  selected configurations use, so leaving a configuration out also leaves out
  its key, as decision 5 requires.
- **Exit code 0's wording.** `--help` now says "every case that ran passed"
  rather than "the suite passed".

Verification: four tests in `tests/cli-headless-run.test.ts`, written and run
red first. They cover a subset run (the requests sent, the plan's snapshot,
`scope`, and the human line), a full run's `scope` with no line, a connection
needing no key once its configuration is left out, and each refusal on the
command line. No browser spec was added: the plan has the shape the app
writes for its own subset runs.
