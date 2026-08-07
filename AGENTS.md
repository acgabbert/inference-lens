# Inference Lens Agent Guidelines

## Design before implementation

Before implementing a feature, first make the relevant design decisions about:

- Type definitions and ownership
- Object and data structure
- Public and internal contracts
- Serialization, persistence, and compatibility boundaries
- Provider-neutral versus provider-specific representations

Actively involve the user in consequential or ambiguous decisions. Present the
available options, tradeoffs, and a recommendation before committing to a
design that would meaningfully constrain the implementation.

Do not begin implementation while a material contract decision remains
unresolved. Small, reversible implementation details may be decided
independently when they do not alter the agreed design.

## Route composition roots

Route and page components primarily compose feature owners and top-level
regions. Cohesive feature state, effects, refs, and mutation workflows move
with their feature owner; only genuine cross-feature adapters remain in the
route. Before materially expanding a route component, name the intended owner
and its contract. Ownership and contracts matter more than arbitrary file-size
limits.

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
(`npm run test:e2e -- tests/e2e/<name>.spec.ts`), then run the full suite once
before handing the work back. A change with no user-visible surface — a pure
type refactor, a docs edit, build configuration — needs no browser run at all;
say that rather than spending one to prove it.

Report what was actually run. If a check was skipped, or a fixture could not
reproduce the situation, or a spec covers only part of what changed, say so
rather than implying broader coverage. Naming a spec is a report; "verified the
app" is not. Close out with what you could not check yourself and what is worth
the user's own eyes — that is a complement to running it, never a substitute
for it.

Write the regression test before the fix and run it red, rather than
implementing first and then unwinding the change to manufacture a failure.
Reserve stash-and-rerun for cases where the observable shape genuinely could
not be known before building it — and when a test could not be shown to fail,
say so instead of implying it was.

A red run must be red for the right reason. Assert on the actual incorrect
value, and check that the failure output shows it; a spec that fails because
of a bad selector, a hydration race, or a fixture that never loaded is not
evidence of anything.
