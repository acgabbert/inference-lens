/**
 * The one Vite SSR server a render or interaction test file gets.
 *
 * Every `*-render.test.mjs` and `*-interaction.test.mjs` used to build its own
 * server inside its own render helper, which meant one `createServer()` per
 * *test* rather than per file — 146 servers for 141 tests, each paying Vite's
 * startup and each leaving a `mkdtemp` cache directory behind that nothing
 * removed. Sharing one server per test process is both faster and the only
 * place the teardown has to be right.
 *
 * The registry is shared between tests in a file, which is what the real app
 * does too: a module is evaluated once and its exports are reused. Tests here
 * pass every piece of state in as props, so there is nothing for one to leave
 * behind for the next.
 *
 * Node's test runner isolates each file in its own process, so "per process"
 * and "per file" are the same thing here, and two files still cannot race each
 * other's dependency-optimizer cache — see `viteCacheDir`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const cacheDirectories = new Set();
let serverStarting;

/**
 * A dependency-optimizer cache directory of this process's own, removed when
 * the process ends.
 *
 * Vite defaults every server to the single shared `node_modules/.vite`. Test
 * files run concurrently, and concurrent `createServer()` calls racing that one
 * cache lock can hang indefinitely — there is no `createServer()` timeout to
 * fall back on. A directory per process removes the race.
 *
 * Removal is registered on `exit` rather than in an `after()` hook because it
 * has to survive the ways a test file ends without running its hooks.
 */
export function viteCacheDir() {
  const directory = mkdtempSync(join(tmpdir(), "inference-lens-vite-"));
  cacheDirectories.add(directory);
  return directory;
}

/** Every cache directory this process has claimed, for the regression test. */
export function claimedCacheDirs() {
  return [...cacheDirectories];
}

function removeCacheDirectories() {
  for (const directory of cacheDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cacheDirectories.clear();
}

process.on("exit", removeCacheDirectories);

/**
 * This file's SSR server, created on first use.
 *
 * A Vite server holds the event loop open, so a file that creates one and never
 * closes it does not fail — it hangs until something outside kills it, hiding
 * whatever the real assertion was. The `after()` hook below is what closes it,
 * and registering that hook here, at import time, is what makes it impossible
 * for a caller to forget.
 */
export function ssrServer() {
  // The *promise* is what gets memoized, not the server it resolves to.
  // `server ??= await createServer(...)` looks equivalent and is not: two
  // callers racing the first `await` both see an unset binding and both start a
  // server, and the one that loses the assignment is never closed and never
  // closeable — so the file's tests pass and then the process hangs forever.
  // A `Promise.all` of two `ssrLoadModule` calls is enough to hit it.
  serverStarting ??= createServer({
    configFile: false,
    cacheDir: viteCacheDir(),
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  return serverStarting;
}

/** Loads one application module through the shared SSR pipeline. */
export async function ssrLoadModule(modulePath) {
  return (await ssrServer()).ssrLoadModule(modulePath);
}

/**
 * Renders one exported component to static markup.
 *
 * The shorthand for the common case. A file that needs to load core modules
 * alongside its component builds its own `Promise.all` on `ssrLoadModule`
 * instead — sharing the server is the point, not sharing the call shape.
 */
export async function renderToHtml(modulePath, exportName, props) {
  const [module, { renderToStaticMarkup }, { createElement }] =
    await Promise.all([
      ssrLoadModule(modulePath),
      import("react-dom/server"),
      import("react"),
    ]);
  return renderToStaticMarkup(createElement(module[exportName], props));
}

after(async () => {
  const starting = serverStarting;
  serverStarting = undefined;
  await (await starting)?.close();
});
