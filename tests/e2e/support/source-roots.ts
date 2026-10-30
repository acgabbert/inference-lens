import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestInfo } from "@playwright/test";

/** The folders `tests/fixtures/source-roots/catalog.json` declares to the suite's server. */
const SOURCE_ROOTS = fileURLToPath(new URL("../../../test-results/source-roots/", import.meta.url));

export interface SourceRootFixture {
  /** This test's own subfolder, the same in every declared root. */
  prefix: string;
  /** Writes `<root>/<prefix>/<path>` and returns the path relative to the root. */
  write(root: "e2e-prompts" | "e2e-alternate", path: string, text: string): string;
}

/**
 * A per-test subfolder in each declared source root, so parallel workers and
 * repeated runs never share a file.
 */
export function sourceRootFixture(testInfo: TestInfo): SourceRootFixture {
  const prefix = `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
  return {
    prefix,
    write(root, path, text) {
      const target = join(SOURCE_ROOTS, root, prefix, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      return `${prefix}/${path}`;
    },
  };
}
