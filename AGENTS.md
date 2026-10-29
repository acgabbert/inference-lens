# Inference Lens Agent Guidelines

## Orientation

Start from [`docs/README.md`](docs/README.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read a plan, `docs/archive/`, or
`docs/reviews/` only when the task names it: they are records, not current
instructions.

## Design before implementation

Before implementing a feature, first make the relevant design decisions about:

- Type definitions and ownership
- Object and data structure
- Public and internal contracts
- Serialization, persistence, and compatibility boundaries
- Provider-neutral versus provider-specific representations

Actively involve the user in consequential or ambiguous decisions. Present the
available options, tradeoffs, and a recommendation before committing to a
design that would meaningfully constrain the implementation. Raise the open
decisions together in one round rather than one at a time.

Do not begin implementation while a material contract decision remains
unresolved. Small, reversible implementation details may be decided
independently when they do not alter the agreed design.

Record each agreed decision in the relevant plan or the pull request
description, so a later session finds it rather than asking again.

## Route composition roots

Route and page components compose feature owners and top-level regions; feature
state, effects, and workflows live with their owner. Before materially
expanding a route component, name the intended owner and its contract.

## Local checks

Run what the change touches. CI runs everything on the pull request.

- Always: `npm run lint` and `npm run typecheck`
- Core logic: `npm run test:core`, or one file with
  `node --experimental-strip-types --test tests/<name>.test.ts`
- Rendered components: the matching `tests/*-render.test.mjs` or
  `tests/*-interaction.test.mjs`, with `node --test tests/<name>.test.mjs`.
  `npm test` runs all of them, but builds the app first.
- `src-tauri/` changed: `npm run check:rust && npm run test:rust`

When editing docs, change only the lines you mean to; don't reflow the rest.

## One scroll viewport per pane

A workbench pane has exactly one scroll area, and only its panel header sits
outside it. Readiness notices, pins, storage notices and action rows go inside,
at the top, and scroll away with the content. A fixed sibling of a flex
scroller shrinks the scroller, not itself, so a stack of them on a short window
leaves the content below the fold out of reach. `WorkbenchPanel`
(`app/workbench-panel.client.tsx`) renders that shape; build panes on it rather
than wiring a header and scroller by hand, and give any other scroll area the
`pane-scroll` class instead of re-declaring its mechanics.

Every e2e test checks this after it passes, at its own viewport and in a short
and a phone-sized window (`tests/e2e/support/test.ts`). When it fails, fix the
layout; exempt an element only when its clipping is deliberate.

## Verify against a running app, not only against tests

A green suite proves a derivation is correct. It does not prove the result
reaches the screen in a usable form, and it cannot exercise provider behavior
the tests fabricate.

So when a change alters what a user reads or how a provider drives the app,
drive the browser with the committed Playwright suite rather than stopping at a
green unit run. [`tests/e2e/README.md`](tests/e2e/README.md) has the mechanics —
how to invoke it, the shared drivers, the fixture rules — and
[the provider fixture guide](docs/PROVIDER_FIXTURES.md) has the traps that
produce a *passing* test which exercised nothing. Neither is repeated here.

Scope the run to the change. Iterate against the affected spec
(`npm run test:e2e -- tests/e2e/<name>.spec.ts`) rather than running the whole
suite locally: CI runs the full suite in shards against the pinned Chromium
once the work goes up as a pull request, so when handing work back, say that
it has not run yet. When a change touches shared e2e support, provider
fixtures, or app-wide composition, also run the specs most likely to share that
ground. A change with no user-visible surface — a pure type refactor, a docs
edit, build configuration — needs no browser run at all; say that rather than
spending one to prove it.

Report what was actually run, by name, and anything skipped or only partly
covered. Close out with what you could not check yourself and what is worth the
user's own eyes — a complement to running it, never a substitute.

Write the regression test before the fix and run it red, rather than
implementing first and then unwinding the change to manufacture a failure.
Reserve stash-and-rerun for cases where the observable shape genuinely could
not be known before building it — and when a test could not be shown to fail,
say so instead of implying it was.

A red run must be red for the right reason. Assert on the actual incorrect
value, and check that the failure output shows it; a spec that fails because
of a bad selector, a hydration race, or a fixture that never loaded is not
evidence of anything.
