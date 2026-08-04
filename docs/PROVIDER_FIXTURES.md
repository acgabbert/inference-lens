# Local provider fixtures and browser verification

Some Inference Lens behavior can only be checked against a provider that misbehaves
on purpose. A run that fails once and then succeeds, a stream that stalls before
its first byte, a response that reports token usage in a trailing chunk — these
are ordinary provider behaviors, but they cannot be requested from a hosted
account on demand, and reproducing them by waiting for a real provider to
cooperate is not a test.

A local fixture is a few dozen lines of `node:http` that speaks just enough of
the OpenAI-compatible streaming protocol to drive one situation deterministically.
This guide covers writing one and then exercising it through the real UI.

This is complementary to [the llama.cpp guide](LLAMA_CPP_E2E.md). Use llama.cpp
when the question is *does the real transport work against a real server*. Use a
fixture when the question is *does the app behave correctly when the provider
does this specific thing*, and the answer depends on exact timing, an exact
failure, or an exact payload.

## What already exists

| Script | npm script | Purpose |
| --- | --- | --- |
| `scripts/flaky-openai-provider.mjs` | `dev:flaky-provider` | First request returns HTTP 503, later identical requests stream normally. Drives the retryable-failure and retry path, and logs whether the retry body byte-matches the first attempt. |
| `scripts/paced-openai-provider.mjs` | `dev:paced-provider` | Streams with a deliberate stall before the first byte and a fixed gap between deltas, then reports usage. Makes time-to-first-token and throughput predictable. |
| `scripts/echo-openai-provider.mjs` | `dev:echo-provider` | Echoes the exact serialized message roles and text it received. Verifies template resolution, ordering, overrides, and request preview against the real transport. |
| `scripts/buffered-openai-provider.mjs` | `dev:buffered-provider` | Accepts only `stream: false` requests with no `stream_options`, then returns one predictable JSON completion with 4 input, 7 output, and 11 total tokens. Verifies the remembered streaming toggle, buffered normalization, and rendered usage. Model-selected variants cover a provider-default temperature, an echoed temperature, (`math-output-model`) a LaTeX answer in both delimiter forms, and (`tool-calling-model`) one `get_weather` call followed by an answer echoing whatever tool result came back — refusing outright if `get_weather` is not in `tools`, so a run where the tool never reached the wire fails instead of passing against an empty manifest. `looping-tool-model` calls the same tool forever no matter how many results it is given, which is the only way to reach a batch's turn ceiling — a model that eventually answers ends the run before the bound is tested. |
| `scripts/n8n-public-api-fixture.mjs` | `dev:n8n-api-fixture` | Serves the committed n8n 2.32.5 workflow and execution captures through a loopback, GET-only public API. Verifies workflow/execution browsing without a live n8n instance. |
| `scripts/markdown-openai-provider.mjs` | `dev:markdown-provider` | Streams one answer containing every supported markdown block, split so fences, lists, and tables straddle chunk boundaries. Checks incremental parsing while streaming and that the finished transcript renders the same answer the same way. |

Neither is part of `npm test`. They are development endpoints started by hand
in a second terminal, and they bind to loopback only.

## Writing a fixture

A fixture needs three routes at most:

- `GET /v1/models` — a single-entry list, so model discovery in the picker has
  something to return. Optional; the model ID can always be typed manually.
- `POST /v1/chat/completions` — the path under test.
- Anything else — return 404. Do not silently accept unexpected paths; a fixture
  that answers everything hides routing bugs.

The streaming response contract that matters to Inference Lens:

- Content type `text/event-stream`, with each chunk written as
  `data: <json>\n\n`.
- Content arrives as `choices[0].delta.content`.
- The stream must end with a `finish_reason` **or** `data: [DONE]`. Inference Lens
  treats a stream that ends with neither as a protocol error, which is correct
  behavior and easy to trigger accidentally while writing a fixture.
- Usage, when reported, arrives in its own trailing chunk with an empty
  `choices` array — the shape providers use for
  `stream_options.include_usage`, which Inference Lens always requests.

For a buffered fixture, require `stream: false`, reject `stream_options`, and
return one `application/json` chat completion. Content comes from
`choices[0].message.content`; usage and `finish_reason` use their ordinary
non-streaming fields.

Drain the request body before responding, even when the fixture ignores it.
Leaving it unread can stall the client on larger requests.

Put timing knobs in environment variables with defaults, as
`paced-openai-provider.mjs` does. A fixture whose delays are constants has to be
edited to test a second scenario; one with knobs can be re-run against a
different shape of run.

### Make the fixture's own numbers checkable

A timing fixture is only useful if you can say in advance what the app should
report. `paced-openai-provider.mjs` stalls 600 ms before the first byte and then
emits nine deltas 120 ms apart, so:

- time to first output should land just over 600 ms;
- the generation phase should span roughly 9 × 120 ms; and
- throughput should land near 9 tokens ÷ that span.

When the UI showed 729 ms TTFO and 9.3 tok/s over a 963 ms output span,
those numbers could be checked against the fixture rather than merely looking
plausible. Plausible-looking numbers are exactly how a metrics bug survives.

## Driving the UI in a browser

Unit tests cover derivations; they do not cover whether a value reaches the
screen in a readable form. The run-metrics work shipped a per-attempt label that
passed every test and rendered a raw turn UUID in the browser. Only opening the
page caught it.

Playwright **is** a repository dependency and there **is** a committed browser
suite. Run it with `npm run test:e2e`, or narrow it while working:

```
npx playwright test model-picker-empty-value          # one spec
npx playwright test --project=chromium-light          # one theme
```

`playwright.config.ts` starts the dev server on port 4300 and the buffered
fixture provider on 44014 for you, and runs every spec twice — once in
`chromium-light` and once in `chromium-dark`. Do not start a dev server by hand
for a Playwright run; the config owns that lifecycle.

The suite is deliberately **not** part of `npm test`. Run both before opening a
pull request.

Use the npm script rather than a bare `npx playwright test`: `pretest:e2e`
installs the exact Chromium build this Playwright version pins, which is a
sub-second no-op once it is cached. Without it, an environment holding an older
cached build — a cloud session, a fresh container — fails with *"Executable
doesn't exist … Run `npx playwright install`"* rather than running. Playwright
is pinned to an exact version for the same reason: a minor bump expects a
browser build nobody has cached yet.

The browser build is not interchangeable. This suite asserts an 11px type
floor, contrast, and layout at nine widths, so a different Chromium is a
different result — which is why the run refuses to start rather than
substituting a system browser. Do not report the suite as passing when it
never started.

### When the pinned Chromium cannot be downloaded

In a sandboxed or proxied environment `pretest:e2e` can fail outright —
typically `403 request rejected: host not permitted` from
`cdn.playwright.dev` — and the suite never starts. That is not a reason to
skip the browser check. Environments that block the download usually ship a
pre-installed build; look for `$PLAYWRIGHT_BROWSERS_PATH` (commonly
`/opt/pw-browsers/chromium`). Run the committed suite against the newest build
you actually have, by pointing `launchOptions.executablePath` at it from a
throwaway config that spreads `playwright.config.ts`:

```ts
// playwright.localbuild.config.ts — delete after the run; never commit it.
import base from "./playwright.config.ts";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  use: { ...base.use, launchOptions: { executablePath: "/opt/pw-browsers/chromium" } },
});
```

Then `npx playwright test --config=playwright.localbuild.config.ts`, which also
bypasses the failing `pretest:e2e`. Delete the config and `test-results/` when
the run is finished.

The warning above is about interpretation, not about refusing to run: the
type-floor, contrast, and nine-width assertions genuinely are build-sensitive,
so a different Chromium is a different result for those. Text, role, and
layout-overflow assertions are not. Running everything on a near-by build and
saying which one ran beats reporting no browser coverage at all.

What stays forbidden is quiet substitution. Report the build you used and its
version, name it as not the pinned one, and call the build-sensitive sweep
unconfirmed on the pinned build. Never write "the browser suite passed"
without that qualification, and never claim the suite ran when it never
started.

Prefer adding a spec to `tests/e2e/` over writing a throwaway driver script. A
scratch script proves the same thing once and then deletes the evidence; a spec
keeps proving it. When a check really is one-off, still write it as a spec, run
it, and only then decide whether to keep it.

### Use the shared drivers

`tests/e2e/support/` holds the recipes every spec needs. Import them rather than
re-deriving them — each one exists because getting it wrong produces a *passing*
test that proves nothing:

```ts
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
await page.goto("/");
await waitForHydration(page);
await importProject(page, fixtureProject(), "My fixture project");
```

- **`seedProfile`** writes the connection profile straight to local storage.
  Credentials are never persisted there and a fixture needs no key. This is a
  shortcut through the connection drawer, not a substitute for testing it — when
  the drawer itself is what changed, drive the drawer.
- **`waitForHydration`** waits for the seeded profile name to appear in the top
  bar. Do this before any synthetic event, and see the hydration trap below.
- **`importProject`** imports through the Project menu's hidden file input,
  waits for the project to really be open, and closes the menu.
- **`stubProjectDirectory`** replaces `showDirectoryPicker` with an in-memory
  directory, which is the only way to reach project-backed features in a
  browser.

### Traps that produce false passes

Each of these has silently shipped a green test that exercised nothing:

- **Assert on something that only exists when the state is real.** `Run target:`
  renders with *or without* an open project, so waiting on it after an import
  passes even when the import was dropped — and every later assertion then tests
  the no-project path. Wait for the project's own name. This is what
  `importProject`'s required `expectedName` is for.
- **Synthetic events before hydration are dropped silently.** `setInputFiles`
  dispatches a change event against the DOM; if React has not attached its
  handler yet, nothing happens and no error is raised. Call `waitForHydration`
  first. Waiting on a server-rendered element proves nothing here, because it is
  visible before hydration — wait for state that can only come from local
  storage.
- **Clicking an already-focused element fires no `focus` event.** Opening a
  project can leave focus on a field, so a later `click()` on it will not open a
  focus-driven menu. Click something neutral first.
- **Model discovery goes through the app, not the provider.** The browser fetches
  `/api/models` (`MODELS_API_PATH`), so routing `**/v1/models` intercepts
  nothing. Route `**/api/models` to simulate a catalogue that cannot be listed.
- **Measure layout only after the content settles.** A region that grows as
  results arrive has non-final geometry until the work finishes; a row is
  attached before its contents fill in. Wait for a completion signal — the
  absence of `Experiment progress`, for instance — not merely for a row.

### Selectors worth knowing

These cost a round trip each to discover:

- **Retry appears twice.** The top bar and the response pane both render a retry
  control, so `name: /^Retry/` is ambiguous. The top-bar one is `Retry ⌘↵`.
- **The Project menu is a `<summary>`, not a button.** Use
  `page.locator("summary", { hasText: "Project" })`.
- **File imports are hidden inputs inside a label.** There is no dialog to
  intercept; set the file directly:
  `page.locator('.menu-file-button:has-text("Import run trace") input[type=file]').setInputFiles(path)`.
- **Menus are `<details>`, so they toggle.** Escape does not close one, and a
  second click on the summary closes it, which is a confusing way to discover
  that the item you wanted is merely invisible. Set the state instead:
  `page.evaluate(() => { document.querySelector("details.project-menu").open = true; })`.
- **Disclosure content is not in `innerText` until it is open.** The skipped
  artifacts under run history live in a collapsed `<details>`; open it the same
  way before reading.
- **CSS uppercasing reaches `innerText`.** Status pills are
  `text-transform: uppercase`, so match `COMPLETED`, not `completed`.

### Stub the folder picker to drive project-backed features

`showDirectoryPicker` cannot be driven by Playwright: it is a native dialog and
there is no permission to grant. Features that need an open project folder —
run history above all — are therefore unreachable in a browser unless the
picker is replaced.

Replace only the picker. Everything past it, including the workspace adapter,
takes handles through the `FileSystemDirectoryHandleLike` and
`FileSystemFileHandleLike` shapes in `app/project-directory.client.ts`, so an
in-memory object satisfying those runs the real application code:

`stubProjectDirectory` in `tests/e2e/support/` does this. Give it a folder name
and a flat map of paths to contents:

```ts
await stubProjectDirectory(page, {
  name: "history-demo.inference-lens",
  files: {
    "project.json": manifest,
    "traces/run_a.json": traceA,
  },
  directories: ["experiments"],   // paths that must exist but stay empty
});
```

Generate the manifest and the traces with `createProjectFile`,
`serializeProjectFile`, and `serializeRunTrace` so the page is validating real
artifacts rather than hand-written JSON that only resembles them. Include a
deliberately damaged file: the interesting assertion is usually that one bad
artifact is disclosed without hiding the good ones.

Wrapping a handle's method also lets a driver assert on work that is supposed
*not* to happen. Counting calls to the traces directory's `values()` is how the
claim that history loads on demand is checked rather than asserted:

```js
window.__traceListings = 0;
const inner = traces.values.bind(traces);
traces.values = () => (window.__traceListings += 1, inner());
```

### Assert on text, not only on screenshots

Screenshots catch layout; they do not fail a build. Read the panel's text and
assert on it:

```js
const text = await page.locator(".run-metrics").innerText();
console.log(text.match(/NaN|Infinity|undefined|null/g) ?? "none");
```

Scanning rendered text for `NaN`, `Infinity`, and `undefined` is worth doing on
any numeric UI. Those three strings are what a formatting or divide-by-zero bug
looks like once it reaches a user, and they are trivially greppable.

### Round-trip through a saved trace

For anything derived from run state, the strongest check is that a saved trace
reproduces it. Save the trace, reload, re-import, and compare the rendered text
to what the live run showed:

```js
const before = await page.locator(".run-metrics").innerText();
// …save the download, reload, import it through the Project menu…
const after = await page.locator(".run-metrics").innerText();
console.log("match:", before === after);
```

An exact string match proves the projection depends only on the persisted event
stream. Anything that leaks in from live session state shows up here as a
difference.

### Check both themes

Theming is `light-dark()` tokens with no `prefers-color-scheme` blocks (see
[THEMING.md](THEMING.md)), so `page.emulateMedia({ colorScheme: "dark" })` is
enough to check the dark rendering. New CSS must draw its colors from the
`:root` tokens; `tests/theme-tokens.test.ts` fails on any color literal outside
that block.

## Cleaning up

Fixtures and `npm run dev` are long-lived processes. Stop them when the check is
finished — a stale fixture on port 4010 or 4011 will quietly serve a later
session and make its results confusing.
