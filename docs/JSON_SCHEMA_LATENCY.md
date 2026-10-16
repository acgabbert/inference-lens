# Metered schema evaluation latency

The isolated evaluator now has a repeatable latency probe. This measures the
existing experimental implementation; it does not establish production limits
or change check definitions, persisted artifacts, or application behavior.

## Reproduce

```sh
npm run test:metered-json-schema
npm run test:metered-json-schema:latency -- --output /tmp/schema-latency.json
npm run test:metered-json-schema:latency -- --native --output /tmp/schema-native-latency.json
```

The browser runs require loopback access and installed Playwright browsers. An
explicit `IF_METERED_WEBKIT_EXECUTABLE` can select a locally installed WebKit
build. Missing executables are recorded as unavailable. The optional native run
launches the actual existing Tauri host, with a temporary frontend URL and
window configuration passed to the CLI. It builds Rust if necessary and requires
a desktop session. It never edits the application configuration or production
routes. The launcher and its child processes are terminated on completion or
failure, and temporary bundles are removed. The native probe has a five-minute
startup/measurement deadline; a timeout fails the command, never a check verdict.

The native frontend is the same minified ES2021 benchmark bundle used in the
browser probes. Its result is accepted only when Tauri's internal bridge is
present. Native timings identify the host's user agent; Playwright WebKit
measurements are reported separately. This is evaluator execution inside the
native host, not a packaged application workflow or a release-bundle smoke test.

## Method

Eight deterministic fixtures cover 100 and 1,000 ordinary answer/score records,
100,000 numeric items with composition, 100,000 invalid items with diagnostics,
45,000 unique objects, a 480,002-code-unit Unicode JSON string, 30,000 object
keys to sort, and 1,700 schema definitions to preflight. All fit the experimental
schema and output size bounds. Fixture construction and serialization happen
outside the timed region. Each timed evaluation includes parsing both original
JSON texts, schema preflight, data indexing, validation, and diagnostics.

Each fixture runs at 100,000, 250,000, 500,000, 1,000,000, 2,000,000, and
4,000,000 work units with the existing 4,000,000 storage units and 20 issues.
For each pairing, three warmups precede fifteen recorded samples. The report
retains first invocation, median, nearest-rank p95, and maximum milliseconds.
With fifteen samples p95 is the maximum; it is not a statistically stable tail
latency estimate. First invocation is per fixture/budget, not a fresh-process
cold-start measurement. Garbage collection is neither forced nor excluded.

Every repeated result must be identical within a runtime. Status, resource code,
work/storage accounting, and input lengths must also agree across runtimes.
The focused tests prove that at least one fixture exhausts at least 99% of every
candidate work budget, and that the fixtures validate with generous resources
(apart from the intentionally invalid item array). Reports expose actual work
fractions so a cheap valid fixture cannot masquerade as a full-budget probe.

Timing exists only in this harness. The evaluator never reads a clock, and no
sample duration selects a verdict. All measurements are local observations,
not guarantees for slower supported machines, background load, or other schema
shapes. The prototype still shares verdict/diagnostic resources and uses its
conservative recursive evaluation guard; production changes to these mechanisms
require new measurements before accounting is frozen.

## Recorded results: October 16, 2026

[The complete machine-readable report](measurements/json-schema-latency-2026-10-16.json)
was collected on an Apple M4 Pro, Darwin 25.6.0, starting at
2026-10-16T19:07:47Z. Node was 24.3.0, Chromium 145.0.7632.6, and Playwright
WebKit 26.0. The native Tauri 2.11.5 debug host used the system WKWebView
(`AppleWebKit/605.1.15` user agent). That user agent reports an Intel Mac and
macOS 10.15.7 for compatibility; it does not identify the physical CPU or OS.
The bundle was minified in all three webviews. No other repository checks ran
concurrently with this final collection.

The table reports the largest recorded sample across all eight workloads at
each work budget, in milliseconds. Values are observations, not hard ceilings.

| Work budget | Node | Chromium | Playwright WebKit | Native Tauri/WKWebView |
| ---: | ---: | ---: | ---: | ---: |
| 100,000 | 6.3 | 4.2 | 8.0 | 8.0 |
| 250,000 | 22.9 | 24.5 | 14.0 | 18.0 |
| 500,000 | 48.4 | 43.9 | 29.0 | 25.0 |
| 1,000,000 | 81.4 | 74.6 | 64.0 | **327.0** |
| 2,000,000 | 142.7 | 144.9 | 154.0 | 149.0 |
| 4,000,000 | 145.6 | 136.9 | 175.0 | 158.0 |

The native one-million-unit numeric traversal had a median of 54 ms and a
327 ms maximum. The harness does not establish the cause of that pause; it is
retained rather than discarded. The first Chromium invocation at 500,000 units
was 52.3 ms, outside the fifteen recorded samples but still below 100 ms.
Warmup durations other than the first invocation are not retained.

At 500,000 units the 1,000-record fixture passed in every runtime, using 130,576
work and 99,357 storage units; its recorded maxima were 1.5, 1.1, 2.0, and
1.0 ms respectively. The 1,700-definition schema also passed (199,733 work).
The 100,000-item array and other adversarial workloads can exhaust this budget;
the resource result is intentional, not evidence that those schemas validate.
All four runtimes agreed on outcomes and resource accounting for all 48
fixture/budget pairings. Within each pairing, all eighteen invocations returned
the same complete evaluator result.

## Recommendation and remaining decision

Use **500,000 work units as a provisional production starting point**, then
measure again after the explicit-stack evaluator and independent diagnostic
budget are implemented. It leaves more local headroom than one million while
covering the exercised ordinary records and large schema preflight. The current
four-million default is not supported as a synchronous UI budget by these data.
Do not freeze it into a portable vocabulary based on this prototype measurement.

Alternatives are to measure slower supported hardware before selecting a limit,
or to add off-main-thread scheduling to accommodate larger work budgets. The
latter changes scheduling contracts and implementation scope; deterministic
metering must still decide outcomes. This record does not choose that contract.
The storage default was held constant, not independently calibrated as a heap
limit. Broader realistic schemas, slower hardware, sustained UI interactions,
and the final production accounting still need measurement. Per-check latency
also does not bound the total pause from evaluating a suite of many checks.

## Verification and limits

The recorded commands were:

```sh
npm run test:metered-json-schema
npm run typecheck
npm run lint
IF_METERED_WEBKIT_EXECUTABLE=/Users/aaron/Library/Caches/ms-playwright/webkit-2123/pw_run.sh \
  node scripts/spikes/metered-json-schema/latency.mjs --native --output /tmp/if-schema-latency.json
```

The focused suite passed 18 tests and all 807 selected upstream assertions.
Typecheck passed. Lint passed with the same three existing unused-variable
warnings in `evaluation-suites.ts`, `project.ts`, and `project.test.ts`.

Initial attempts encountered a sandbox loopback restriction, a harness transport
mismatch between absent codes and explicit nulls, and stale native build metadata
pointing at the repository's former directory. The transport was normalized;
rebuilding the three affected Tauri crates repaired the native launch. Those
failed attempts are not included in the recorded report, and no evaluator
regression or red/green production fix is claimed.

Application E2E, the application core suite, CLI builds, and packaged native
builds were not run: this change adds isolated measurement tooling, fixtures, and
documentation, with no production consumer or user-visible application behavior
changed. The native benchmark actually ran; the application authoring/results
workflow did not. Production schema workflows and interaction responsiveness
remain for browser and native acceptance when those features are integrated.
