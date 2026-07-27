# Trace Lens Agent Guidelines

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

## Verify against a running app, not only against tests

A green suite proves a derivation is correct. It does not prove the result
reaches the screen in a usable form, and it cannot exercise provider behavior
the tests fabricate.

For anything a user reads or a provider drives, run it:

- Prefer a local fixture over a hosted account. When the situation under test is
  a specific failure, a specific timing, or a specific payload, write a fixture
  that produces it deterministically rather than waiting for a real provider to
  cooperate. See [the provider fixture guide](docs/PROVIDER_FIXTURES.md).
- Choose fixture values you can predict the correct output from, so the UI's
  numbers can be checked rather than merely eyeballed for plausibility.
- Assert on rendered text, not only on screenshots. Scanning a numeric UI for
  `NaN`, `Infinity`, and `undefined` catches formatting and divide-by-zero bugs
  that unit tests pass straight through.
- Stop long-lived fixtures and dev servers when the check is finished.

Report what was actually run. If a check was skipped or a fixture could not
reproduce the situation, say so rather than implying broader coverage.

## Keep route components as composition roots

Route and page components should primarily compose feature owners. When a
feature adds cohesive state, effects, refs, or mutation workflows, define a
feature hook or component boundary as part of that feature. Keep only genuinely
cross-feature adapters in the route.

Before materially expanding a route component, identify the intended owner for
the new responsibility. If the route must own it, record why it cannot belong
to an existing or new feature boundary. Treat a substantial increase in
route-local state or orchestration as a design decision, not a default
implementation detail.

Prefer ownership and cohesive contracts over arbitrary file-size limits.
Extract presentational JSX for local readability, but do not create global
state or generic abstractions without a durable ownership, compatibility, or
reuse reason.
