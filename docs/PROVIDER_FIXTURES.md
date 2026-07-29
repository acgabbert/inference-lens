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

The response contract that matters to Inference Lens:

- Content type `text/event-stream`, with each chunk written as
  `data: <json>\n\n`.
- Content arrives as `choices[0].delta.content`.
- The stream must end with a `finish_reason` **or** `data: [DONE]`. Inference Lens
  treats a stream that ends with neither as a protocol error, which is correct
  behavior and easy to trigger accidentally while writing a fixture.
- Usage, when reported, arrives in its own trailing chunk with an empty
  `choices` array — the shape providers use for
  `stream_options.include_usage`, which Inference Lens always requests.

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

Playwright is **not** a repository dependency, and there is no committed browser
suite. The workflow below is an ad hoc driver script run from a scratch
directory with `playwright-core` installed there. Keep it that way unless a
committed browser suite is deliberately designed.

### Seed the profile instead of clicking through settings

Connection profiles are metadata in local storage under
`inference-lens:inference-profiles:v1` (see `app/profile-store.client.ts`).
Credentials are never persisted there, and a fixture needs no key, so a profile
can be seeded directly:

```js
await page.goto("http://localhost:3000");
await page.evaluate(() => {
  localStorage.setItem(
    "inference-lens:inference-profiles:v1",
    JSON.stringify({
      profiles: [{
        id: "paced",
        name: "Paced fixture",
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:4011/v1",
        model: "paced-test-model",
        temperature: 0.7,
      }],
      activeProfileId: "paced",
    }),
  );
});
await page.reload({ waitUntil: "networkidle" });
```

This is a shortcut through the connection drawer, not a substitute for testing
it. When the drawer itself is what changed, drive the drawer.

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

```js
await page.addInitScript((contents) => {
  const file = (name, text) => ({
    kind: "file",
    name,
    getFile: async () => ({ text: async () => text }),
    createWritable: async () => ({ async write() {}, async close() {} }),
  });
  const dir = (name, entries) => ({
    kind: "directory",
    name,
    async *values() { for (const entry of entries) yield entry; },
    async getFileHandle(requested) {
      const match = entries.find((e) => e.kind === "file" && e.name === requested);
      if (!match) throw new DOMException("missing", "NotFoundError");
      return match;
    },
    async getDirectoryHandle(requested) {
      const match = entries.find((e) => e.kind === "directory" && e.name === requested);
      if (!match) throw new DOMException("missing", "NotFoundError");
      return match;
    },
  });
  const project = dir("history-demo", [
    file("inference-lens.project.json", contents.manifest),
    dir("traces", [file("run_a.json", contents.traceA)]),
  ]);
  window.showDirectoryPicker = async () => project;
}, contents);
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
