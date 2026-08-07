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

For anything a user reads or a provider drives, run it:

- **Drive the browser with the committed Playwright suite: `npm run test:e2e`.**
  `npm run test:e2e` starts loopback services. In execution environments known
  to block socket binding, run it with host-network/out-of-sandbox permission
  on the first attempt. Do not first start a dev server or run Playwright
  installation separately.
  Add a spec under `tests/e2e/` rather than writing a throwaway driver script,
  and import the shared drivers from `tests/e2e/support/` — `seedProfile`,
  `waitForHydration`, `importProject`, `stubProjectDirectory` — instead of
  re-deriving them. The config starts the dev server and the buffered fixture
  itself, so do not start one by hand for a Playwright run. Read
  [the provider fixture guide](docs/PROVIDER_FIXTURES.md) first: it lists the
  traps that produce a *passing* test which exercised nothing.
- Prefer a local fixture over a hosted account. When the situation under test is
  a specific failure, a specific timing, or a specific payload, write a fixture
  that produces it deterministically rather than waiting for a real provider to
  cooperate.
- Choose fixture values you can predict the correct output from, so the UI's
  numbers can be checked rather than merely eyeballed for plausibility.
- Assert on rendered text, not only on screenshots. Scanning a numeric UI for
  `NaN`, `Infinity`, and `undefined` catches formatting and divide-by-zero bugs
  that unit tests pass straight through.
- Stop long-lived fixtures and dev servers when the check is finished.

Report what was actually run. If a check was skipped or a fixture could not
reproduce the situation, say so rather than implying broader coverage. Naming a
spec is a report; "verified the app" is not.

A new regression test must be shown to fail without the fix. A test written
against already-fixed code proves only that it passes today.

## Keep n8n work API-first and collaborative

Browser-driven n8n UI work is unusually expensive. For n8n investigation,
fixture capture, and verification:

- Prefer the documented public API and the repository's read-only n8n probe
  scripts whenever they can answer the question.
- Do not use browser automation or the browser skill for n8n.
- When an action requires the n8n UI, give the user the exact value or steps to
  enter. Let the user perform the action, then continue from the execution ID,
  output, screenshot, or other result they provide.
- Never expose the n8n API key or private instance topology in chat, logs, or
  committed fixtures. Continue using ignored environment and staging files.
