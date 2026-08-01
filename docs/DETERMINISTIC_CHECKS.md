# Deterministic checks

A check is a provider-neutral assertion about one terminal run. The engine in
`packages/core/src/checks.ts` is pure: it reads a `RunState` and a check
definition and returns an outcome. It performs no I/O, reads no clock, and
never mutates the state it is given. The same run and the same definition
always produce the same outcome.

Outcomes are derived, never persisted into a `RunTrace`. A trace remains
immutable provider evidence; whether that evidence satisfies an assertion is a
separate, re-derivable projection.

## The canonical answer

`packages/core/src/run-output.ts` owns the single projection of what a run
answered: the accumulated assistant text of the **last completed attempt of the
last turn that produced one**.

- Reasoning is excluded. It is a separate provider channel, not the answer.
- Tool-call arguments are excluded. They are structured requests, not text.
- Attempts that failed and were retried are excluded. The completed attempt
  that replaced them is the one the model finished.
- `undefined` means no completed assistant attempt exists at all. `""` means
  the model completed and said nothing. These are different, and consumers
  must keep them different.

Every consumer that compares, counts, or asserts on a run's answer uses this
projection, so a repeated-experiment aggregate and a check can never disagree
about what the run said.

## When a check cannot be decided

`not-evaluated` is not a soft failure. It means the assertion could not be
decided at all, and it exists so provider instability is never reported as a
quality regression.

Everything about a run is undecidable unless the run reached `completed`:

| Run status | Every check |
| --- | --- |
| `failed` | `not-evaluated`, naming the run error's code |
| `cancelled` | `not-evaluated` |
| not terminal | `not-evaluated` |

A cancelled run may have streamed real text and consumed real wall time. None
of it is asserted on: reporting a run the user stopped as "within the duration
budget" would read as a pass it never earned.

Within a completed run, an individual check is `not-evaluated` when its own
evidence is missing:

- output-shaped checks, when the run produced no final assistant output;
- `max-total-tokens`, unless every provider attempt reported total token usage;
- `max-duration-ms`, when the run recorded no total duration; and
- `regex`, when the Safe regex definition is invalid or the output exceeds its
  explicit checkable-size limit (see below).

Missing usage stays missing. It is never substituted with zero.
An available subtotal is only a lower bound, so partial attempt coverage cannot
pass or fail a maximum-token check.

## Vocabulary

Seven kinds ship in v1. Four make a statement about the shape of the answer and
accept `negate`, which asserts the opposite — "does not contain", "does not
match", "is not JSON". Three are thresholds; their bound direction is already
in the kind name, so they reject `negate` at parse time.

| Kind | Parameters | Passes when |
| --- | --- | --- |
| `exact-match` | `value`, text options | The answer equals `value` |
| `contains` | `value`, text options | The answer contains `value` |
| `regex` | `syntax: "re2"`, `pattern`, `flags?` | The Safe regex pattern matches somewhere in the answer |
| `valid-json` | `topLevel?` | The whole answer parses as JSON of that shape |
| `max-output-characters` | `limit` | Character count ≤ `limit` |
| `max-duration-ms` | `limit` | Total run duration ≤ `limit` |
| `max-total-tokens` | `limit` | Reported total tokens ≤ `limit` |

Every maximum is inclusive at its exact edge.

Characters are Unicode code points, matching the count the repeated-experiment
aggregate reports, so an astral character counts once rather than twice.

`max-duration-ms` bounds the run's total wall time, which includes retried
attempts and any wait between turns. It is not a measure of model speed.

### Text comparison

`exact-match` and `contains` compare the canonical answer exactly as the
provider produced it. Two options loosen that, and both default to off, so a
stored suite always states what it actually compared:

- `caseSensitive: false` folds both sides with locale-independent
  lower-casing, so the same definition and answer always agree regardless of
  where the check runs.
- `trimWhitespace: true` trims leading and trailing whitespace from both sides.

Positions reported in evidence are indices into the compared text, which is the
raw answer unless one of these options transformed it.

### Safe regex

Regex checks use the application-owned **Safe regex v1** contract. Every stored
definition carries `syntax: "re2"`; this is a compatibility boundary, not the
name of the package currently implementing it. Matching has RE2-compatible
linear-time behavior and never falls back to JavaScript `RegExp`.

Safe regex supports literals, anchors, alternation, character classes,
capturing and non-capturing groups, and greedy or lazy repetition. It searches
anywhere in the answer unless the pattern supplies anchors. Flags are a unique
subset of:

- `i` — case-insensitive matching;
- `m` — `^` and `$` also match line boundaries; and
- `s` — `.` also matches newlines.

Unicode semantics are always enabled, so there is no `u` flag. Stateful or
engine-specific flags, including `g`, `y`, and `u`, are rejected.

Patterns may also use RE2 inline modifier groups. `(?i)`, `(?m)`, and `(?s)`
enable the corresponding behavior inside a pattern; modifiers can be combined,
disabled with `-`, or scoped to a group (for example, `(?i:answer)`). RE2's
`(?U)` modifier swaps greedy and non-greedy repetition behavior. These inline
modifiers are pattern syntax and are not restricted by the separate `flags`
field.

Lookahead, lookbehind, and backreferences are not supported. Common rewrites
are:

- Replace `^(?=.*error)(?=.*retry)` with two Safe regex checks, `error` and
  `retry`.
- Replace `^(?!.*error)` with a Safe regex check for `error` whose `negate`
  option is `true`.
- Replace `(?<=Status: )ok` with `Status: ok` when the surrounding text is
  literal.
- A repeated-capture assertion such as `^(.+) \\1$` cannot generally be
  rewritten as one Safe regex check; restructure the case or use a separate
  deterministic assertion.

The parser and authoring validator report these unsupported constructs
specifically. An invalid definition that bypasses parsing returns
`not-evaluated`; it is never handed to another regex engine.

Patterns are limited to 4,096 UTF-16 code units. Checkable outputs are limited
to 1,000,000 UTF-16 code units. A larger output returns `not-evaluated` rather
than being truncated, because truncation could silently change whether the
pattern matches.

### JSON

`valid-json` requires the **whole** answer to parse under `JSON.parse`.
Markdown code fences are not stripped, and no substring is extracted; a fenced
JSON block therefore fails. Unwrapping is a product decision that has not been
made, and guessing at it would silently pass answers that a strict consumer
would reject.

`topLevel` narrows the accepted shape to `object` or `array`, and defaults to
`any`, which accepts any JSON value including scalars and `null`.

JSON Schema is deliberately absent. It waits on choosing a real implementation
and a supported draft rather than shipping an undocumented home-grown subset.

## Evidence

A `passed` or `failed` outcome may carry `evidence`, and a `failed` outcome
always carries a `message`. Both contain **measurements only**: counts,
positions, observed values, and booleans.

Neither ever copies model output. This follows the roadmap invariant that
derived artifacts reference traces rather than duplicating provider evidence —
a check outcome may end up in an evaluation artifact, and that artifact must
not become a second copy of the answer. A consumer that needs the text opens
the referenced run.

The message from a failed `JSON.parse` is dropped for the same reason: engines
quote the offending input inside it.

## Versioning

Check definitions carry no `schemaVersion` of their own. They are always
embedded in a versioned container — the project document, or an evaluation
execution artifact — and that container's version is what a parser negotiates.
`CHECK_SCHEMA_VERSION` records the vocabulary's version. Safe regex is version
2 of that vocabulary. Adding, removing, or changing the meaning of a kind
requires bumping it and the version of every container that stores checks.

Parsers reject unknown fields, unknown kinds, unsafe identifiers, `negate` on a
threshold kind, unusable Safe regex definitions, and repeated check identities
within one list.

## What is deliberately not here

- **Scoring.** `checkOutcomeSummary` counts outcomes; it does not decide
  whether a run passed. Whether a `not-evaluated` check blocks a pass, and how
  repetitions of one case aggregate, are suite-level rules that belong with
  evaluation execution.
- **Model-graded checks.** A grader is an ordinary run against a provider, not
  a pure function, and it needs its own rubric and cost contracts.
- **Arbitrary code checks.**
