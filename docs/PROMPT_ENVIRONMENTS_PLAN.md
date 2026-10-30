# Prompt environments

**Status:** Decision table, limits and format versions accepted 2026-10-29;
the staged shared format is renumbered to v17, and to v18 on 2026-10-30. Environments are implemented
before final output, so they keep Project v16 and take RunTrace v9 and
ExperimentPlan v6; [final output](FINAL_OUTPUT_CONTRACTS.md#d1-format-version-allocation)
moves to Project v18, RunTrace v10 and ExperimentPlan v7 (see
[Format version](#format-version)). Contract slice accepted and core
implemented 2026-10-29. The app slice (selector, editor drawer, provenance
labels) is implemented; evaluation authoring and run comparison remain.
**Date:** 2026-10-29. **Inspected baseline:** `main` at `406cb03`.

## Outcome

Let a project define named, switchable sets of values — environments — that
fill template variables in any prompt a run sends. Switching the environment
changes what every template use renders without editing the prompts. Entries
may be built from other entries in the same environment.

The motivating workflow is an agent whose prompts are filled from state that is
known before the agent runs: workflow inputs, configuration, or data fetched
ahead of time (an n8n workflow's global state, for example). Today the closest
emulation is typing those values into each template use by hand. An environment
holds them once and lets the same prompts run against several of them, or
several prompts run against one of them.

This is the input layer that
[request-backed sub-agent routing](REQUEST_SUBAGENT_ROUTING_PLAN.md) consumes:
a parent and its children render against the same environment snapshot. It is
sequenced first because it is useful without sub-agents — for ordinary runs and
evaluation suites — and has no nesting of its own.

### Out of scope

- **State written during a run.** A tool result or child answer that becomes a
  variable for a later request is a workflow engine: write rules, ordering,
  per-change trace evidence and replay. It is a separate design, and nothing
  here should anticipate it in types.
- **Secrets.** An environment is portable project content that can be committed
  and shared. Credentials stay with connections.
- **Expressions.** Entries reference other entries by name; there are no
  functions, conditionals, dotted paths or JSON access.

## Existing seams

| Owner | Today | Gap |
| --- | --- | --- |
| [`template-engine.ts`](../packages/core/src/template-engine.ts) | One flat substitution pass; unresolved tokens render visibly with a diagnostic; rendered values are never re-scanned. `resolveTemplateValues` merges defaults < use values < run overrides. | No layer between template defaults and the use, and no value can reference another. |
| [`project.ts`](../packages/core/src/project.ts) `resolveProjectRevision` | Renders every template use in a conversation revision; rejects secret-like variable names. | Takes no environment. |
| [`run-kernel/types.ts`](../packages/core/src/run-kernel/types.ts) `ResolvedTemplateUse` | Stores `variableDefaults` and the effective `values` per use, so a trace already reproduces rendered content. | Cannot say which environment, or which layer, supplied a value. |
| [`evaluation-suites.ts`](../packages/core/src/evaluation-suites.ts) | Case values bind to one template use's variable; variants are sparse execution overrides. | No way to vary shared context across a suite or a variant. |

## Decisions

Accepted as recommended on 2026-10-29, together with the
[format version](#format-version).

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| How a variable picks up an environment value | **By name**: an entry `customer` fills every `{{customer}}` not set more specifically. Light to author; a rename can silently change the source. **By explicit reference** in use values (`{{env.customer}}`): visible wiring, but needs a grammar change (dotted names are invalid native tokens today) and wiring in every use. | By name, with per-variable provenance shown in the preview and recorded in the trace, so a silent source change is visible rather than hidden. |
| Precedence | Environment **below** use values: explicit authoring wins, but a use that stored a value ignores the environment. Environment **above** use values: switching always takes effect, but overrides deliberate authoring. | Template default < **environment** < use value < run override < evaluation case value. The editor must let a use leave a variable unset ("from environment"), and must show when a use value shadows the environment. |
| Derived entries | Single-level values only, or entries that reference other entries. | Entries may reference entries in the same environment with ordinary `{{name}}` tokens. Resolve once in dependency order; the resolved value is literal and is not re-scanned when inserted into a template. A cycle is rejected when saved; a missing reference renders as its token with a diagnostic, like a template. |
| Mutability | **Revisioned** like templates: exact pins, but an extra pin/update workflow for every edit. **Mutable** with a snapshot in every run and plan: simpler, and evidence stays exact. | Mutable authored content, snapshotted at preparation. Runs and evaluation results are reproducible from their own snapshot; re-running a suite after editing an environment uses the edit, as it does after editing a suite. |
| Selection | Device-local only; project default only; or both. | Optional `defaults.environmentId` in the project plus a composer selector. Absence means no environment, preserving current behavior. |
| Evaluation integration | None in MVP; suite-level only; suite plus per-variant override. | Suite `execution.environmentId` and an optional variant override. A variant is then "same cases, different environment", and two suites can run different prompts against one environment. |
| Trace provenance | Rely on the rendered values already stored (no format change), or record environment identity and per-variable source. | Record the environment's ID, name and the resolved entries actually consumed, plus a per-variable source layer. Without it, two runs that differ only by environment are indistinguishable in history. Requires a RunTrace version. |
| Deleting a referenced environment | Clear references silently, or refuse. | Refuse, listing the suites and defaults that use it. Clearing a reference changes rendered values, unlike withdrawing a tool. |

## Proposed contracts

Shapes are fixed in the contract slice; field names here may still be refined
without changing the accepted decisions.

```ts
interface ProjectEnvironment {
  id: EnvironmentId;
  name: string;            // unique within the project, ignoring case
  entries: Array<{ name: string; value: string }>; // ordered; names unique
}

interface ResolvedEnvironment {
  environmentId: EnvironmentId;
  name: string;
  values: Record<string, string>;          // fully resolved, literal
  diagnostics: EnvironmentDiagnostic[];    // missing references
}

type TemplateValueSource =
  | "template-default" | "environment" | "use" | "run-override" | "evaluation-case";
```

- **Ownership.** A pure core module, `packages/core/src/environment.ts`, owns
  parsing, cycle detection, resolution and diagnostics. `resolveProjectRevision`
  takes an optional `ResolvedEnvironment` and inserts it as one layer in
  `resolveTemplateValues`. The template engine itself stays unaware of
  environments.
- **Validation.** Entry names follow the native variable grammar and are
  rejected when secret-like, using the existing
  `isSensitiveTemplateVariableName`. Values cannot be checked for secrets; the
  editor states that environments travel with the project. Numeric limits on
  entry count and value size follow existing project conventions and are set in
  the contract slice.
- **Snapshot.** Preparation resolves the selected environment once.
  `ResolvedRunInput` carries the resolved environment, and `ResolvedTemplateUse`
  gains a per-variable source map. Nothing looks up the environment again after
  the run starts, so editing it never retargets an in-flight run. Experiment
  plans snapshot it the same way.
- **Selection ownership.** `defaults.environmentId` is the project's authored
  launch default. The composer's current choice is session state, like the
  composer's model, and is not written back into the project on every switch.

### Limits

Limits are counted in UTF-16 code units, like the
[schema check limits](../packages/core/src/json-schema/limits.ts). They start
conservative because raising a limit later is compatible and lowering one is
not.

| Limit | Value | When exceeded |
| --- | --- | --- |
| Environments per project | 50 | Project rejected on parse |
| Entries per environment | 200 | Project rejected on parse |
| Authored entry value | 65,536 | Project rejected on parse |
| Resolved entry value | 150,000 | Resolution error; the run is refused in preflight |
| Resolved environment, all entries | 1,000,000 | Resolution error; the run is refused in preflight |

The two resolved limits exist because derived entries can grow exponentially:
`a = "{{b}}{{b}}"`, `b = "{{c}}{{c}}"`, and so on. Resolution stops as soon as a
limit is crossed instead of building the value first. Results are never
truncated. Reference depth needs no separate limit: references are acyclic and
there are at most 200 entries.

### Format version

Environments are a new top-level collection, so the project format needs a new
version. The active project parser is strict, so an old build rejects an
unknown field rather than dropping it. That stops data loss, but the old build
reports a malformed file instead of a newer version. A version bump gives the
explicit "newer version" refusal.

The collision: [`shared-project.ts`](../packages/core/src/shared-project.ts)
already claims 16 for the staged shared-assets format, which removes template
drafts. The app and CLI do not use it yet, and its remaining integration work
is unscheduled.

| Option | Cost | Risk |
| --- | --- | --- |
| **A. Environments ship as active v16; the staged shared format becomes v17 and carries environments.** | Renumber the staged constant, its type, two tests, one example file, and the version references in the shared-assets design docs. Mechanical. | The shared-assets docs were reviewed against "v16"; the renumber must be one reviewed change. |
| B. Environments join staged v16 and ship with the shared-assets migration. | No renumbering. | Environments wait on unrelated, unscheduled work: publication, recovery, and the workbench. |
| C. Environments ship as active v17, skipping 16. | No renumbering. | Two "next" formats exist at once, and a v15 → v17 migration must later reconcile with a v16 that never shipped. |

**Accepted 2026-10-29: A.** Environments are shared authored content, so they
belong in the shared format either way, and A puts them there without blocking
on the migration. The renumber is done: `SHARED_PROJECT_SCHEMA_VERSION` is 17,
the example is `project-v17.proposed.json`, and the live shared-assets docs
carry a renumbering note. Dated verification records and archived documents
keep "v16" because that is what they recorded. The renumber had no runtime
effect; no app or CLI path reads the staged format. When environments land,
the staged v17 codec derives from active v16 instead of v15. RunTrace has no
collision: environments take v9.

**Revised 2026-10-29: numbers only.** The
[final-output contracts](FINAL_OUTPUT_CONTRACTS.md#d1-format-version-allocation)
claim active Project v16, RunTrace v9 and ExperimentPlan v6. Environments now
take active Project v17 and RunTrace v10. Experiment plans snapshot the
environment, so they also take ExperimentPlan v7. Option A's reasoning is
unchanged: the staged shared format still carries environments. It stays v17
in code until environments land. That change renumbers it to v18, derived from
active v17, the same mechanical renumber as before. Nothing reads the staged
format today, so the two v17s never meet in a reader. If environments land
before final output, the two features swap numbers rather than skip one.

**Revised again 2026-10-29: numbers swapped back.** Environments are
implemented first, so they take active **Project v16, RunTrace v9 and
ExperimentPlan v6**, and
[final output](FINAL_OUTPUT_CONTRACTS.md#d1-format-version-allocation) takes
Project v17, RunTrace v10 and ExperimentPlan v7. This restores option A as
first accepted: the staged shared format stays v17, carries environments, and
derives from active v16 when environments land. It renumbers to v18 only when
final output lands active v17.

**Revised 2026-10-30.** [External prompt file imports](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#external-prompt-sources) took
active Project v17 first, so the staged shared format is now v18 and carries
both. Final output takes Project v18, and the staged format renumbers to v19
when it lands. Environments keep Project v16, RunTrace v9 and ExperimentPlan v6.

### Contract slice proposal

**Accepted 2026-10-29, all four questions as recommended.** Exact names and
the provenance shape, written against `main` at `79a3b2a`. The four questions
are kept below as the record of what was decided.

```ts
// project.ts: Project v16
type EnvironmentId = `environment_${string}`;
interface ProjectEnvironmentEntry { name: string; value: string }
interface ProjectEnvironment {
  id: EnvironmentId;
  name: string;                       // unique ignoring case, trimmed, non-empty
  entries: ProjectEnvironmentEntry[]; // ordered; names unique
}
// ProjectFileV16 = ProjectFileV15 + { schemaVersion: 16; environments: ProjectEnvironment[] }
// ProjectDefaults gains environmentId?: EnvironmentId

// evaluation-suites.ts: chat suites only
// ChatEvaluationSuite.execution.environmentId?: EnvironmentId
// EvaluationVariant.overrides.environmentId?: EnvironmentId | null   // null: no environment

// environment.ts
interface ResolvedEnvironment {
  environmentId: EnvironmentId;
  name: string;
  values: Record<string, string>;        // every entry, fully resolved, literal
  diagnostics: EnvironmentDiagnostic[];
}
type EnvironmentDiagnostic =
  | { code: "missing-environment-reference"; entryName: string; reference: string; message: string }
  | { code: "invalid-environment-token"; entryName: string; token: string; message: string }
  | { code: "environment-limit-exceeded"; entryName?: string; limit: number; message: string };

// run-kernel/types.ts: RunTrace v9, ExperimentPlan v6
type TemplateValueSource =
  | "template-default" | "environment" | "authored-use" | "run-override" | "case";
// ResolvedTemplateUse gains valueSources: Record<string, TemplateValueSource>
// ResolvedRunInput gains environment?: RunEnvironmentSnapshot
interface RunEnvironmentSnapshot {
  environmentId: EnvironmentId;
  name: string;
  consumed: Record<string, string>; // resolved entries some template use took
}
```

Settled by the accepted decisions or by existing code:

- **Source names** reuse `EvaluationValueSource` in
  [`evaluation-case-resolution.ts`](../packages/core/src/evaluation-case-resolution.ts)
  (`"case"`, `"authored-use"`, `"template-default"`) and add `"environment"`
  and `"run-override"`. That type becomes an alias of `TemplateValueSource`.
- **Only referenced names enter a use.** An environment entry fills a use only
  for a variable that the pinned template revision references. `values` does
  not gain the whole environment for every use.
- **Case values are labelled.** Evaluation cases reach `resolveProjectRevision`
  through the same override parameter as composer run values. The resolver
  therefore takes the override layer's source (`"run-override"` or `"case"`) so
  that the trace says which one supplied a value.
- **Cycles and duplicate names** are rejected when the project is parsed, with
  a path to the entry. They never become resolution diagnostics.
- **Old artifacts.** A v15 project upgrades with `environments: []` and no
  default. A v8 trace has no `valueSources` or `environment`, and the reader
  infers nothing. In v9, `valueSources` is required on every template use, so
  "no provenance" and "predates provenance" stay distinct, as with
  `toolExecutions` in v6.
- **Variant `null`** follows the existing option overrides: `null` clears the
  suite's environment for that variant, and absence inherits it.

Questions, each accepted as recommended:

1. **Provenance shape.** A `valueSources` map parallel to `values`. *Or*
   replace `values` with per-variable `{ value, source }` records. The parallel
   map keeps replay, parsing and every reader of `values` unchanged.
   **Recommend the parallel map.**
2. **What the trace snapshots.** Only the consumed entries. *Or* the whole
   resolved environment. The whole environment lets history compare two runs
   by every entry, not only by the entries the prompts used. The cost is up to
   1,000,000 code units in every trace and every plan input. **Recommend
   consumed entries**, as the accepted table says.
3. **Which diagnostics block a run.** A run is refused when a consumed entry,
   or an entry it derives from, has a diagnostic. A limit error always refuses
   the run. *Or* any environment diagnostic refuses it. With the narrower rule,
   an unfinished entry that no prompt uses does not block unrelated runs.
   **Recommend the narrower rule.**
4. **Decision requests.** System One decision inputs have their own
   `{{variable}}` values (D40) and their own trace format. Keep environments
   to chat template uses for now. *Or* also fill decision inputs, which needs
   a decision-trace version and a decision-suite field. **Recommend chat only**;
   decision inputs become a follow-up.

### Evaluation plans and saved formats

**Accepted 2026-10-29: one input per environment.** A variant can choose its
own environment, so one case renders differently per variant. An ExperimentPlan
v6 evaluation case holds `inputs`, one rendering per distinct environment its
configurations use, and each configuration snapshot names its
`environmentId`. Configurations that share an environment share one input.
Inputs are keyed by environment identity, not by variable names. Two
environments with the same entry names and different values therefore each
get their own input, and the history says which environment produced a run.
Preflight resolves every case once per environment the selected configurations
use, and names the configuration when they use more than one.

Two details follow from not inventing evidence:

- A v9 trace requires `valueSources`. A trace read from an older file, whose
  template uses have none, is written back as v8 rather than given sources
  nobody observed.
- A v6 plan's `valueSources` are optional per use, because a v5 plan opens as
  v6 and its case shape changed, so it cannot be written back as v5. An input
  that records an environment must carry them.

## Feature owners and user experience

- `app/environments/` owns the environment list, entry table, resolved preview
  with diagnostics, and the selector. The route composes the selector; it does
  not gain resolution state of its own.
- The template editor and request preview show each variable's value and its
  source ("from environment *Staging*", "set on this use", "default").
- The evaluation suite editor gains an environment field on the suite and on
  each variant, inheriting like other variant overrides.
- Run history and run inspection name the environment; comparing two runs
  shows an environment difference before a content difference.

### App slice decisions

**Accepted 2026-10-29, all as recommended.** Written against `main` at
`69b31c3`.

- **One resolution context.** The core helpers that render a conversation
  revision for the workbench (`projectDraft`, `authoredItemsForMessages`,
  `createBranchRevision`, `projectForTemplateMutation` and the pending-branch
  helpers) take a `TemplateResolutionContext { runOverrides, environment? }`
  in place of a bare `runOverrides`. The template hook owns one value and
  passes it everywhere, so no call site can render with the overrides but
  without the environment; a mismatch would refuse every run as "differs from
  its generated messages".
- **Editor home.** A drawer opened from the composer's environment selector,
  like the connection drawer, so the request preview stays visible while
  entries are edited.
- **Editing commits explicitly.** Each environment is edited as a local draft
  with its issues inline. Save writes it to the project and is disabled while
  the draft has a cycle, a duplicate or an invalid name; Discard drops it.
- **Scope of the first app PR.** The selector (session choice, initialized
  from `defaults.environmentId`, with a "use as project default" action), the
  threading, readiness for blocking environment diagnostics, the editor, value
  sources in template-use cards and the request preview, the environment name
  in run history and inspection, and `tests/e2e/prompt-environments.spec.ts`.
  Run comparison ordering and the evaluation suite and variant fields follow
  in the next PR.

## Interaction with sub-agent routing

When routing lands, a child request renders against the parent's environment
snapshot by name, at the same precedence. Tool-call arguments become one more
layer above the environment, bound explicitly to named child variables rather
than by name, because they come from a model. That replaces the routing plan's
fixed `{ "input": string }` schema without changing its other decisions.

## Delivery sequence and effort

Rough, code-inspection estimates for one developer familiar with the repo;
not measured by a spike.

1. **Contracts (about half a day).** Decision table, limits and versions are
   settled; the staged format is renumbered. Exact field names and the
   provenance shape remain.
2. **Core (1–2 days).** Environment module, resolution and cycle detection,
   precedence layer and provenance, snapshot in resolved input and plans,
   project and trace parsing/round trips, deletion rules.
3. **App (1–2 days).** Environment editor and selector, provenance in the
   template editor and preview, history/inspection labels.
4. **Evaluations (about half a day).** Suite and variant environment fields,
   preflight, result labelling; CLI parity through the shared plan path.

Total roughly 3–5 days.

## Verification

Write each regression test before its implementation and run it red for the
actual wrong value.

- **Core:** precedence across all five layers; unset versus explicit empty use
  values; derived entries in dependency order; cycle rejection; missing
  references rendering visibly; resolved values not re-scanned; resolved-size
  limits stopping exponential expansion without truncating; secret-like
  names rejected; snapshot independence from later edits; old project and
  trace compatibility; refused deletion.
- **Browser:** a committed `tests/e2e/prompt-environments.spec.ts` whose
  fixture asserts the exact rendered request content under two environments
  from the same prompt, plus a derived entry and a use value shadowing the
  environment. A fixture that accepts any request content proves nothing about
  switching. Evaluation coverage asserts two variants send different rendered
  content for the same case.

This change is documentation only: no unit, runtime or browser run is needed
under AGENTS.md.
