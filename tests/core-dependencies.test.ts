import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const coreRoot = fileURLToPath(new URL("../packages/core/src", import.meta.url));

/**
 * The only third-party code `packages/core` may reach for.
 *
 * `zod` validates the artifact boundaries and `re2js` backs the linear-time
 * regex engine deterministic checks run on. Both are format and evaluation
 * concerns that exist regardless of who is on the other end of a tool call.
 */
const allowedDependencies = new Set(["zod", "re2js"]);

function coreSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return coreSourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Import specifiers only.
 *
 * Deliberately line-anchored rather than a general scan: prose in a message
 * string contains the word `from`, and a scanner loose enough to match it
 * reports source text as a dependency, which is how a contract test turns into
 * noise nobody reads.
 */
function importedModules(contents: string): string[] {
  const patterns = [
    // import "x" and import … from "x", on one line.
    /^\s*import\s+(?:[^'";]*\sfrom\s*)?['"]([^'"]+)['"]/gm,
    // export … from "x", on one line.
    /^\s*export\s+[^'";]*\sfrom\s*['"]([^'"]+)['"]/gm,
    // The closing line of a multi-line import list.
    /^\s*\}\s*from\s*['"]([^'"]+)['"]/gm,
    // Dynamic and type-position import expressions.
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  return patterns.flatMap((pattern) =>
    [...contents.matchAll(pattern)].map(([, specifier]) => specifier!),
  );
}

/**
 * The executor contract exists so that a command tool and an MCP client can be
 * added without reshaping the run model. That claim is only true while the run
 * model itself stays ignorant of every protocol: the moment core imports a
 * protocol SDK, its types start describing that protocol's world, and the next
 * executor has to be bent to fit.
 *
 * So the boundary is asserted rather than intended. An executor's transport
 * lives beside its binding, on the host side of the seam.
 */
test("packages/core imports no protocol SDK", () => {
  const offenders: string[] = [];
  for (const file of coreSourceFiles(coreRoot)) {
    for (const specifier of importedModules(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".") || specifier.startsWith("#")) continue;
      if (allowedDependencies.has(specifier)) continue;
      offenders.push(`${file.slice(coreRoot.length + 1)} imports "${specifier}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("packages/core reaches no host capability", () => {
  const forbidden = [
    "node:",
    "@tauri-apps/",
    "next/",
    "react",
    "@modelcontextprotocol/",
  ];
  const offenders: string[] = [];
  for (const file of coreSourceFiles(coreRoot)) {
    for (const specifier of importedModules(readFileSync(file, "utf8"))) {
      if (forbidden.some((prefix) => specifier.startsWith(prefix))) {
        offenders.push(`${file.slice(coreRoot.length + 1)} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
