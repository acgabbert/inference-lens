# UX verification matrix

The running-app checklist for the UX consolidation cycle
(`notes/UX_CONSOLIDATION_CYCLE_PLAN.md`).

The automated gate — `npm run lint`, `npm run typecheck`,
`npm run typecheck:core`, `npm test` — proves derivations. It does not prove a
value reached the screen in a usable form, and it cannot exercise focus,
layout, or contrast. This file is what a human or an agent works through in a
browser to cover the rest.

**This matrix is broader than the automated suite.** The repository's
Playwright suite (`npm run test:e2e`) exercises the deterministic paths that
are practical to keep committed. Work through the remaining rows the same way —
add a spec under `tests/e2e/` using the shared drivers in `tests/e2e/support/`,
and see the false-pass traps in [the provider fixture
guide](PROVIDER_FIXTURES.md), which this file assumes rather than repeats. The
durable asset here is the *expected values*, not any one runner; a row that
turns out to be deterministic should graduate into a committed spec rather than
being re-driven by hand each cycle.

## Reporting contract

The point of writing the matrix down is that coverage stops being improvised.
When reporting a verification pass, state:

- which scenarios were run, by name from the tables below;
- which widths and themes each was run at;
- the actual observed values for any row with a stated expected value; and
- every scenario skipped, with the reason.

"Verified the app" is not a report. A scenario not named was not run.

## Fixtures and their predictable values

Start fixtures by hand in a second terminal; they bind to loopback only. Seed
the connection profile through `localStorage` rather than clicking the drawer
(recipe in the fixture guide) *except* when the drawer itself is under test.

| Fixture | Script | Port | Model ID | Values you can state in advance |
| --- | --- | --- | --- | --- |
| Buffered | `npm run dev:buffered-provider` | 4014 | `buffered-test-model` | Content is exactly `Buffered fixture response: 2 + 2 = 4.` Usage is **4 input, 7 output, 11 total**. Rejects any request with `stream: true` or `stream_options`. |
| Paced | `npm run dev:paced-provider` | 4011 | `paced-test-model` | 600 ms stall before first byte, then 9 deltas 120 ms apart spelling `The first sunrise on Mars is pale and cold.` Usage reports **187 input, 9 output**. TTFO lands just over 600 ms; output span ≈ 960 ms; throughput ≈ 9 tok/s. Knobs: `INFERENCE_LENS_PACED_FIRST_BYTE_MS`, `INFERENCE_LENS_PACED_DELTA_MS`. |
| Echo | `npm run dev:echo-provider` | 4012 | `template-echo-model` | Answers `Fixture received <the exact serialized roles and text it got>`. Input tokens = message count; output tokens = word count. This is the fixture that proves template resolution, not a guess about it. |
| Flaky | `npm run dev:flaky-provider` | 4010 | `flaky-test-model` | First request returns HTTP 503; identical later requests stream `Recovered on retry.` Reset between passes with `curl -X POST http://127.0.0.1:4010/reset`. |
| Markdown | `npm run dev:markdown-provider` | — | — | One answer containing every supported markdown block, chunk-split so fences, lists, and tables straddle boundaries. |
| n8n API | `npm run dev:n8n-api-fixture` | — | — | Committed n8n 2.32.5 workflow and execution captures over a GET-only loopback API. |

Stop every fixture and dev server when the pass is finished.

## Widths and themes

The plan names 320, 390, 760, 880, and a representative desktop width.

`app/globals.css` currently has media queries at **480, 600, 700, 720, 760,
880, 1050, and 1080px**. The plan's list covers the workbench breakpoint (760)
and one layout breakpoint (880) but skips 480, 600, 700/720, and 1050/1080.
Treat the plan's five as the required minimum and add a 1080 and a 600 pass
when a PR touches layout that those queries govern.

760 and 880 are `max-width` queries, so a viewport of exactly 760 is on the
narrow side of the boundary. When a boundary is what changed, check 759 / 760 /
761 rather than 760 alone.

Run every scenario in both light and dark. Theme bugs in this codebase are
overwhelmingly contrast and state-distinguishability bugs, not layout bugs.

## Checks that apply to every scenario

From the plan, applied to each rendered scenario:

- assert on rendered text, not screenshots alone — screenshots catch layout but
  do not fail anything;
- assert the expected focused element after any readiness action, not merely
  that the right surface opened;
- scan the rendered region for `NaN`, `Infinity`, `undefined`, and `null`
  (`text.match(/NaN|Infinity|undefined|null/g)`);
- operate the path by keyboard and confirm the focus ring is visible;
- judge the 11px type floor at 100% browser zoom only; and
- confirm no meaningful text renders below 11px, and controls and labels are at
  least 12px.

## A. Readiness routing

Each row states the blocker to construct, the copy that must appear, and the
element that must hold focus after the action. Asserting the drawer or tab
opened is not sufficient — assert `document.activeElement`.

| # | Scenario | Setup | Expected copy | Expected focus after action |
| --- | --- | --- | --- | --- |
| A1 | Brand-new profile | Clear `inference-lens:inference-profiles:v1`, reload | Names the missing endpoint or model. Must **not** ask for an API key. | Connections drawer open, endpoint field focused. Then, with an endpoint set, Request → Messages with the model picker focused. |
| A2 | Unmapped project | Open a project with no connection mapping | Names the mapping. Must **not** mention an API key. | The exact project mapping control, not the drawer generally. |
| A3 | Unresolved template use | Compose a request with an unresolved template use and an unfilled variable | Names the unresolved use or variable | Request → Messages, scrolled to and focused on the specific unresolved use / variable field — **not** the prompt-authoring library. |
| A4 | Tools disabled, tools selected | Select tools, then disable the tools capability on the profile | Names the capability, not the tools | Tools capability control on the connection surface. |
| A5 | Review tools | Selected tool with a problem in its manifest | Names the tool needing review | Request → Tools, focused on the relevant manifest or control. |

Also confirm for the whole group: readiness copy and the disabled Run button's
tooltip say the same thing, and the response empty state names the *first*
blocker rather than defaulting to the API key.

## B. Run states

| # | Scenario | Fixture | Expected observations |
| --- | --- | --- | --- |
| B1 | Ready idle | Any seeded profile | Response invites the run. Inspector is collapsed and shows no empty event panel. |
| B2 | Buffered success | Buffered (4014) | Transcript reads exactly `Buffered fixture response: 2 + 2 = 4.` Compact summary reports **4 / 7 / 11** tokens. The remembered streaming toggle stayed off — the fixture 400s otherwise, so a wrong toggle is a visible failure, not a silent one. |
| B3 | Streaming success | Paced (4011) | Response stays the primary surface while streaming. Final transcript is `The first sunrise on Mars is pale and cold.` Summary reports 187 input / 9 output; TTFO just over 600 ms; output span ≈ 960 ms; throughput ≈ 9 tok/s. Check the numbers against the fixture — plausible-looking metrics are how a metrics bug survives. |
| B4 | Retry, failure, cancel | Flaky (4010) | First attempt surfaces the 503 truthfully; retry streams `Recovered on retry.` Per-attempt labels are human-readable, not raw UUIDs. Cancel mid-stream leaves an honest terminal state. Reset the fixture between passes. |
| B5 | Tool-result continuation | Echo (4012) | Response and inspector stay usable across turns. The echoed content confirms the serialized roles and ordering actually sent. |
| B6 | Markdown while streaming | Markdown | Incremental parsing holds across chunk boundaries, and the finished transcript renders the same answer the same way. |

## C. Inspection and reuse

| # | Scenario | Setup | Expected observations |
| --- | --- | --- | --- |
| C1 | Imported trace | Import a run trace through the Project menu | Inspect opens deliberately, not incidentally. Evidence tabs remain available. Round-trip check: rendered summary text after import matches what the live run showed. |
| C2 | Project history trace | Stub `showDirectoryPicker` per the fixture guide; include one deliberately damaged artifact | Summary and transcript reflect the selected saved run. The damaged artifact is disclosed without hiding the good ones. History still loads on demand (count `values()` calls). |
| C3 | Inspector state | Expand, collapse, switch tabs, start a run | Collapsing never discards tab selection or evidence. Starting or completing a run does not steal focus by expanding the panel. |

## D. Layout, mobile, and vocabulary

| # | Scenario | Widths | Expected observations |
| --- | --- | --- | --- |
| D1 | Mobile peer views | 320, 390, 760 | Request, Response, and Inspect are peer views. No inspector stacked below the transcript. One primary scroll container per view. Explicit trace-open selects Inspect; normal run completion stays on Response. |
| D2 | View state stability | 320, 390 | Switching views preserves request draft, transcript position where practical, inspector tab, and disclosure state. |
| D3 | Desktop unchanged | 880, 1080, desktop | Split resizing and inspector height behave as they did before the mobile work. |
| D4 | Themes | any | Hierarchy holds. Active and disabled states stay distinguishable in both themes. |
| D5 | Vocabulary and menus | any | Project holds only project lifecycle. Run data holds history, trace transfer, diagnostics. Tool library reachable from Tools; n8n import from Prompt library. Authoring tab reads "Prompt library"; run evidence reads "Templates" only when template-resolution evidence was captured. Older traces with no captured evidence omit that tab. Narrow-screen overflow keeps the Project and Run data group labels. Every pre-cycle action remains reachable with the same enable/disable rules. |

## Known gaps

Things this checklist cannot cover, so nobody mistakes a completed pass for
total coverage:

- **`showDirectoryPicker` is a native dialog.** Project-backed features are
  reachable only through the stub in the fixture guide. That runs the real
  workspace adapter but not the real picker.
- **Fixtures are not providers.** They prove the app behaves correctly when a
  provider does a specific thing. Use the
  [llama.cpp guide](LLAMA_CPP_E2E.md) when the question is whether the real
  transport works against a real server.
- **The 11px floor is enforced in the gate, not here.** The source-level
  `font-size` lint added in PR 2 is authoritative; the visual check at 100%
  zoom is a second opinion on whether the floor reads well, not the guard.
