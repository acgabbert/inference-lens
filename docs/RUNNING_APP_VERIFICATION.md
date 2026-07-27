# Running-app verification from a sandboxed Codex session

Use this guide when a change needs verification in the actual Trace Lens UI.
It complements [the provider fixture guide](PROVIDER_FIXTURES.md): that guide
explains which deterministic provider to use; this one explains how an agent
can reach that provider and the local app from a sandboxed session.

## The important distinction: binding is not connectivity

The shell sandbox may reject a local listener before the application starts:

```text
listen EPERM: operation not permitted 127.0.0.1:4012
```

or:

```text
listen EPERM: operation not permitted ::1:3000
```

Those errors mean the sandbox denied the process permission to bind its
loopback port. They do **not** mean that the fixture is unreachable, that
`localhost` is broken, or that the browser cannot test the app. Re-run the
same start command with the normal permission escalation and a narrowly
scoped justification. Once the process prints its listening URL, proceed to
browser verification.

Do not use `curl` as a workaround for a failed bind: no HTTP client can reach a
server that never started. `curl` is useful only *after* the server is listening
to diagnose an HTTP route or fixture response. It verifies the transport from
the shell, not the user-visible application; it cannot replace the browser
check required by `AGENTS.md`.

## Proven workflow

The following completed the Session 3 request-composer verification on
2026-07-27.

1. Start a deterministic fixture in one long-lived terminal session:

   ```sh
   npm run dev:echo-provider
   ```

   Accept the scoped escalation only if the sandbox reports `EPERM` while
   binding. Wait for:

   ```text
   Template echo provider listening at http://127.0.0.1:4012/v1
   ```

2. Start the workbench in a second long-lived terminal session:

   ```sh
   npm run dev
   ```

   Again, escalate only if binding is denied. Wait for the printed local URL,
   normally `http://localhost:3000/`.

3. Use the bundled Browser skill, rather than a shell-launched browser or an
   ad hoc Playwright installation. Initialize its browser runtime once, then
   select a browser with `getForUrl("http://localhost:3000/")`. That selection
   lets the browser runtime choose a surface that can reach the local URL.
   Read the selected browser's full documented interaction contract before
   controlling a tab.

   The Browser skill's setup code uses the absolute plugin path and the
   persistent Node JavaScript tool. In outline:

   ```js
   if (globalThis.agent?.browsers == null) {
     const { setupBrowserRuntime } = await import(
       "/absolute/path/to/browser-client.mjs"
     );
     await setupBrowserRuntime({ globals: globalThis });
   }
   if (globalThis.browser == null) {
     globalThis.browser = await agent.browsers.getForUrl(
       "http://localhost:3000/",
     );
     nodeRepl.write(await browser.documentation());
   }
   ```

   Follow the installed Browser skill for the current plugin path and any
   newer API details. Do not substitute another browser-control tool.

4. Create a new tab, navigate to the printed local URL, wait for DOM content,
   and take a DOM snapshot. The snapshot is the source of truth for locators.
   Before each click, fill, select, or keyboard press, use a scoped locator
   from that snapshot and confirm it resolves to exactly one element. Take a
   fresh snapshot after an interaction when the next action depends on the new
   UI state.

5. Configure the fixture through the real connection drawer when that drawer is
   part of the behavior under test. A fixture needs no real credential; if the
   UI requires a non-empty session key, enter an obvious throwaway value such
   as `trace-lens-test-key`, never a user credential.

6. Exercise the intended user path and assert on visible text. For Session 3,
   that was: switch Messages/Templates/Tools; edit a message; open and close
   the connection drawer; send the keyboard save and run shortcuts; and confirm
   the completed echo reads:

   ```text
   Fixture received system="You are a concise, thoughtful assistant." |
   user="Echo this exact Session 3 request."
   ```

7. Inspect the exact application root rather than dumping the whole page. Scan
   its rendered text for `NaN`, `Infinity`, and `undefined`; inspect browser
   console errors as well. The Session 3 run found none.

8. Finalize the browser's temporary tabs, then stop both long-lived terminal
   sessions with `Ctrl+C`. Do not leave a fixture on its port: a stale endpoint
   can make a later verification look successful for the wrong reason.

## If the browser still cannot load the app

First check the server session, not `curl`: it must still be running and must
have printed its local URL. Then create or select the browser via
`getForUrl(...)` for that exact URL rather than reusing an unrelated binding.
The browser runtime can choose a different compatible surface when the user
has not explicitly required a particular browser.

If navigation still fails after a successful listener and correct browser
selection, report that precise state. It is a genuine environment limitation;
do not claim that a shell `curl` result proves the UI worked, and do not claim
that an initial `EPERM` proves browser verification is impossible.

## Minimum report in a handoff

State all of the following:

- fixture and app commands actually started;
- whether loopback binding required escalation;
- the visible scenario and exact expected output asserted;
- the rendered-text and console-error results; and
- that the fixture and development server were stopped.
