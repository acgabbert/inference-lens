@AGENTS.md

## When the pinned Chromium cannot be downloaded

`npm run test:e2e` runs `pretest:e2e`, which fetches the exact Chromium build
this Playwright version pins. In a sandboxed or proxied environment that fetch
can fail outright — typically `403 request rejected: host not permitted` from
`cdn.playwright.dev` — and the suite never starts.

That is not a reason to skip the browser check. Environments that block the
download usually ship a pre-installed build; look for `$PLAYWRIGHT_BROWSERS_PATH`
(commonly `/opt/pw-browsers/chromium`). Run the committed suite against the
newest build you actually have, by pointing `launchOptions.executablePath` at it
from a throwaway config that spreads `playwright.config.ts`:

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

This amends the closing paragraph of [the provider fixture
guide](docs/PROVIDER_FIXTURES.md#driving-the-ui-in-a-browser). Its warning is
about interpretation, not about refusing to run: the type-floor, contrast, and
nine-width assertions genuinely are build-sensitive, so a different Chromium is
a different result for those. Text, role, and layout-overflow assertions are
not. Running everything on a near-by build and saying which one ran beats
reporting no browser coverage at all.

What the guide's warning does still forbid is quiet substitution. So report the
build you used and its version, name it as not the pinned one, and call the
build-sensitive sweep unconfirmed on the pinned build. Never write "the browser
suite passed" without that qualification, and never claim the suite ran when it
never started.
