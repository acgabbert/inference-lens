# JSON Schema preflight

`packages/core/src/json-schema/preflight.ts` prepares schemas for the core
structured-output evaluator. It is an internal foundation: no schema check kind,
editor, portable check fields, or container versions are exposed yet. A successful
preflight means the schema is supported, not that an answer satisfies it.

The owner accepts a JSON value and explicit resource limits, returning either an
execution graph or an owned diagnostic. The graph, indexed values, and accounting
statistics are temporary internal state, not persisted evidence. It does not
mutate the caller's schema. Each invocation owns its meter; neither a clock nor a
process-wide cache affects the result. The limits and charge table still require
calibration before integration into a versioned check vocabulary.

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
prepared once. This does not yet validate model answers or establish upstream
evaluator conformance, browser latency, or native Tauri behavior.
