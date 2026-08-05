/**
 * How every local fixture server stops.
 *
 * A fixture is started by something that expects to be able to stop it —
 * Playwright's `webServer`, a `Ctrl-C` in the second terminal it was launched
 * in, a test that spawned it. None of those can wait, and a fixture that
 * outlives its run holds its port, which is what makes the *next* run fail with
 * a port-in-use error rather than the fixture's own bug.
 *
 * Two shapes get this wrong, and both were in this directory:
 *
 * - No handler at all. Node's default terminates on SIGTERM, so this happens to
 *   work, but nothing says so, and the first person to add a handler for any
 *   reason silently takes the default away.
 * - `server.close(() => process.exit(0))`. `close()` stops the server accepting
 *   and then waits for every open connection to end on its own. A client
 *   holding a request open — an SSE stream still being written, a browser's
 *   keep-alive socket, a half-sent request — never ends on its own, so the
 *   callback never runs and the process ignores SIGTERM until something
 *   SIGKILLs it. `tests/fixture-shutdown.test.mjs` reproduces exactly that.
 *
 * `closeAllConnections()` is the part that makes the difference: it drops those
 * connections instead of waiting on them.
 */

/**
 * Stops `server` on SIGINT and SIGTERM, dropping open connections rather than
 * waiting for clients to release them.
 *
 * The signal is re-raised once its handler is removed, so the process still
 * dies the way the signal says it should — exit status and all — rather than
 * this listener quietly turning a terminating signal into a no-op.
 */
export function stopOnSignal(server) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, function handler() {
      server.close();
      server.closeAllConnections();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    });
  }
  return server;
}
