# Core schema evaluator: lazy answer encodings

The core evaluator indexes answer structure without canonical strings or copied
paths. `const`, `enum`, and `uniqueItems` request encodings from an invocation-local
cache. Encoding uses an explicit stack to emit one requested subtree into chunks,
then joins once. It does not construct and cache every descendant encoding.
Authored-schema preparation is unchanged.

## Cost regression and results

The regressions were written and run before the change against commit `f9797bb`.
The record assertion failed on 295,897 actual work units against a 200,000-unit
ceiling. The depth assertion failed because 15 wrappers added 151,440 work units
rather than work proportional to the wrappers. These are deterministic logical
work/storage counts, not milliseconds or heap bytes.

| Fixture | Answer UTF-16 units | Before: verdict work | After: verdict work | Before: storage | After: storage |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 answer/score records | 56,001 | 295,897 | 117,894 | 235,915 | 103,915 |
| 10k string at depth 1, boolean schema | 10,002 | 20,006 | 10,004 | 10,019 | 10,019 |
| Same payload at depth 64, boolean schema | 10,569 | 669,662 | 10,508 | 661,628 | 11,027 |

The record fixture uses `answer: "A useful answer for the user."` and `score: 0.75`,
with required fields, type assertions, numeric bounds, and no extra properties.
Its ordinary validation now costs about 2.1 work units per answer code unit,
a reduction of 60%. Indexing remains sensitive to node counts and deterministic
object-key sorting; this does not claim a universal work-per-character ratio.

## Reproduce the production latency probe

```sh
npm run test:json-schema:latency -- --output /tmp/core-schema-latency.json
npm run test:json-schema:latency -- --native --output /tmp/core-schema-native-latency.json
```

The existing isolated runtime launcher selects the production entry with `--core`;
the original spike entry remains the default for the spike's commands. The
`IF_METERED_WEBKIT_EXECUTABLE` override selects an installed Playwright WebKit
build. Native mode launches the actual Tauri debug host with the temporary
benchmark frontend, requires its internal bridge, and closes it afterward.
It does not test packaged application workflows.

Ten workloads cover ordinary records, numeric traversal, invalid-item diagnostics,
unique objects, long Unicode strings, wide object sorting, schema preparation,
a large payload at depth 64, and equality at depth 64. Each runs with six candidate
work ceilings (100k through 4m), three warmups, and fifteen samples. Parsing both
schema and answer texts is inside the timed region. The report separates
preflight, verdict, and diagnostic accounting. Schema and verdict meters each
receive the candidate work ceiling and 20m storage units; diagnostics receive
100k work, 1m storage, and 20 issues. Schema depth is 65 to accommodate the
`const` wrapper around the depth-64 equality fixture; data depth is 64.
These are benchmark inputs, not public defaults.

[The complete report](measurements/json-schema-core-lazy-latency-2026-10-16.json)
captures the lazy-encoding baseline from commit `b9b74fb`, before the later
depth-first diagnostic traversal change. Diagnostic costs and issue order can
differ in newer revisions; rerun the probe for current measurements. The run
started at 2026-10-16T20:07:21Z on an Apple M4 Pro, Darwin 25.6.0, Node 24.3.0,
Chromium 145.0.7632.6, Playwright WebKit 26.0, and native Tauri/WKWebView
(`AppleWebKit/605.1.15`). All four runtimes agreed on the complete outcomes and
accounting for all 60 fixture/budget pairings; every repeated invocation also
agreed. The spike latency tests briefly overlapped this collection. These are
observations under local load, not isolated calibration results.

At a 500k candidate ceiling, the 1,000-record medians were 1.19, 1.0, 1.0, and
1.0 ms, respectively. The largest recorded sample across all ten workloads was
9.2, 10.3, 13, and 10 ms. Native and WebKit timers quantize small results to whole
milliseconds; a reported zero does not mean zero cost. Fifteen samples do not
establish stable tail latency. At 4m, the largest recorded samples reached 153,
135, 210, and 181 ms, respectively.

## Boundaries still to calibrate

This removes answer size-times-depth encoding costs from ordinary validation.
It does not freeze the charge table, select an output limit, or establish that
all answers under a proposed output limit fit a candidate work budget. Unicode
length validation still scans strings, and wide maps still require sorting.
Nested equality requests each pay for their requested encoding and comparisons.
Authored-schema preparation still builds encodings eagerly: the depth-64 `const`
fixture needs 680,272 preflight work units, while its answer indexing/validation
uses 63,488. It therefore stops on the schema meter at a 500k ceiling.

The storage meter is logical retained input, encoding, and record accounting,
not a calibrated heap limit. Slower hardware, charge-to-time balancing,
combined output/work limits, and whole-view scheduling remain separate work.
No application E2E run was needed: the evaluator remains internal with no UI or
provider consumer. Native evaluator execution was measured; user-visible
structured-check workflows and release packaging were not exercised.
