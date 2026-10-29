# JSON Schema charge calibration and limits

Date: 2026-10-16. Status: charges rebalanced and limits chosen for the core
evaluator under `packages/core/src/json-schema/`. The production `json-schema`
check now exposes these limits through check vocabulary v4. The charge table
and limits are frozen as part of that vocabulary (evaluation requirement 4 in
[the plan](STRUCTURED_OUTPUT_CHECKS_PLAN.md)).

## Why recalibrate

A work budget bounds latency only at the most expensive time per unit. The
evaluator inherited the spike's charges, which priced text by the code unit and
structure by the step. Measured against wall time, units ranged from about
0.03 ns (comparing long shared-prefix strings) to about 45 ns (starting a
subschema evaluation), a spread of over a thousand between the cheapest and
dearest operation, and about 50× across the original latency fixtures:

- **Undercharged:** each subschema evaluation creates a generator frame, costing
  roughly 150–250 ns, but was charged 3–4 units. Preparing a schema node runs
  about 25 keyword checks and graph bookkeeping for one unit.
- **Overcharged:** indexing a string, merging sorted keys, `enum`/`const`
  comparison, uniqueness hashing, `multipleOf` arithmetic, and schema encoding
  charged one unit per code unit. V8 neither copies nor scans most of that text
  (strings are shared, concatenation builds ropes, and comparison is a memory
  compare), so these ran at 0–3 ns per unit.

## Charge table

`WORK` in `resources.ts` names every charge. Fixed charges price an operation;
text divisors price its length.

| Charge | Units | Applies to |
| --- | ---: | --- |
| `node` | 2 | Indexing one JSON value; one encoding chunk; one equality or uniqueness check |
| `key` | 1 | Collecting, merge-comparing, or looking up one object key; one `required` or dependency name |
| `frame` | 10 | Starting one subschema evaluation (verdict or diagnostics); preparing one schema node |
| `multiple` | 8 | One `multipleOf` decision |
| `scanText` | 1 per 4 code units | Code-point scans (`minLength`/`maxLength`), quoting, hashing, key text at indexing, schema path copies |
| `copyText` | 1 per 256 code units | Copying or comparing text: key merges, equality, encoding joins, string indexing |
| `shiftDigits` | 1 per 16 digits | The decimal shift in `multipleOf` |

Explicit stack steps, memo lookups, assertions, and similar fixed bookkeeping
remain one unit each. A length scan is charged in full before it runs, so the
loop itself is unmetered.

## Calibration method

`scripts/json-schema-calibration.ts` runs every workload in
`scripts/json-schema-latency-entry.ts` with budgets large enough to finish,
times evaluation on already-parsed input (parsing is timed separately, since the
output limit bounds it), and reports nanoseconds per work unit. Beyond the
latency fixtures, each calibration workload isolates one charged operation:
indexing small values and empty containers, frames, memo hits, `anyOf`
branches, `enum`, `multipleOf` with a large decimal shift, `required`,
`propertyNames`, uniqueness of integers and of nested arrays, code-point length
scans, and three adversarial text cases whose keys, `enum` candidates, or items
share a 1,000-character prefix. Dense 64 KiB schemas exercise preflight.

```sh
node --experimental-strip-types scripts/json-schema-calibration.ts
```

## Calibrated cost per unit

Node 24.3.0, Apple M4 Pro, median of nine runs after three warm-ups, evaluation
only. Workloads taking at least 1 ms, where per-unit cost is measurable:

| Workload | Work units | Median ms | ns per unit |
| --- | ---: | ---: | ---: |
| realistic 1000 records | 77,273 | 1.8 | 23.1 |
| number traversal | 7,099,172 | 148.1 | 20.9 |
| invalid item diagnostics | 2,399,910 | 44.8 | 18.7 |
| unique objects | 1,484,035 | 32.4 | 21.9 |
| long unicode string | 121,941 | 1.2 | 10.0 |
| wide object sorting | 656,262 | 10.4 | 15.9 |
| schema preflight | 84,834 | 2.4 | 28.2 |
| index only: 200k small integers | 1,399,029 | 28.6 | 20.5 |
| index only: 50k empty objects | 349,029 | 7.2 | 20.5 |
| node visits: 100k items, type only | 2,399,071 | 43.8 | 18.3 |
| memo hits: anyOf of 64 refs to one definition | 5,627,277 | 78.7 | 14.0 |
| branches: anyOf of 64 distinct consts | 6,221,190 | 127.6 | 20.5 |
| enum: 2k candidates | 1,636,150 | 8.6 | 5.3 |
| multipleOf: large decimal shift | 339,069 | 5.6 | 16.5 |
| propertyNames: 30k keys | 1,315,305 | 26.7 | 20.3 |
| uniqueItems: 100k small integers | 1,598,045 | 39.0 | 24.4 |
| uniqueItems: nested arrays at depth 16 | 871,035 | 17.6 | 20.2 |
| ascii string length 1m | 253,972 | 4.6 | 18.0 |
| enum: 50 candidates, 1k-char shared prefix | 444,197 | 1.5 | 3.4 |
| diagnostics: 100k failing nested items | 4,401,113 | 105.9 | 24.1 |

The most expensive rate, which is what bounds latency, is 28.2 ns per unit
(preflight). Structural workloads (frames, indexing, uniqueness, diagnostics)
fall between 14.0 and 24.4 ns per unit, about a 2× spread, down from about 50×.
Text paths read cheaper (3.4–18 ns) because they are deliberately overcharged. Dense 64 KiB schemas
measured separately preflight at 21–33 ns per unit. Workloads under 1 ms
(realistic 100 records, the depth-64 payloads, plain strings, shared-prefix
sorting) read higher or lower per unit because fixed overhead or timer
resolution dominates; their absolute cost is negligible.

## Limits

`SCHEMA_CHECK_LIMITS` and `MAX_SCHEMA_OUTPUT_CODE_UNITS` in `limits.ts`:

| Limit | Value |
| --- | ---: |
| Output (original answer text) | 150,000 UTF-16 code units |
| Verdict work / storage | 750,000 / 4,000,000 units |
| Schema size / depth | 65,536 code units / 64 |
| Schema preflight work / storage | 600,000 / 2,000,000 units |
| Diagnostics work / storage / issues | 100,000 / 1,000,000 units / 20 |
| Data depth | 64 |

The output limit and verdict budget are chosen together
(`tests/json-schema-limits.test.ts`):

- The densest answers per code unit (single-digit integers, empty containers,
  one-character keys) index within three quarters of the verdict budget at the
  output limit. Single-digit integers are the worst case, at 524,015 units,
  70% of the budget.
- Realistic records at the output limit (`{ answer, score }` with types, bounds,
  required fields, and no extras) validate within half the budget.
- Every schema within the size limit preflights within the schema budget. The
  densest found, an `allOf` of 21,800 empty schemas, uses about 480,000 units.

Before this change, the plan's provisional pairing (500,000 units against a
1,000,000-code-unit output) failed the first two assertions: both a dense
integer answer and realistic records within the output limit returned
`not-evaluated` (`work-limit`) without indexing completely.

**Known limit:** indexing and validation cost follow the number of values, not
characters. A per-item schema over an array of tens of thousands of small
values can still exhaust the verdict budget and return `not-evaluated`; a
schema check over 75,000 single-digit integers (the output limit) does. Such
answers are not realistic structured output, and the bound is deterministic.

## Cross-runtime latency at the calibrated limits

[The complete report](measurements/json-schema-calibrated-latency-2026-10-16.json)
was collected on 2026-10-16 on an Apple M4 Pro (Darwin 25.6.0) with
`npm run test:json-schema:latency -- --native`, using the calibrated schema and
diagnostic limits and varying only the verdict budget. Each of the 27 workloads
ran three warm-ups and fifteen samples per budget, timing original-text parsing
through diagnostics. All four runtimes returned identical outcomes and
accounting for every workload and budget.

Slowest workload per budget, median / largest sample, in milliseconds:

| Verdict budget | Node 24.3.0 | Chromium 145 | Playwright WebKit 26.0 | Native Tauri/WKWebView |
| ---: | ---: | ---: | ---: | ---: |
| 250,000 | 8 / 9 | 6 / 16 | 12 / 13 | 10 / 11 |
| 500,000 | 13 / 25 | 17 / 33 | 19 / 21 | 16 / 19 |
| **750,000** | 21 / 34 | 28 / 57 | 25 / 28 | 21 / 33 |
| 1,000,000 | 31 / 49 | 36 / 106 | 32 / 38 | 27 / 35 |
| 2,000,000 | 54 / 73 | 61 / 97 | 64 / 70 | 58 / 79 |

At the calibrated 750,000 units, the slowest workload's median is 21–28 ms
across runtimes; the largest single sample is 57 ms (Chromium, integer
indexing, likely a collection pause). Twelve adversarial workloads exhaust the
budget there by design. Realistic 1,000-record answers take about 2 ms.

These are measurements on fast hardware. Slower supported machines were not
measured. At an assumed four-times slowdown, the worst-case median would reach
roughly 85–110 ms, at the top of the plan's 50–100 ms per-check ceiling. A
500,000-unit budget (medians 13–19 ms here) would add margin but needs the
output limit lowered to about 100,000 code units to keep the indexing guarantee.

## What was not covered

- Slower hardware, and timing under sustained UI interaction.
- Whole-view latency: per-check timings do not bound a results view that
  derives many checks; the plan's yield-between-checks requirement covers that.
- The storage meter remains logical accounting, not a calibrated heap ceiling.
- Packaged release builds; the native probe runs the Tauri debug host.
