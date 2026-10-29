# Prompt environments

**Status:** Proposal for review; no runtime implementation or contract approval.
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

## Decisions to review

Per [AGENTS.md](../AGENTS.md), these are resolved before types change.

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

These shapes are illustrative until the decisions above are accepted.

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
- **Format.** New Project and RunTrace versions. The Project version must be
  allocated alongside the staged v16 shared-project format in
  [`shared-project.ts`](../packages/core/src/shared-project.ts): either the
  environment collection joins that format, or the active format gains it under
  a version that does not collide. Old readers reject the new formats
  explicitly; old projects open with no environments and render as before.

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

## Interaction with sub-agent routing

When routing lands, a child request renders against the parent's environment
snapshot by name, at the same precedence. Tool-call arguments become one more
layer above the environment, bound explicitly to named child variables rather
than by name, because they come from a model. That replaces the routing plan's
fixed `{ "input": string }` schema without changing its other decisions.

## Delivery sequence and effort

Rough, code-inspection estimates for one developer familiar with the repo;
not measured by a spike.

1. **Contracts (about half a day).** Settle the decision table, numeric limits,
   and version allocation against staged v16.
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
  references rendering visibly; resolved values not re-scanned; secret-like
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
