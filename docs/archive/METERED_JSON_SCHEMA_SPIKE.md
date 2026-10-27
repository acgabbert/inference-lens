# Deterministic JSON Schema evaluator feasibility

**Archive note (October 27, 2026):** Completed implementation or investigation
record. The dated decisions and verification below are historical; see the
[archive index](README.md) for scope, superseding contracts and follow-up work.

Date: 2026-10-16. Status: the synchronous metered approach is feasible over the
exercised draft-07 profile. This supersedes the worker-first recommendation in
[the engine comparison](JSON_SCHEMA_ENGINE_SPIKE.md). Production integration is
not implemented or authorized by this record alone.

The prototype is isolated under `scripts/spikes/metered-json-schema/`. It has no
runtime dependencies and does not import either external schema engine. It does
not change `evaluateCheck`, aggregation, portable checks, artifact versions,
routes, authoring, or results. The earlier engine candidates are confined to an optional, isolated comparison
package; neither is added to the application root dependency set.

## What was proved

The same synchronous implementation can validate the supported profile, bound
reference/composition work, avoid pairwise uniqueness comparisons, and return
identical budget outcomes and accounting in Node, Chromium, and WebKit. No clock,
worker, I/O, code generation, global cache, or provider/model call participates
in an outcome.

| Workload | Outcome | Work units | Storage units | Distinct schema/instance pairs |
| --- | --- | ---: | ---: | ---: |
| 28-level DAG, two refs to each next node | Valid | 7,558 | 6,755 | 86 |
| Same DAG ending in `false` | Invalid; one diagnostic | 8,883 | 8,056 | 86 |
| Non-consuming root reference | `non-consuming-cycle` | 30 | 41 | 0 |
| Consuming recursive object at depth 64 | Valid | 1,782 | 1,914 | 127 |
| `uniqueItems`, 12,000 distinct objects | Valid | 567,613 | 760,517 | 1 |
| Number-item array with a 500-unit work budget | `work-limit` | 500 | 1,408 | 6 |

The passing DAG has 28 memo hits; its failed variant also stays bounded while
producing diagnostics. Doubling the uniqueness workload to 24,000 objects stays
valid and uses less than 2.5 times the work. The prototype stores complete
canonical strings in a `Set`, so application-level hash collisions cannot
change equality. This is expected efficient set lookup, not a promise about
worst-case host hash-table implementation time. Object key sorting contributes
additional work; uniqueness is not advertised as strictly linear for every
possible item shape.

These are logical resource measurements, not millisecond promises. They prove
that the three failures in the external-engine spike do not require a timer to
decide their outcome.

## Prototype ownership and accounting

- `resources.mjs` owns the per-call meter, deterministic merge sort, bounded JSON
  indexing, and canonical equality encoding.
- `preflight.mjs` owns schema shape/profile checks, eager local-reference
  resolution, and cycle detection.
- `evaluator.mjs` owns pair memoization, assertions, and a separate bounded
  diagnostic traversal. Engine-specific objects never enter public contracts.

The experimental API consumes **already parsed JSON values** and returns
`valid`, `invalid`, or `not-evaluated`, plus accounting and bounded diagnostics.
Limits and result names are private spike contracts. Raw answer parsing,
Markdown policies, and production output-budget classification are not part of
this implementation. In particular, its generic `input-limit` code is not the
future persisted `output-too-large` outcome.

Every call starts from zero. `accountingVersion: "spike-1"` identifies this
experimental accounting model. Defaults are 4,000,000 work units, 4,000,000
storage units, and 20 issues. Schema/data limits are 65,536 / 1,000,000 compact
JSON UTF-16 units and nesting depth 64. These compact lengths are suitable for
this parsed-value experiment; production must enforce its budget on the actual
original text. The budget values are evidence-gathering defaults, not settled
product thresholds.

The follow-up [latency measurements](../JSON_SCHEMA_LATENCY.md) exercise candidate
budgets in Node, Chromium, Playwright WebKit, and the actual native Tauri host.
They do not support the four-million default as a synchronous UI budget;
500,000 units is a provisional starting point to remeasure with the production
evaluator before freezing accounting.

Work charges cover indexing, string lengths, key comparisons, graph/reference
traversal, pair evaluation, canonical encoding/equality, and diagnostics.
`Array.sort` comparison counts can differ across engines, so sorting uses an
explicit merge algorithm and charges an upper bound on each UTF-16 comparison.
Canonical strings sort object keys, preserve array order, and follow JSON value
rather than object identity equality. Decimal `multipleOf` uses bounded BigInt
arithmetic on finite JavaScript numbers' decimal representations, avoiding naive
floating-point division failures in the official fixtures.

The storage counter charges logical record slots and UTF-16 payloads
cumulatively, including conservative charges for temporary work; it never
reclaims budget during a call. It is **not a byte-accurate heap ceiling** or a
complete accounting of VM bookkeeping and native temporary allocations.
Native string operations, BigInt operations, and set lookup have bounded inputs
but are not decomposed into individual machine instructions. A production
resource-accounting audit and practical main-thread latency measurements remain
necessary before treating these defaults as sufficient UI protection.

A deterministic evaluation-stack allowance of 128 nested pair evaluations
prevents relying on a host-specific `RangeError` point. A 160-link acyclic ref
chain returns `evaluation-depth-limit`, while the depth-64 consuming recursion
fixture passes. This is a schema-side resource exhaustion, not removal of local
references from the profile. An explicit-stack evaluator would be preferable
before production to avoid this additional conservative allowance.

## References, recursion, and diagnostics

Preflight resolves every local pointer, including unused branches, escaped
pointer tokens, and `$defs` targets. It checks cycles in the graph of
**same-instance transitions**: references, composition, conditions, negation,
and schema dependencies. Object-property and array-element transitions consume
data and do not form edges in that cycle graph. Draft-07 `$ref` siblings are
ignored when building evaluation edges. All loaded schema nodes, including
unused definitions, are checked. Unsupported features and malformed schemas
return explicit preflight codes rather than passing as unconstrained checks.

Validity is memoized by schema node and instance occurrence, not by primitive
value or an object reference that might merge distinct locations. Pair reuse
bounds the repeated DAG evaluation. It does not by itself bound all scanning,
equality, or diagnostic work; those consume the same work budget.

Diagnostics use a separate traversal over memoized validity and are deduplicated
by schema node, instance occurrence, and safe display location. This prevents
repeated failing branches from expanding error trees and prevents a declared
property path from being reused for a map location. One fixture deliberately
validates the same value through a declared `answer` property and through
`additionalProperties`; its two issues retain the declared path and the
redacted path respectively.

Public issues contain a keyword plus typed location segments: authored property,
array index, or `{ redacted: true }`. They contain no parsed answer, raw parse
message, unexpected property name, or provider value. A 100-property map yields
three redacted issues with `truncated: true` under a three-issue limit. A
zero-issue limit still produces an invalid verdict and a truncation marker.
`format` stays annotation-only and is listed as unchecked. Schema loading and
validation accept frozen inputs without mutation.

## Conformance and cross-runtime evidence

The prototype passes all 42 original authored cases, plus all **807 selected
upstream tests** from JSON-Schema-Test-Suite revision
`55719286c33ae0d1823bfb65fea10338a19bc37c`. The unchanged fixtures, MIT notice,
and explicit exclusion manifest are [vendored with the spike](../../scripts/spikes/metered-json-schema/official/README.md).

These measurements used the original 807-test selection. The shared manifest
now selects 804 tests: core preflight rejects assertions beside `$ref`, so the
three upstream tests that require silently ignoring those assertions are
explicitly excluded. `npm run test:core` now sweeps every selected and excluded
schema against core preflight; the spike conformance runner uses the updated
selection. The measured results below retain their original counts.

The snapshot contains all 929 top-level draft-07 tests. The 122 excluded tests
require features the profile rejects: 39 use `patternProperties`, 12 use
`pattern`, 14 require non-pointer references, 12 use `$id`, and 45 combine `$id`
with non-pointer references. Optional suites are not included. Unknown keywords
are rejected by the application profile even though the general standard allows
them to be ignored. This is supported-profile coverage, not full-draft or
arbitrary-precision-number conformance. The prototype shares JavaScript's parsed
JSON number representation; original numeric lexemes are not retained.

The runtime matrix contains **865 cases**: those 807 tests, the 42 authored
cases, and 16 additional adversarial/boundary cases. It compares the **entire
result**, including issue order, codes, work/storage counts, memo statistics,
format annotations, and accounting version. It passes in:

- Node 24.3.0 source execution and a Vite production Node bundle;
- Chromium 145.0.7632.6, web and Tauri-target frontend bundles;
- Playwright WebKit 26.0, web and Tauri-target frontend bundles.

Each browser executes the full matrix twice in the same page under
`script-src 'self'` without `unsafe-eval`. Both runs match Node exactly. The
result-array SHA-256 is
`fb6802346014af2bc807c2a451cfd1711e1dffd30cafe92fb59ed057ae6f421d`.

Each explicit production library bundle is **15,662 bytes / 4,796 gzip**. It
contains the evaluator and runtime entry, without test data or external
validators. This is not a measured incremental application bundle cost. The
Tauri-target library probe is a frontend build, not execution inside the native
Tauri host; Playwright WebKit does not establish WKWebView integration.

The first browser attempt revealed that object-argument fixture transport lost
own `__proto__` keys and changed several test inputs. The harness now sends JSON
text and parses it in the page, preserving those keys. This transport failure is
not counted as evidence of an evaluator defect or fix.

## Commands and acceptance limits

```sh
npm run test:metered-json-schema
npm run test:metered-json-schema:runtimes
npm run typecheck
npm run lint
```

The first command passes 16 focused tests and the 807 upstream assertions. The
runtime command requires loopback access. For the recorded run,
`IF_METERED_WEBKIT_EXECUTABLE` selected the already installed `webkit-2123/pw_run.sh`
executable; a missing default WebKit executable is explicitly reported as
unavailable, not as passing. No browser installation is required by the script.
Typecheck passed; lint passed with three existing unused-variable warnings
outside this spike.

Before writing the owned evaluator, the one-unit-work-budget test was run
against a temporary baseline adapter delegating to cfworker. It failed on the
actual result: `valid` instead of `not-evaluated`. The same assertion passes with
the owned meter. This establishes the missing resource behavior; no existing
product regression or red/green product fix is claimed.

Application E2E, core regression suites, and production application builds were
not rerun for this isolated follow-up: no production consumer changed, and the
new evaluator was explicitly bundled and executed in its own runtime matrix.
No native Tauri/WKWebView execution, UI responsiveness check, or end-to-end
schema-check workflow was performed.

## Recommendation

Proceed with an IF-owned synchronous interpreter and deterministic, versioned
work/storage budgets. Keep optional worker scheduling separate from validation
semantics; a timer must not choose a check verdict.

Before production integration, review the supported keyword manifest, replace
or formalize the conservative stack allowance, audit resource charges and
host-native allocations, choose product budgets against realistic workloads,
and pin their interpretation for historical evidence. Wire schema-side
exhaustion, original-text output limits, and bounded diagnostics through the
existing pure evaluator only after those contracts are settled. Native Tauri
execution and affected application E2E remain integration acceptance gates.
