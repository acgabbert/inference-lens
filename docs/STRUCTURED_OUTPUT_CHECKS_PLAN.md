# Structured output checks implementation plan

Status: portable vocabulary v4, example generation, suite authoring, reassessment editor reuse, and expandable result diagnostics implemented. Step 5 scheduling and broader integration checks remain.
Date: 2026-10-16.

## Implementation progress

- Core JSON input owner implemented with strict, surrounding-fence, and
  first-json-fence policies, actual successful extraction paths, and fixed
  syntax diagnostics that exclude answer text and native parser messages.
- Regression tests ran red on rejected valid fenced JSON before fence support,
  then green alongside the existing strict-check tests. Existing `valid-json`
  delegates to the parser in strict mode and preserves its evidence contract.
- Added internal, metered draft-07 schema preflight with explicit-stack JSON
  indexing and cycle detection, local pointer resolution, supported-keyword
  validation, authored-schema diagnostics, and unchecked-format locations.
- The assertion-beside-`$ref` regression ran red against the spike's actual
  `valid` result, then green against core preflight. Fifteen core tests cover
  preflight behavior; this is not answer-validation conformance coverage.
- Added the pinned upstream schema sweep to the core run: 258 groups cover
  804 selected answer cases and 125 excluded cases, with explicit rejection
  codes in the exclusion manifest. Pattern rejection now has its own code.
- Fence scanning accepts whitespace before the JSON marker and skips invalid
  backtick-containing info strings; an unclosed other-language block deliberately
  hides subsequent JSON-looking fences.
- Fence policies and schema preflight remain internal until vocabulary/container
  v4 integration. No UI or persisted check fields have been introduced. The
  explicit-stack answer evaluator and separate verdict/diagnostic budgets are now
  implemented as an internal parsed-value API; latency calibration, original-text
  output limits, portable formats, generation, and browser integration remain.
- Added the production parsed-value evaluator with explicit generator/task frames,
  per-invocation memoization, separate preflight/verdict/diagnostic meters, typed
  safe locations, authored type/required expectations, and bounded diagnostics.
  Diagnostic work/storage exhaustion and issue count cannot change verdicts.
- The recursion regression ran red against the spike's `evaluation-depth-limit`,
  then green at data depth 64 with allOf-wrapped local references. The initial
  diagnostic red used a work limit too low to isolate diagnostic cost; the
  corrected probe at 3,000 units demonstrated `invalid` with maxIssues 0 versus
  `not-evaluated` with maxIssues 20. Core tests use exact verdict accounting and
  independent diagnostic limits rather than preserving prototype charge values.
- The pinned upstream sweep now also evaluates all 804 selected answer cases.
  This is supported-profile validation coverage, not full draft-07 conformance.
  The evaluator is not exported through the public core entry point or wired to
  checks/UI; its accounting inputs remain explicit and unfrozen.
- Validation for this slice: the three schema test files passed (286 tests,
  including the upstream group subtests); `npm run typecheck`, `npm run lint`
  (three existing warnings), `npm run test:core` (1,142 tests), and
  `npm run build:cli` passed. Core tests required loopback permission for local
  fixtures. No browser run: this module is internal with no UI/provider wiring.
  Native Tauri evaluator execution and production latency calibration remain
  unchecked, as do CLI schema evaluation and portable schema-check integration.

## Lazy answer indexing follow-up

- Wrote cost regressions before implementation; both failed on actual work counts
  (295,897 units for 56,001 characters; 151,440 extra units for 15 wrappers).
- Answer indexing now has a separate owner with no full paths or encodings.
  Equality encodings are emitted with an explicit stack only when requested,
  cached per invocation, and metered without caching every descendant.
- The record fixture now costs 117,894 work units; the depth-64 10k payload costs
  10,508 rather than 669,662. Schema-side preparation remains unchanged.
- Added a production latency entry to the existing isolated runtime launcher.
  Node, Chromium, Playwright WebKit, and native Tauri agree on all 60 measured
  fixture/budget outcomes and accounting. See [the core measurement record](JSON_SCHEMA_CORE_LATENCY.md).
  These observations improve the baseline; charge calibration and final limits
  remain unsettled, including schema-side costs for deep literal values.
- Scoped schema tests passed (295 tests, including upstream groups); the full
  `npm run test:core` passed 1,151 tests. `npm run typecheck`, `npm run lint`
  (the same three existing warnings), `npm run build:cli`, and the original spike
  latency tests passed. The core latency probe ran with `--native` and the
  installed WebKit override. No UI/provider changes required application E2E.

## Diagnostic traversal follow-up

- Regressions ran red before the fix: a 100-unit diagnostic budget returned zero
  issues for 200 failing items; a fault-injected missing memo verdict threw the
  actual plain Error. The missing-verdict test is fault injection, not a claim
  that a normal schema can trigger this invariant failure.
- Diagnostics now suspend parents and immediately descend into failing children
  with explicit frames. Issues follow deterministic forward traversal order.
  Small work/storage budgets report the first array location before siblings
  consume the budget; genuinely insufficient budgets can still report no issues.
- A missing diagnostic memo value stops explanation with `truncated: true`,
  preserving the invalid verdict and collected issues. Unrelated exceptions
  remain visible. Tests also cover deep consuming references and retained issues.
- Scoped schema tests passed 299 tests, and `npm run test:core` passed 1,155 tests.
  `npm run typecheck`, `npm run lint` (three existing warnings), and
  `npm run build:cli` passed. No UI/provider consumer changed, so application E2E
  was not run. Cross-runtime latency was not repeated for this diagnostic change;
  the saved lazy-encoding report is labeled as the earlier baseline.

## Example generation and suite authoring follow-up

- Added the core authoring action `generateJsonSchema`, owned by
  `json-schema/generate.ts`. It parses strict JSON locally, infers all JSON root
  types, requires observed fields, inspects every array item, deduplicates item
  schemas, and offers recursive extra-property rejection. Empty-array warnings
  are bounded and never enter saved checks.
- Examples use the schema size/depth and structural budgets; generated schemas
  must pass the production preflight. Generation is bounded and uses explicit
  traversal. Prototype-shaped authored keys remain ordinary own properties.
- Added `StructuredCheckEditor` as the suite's feature owner for schema and
  example drafts, generation preview, extras choice, input policy, validation,
  and explicit save/cancel. Invalid drafts stay editable and do not mutate
  portable data. Only the committed definition is saved through existing suite
  authoring. JSON Schema is now offered in the check picker; Valid JSON exposes
  all three input policies. Unchecked formats are listed for loaded/saved schemas.
- Tests were written before implementation. The core red established the absent
  generation API (`undefined` versus `function`); inference assertions could not
  execute until the API existed, so this was not a red demonstration of incorrect
  inference. The browser red reached an imported schema check and found zero
  schema draft controls versus the required one. Later label and dirty-project
  replacement failures were test mechanics, not further behavioral red evidence.
- `tests/json-schema-generation.test.ts` covers root types, nested required fields,
  extras, array inference, resource rejection, prototype-shaped properties, and
  exact evaluator agreement with an equivalent hand-authored schema, without
  mutation. `tests/e2e/structured-output-checks.spec.ts` covers draft validation,
  generation/editing, save/cancel, export/reopen, adding schemas, unchecked formats,
  policy editing, and narrow-screen usability. This slice does not test new
  provider responses or results rendering.
- Validation: `npm run test:core` passed all 1,179 tests;
  `npm run typecheck`, `npm run lint` (the same three existing warnings), and
  `npm run build:cli` passed. `npm run build:tauri` passed after granting the
  build's loopback access; this is frontend bundling, not native execution.
  The scoped `npm run test:e2e -- tests/e2e/structured-output-checks.spec.ts`
  passed the generation/save/cancel/export/reopen case. The full-suite run
  exercised both new cases and the expanded suite-authoring spec; both new
  cases passed, but that run ended at 266 passed, 7 skipped, and one Vite-overlay
  failure in the unrelated folder-reopen workflow. A production build was
  concurrent with that run. The clean rerun had 264 passed, 7 skipped, and
  three dark-theme execution-settings tests blocked by the same Vite overlay.
  Both new structured-output cases and the expanded authoring spec passed again.
  This request-body overlay failure is also recorded in
  [the earlier composition-root verification](PAGE_COMPOSITION_ROOT_EXECUTION_PLAN.md).
  `npm run test:e2e -- tests/e2e/evaluation-suite-execution-settings.spec.ts`
  then passed all 16 tests in isolation, including the three blocked cases.
  After a small editor cleanup (shared unchecked-format listing with leading `/`
  paths), a later full run with no concurrent build passed: 267 passed,
  7 skipped, none failed. The earlier overlay failures did not recur.
  Native Tauri editor interaction remains unverified; review the editor there.
- Step 4 is not entirely complete: reuse the editor in saved-output reassessment
  next. Step 5 still owns rendered result diagnostics, strict-versus-fenced
  provider fixtures, CLI/browser outcome agreement, and the final profile docs.

## Reassessment editor reuse follow-up

- Reused `StructuredCheckEditor` in the saved-output reassessment drawer for
  JSON Schema and Valid JSON. The editor owns ephemeral schema/example/policy
  drafts; the reassessment handle accepts validated definitions into its existing
  criteria map for preview, immutable save, and separate authored-suite adoption.
  No new persisted fields or version changes were needed. Other check kinds
  continue to be listed as carried through unchanged.
- The browser regression was written first and ran red on the missing schema
  controls (zero versus one) in the open reassessment drawer. Subsequent failures
  exposed test setup mistakes selecting the provider model, not further product
  regressions. The fixture now selects the suite execution target explicitly.
- The buffered fixture's `structured-output-model` returns fenced `{"answer":2}`.
  `tests/e2e/evaluation-reassessment.spec.ts` covers invalid drafts, generation,
  explicit per-check commits, strict-to-fenced outcome changes, saved assessment
  reopening, unchanged As run, separate suite adoption, carried checks, discarded
  drafts on close, and no additional provider requests. All three cases passed.
- `npm run test:core` passed 1,179 tests; `npm run typecheck` passed;
  `npm run lint` passed with the same three existing warnings.
  `npm run test:e2e` passed: 268 passed, 7 skipped, none failed.
  This included the existing structured-output authoring scenarios.
- Remaining: step 5 result diagnostics, whole-view scheduling, broader provider
  policy fixtures, CLI/browser agreement, and final supported-profile docs.
  Native Tauri reassessment interaction remains unchecked.

## Results diagnostics follow-up

- Added `StructuredCheckDiagnostics` as a presentation owner composed by the
  results workspace. It consumes the existing check definition and sanitized
  outcome evidence for As run, current-criteria previews, and saved reassessments.
  It performs no schema evaluation, provider call, or persistence mutation.
- Disclosures show policy, successful extraction, original output size and JSON
  type, diagnostic code, bounded issues with authored expectations, truncation,
  and unchecked formats. Typed location segments stay visibly distinct from
  JSON pointers; additional property names remain redacted. The existing link
  to the original response and trace remains the evidence navigation.
- The browser regression was written first. Its initial run timed out on the
  absent disclosure control; a second run explicitly asserted one disclosure
  and failed with actual zero before implementation. The subsequent format
  location failure was an incorrect test expectation: the schema location ends
  in `/format`, which the renderer correctly preserved.
- `tests/e2e/evaluation-reassessment.spec.ts` now checks strict syntax failure,
  fenced successful saved reassessment, multiple mismatch issues, missing-property
  and type expectations, redacted extra keys, unchecked formats, the 20-issue cap,
  truncation, no copied answer, and narrow-screen layout. The existing buffered
  provider supplies fenced `{"answer":2}` through the real execution path.
- Validation: `npm run test:e2e -- tests/e2e/evaluation-reassessment.spec.ts
  tests/e2e/structured-output-checks.spec.ts` passed all eight affected cases.
  The final `npm run test:e2e` passed 271 tests with 7 skipped and none failed,
  including the added strict-policy diagnostic assertions. `npm run test:core`
  passed 1,180 tests. `npm run typecheck`, `npm run lint` (the same three existing
  warnings), `npm run build:cli`, and `npm run build:tauri` passed. The latter is
  frontend bundling, not native execution. `node --test --test-timeout=120000
  tests/evaluation-results-render.test.mjs tests/evaluation-results-interaction.test.mjs`
  passed all 10 existing render/interaction tests. No CLI schema execution or
  cross-runtime evaluator calibration was repeated for this presentation change.
- Remaining step 5 work: yielding between checks in results and reassessment
  derivations, broader provider policy fixtures, CLI/browser outcome agreement,
  and final supported-profile/provenance/artifact-format documentation.
  Native Tauri interaction with the disclosures remains unchecked.

## Outcome and scope

Add four capabilities to evaluation experiments: JSON Schema validation,
explicit Markdown fence handling, editable schema generation from a JSON example,
and useful parser/validation diagnostics. Use n8n's Structured Output Parser
without auto-fix as a behavioral reference, implemented independently for IF.

The result should measure both strict model compliance and downstream usability.
One answer can fail a strict JSON check but pass a second check that permits a
fence and validates the enclosed data. Every check states its own acceptance
policy. Neither check changes the answer or any other check's input.

Excluded: model repair, item-list parsing, final-response tools, provider JSON
mode, prompt injection of schemas/instructions, automatic n8n wrappers, defaults,
type coercion, unknown-property removal, and JSON-aware diversity metrics.
This is capability parity for the four selected features, not a claim of complete
n8n parser or agent compatibility.

## Existing code boundaries

- `packages/core/src/run-output.ts` owns the canonical final assistant text.
  Preserve it, including the distinction between missing output and empty text.
- `packages/core/src/checks.ts` owns portable check definitions, strict Zod
  parsers, pure evaluation, and the check vocabulary version (currently 3).
  Today `valid-json` directly parses the whole answer and optionally checks its
  top-level shape. Its evidence never copies provider output.
- `packages/core/src/evaluation-suite-authoring.ts` owns check creation and
  authored mutations. Its new-check input currently special-cases only regex;
  schema checks need an explicit creation contract rather than an accidental
  default that passes everything.
- `project.ts`, `experiment.ts`, and `evaluation-assessment.ts` own containers
  carrying checks. Current versions are project 11, experiment plan 4, and
  assessment 1. Plans and assessments pin `checkSchemaVersion` to a literal.
- Evaluation outcomes are derived from checks and traces when opened; saved
  assessments store criteria, not outcomes. Compatibility therefore affects
  historical interpretation as well as file parsing.
- `app/evaluations/evaluation-suite-editor.client.tsx` and its authoring hook own
  suite edits; reassessment and results have separate feature owners. Routes
  remain composition roots.
- `experiment.ts` counts distinct final answers by exact string; `run-diff.ts`
  normalizes requests/tool arguments for display. Neither behavior changes.

## Proposed public contracts

These are recommendations for review before runtime implementation. Names are
illustrative; the semantics and persistence boundaries are the decisions.

```ts
type JsonInputPolicy =
  | 'strict'
  | 'surrounding-fence'
  | 'first-json-fence';

// Extend existing ValidJsonCheck; omitted inputPolicy remains strict.
interface ValidJsonOptions {
  inputPolicy?: JsonInputPolicy;
  topLevel?: 'any' | 'object' | 'array';
}

// New check kind on the non-negatable definition base (check ID and label only).
interface JsonSchemaOptions {
  kind: 'json-schema';
  inputPolicy?: JsonInputPolicy;
  dialect: 'draft-07';
  schema: JsonObject | boolean;
}
```

The schema belongs to the check and is snapshotted with it into execution plans
and saved criteria. It describes the payload directly: no implicit `output`
envelope. No separate persisted parser registry or mutable schema reference.
Do not add `topLevel` to schema checks; the schema already specifies shape.

Syntax failure, schema mismatch, and an answer over the output budget are
`failed`. A completed run produced that answer; an oversized answer is almost
always runaway generation, the regression a structured-output check exists to
catch, so it reports a distinct `output-too-large` code rather than hiding as
an incomplete case. An unsupported/invalid schema, or a budget IF imposes on its
own schema-side work, is `not-evaluated`. Diagnostic work never changes a decided
verdict. Existing incomplete/failed run rules still apply.

Schema checks are not negatable. "The answer does not satisfy this schema" is
rarely the intended assertion, and the parse-and-schema predicate would make
invalid JSON satisfy it. Adding negation later is additive; removing it would
not be. `valid-json` keeps its existing negation.

### JSON input policies

Always attempt whole-answer JSON first. Ordinary JSON whitespace needs no repair.
For the optional fence paths, scan lines; do not remove backticks globally or use
a greedy expression that damages backticks inside string values.

| Policy | Acceptance after whole-answer parsing fails |
| --- | --- |
| `strict` | No fallback. Existing behavior. |
| `surrounding-fence` | Exactly one recognized complete fence occupies the answer, apart from outside whitespace. |
| `first-json-fence` | Parse the first complete recognized fence even when prose or other blocks surround it. Fences with another language marker are skipped, not recognized. If the first recognized fence holds invalid JSON the check fails; never search later blocks for one that passes. |

Recognized fences follow the report: after trimming each delimiter line, the
opening is exactly three backticks, optionally followed by `json` matched
case-insensitively after trimming surrounding info-string whitespace, and the
closing is exactly three backticks. Backtick-containing info strings do not open
a fence. An unclosed other-language fence hides later fence-like lines through
the end of the answer. Accept LF and
CRLF. Tildes, four-backtick delimiters, other language markers, and incomplete
blocks are not recognized fences: `surrounding-fence` fails on them, and
`first-json-fence` passes over them. Preserve
the enclosed text; malformed JSON still fails. No extraction of unfenced JSON
from prose, wrapper flattening, trailing-comma repair, or single-quote repair.

`first-json-fence` provides the reported n8n prose-plus-fence functionality.
The narrower surrounding-fence mode is recommended for normal IF use. UI labels
must explain that first-fence selection can ignore other answer content.
Record which path actually parsed successfully, not just the selected policy.

### JSON Schema engine and supported surface

Validate with an IF-owned, synchronous, metered interpreter over one explicit
draft, initially draft-07. [The engine comparison](JSON_SCHEMA_ENGINE_SPIKE.md)
showed that neither Ajv nor `@cfworker/json-schema` can be bounded by size and
depth limits alone: quadratic `uniqueItems`, non-consuming reference cycles, and
exponential reference/composition branching all ran away within the proposed
limits. Worker isolation would bound wall-clock time, but a timer would then
choose verdicts that differ by machine and load, and every outcome consumer
would become asynchronous. [The metered spike](METERED_JSON_SCHEMA_SPIKE.md)
showed that a dependency-free interpreter with deterministic work and storage
budgets decides all three cases without a clock, passes the 807 selected
JSON-Schema-Test-Suite draft-07 tests, and returns identical results in Node,
Chromium, and WebKit under a CSP without `unsafe-eval`.

The evaluator keeps the existing purity contract of `evaluateCheck`: no clock,
worker, I/O, code generation, or process-wide cache participates in an outcome.
A worker may later schedule evaluation off the main thread for responsiveness,
but must never decide a verdict.

- No type coercion, default insertion, or removal of additional properties.
  Extra properties remain allowed unless the authored schema disallows them.
- Support ordinary type/required/properties/items/enum/const, numeric and length
  bounds, object/array constraints, and composition. Validate boolean schemas too.
- Reject unsupported assertion keywords explicitly. Accept annotation keywords —
  `title`, `description`, `examples`, `default`, `$comment`, `readOnly`,
  `writeOnly` — without effect; `default` is never applied to the answer.
- `$schema` is optional. When present it must name draft-07; any other dialect
  (for example 2020-12) is rejected with a diagnostic, not reinterpreted.
- Local references are required in the initial profile: `$ref` to a JSON pointer
  within the same document, including `#/definitions/...` and `#/$defs/...`
  (draft-07 does not define `$defs`, but a pointer into it still resolves).
  Every reference must resolve when the schema is loaded, including references
  in unused definitions. No remote references, `$id` re-basing, asynchronous
  schemas, plugins, or application-defined executable keywords.
- Recursive references are allowed only when every cycle consumes data. Preflight
  builds the graph of same-instance transitions (references, composition,
  conditions, negation, schema dependencies) and rejects any cycle in it with a
  `non-consuming-cycle` diagnostic. Property and item transitions consume data
  and do not form edges in that graph.
- Draft-07 ignores keywords beside `$ref`. Preflight rejects assertion keywords
  beside `$ref` rather than silently dropping them; annotation keywords and
  `definitions`/`$defs` remain allowed there.
- `format` is accepted as an annotation and not asserted, which is draft-07's
  default treatment. It never fails silently: the editor and results list each
  unchecked format (for example "format not checked: date-time"). Asserting a
  few bounded formats can be added later as an explicit opt-in.
- Reject `pattern` and `patternProperties` initially, with a diagnostic that
  points to Safe regex checks. IF Safe regex uses RE2 semantics, whereas JSON
  Schema expects ECMA-262; do not silently substitute RE2 or reintroduce
  unbounded main-thread regex.

This is an explicitly documented draft-07 profile, not full-draft conformance.
Unsupported assertion keywords are rejected; annotation keywords are accepted
and listed. No assertion may degrade into an unconstrained successful check.
Do not recreate n8n's JSON Schema-to-Zod converter or its reported `$ref` fallback.
Vendor the upstream test-suite snapshot with its notice and exclusion manifest,
as the spike does, and keep it in the core test run.

#### Evaluation requirements

The spike prototype is evidence, not the production module. Production
integration must also meet these requirements, each with a test written red
first against the spike behavior:

1. **Diagnostics never change a verdict.** Decide validity first with the
   verdict budget. Diagnostics then run under their own budget, and exhausting
   it returns the decided `invalid` verdict with `truncated: true`. The spike
   shares one budget: an `items: number` schema over 200 strings is decided
   invalid within about 1,900 work units but returns `not-evaluated` for every
   work limit from 2,000 to 3,464, and the display setting `maxIssues` changes
   the outcome.
2. **Assertions beside `$ref` are rejected** (see above). The spike validates
   `"text"` against `{ "$ref": "#/definitions/a", "type": "number" }` as valid.
3. **Explicit evaluation stack.** Replace the spike's 128-frame recursion
   allowance with an explicit-stack evaluator whose depth bound is deterministic
   and independent of the host's native stack. Realistic recursive schemas
   within the agreed data depth must pass: the spike returns
   `evaluation-depth-limit` at data depth 50 when each level wraps its `$ref`
   in `allOf`.
4. **Accounting is frozen with the vocabulary.** Outcomes are re-derived when
   evidence is opened, so a changed charge table or budget could turn a
   historical `valid` into `not-evaluated`. The charge table and budgets are
   part of check vocabulary version 4; changing either is a vocabulary bump
   handled by the version gate under Versioning. Results do not carry a separate
   accounting version.
5. **Budgets come from measured latency, after calibration.** Done in
   [the calibration record](JSON_SCHEMA_CALIBRATION.md): charges were rebalanced
   to about a 2× spread (worst 28 ns per unit on Node), and the calibrated limits
   are a 150,000-code-unit output limit with a 750,000-unit verdict budget. The
   cross-runtime probe on the production evaluator, including native Tauri, puts
   the slowest workload's median at 21–28 ms there. The bullets below record the
   reasoning that calibration followed.
   [The latency record](JSON_SCHEMA_LATENCY.md) measured the spike in Node,
   Chromium, Playwright WebKit, and native Tauri/WKWebView. It supports
   **500,000 work units as a provisional budget**, not the spike's 4,000,000,
   and nothing is frozen from those prototype numbers. Before freezing:
   - **Calibrate charges to time.** A work budget protects latency only at the
     most expensive per-unit rate. The recorded medians range from about 1.2 µs
     per 1,000 units (long strings) through about 8 µs (realistic records,
     schema preflight) to about 60–70 µs (numeric traversal), a spread of
     roughly 50×. Strings and key sorting are overcharged relative to their
     cost, while numeric traversal and diagnostics are undercharged. Rebalance
     the charge table in the ported evaluator so the per-unit cost across the
     latency fixtures falls within a few times of each other, then choose the
     budget from the worst remaining rate.
   - **Choose the output limit and work budget together.** Any answer within
     the output limit must at least parse and index within the work budget,
     with realistic validation headroom left. Otherwise answers between those
     two bounds come back `not-evaluated` instead of judged or
     `output-too-large`. In the spike, a 480,002-code-unit string exhausts a
     500,000-unit budget (it needs 1,440,096), and realistic records cost about
     3 units per character, so 500,000 units reach only about 150,000
     characters against a 1,000,000-character output limit.
   - **Set the ceiling for the whole view, not one check.** Keep a per-check
     main-thread ceiling of roughly 50–100 ms on the slowest supported target,
     with headroom for hardware slower than the recorded Apple M4 Pro. Opening
     results also re-derives every check across every repetition. Realistic
     checks cost 1–2 ms each, but runaway outputs that push each repetition's
     check to its budget could add up to seconds. Result derivation yields
     between checks (see Internal owners and UI integration).
   - **Measure again after the port.** The explicit stack, separate diagnostic
     budget, and recalibrated charges all change cost. Repeat the latency probe
     on the production evaluator, including native Tauri, and freeze budgets
     only from that run.

   If no budget both fits the ceiling and covers realistic schemas, revisit
   off-main-thread scheduling, still without a timer deciding the verdict.
6. **Output limits apply to original text.** The spike measures compact
   re-serialized JSON. Production enforces the output budget on the original
   answer text before parsing (`output-too-large`, `failed`) and the structural
   budgets on the parsed value. Numbers keep JavaScript's parsed representation;
   original numeric lexemes are not retained, and the profile documents that.

Calibrated limits (`packages/core/src/json-schema/limits.ts`) are 150,000 UTF-16
code units of original answer text, 750,000 verdict work units, 64 Ki code units
and 600,000 preflight units of schema, data and schema depth 64, and 100,000
diagnostic units with 20 displayed issues. `tests/json-schema-limits.test.ts`
holds the pairing: the densest answers index within three quarters of the budget,
realistic records at the output limit validate within half, and every schema
within the size limit preflights. Per-item schemas over tens of thousands of
small values can still exhaust the budget. The storage budget has not been
calibrated as a heap limit. Exceeding the output budget
fails the check; exhausting a schema-side work, storage, or depth budget is
`not-evaluated`. Apply new limits to new schema checks; preserve historical
strict-JSON semantics. Native Tauri/WKWebView execution remains an integration
acceptance gate; Playwright WebKit does not establish it.

### Generate schema from an example

Generate locally through original deterministic code. This is an editor action,
not a runtime mode or an LLM call. Users inspect/edit the resulting schema before
committing it. Persist the resulting schema, not the example or a second source
of truth; changing examples later does not silently change saved checks.

- Accept any JSON root. Map strings, booleans, null, integers, and non-integer
  numbers to their types. Values do not imply `enum`, `const`, formats, or bounds.
- Recursively mark every observed object property required, including objects
  within arrays, matching the useful n8n 1.3 behavior described by the report.
- Default generated objects to permitting additional properties, consistent with
  JSON Schema defaults. Offer an explicit editor choice to disallow extras at
  every generated object level. Explain that IF preserves extras when permitted.
- Inspect all array examples. Homogeneous arrays share an item schema;
  heterogeneous arrays use deduplicated `anyOf` branches. Empty arrays use an
  unconstrained item schema and show a warning that item types cannot be inferred.
- Show that observed fields are required; optionality requires editing the schema.
  Never claim that one example establishes all valid domain shapes.
- Enforce the same schema/example size and nesting budgets before generation.
  Generated schema must pass the same preflight as hand-authored schema.

### Diagnostics without duplicating model output

Use stable IF-owned codes and templates for syntax failure, top-level mismatch,
schema violation, invalid schema, unsupported feature, and resource limit.
Internal parse results may hold parsed data temporarily; public outcomes do not.

Evidence may include selected policy, actual extraction path, character count,
observed top-level type, violated keyword, safe location, issue count, and an
explicit truncation indicator. Report deterministic bounded issues. Do not persist
validator error objects or engine parse messages: messages/params can contain values,
dynamic property names, or snippets of provider output.

Paths require sanitization too. Preserve numeric array positions and property
segments established by the authored schema; redact data-derived property names
under maps/additional properties. Avoid serializing a literal RFC 6901 pointer
containing redacted segments as if it identified a real key; use typed location
segments or a clearly labeled display location. A safe message could read
`Schema mismatch at /answer: expected number` for a declared `answer` property.
Extra-field violations report a count/redacted location, not the unexpected key.
Issues carry what the authored schema expected, not only the violated keyword:
the expected type for `type`, and the missing property name for `required`
(authored names are safe). The spike's issues hold only keyword and location.

Results show a concise failure reason with expandable diagnostics and the existing
link to the original run. Do not introduce parsed-answer copies into artifacts.

## Internal owners and UI integration

Add cohesive core modules for JSON input parsing, schema validation/preflight,
schema generation, and diagnostic sanitization. `checks.ts` orchestrates these
owners; it does not accumulate their scanner, converter, or renderer logic.
Keep evaluator internals (meter, memo, index) out of public contracts. Core
contracts stay provider-neutral and usable from browser, CLI, run-based
evaluation, and reassessment with identical results.

Each check stays synchronous and pure in core. When the app derives outcomes for
a results or reassessment view, the feature that owns that derivation processes
checks in chunks and yields to the UI between them, so no view freezes for the
sum of its checks. Yielding changes only when a verdict is computed, never what
it is: each verdict depends on its own definition, trace, and budget. The CLI
may derive straight through. If measured whole-view latency still needs it,
derived outcomes may also be cached by trace, check definition, and vocabulary
version.

Add a structured-check editor feature under `app/evaluations/`, composed by the
suite editor and reused where reassessment edits criteria. It owns schema draft
text, example draft, generation preview, validation errors, and commit/cancel.
Its contract consumes a check and commits a validated portable definition through
the existing authoring workflow. Draft text never mutates portable project data
on each keystroke. No new feature state in route/page components.

Update exhaustive check labels/pickers, authoring error fields, preflight, results
rendering, comparison/alignment, assessment editing, CLI output, and import/export.
Review each consumer of `CheckKind`; do not rely on TypeScript exhaustiveness alone
to establish usable controls or diagnostics. Run aggregation/scoring remains strict.

## Versioning and historical evidence

Expand the vocabulary to version 4. The project has no vocabulary field, so it
moves to v12, and v10–v11 documents are gated to vocabulary 3. Evaluation plans
and reassessments already record `checkSchemaVersion`, so they widen it to 3 or 4
rather than bumping their own container versions; new ones always record 4.
Result files contain execution references rather than checks and do not change.
RunTrace format does not change.

Retain readers for current artifacts rather than making existing experiment
history unreadable after this additive feature. Use one check-definition parser,
not frozen legacy parsers: each container passes its declared
`checkSchemaVersion` to the parser, which rejects v4-only constructs
(`inputPolicy`, `kind: "json-schema"`) when that version is 3. Plans and
assessments widen their `checkSchemaVersion` literal to accept 3 or 4.
Evaluation needs no version branching, because an old `valid-json` with no
`inputPolicy` already means whole-answer parsing. Old files therefore reject
newly introduced fields instead of acquiring new meanings, and each later
vocabulary bump adds one gate rather than another parser. Existing archived plans and criteria
remain immutable; opening them does not rewrite their vocabulary/version.

Project upgrade can write the new container version on save with absent policy
remaining strict. New reassessments over legacy traces may use the new vocabulary
only through an explicit supported compatibility path; their criteria/version
are saved separately and do not change the execution's “As run” interpretation.
Comparison alignment must also accept mixed check vocabulary versions. Test
same-version and cross-version comparisons, including an actionable
incompatibility state when a pairing is unsupported.

## Delivery sequence and acceptance

1. **Resolve design and engine feasibility.** Done for the engine choice:
   [the engine comparison](JSON_SCHEMA_ENGINE_SPIKE.md) and
   [the metered spike](METERED_JSON_SCHEMA_SPIKE.md) select an IF-owned metered
   interpreter. [The calibration record](JSON_SCHEMA_CALIBRATION.md) rebalances
   charges and sets the output limit and budgets, measured again on the
   production evaluator in all four runtimes. They freeze when vocabulary v4
   ships them. Slower hardware remains unmeasured.
2. **Core parsing and diagnostics.** Write original tests first, run them red for
   the actual unsupported behavior, then add the three input policies and sanitized
   diagnostics. Preserve strict JSON tests, including the existing fenced failure.
3. **Schema validation and portable formats.** Write red fixtures for nested types,
   required/optional fields, enums, arrays, extras, boolean schemas, unsupported
   constraints, and nonmutation, plus red tests for evaluation requirements 1–3
   against the spike behavior. Port the evaluator from the spike into core with
   an explicit stack and frozen accounting rather than importing the prototype.
   Add vocabulary/container readers and migrations together, with legacy
   history/reassessment fixtures before changing versions. Done in core:
   `json-schema` checks and input policies, the vocabulary gate, project v12,
   and cross-version comparison (`tests/structured-output-checks.test.ts`). The
   suite editor shows existing schema checks but does not offer new ones until
   step 4 adds the structured-check editor.
4. **Example generation and authoring.** Test generation before implementation;
   add the editor, preview, invalid draft behavior, explicit extras policy, and
   persistence. Verify hand-authored and generated schemas use the same evaluator.
   Done for suite authoring, core generation, and reassessment editor reuse.
5. **Results and end-to-end behavior.** Render diagnostics in suite and reassessment
   results; verify CLI/browser agreement and reopen exported history. Complete the
   supported-profile, provenance, deterministic-check, and artifact-format docs.

The behavioral matrix must cover raw JSON, scalar/null, blank output, complete and
incomplete fences, CRLF, prose around a fence, multiple blocks, backticks in string
values, invalid fenced JSON, an uppercase `JSON` marker, an other-language fence
before a JSON fence, unsupported fence markers, valid JSON that fails schema
validation, local and recursive references, unchecked `format` annotations,
rejected `pattern` keywords, a non-draft-07 `$schema`, non-consuming reference
cycles, assertions beside `$ref`, `allOf`-wrapped recursion at the maximum data
depth, diagnostic-budget exhaustion after a decided verdict, schema-side budget
exhaustion, an answer just under the output limit that still evaluates within
the work budget, and output over budget. Include explicit cases for no coercion, defaults, stripping,
wrapper changes, or model calls. An empty object is valid unless its schema says
otherwise; do not reproduce n8n's special empty-object error classification.

Follow `tests/e2e/README.md` and `docs/PROVIDER_FIXTURES.md`. Add a committed
`tests/e2e/structured-output-checks.spec.ts` using shared drivers and deterministic
provider outputs whose request cases must actually reach the wire. Assert rendered
strict-vs-fenced outcomes, schema mismatch location, generated-schema editing,
import/export, and reassessment. Extend `evaluation-suite-authoring.spec.ts` and
appropriate history/reassessment specs where existing ownership is exercised.
Show new regression assertions red before implementing their fixes; selector or
fixture failures do not count as a meaningful red run.

Run scoped core tests during each slice, then `npm run typecheck`, `npm run lint`,
`npm run test:core`, and `npm run build:cli`; exercise CLI evaluation with an
original schema fixture. Run affected browser specs during iteration, then
`npm run test:e2e` once before handing runtime changes back. Validate Tauri bundling
and the schema evaluator in the native Tauri webview; if unavailable, report that gap.
Report exact commands and coverage limits, not a generic “verified the app.”

## Decisions

Settled in review on 2026-10-16; the engine row was revised after the engine
and metered spikes the same day.

| Decision | Alternatives and tradeoff | Resolution |
| --- | --- | --- |
| Fence acceptance | Surrounding-only is easy to interpret; first-fence extraction also matches n8n's reported prose handling but ignores other content. | Offer both explicitly; retain strict as default. `first-json-fence` skips fences with other language markers and fails on invalid JSON in the first recognized fence. The `json` marker is case-insensitive. |
| Schema engine | n8n-style conversion brings transformation and coverage ambiguity. Ajv and `@cfworker/json-schema` cannot be bounded by size/depth limits. Worker isolation bounds time but lets a timer decide verdicts and makes all outcome consumers asynchronous. An owned interpreter is a module to build and maintain. | IF-owned synchronous interpreter with deterministic work/storage budgets and an explicit draft-07 profile. Workers may later schedule evaluation but never decide a verdict. |
| Budget accounting | A separate accounting version in results adds a second compatibility axis; unpinned charges let releases change historical verdicts. | Charge table and budgets are frozen with check vocabulary v4; changing them is a vocabulary bump. Charges are calibrated to measured cost (about a 2× spread); budgets come from latency measured on the production evaluator: 750,000 verdict units with a 150,000-code-unit output limit. |
| Output limit vs work budget | Independent limits let answers under the output limit exhaust the work budget and come back `not-evaluated`. | Choose them together, so any answer within the output limit parses and indexes within budget. |
| Whole-view latency | Per-check budgets do not bound a view that derives many checks; caching adds an invalidation surface. | The results and reassessment views yield to the UI between checks; caching only if measured latency still requires it. |
| Diagnostics budget | One shared budget is simpler but lets diagnostic cost and `maxIssues` change a verdict. | Verdict first; diagnostics exhaust to `invalid` with `truncated: true`. |
| `format` | Rejecting it blocks many real schemas (Pydantic exports); enforcing it needs bounded format implementations; ignoring it silently mis-scores. | Accept as an annotation, not asserted (draft-07 default), and list each unchecked format in the editor and results. Assertion may be added later as an opt-in. |
| References | Without `$ref`/`$defs` most pasted schemas fail to load; references add resolution work. | Local references required in v1, including recursive ones whose every cycle consumes data; non-consuming cycles are rejected at preflight. Assertions beside `$ref` are rejected rather than ignored. No remote references or `$id` re-basing. |
| Regex keywords | `pattern`/`patternProperties` expect ECMA-262; IF Safe regex is RE2. | Reject initially with a diagnostic pointing to Safe regex checks. |
| Example extras | Disallowing extras is stricter; allowing them follows JSON Schema defaults and accommodates incomplete examples. | Allow by default, with an explicit recursive disallow-extras choice; require observed fields. |
| Existing history | Rejecting old containers is simpler but prevents reopening experiments; frozen legacy parsers are heavy. | Preserve history and “As run” semantics through one parser gated by the container's declared `checkSchemaVersion`. |
| Schema-check negation | Negation would make invalid JSON satisfy the check and has no clear use. | Not negatable; can be added later without breaking files. |
| Oversized output | `not-evaluated` would hide runaway generation as an incomplete case. | `failed` with `output-too-large`; schema-side budgets remain `not-evaluated`. |
