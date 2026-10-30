import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The lowest port an operating system hands out as the local end of an
 * outgoing connection: Linux's default `ip_local_port_range` starts here, and
 * macOS and Windows start higher, at 49152.
 *
 * A fixed listener above it can find its port already taken by one of the
 * suite's own outgoing connections — Playwright starts every web server at
 * once — and fails to start with EADDRINUSE before any test runs.
 */
const EPHEMERAL_RANGE_START = 32768;

const sourceExtensions = /\.(?:ts|mts|mjs|js|json|py)$/;

/** A fixed port in a loopback URL, a port setting, or a port variable's default. */
const fixedPortPatterns = [
  /(?:127\.0\.0\.1|localhost):(\d{4,5})\b/g,
  /\b\w*[Pp][Oo][Rr][Tt]\w*["']?\s*[:=]\s*["']?(\d{4,5})\b/g,
  /_PORT\s*\?\?\s*["']?(\d{4,5})\b/g,
];

function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${root}${dir}`, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && sourceExtensions.test(entry.name)) {
      found.push(`${entry.parentPath}/${entry.name}`.slice(root.length));
    }
  }
  return found;
}

function suiteSources(): string[] {
  const configs = readdirSync(root).filter((name) => /^playwright.*\.config\.ts$/.test(name));
  return [...configs, ...sourcesUnder("scripts"), ...sourcesUnder("tests")];
}

test("fixture servers listen below the operating system's ephemeral port range", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const name of suiteSources()) {
    const lines = readFileSync(`${root}${name}`, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const pattern of fixedPortPatterns) {
        for (const match of line.matchAll(pattern)) {
          seen += 1;
          const port = Number(match[1]);
          if (port >= EPHEMERAL_RANGE_START) offenders.push(`${name}:${index + 1} uses ${port}`);
        }
      }
    });
  }
  assert.ok(seen > 0, "the scan found no fixed ports at all, so it no longer reads the suite");
  assert.deepEqual(offenders, []);
});
