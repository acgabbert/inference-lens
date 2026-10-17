# JSON Schema preflight

`packages/core/src/json-schema/preflight.ts` prepares schemas for the core
structured-output evaluator used by vocabulary v4's `json-schema` checks.
A successful preflight means the schema is supported, not that an answer
satisfies it.

The owner accepts a JSON value and explicit resource limits, returning either an
execution graph or an owned diagnostic. The graph, indexed values, and accounting
statistics are temporary internal state, not persisted evidence. It does not
mutate the caller's schema. Each invocation owns its meter; neither a clock nor a
process-wide cache affects the result. The calibrated production limits and
charge table are frozen with vocabulary v4; see the
[calibration record](JSON_SCHEMA_CALIBRATION.md).

The supported surface is a restricted draft-07 profile:

- Boolean schemas; types; required/properties; homogeneous and tuple items;
  numeric, length, array and object bounds; enum/const; uniqueness; dependencies;
  property names; contains; composition; negation; and conditionals.
- Local JSON Pointer references, including URI-fragment percent decoding,
  `~0`/`~1` escapes, and pointers into `definitions` or `$defs`. All schema
  positions are checked, including unused definitions. References may target
  schema-shaped objects elsewhere in the document too.
- Consuming recursion through properties/items. An iterative graph traversal
  rejects cycles composed entirely of transitions on the same instance. Both
  indexing and graph traversal use explicit stacks.
- Draft-07 ignores siblings of `$ref`. This profile rejects assertions beside
  `$ref` instead of silently ignoring them. Use `allOf` to combine a reference
  with other assertions. Annotation keywords, the dialect declaration, and
  definitions remain allowed beside a reference.
- `title`, `description`, `examples`, `default`, `$comment`, `readOnly`, and
  `writeOnly` are annotations. Their contents are never interpreted as schemas
  unless explicitly targeted by a reference. `format` is also an annotation;
  preflight lists each occurrence and its authored-schema location for later
  editor/results display. Defaults are never applied to data.

Other dialects, remote references, `$id` rebasing, unknown keywords, `pattern`,
and `patternProperties` are rejected. The `unsupported-pattern` diagnostic
directs authors to Safe regex checks rather than substituting RE2 for JSON Schema's ECMA-262 rules.
Other unsupported keywords receive a generic `unsupported-keyword` message.
The annotation allowlist above is intentional: `contentMediaType` and
`contentEncoding` remain unsupported even though draft-07 treats them as
annotations. OpenAPI keywords such as `nullable` and `discriminator` are also
rejected. Pasted schemas must fit this profile before they can be committed as
runnable checks; unrecognized keywords are not silently ignored.

Saved execution plans run full schema preflight when parsed, rather than waiting
for evaluation to return `not-evaluated`. Changing preflight acceptance can
therefore make a previously readable plan fail to open. Acceptance rules, limits,
and accounting are part of the declared check vocabulary: changes require a
vocabulary bump and a compatibility path preserving existing saved plans.

Schema size is the compact JSON encoding of the entire schema, including
annotations and literals. The limit counts UTF-16 code units. Nesting counts the
root as depth one. Work and retained-storage units are deterministic accounting
units, not wall time or exact heap bytes. Input indexing and schema preparation
both consume those budgets. Diagnostics contain stable codes, fixed messages,
and authored-schema paths; native exception messages and schema literal values
are not copied into failures.

`tests/json-schema-preflight.test.ts` covers profile acceptance/rejection,
reference resolution, consuming and non-consuming recursion, nonmutation,
enum equality, annotation reporting, and exact resource boundaries. The core test
run also includes `tests/json-schema-profile.test.ts`, which sweeps
all 258 groups in the pinned upstream snapshot: selected schemas must prepare,
and excluded schemas must return the manifest's explicit rejection code. The
selection covers 804 answer cases, with 125 cases excluded; each group schema is
prepared once. The sweep also evaluates all 804 selected answer cases. This is
supported-profile coverage, not full draft-07 conformance or a measurement of
browser latency or native Tauri behavior.

## Implementation and fixture provenance

The production parser, schema preflight, metered evaluator, and example generator
are IF-owned implementations in `packages/core/src/json-input.ts` and
`packages/core/src/json-schema/`. The isolated engine comparison used Ajv and
`@cfworker/json-schema`; neither engine is a production dependency or copied
implementation. Their development probe notices remain in
[the spike notice inventory](../scripts/spikes/json-schema/notices/README.md).
n8n's Structured Output Parser without auto-fix was a behavioral reference for
the selected features, not an imported implementation or a compatibility claim.
IF does not repair, coerce, apply defaults, strip properties, or add item wrappers.

The upstream draft-07 test data is pinned at
`55719286c33ae0d1823bfb65fea10338a19bc37c`, with its MIT notice and explicit
selection/exclusion manifest retained in
[the snapshot directory](../scripts/spikes/metered-json-schema/official/README.md).
It is test data, not the evaluator. The 804 selected answer cases and 125
excluded cases describe this profile, not full draft-07 conformance.

The original provider-policy cases in
`tests/fixtures/structured-output/provider-cases.json` are separate from that
upstream snapshot. `tests/e2e/headless-cli-artifacts.spec.ts` runs each through
the buffered provider and CLI execution owner, checks the exact trace answer
and CLI check counts, then opens the written history in the browser and asserts
each rendered check verdict and its text. The schema-mismatch case also opens
the saved-history diagnostics and asserts the numeric type issue at `["answer"]`.
These cases cover parsing policies and a strict
object schema, including scalar/null inputs, fences, malformed JSON, missing
properties, extra properties, and no string-to-number coercion. They do not
repeat the full upstream sweep in a browser or establish native Tauri coverage.
