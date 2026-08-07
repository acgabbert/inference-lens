# Running the browser suite

The policy — when a change needs a browser run at all, and what a run has to
show — lives in [AGENTS.md](../../AGENTS.md). This file is the mechanics.

## Running it

```bash
npm run test:e2e                                  # everything
npm run test:e2e -- tests/e2e/blocker-chip.spec.ts # one spec
npm run test:e2e -- --list                        # what exists
```

`npm run test:e2e` starts everything the suite needs: the dev server on
`127.0.0.1:4300`, the buffered provider fixture on `44014`, and the flaky
provider fixture on `44015`. **Do not start a dev server or a fixture by hand
for a Playwright run, and do not run a Playwright install step first.** The
config owns all of it, with `reuseExistingServer: false` — a server you started
yourself is not the server the suite talks to, and leaving one running is how a
later run picks up a stale build.

The runner starts loopback listeners. In an execution environment that blocks
socket binding, run it with host-network / out-of-sandbox permission on the
**first** attempt rather than discovering the failure and retrying.

Arguments after `--` go straight to Playwright, so `--grep`, `--project`,
`--headed`, and `--debug` all work as usual.

## Projects

`chromium-light` runs every spec. `chromium-dark` re-runs only the specs listed
in `themeSensitiveSpecs` in [`playwright.config.ts`](../../playwright.config.ts)
— the ones that read resolved styles through `getComputedStyle`, where
`light-dark()` tokens make "disabled reads as disabled" a separate claim per
scheme. Every other spec asserts on text and roles, which the colour scheme
cannot change, so running the whole suite twice bought nothing for half the wall
clock. If a spec starts reading resolved styles, add it to that list.

## Writing a spec

Add a file under `tests/e2e/` rather than writing a throwaway driver script, and
import the shared drivers from [`support/`](support/index.ts) instead of
re-deriving them:

- `seedProfile` — put a connection profile in place before the app loads
- `waitForHydration` — the app is interactive, not merely painted
- `importProject` — load a project fixture
- `stubProjectDirectory` — satisfy the directory picker without a real one

Read [the provider fixture guide](../../docs/PROVIDER_FIXTURES.md) before
writing against a provider. It lists the traps that produce a *passing* test
which exercised nothing — the expensive failure here is not a red run, it is a
green one that never reached the code it claims to cover.

Prefer a local fixture over a hosted account. When the situation under test is a
specific failure, a specific timing, or a specific payload, write a fixture that
produces it deterministically rather than waiting for a real provider to
cooperate. Choose fixture values whose correct output you can predict, so the
UI's numbers can be checked rather than eyeballed for plausibility.

Assert on rendered text, not only on screenshots. Scanning a numeric UI for
`NaN`, `Infinity`, and `undefined` catches formatting and divide-by-zero bugs
that unit tests pass straight through.
