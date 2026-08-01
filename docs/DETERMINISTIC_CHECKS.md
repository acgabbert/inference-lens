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
- `max-total-tokens`, when the provider reported no total token usage;
- `max-duration-ms`, when the run recorded no total duration; and
- `regex`, when the definition does not compile (see below).

Missing usage stays missing. It is never substituted with zero.

## Vocabulary

Seven kinds ship in v1. Four make a statement about the shape of the answer and
accept `negate`, which asserts the opposite — "does not contain", "does not
match", "is not JSON". Three are thresholds; their bound direction is already
in the kind name, so they reject `negate` at parse time.

| Kind | Parameters | Passes when |
| --- | --- | --- |
| `exact-match` | `value`, text options | The answer equals `value` |
| `contains` | `value`, text options | The answer contains `value` |
| `regex` | `pattern`, `flags?` | The pattern matches somewhere in the answer |
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

### Regular expressions

Patterns are JavaScript regular expressions. Flags are restricted to a unique
subset of `i`, `m`, `s`, and `u`. The stateful flags `g` and `y` are refused:
they carry a `lastIndex` across calls, which would make repeated evaluation of
the same stored definition depend on call order.

The parser rejects a pattern that does not compile. The engine independently
returns `not-evaluated` for one that reaches it anyway, because a definition
constructed in code never passed through the parser and evaluation must not
throw.

Patterns are author-supplied and evaluated synchronously with no time limit.
A catastrophically backtracking pattern will block the caller. This is a known
limitation of the v1 engine.

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
`CHECK_SCHEMA_VERSION` records the vocabulary's version. Adding, removing, or
changing the meaning of a kind requires bumping it and the version of every
container that stores checks.

Parsers reject unknown fields, unknown kinds, unsafe identifiers, `negate` on a
threshold kind, unusable regular expressions, and repeated check identities
within one list.

## What is deliberately not here

- **Scoring.** `checkOutcomeSummary` counts outcomes; it does not decide
  whether a run passed. Whether a `not-evaluated` check blocks a pass, and how
  repetitions of one case aggregate, are suite-level rules that belong with
  evaluation execution.
- **Model-graded checks.** A grader is an ordinary run against a provider, not
  a pure function, and it needs its own rubric and cost contracts.
- **Arbitrary code checks.**
