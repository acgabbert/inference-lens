import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Node's test runner isolates each *.mjs file, so tests across files run
 * concurrently. Vite's dependency optimizer defaults to a single shared
 * node_modules/.vite cache dir; concurrent createServer() calls racing that
 * one cache lock each other out and can hang indefinitely (no createServer()
 * timeout exists). Giving every server its own cache dir removes the race.
 */
export function uniqueViteCacheDir() {
  return mkdtempSync(join(tmpdir(), "trace-lens-vite-"));
}
