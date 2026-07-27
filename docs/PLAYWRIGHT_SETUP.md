# Playwright setup for browser verification

[`AGENTS.md`](../AGENTS.md) requires verifying UI changes against the running
app, not only against `npm test`. Earlier sessions did this by installing
`playwright-core` by hand into a scratch directory each time. That worked but
left nothing repeatable: the next session had to rediscover that Playwright
was even an option and reinstall it from scratch.

`playwright` is now a `devDependency` of this repo, so the API is available to
anyone who runs `npm install`. What is **not** committed is a browser binary —
those are large, platform-specific, and provisioned differently depending on
where you're running.

## One-time setup

```sh
npm install                       # pulls in the playwright package
npx playwright install chromium   # downloads a Chromium binary, if needed
```

Only Chromium is worth installing here; there is no reason to pull Firefox or
WebKit for verifying a Chromium-class web app. `npx playwright install
chromium` is safe to re-run — it no-ops if a matching binary is already
present, which matters because the two environments below differ on whether
that download step does anything at all.

## Environment differences

### Claude Code cloud / remote sandbox sessions

A Chromium build is already provisioned outside the repo — no download
happens, and outbound network access for fetching a new one may not be
available. The path is versioned and has moved before
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in one prior session);
don't hardcode a revision. Discover the current one if `playwright install`
doesn't resolve it automatically:

```sh
find /opt/pw-browsers -maxdepth 2 -iname 'chrome*'
```

Try `npx playwright install chromium` first — if a compatible binary is
already staged where Playwright expects it, this is instant. If it hangs or
fails on network access, fall back to launching the discovered binary
directly instead of letting Playwright manage the download:

```js
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
```

### Local machine / generic CI

Nothing is preinstalled. `npx playwright install chromium` downloads a build
into the platform's Playwright cache (`~/Library/Caches/ms-playwright` on
macOS, `~/.cache/ms-playwright` on Linux) the first time, and is a no-op on
every run after that. `chromium.launch()` needs no `executablePath` once the
binary is there. On Linux, missing shared libraries are the usual first
failure; `npx playwright install --with-deps chromium` also installs those
(needs `sudo` / a package manager, so it's not run automatically here).

### A second, unrelated browser mechanism already in this repo

[`CODEX_BROWSER_VERIFICATION.md`](CODEX_BROWSER_VERIFICATION.md) documents a
Codex sandbox session driving the app through Codex's own "Browser skill" —
a different tool with a different API, not the `playwright` package. If
you're in that environment, follow that doc instead of this one. The two are
not interchangeable: this doc is for driving the app with the `playwright`
package directly, which is what [the provider fixture guide's browser
section](PROVIDER_FIXTURES.md#driving-the-ui-in-a-browser) walks through.

## What stays uncommitted

Making the *tool* installable does not mean committing a browser test suite.
Driver scripts remain throwaway — written for the change under review, run
once, discarded — unless a committed browser suite is deliberately designed
as its own decision. See [`PROVIDER_FIXTURES.md`](PROVIDER_FIXTURES.md) for
the selector gotchas, assertion patterns, and fixture-driving workflow that
apply once Playwright is actually launching a page.

## Keep it a devDependency

`playwright` belongs in `devDependencies` only. It downloads real browser
binaries and is never imported by the app or the build; nothing in `npm run
build` or `npm start` should ever require it.
