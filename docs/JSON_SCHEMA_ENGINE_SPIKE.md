# JSON Schema engine feasibility record

Date: 2026-10-16. Status: engine comparison complete; runtime integration gated
on the worker boundary and a native Tauri webview probe. No check vocabulary,
artifact version, authoring UI, or evaluation behavior changes in this slice.
Both packages are exactly pinned **development dependencies**, used only by the
spike. The interpreter is the preferred candidate, not yet a production engine.

Follow-up: the [deterministic evaluator spike](METERED_JSON_SCHEMA_SPIKE.md)
supersedes the worker-first recommendation below. This record preserves the
external-engine measurements and the earlier decision history.

## Candidates and reproducible probes

```sh
npm run test:json-schema:node
npm run test:json-schema:bundles
```

The first command runs original characterization fixtures, then executes each
adversarial workload in a disposable Node worker with a 1,500 ms parent deadline
and a 64 MiB old-generation limit. This is an experimental containment harness,
not the application worker implementation. Timing measurements are observations,
not portable performance assertions. The second builds explicit Vite library
entries for browser, Tauri-target frontend, and Node, executes both Node bundles,
and serves the production frontend bundles to Playwright Chromium. Temporary
bundles are removed on completion. Browser probes require loopback permission.

| Candidate | Published unpacked package | Minified web probe / gzip | Loading | License |
| --- | ---: | ---: | --- | --- |
| `@cfworker/json-schema` 4.1.1 | 173,840 bytes | 32,493 / 8,119 bytes | Synchronous ESM/CJS, no dependencies or assets | MIT, including derived-code notices |
| `ajv` 8.20.0 | 1,033,496 bytes | 157,672 / 40,533 bytes | Synchronous code generation; four direct dependencies | MIT; `fast-uri` is BSD-3-Clause |

Bundle measurements include each adapter and all 42 fixtures, so these are
reproducible probe sizes, **not** incremental application bundle sizes. The
interpreter Node probe was 31,242 bytes / 7,746 gzip; Ajv's was unchanged. The
Tauri-target frontend bundles matched the web sizes. Ordinary application builds
do not import either candidate, so their success alone cannot prove engine
compatibility. Exact notice texts and provenance are retained under
[`scripts/spikes/json-schema/notices`](../scripts/spikes/json-schema/notices/README.md).

## Semantics and diagnostics

The 42 fixtures cover boolean schemas, scalar/null/union types, empty objects,
nested and required/optional properties, extras, maps, enums/const, numeric and
length bounds, Unicode length, array items/tuples/contains/uniqueness/counts,
object counts/property names/dependencies, composition/conditionals, annotations,
local/escaped/`$defs` pointers, and consuming recursive references. Each Node
case checks that the caller's JSON schema and data remain unchanged. They are a
representative supported-profile matrix, not the complete upstream draft suite.

The interpreter agrees with all 42 draft-07 expectations when explicitly given
draft `'7'`. Its default is **2019-09**, which must never choose the dialect for
an authored draft-07 check. Ajv agrees with 41/42 in the tested configuration:
it applies siblings beside `$ref`, whereas draft-07 ignores them. The first
comparison run failed on the actual wrong value (`expected true, got false`)
before that difference was explicitly characterized in the fixture. The Ajv
characterization is intentionally green with this known deviation; it is not
reported as 42-case draft-07 conformance. Ajv has a deprecated
`ignoreKeywordsWithRef` option; this spike does not depend on it.

Other pinned observations:

- Neither adapter coerces data, inserts defaults, strips extras, or wraps values.
  An absent required property with a default still fails. No provider/model calls
  take place.
- The interpreter writes hidden `__absolute_uri__` / reference metadata onto
  schemas. Frozen schema construction throws. Always give it a private copy;
  JSON serialization comparisons alone would miss these hidden mutations.
- The interpreter asserts recognized `format` values with no constructor option
  to disable that behavior. The spike removes `format` only at schema positions
  in a private copy. It preserves literal objects in `const`, `enum`, examples,
  and defaults. Production preflight must collect unchecked formats before
  producing the private engine schema. Ajv uses `validateFormats: false`.
- Both raw engines silently accept an unknown assertion in the tested settings,
  and execute `pattern`. Neither setting is the application profile. An explicit
  keyword allowlist must reject unsupported assertions, regex keywords, `$id`
  rebasing, and other dialects before either engine runs.
- The interpreter is not a schema meta-validator: `maximum: "invalid"` can pass.
  It also accepts a 2020-12 `$schema` while given draft `'7'`. Production needs
  schema validation in addition to profile validation. A missing local reference
  in an unused property is not detected at construction or when evaluating `{}`;
  every reference must be resolved during preflight, including unused branches.
- With 1,000 invalid array items, first-error/all-error counts were **2/2,000**
  for the interpreter and **1/1,000** for Ajv. Interpreter wrapper issues explain
  the extra count. Neither exposes a stop-after-N-issues setting. Slicing to 20
  after validation only bounds display, not collection or evaluation work.
- Both engine error representations contain a provider-derived unexpected
  property name. Raw errors, params, locations, and exception messages must not
  cross the public outcome boundary. Production requires IF-owned codes,
  templates, typed safe locations, and deterministic bounded diagnostics.

The [interpreter documentation](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)
describes its draft selection and short-circuit flag. Ajv documents
[code generation and CSP consequences](https://ajv.js.org/security.html) and
[all-error collection](https://ajv.js.org/options#allerrors). The fixtures pin
observations independently of those defaults.

## Resource feasibility

Observed on macOS, Node 24.3.0; timings include schema setup in the worker but
exclude worker startup. Termination deadlines include startup. Results can vary
with hardware and load; no particular duration is promised.

| Workload | Interpreter | Ajv |
| --- | --- | --- |
| Consuming recursive object, depth 64 | Passed, about 1 ms | Passed, about 10 ms |
| 12,000 distinct object items, `uniqueItems` | Terminated at 1,500 ms | Passed, about 1,353 ms |
| `{"$ref":"#"}` against `null` | `RangeError`, about 2 ms | `RangeError`, about 18 ms |
| 28-level DAG, two refs to the next node at each level | Terminated at 1,500 ms | Passed, about 294 ms |

The DAG is only 2,157 UTF-16 units and validates four units of output (`null`).
Its syntactic nesting is shallow. The unique-items output is 132,891 units and
its schema is 20 units. Both fit the proposed 64 Ki schema / one-million output /
depth-64 limits. Data depth does **not** guarantee recursive-reference
termination: a reference can revisit the same data node indefinitely. Acyclic
reference graphs can still multiply work exponentially. First-error mode cannot
bound successful composition work, and pairwise uniqueness comparisons add
another source of expensive work.

**Finding:** neither candidate is safe to invoke synchronously on arbitrary
profile schemas on the UI thread. Size/depth limits and a displayed-issue cap
are insufficient. Ajv's speed does not resolve non-consuming recursion, CSP, or
arbitrary schema compilation costs; there is no conformance reason here to
prefer it over the interpreter.

## Agreed next direction: worker isolation

The user selected worker isolation after reviewing the findings. Retain the
schema surface and interpreter preference; move expensive schema loading,
meta-validation, reference analysis, and answer validation into a terminable
worker. Validation inside the worker can remain synchronous and pure; callers
must await a bounded job. Do not add an unbounded synchronous fallback.

The next implementation needs an explicit portable job/reply contract plus
browser/Tauri Web Worker and Node `worker_threads` hosts. Hosts own concurrency,
parent-enforced deadlines, cancellation, worker termination/replacement, and
cleanup. Check identity and a request generation must prevent a late reply from
updating replacement criteria. The worker owns the private schema copy and
sanitizes errors before replying; replies never contain parsed answers or raw
validator errors. The answer travels only as transient job input.

Apply answer size/depth gates before validation; output-budget failures stay
failed checks. IF-imposed schema/evaluation work limits remain not-evaluated.
A timeout must produce a stable bounded diagnostic and cannot silently become a
successful check. Exact timeout, queue/concurrency limits, memory strategy,
preflight implementation, and multi-issue strategy still need design and
adversarial verification. Node's heap limit does not establish a browser-worker
memory limit, and a wall-clock deadline alone is not an issue-allocation cap.

`evaluateCheck` / `evaluateChecks` in `checks.ts` and
`evaluationParsedExperimentAggregate` in `experiment.ts` are synchronous today;
the aggregate evaluates checks while deriving results. The next slice must
resolve the asynchronous ownership boundary across live results, history,
reassessment, and CLI before changing their contracts. Keep feature job state
with those owners and pure scoring separate from scheduling. No route state or
persisted worker registry is needed. This record approves the isolation
direction, not an unreviewed signature migration.

## Verification and remaining gates

Passed:

- `npm run test:json-schema:node` (42 characterizations per engine, raw-engine
  hazards, and contained adversarial probes).
- `node scripts/spikes/json-schema/bundles.mjs` (the command behind
  `test:json-schema:bundles`): both Node bundles and eight Chromium combinations
  of engine, frontend target, and CSP. The interpreter passes with strict CSP;
  Ajv throws `EvalError` under strict CSP as expected.
- `npm run typecheck`; `npm run lint` (zero errors, three existing unused-variable
  warnings outside this slice).
- `npm run test:core` (845 passed); `npm run build:cli`; `npm run build`;
  `npm run build:tauri`.

The initial core-suite attempt was blocked by sandbox loopback `EPERM`, then
passed with loopback permission. The Tauri-target build likewise needed loopback
permission. These environmental failures are not regression evidence.

No product behavior changed, so no product regression red run or application
E2E suite was required. The initial Ajv value mismatch is engine characterization,
not a red/green product fix. Chromium frontend probes do not establish native
Tauri/WKWebView behavior; that remains untested. The candidate Node bundles are
not CLI schema-check integration. Production integration still needs native
webview execution, end-to-end worker deadline/cancellation/resource tests,
portable diagnostics, and the larger supported-profile conformance matrix.
